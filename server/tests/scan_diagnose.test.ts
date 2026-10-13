/**
 * scan_diagnose.test.ts — ротация выборки кандидатов, диагностика отбраковки
 * (SCAN_DEBUG) и сводка причин (rejected_by_layer.by_check).
 *
 * Всё БЕЗ сети: глобальный fetch подменён мок-функцией (запросов наружу нет).
 * Контур живой (DATA_MODE=live) — ротация и by_check живут в live-ветке.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { listCandidates, getLastCandidateRotation } from "../sources/dexscreener.ts";
import { runScan } from "../screener.ts";
import { cacheClear } from "../sources/net.ts";
import { setSettings, DEFAULT_SETTINGS, metaSet, closeDb, getDb, nowSec } from "../db.ts";

const realFetch = globalThis.fetch;
const DAY_MS = 86_400_000;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

type Handler = (url: string) => Response | Promise<Response>;

async function withFetch(handler: Handler, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Вселенная Jupiter: n зрелых монет в окне стратегии, у каждой свой символ T<i>. */
function makeTokens(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `Mint${String(i).padStart(3, "0")}${"0".repeat(24)}`,
    symbol: `T${i}`,
    name: `Token ${i}`,
    createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    firstPool: { id: `POOL_T${i}`, createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString() },
    liquidity: 50_000,
    fdv: 5_000_000,
    mcap: 5_000_000,
    usdPrice: 1,
    holderCount: 5000,
    organicScore: 90,
    organicScoreLabel: "high",
    audit: { topHoldersPercentage: 8, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devMints: 0 },
    stats24h: { buyVolume: 12_000, sellVolume: 8_000, holderChange: 5, liquidityChange: -1 },
  }));
}

/**
 * Обработчик отбора кандидатов + слоя 1. RugCheck возвращает lpLockedPct=50 —
 * «ликвидность сожжена» НЕ проходит (порог 70%), поэтому кандидат отбраковывается
 * ровно на слое 1 по коду burned_liq, а дорогие проверки (RPC/свечи) не идут.
 */
function burnedHandler(tokens: unknown[]): Handler {
  return (url: string) => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp(tokens);
    if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
    if (url.includes("trending_pools") || url.includes("new_pools")) return jsonResp({ data: [] });
    if (url.includes("/networks/solana/pools")) return jsonResp({ data: [] });
    if (url.includes("/latest/dex/tokens/")) {
      const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
      return jsonResp({
        pairs: addrs.map((a) => ({
          chainId: "solana",
          pairAddress: `POOL_${a}`,
          baseToken: { address: a, symbol: "X", name: "X" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
          marketCap: 5e6,
          pairCreatedAt: Date.now() - 60 * DAY_MS,
          volume: { h24: 20_000 },
        })),
      });
    }
    if (url.includes("rugcheck"))
      return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 50 } }] });
    throw new Error("неожиданный запрос: " + url);
  };
}

/** Перехват stderr-строк (та же роль, что чтение console.error в терминале). */
function captureErr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(" "));
  };
  return { lines, restore: () => void (console.error = orig) };
}

/** Символы кандидатов, о которых написал отладочный лог (ОТБРАКОВКА/СИГНАЛ). */
function symbolsOf(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = l.match(/^\[скан\] (?:ОТБРАКОВКА|СИГНАЛ) (T\d+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

function liveSetup(): void {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  setSettings(DEFAULT_SETTINGS);
  metaSet("scan_candidate_cursor", "0");
  cacheClear();
}

function teardown(): void {
  delete process.env.SCAN_DEBUG;
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
}

test("ротация: два скана подряд берут РАЗНЫЕ порции кандидатов", async () => {
  liveSetup();
  process.env.SCAN_DEBUG = "1";
  const tokens = makeTokens(80);
  let first: string[] = [];
  let second: string[] = [];
  let rot1: ReturnType<typeof getLastCandidateRotation> = null;
  let rot2: ReturnType<typeof getLastCandidateRotation> = null;
  try {
    await withFetch(burnedHandler(tokens), async () => {
      let cap = captureErr();
      try {
        await runScan();
      } finally {
        cap.restore();
      }
      first = symbolsOf(cap.lines);
      rot1 = getLastCandidateRotation();
      cap = captureErr();
      try {
        await runScan();
      } finally {
        cap.restore();
      }
      second = symbolsOf(cap.lines);
      rot2 = getLastCandidateRotation();
    });
    assert.ok(rot1 && rot2, "позиция выборки видна после каждого скана");
    assert.equal(rot1!.total, 80, "вся вселенная окна — 80 монет");
    assert.equal(rot1!.from, 1, "первый скан берёт начало списка");
    assert.equal(rot2!.from, rot1!.to + 1, "второй скан идёт сразу за первым");
    assert.ok(first.length >= 30, `первый скан оценил порцию: ${first.length}`);
    const set1 = new Set(first);
    for (const s of second) assert.ok(!set1.has(s), `кандидат ${s} повторился во втором скане`);
  } finally {
    teardown();
  }
});

test("ротация: порции разных сканов не пересекаются по адресам", async () => {
  liveSetup();
  const tokens = makeTokens(80);
  try {
    await withFetch(burnedHandler(tokens), async () => {
      const r1 = await listCandidates();
      const rot1 = getLastCandidateRotation();
      const r2 = await listCandidates();
      const rot2 = getLastCandidateRotation();
      assert.ok(r1.length >= 30, `порция сопоставима с прежним потолком: ${r1.length}`);
      assert.ok(rot1 && rot2);
      assert.equal(rot1!.from, 1);
      assert.equal(rot2!.from, rot1!.to + 1);
      const s1 = new Set(r1.map((c) => c.token_addr));
      const s2 = new Set(r2.map((c) => c.token_addr));
      for (const a of s2) assert.ok(!s1.has(a), `во втором скане повтор адреса ${a}`);
    });
  } finally {
    teardown();
  }
});

test("ротация: курсор переживает перезапуск службы (читается из БД)", async () => {
  liveSetup();
  const tokens = makeTokens(80);
  try {
    await withFetch(burnedHandler(tokens), async () => {
      await listCandidates();
      const rot1 = getLastCandidateRotation();
      // «Перезапуск»: закрываем соединение; следующий вызов откроет то же
      // хранилище заново. Курсор лежит в meta — он обязан уцелеть.
      closeDb();
      cacheClear();
      await listCandidates();
      const rot2 = getLastCandidateRotation();
      assert.ok(rot1 && rot2);
      assert.equal(
        rot2!.from,
        rot1!.to + 1,
        `курсор продолжился с ${rot1!.to + 1}, а не с начала (получено ${rot2!.from})`,
      );
    });
  } finally {
    teardown();
  }
});

test("SCAN_DEBUG: печатает причину отбраковки, по умолчанию — молчит; by_check сходится", async () => {
  liveSetup();
  const tokens = makeTokens(40);
  type ScanR = Awaited<ReturnType<typeof runScan>>;
  type WithCheck = ScanR["rejected_by_layer"] & { by_check?: Record<string, number> };
  let off: ScanR;
  let on: ScanR;
  const linesOff: string[] = [];
  const linesOn: string[] = [];
  try {
    await withFetch(burnedHandler(tokens), async () => {
      // 1) Без SCAN_DEBUG — ни одной строки причины/сигнала.
      delete process.env.SCAN_DEBUG;
      let cap = captureErr();
      try {
        off = await runScan();
      } finally {
        cap.restore();
      }
      linesOff.push(...cap.lines);
      // 2) С SCAN_DEBUG — строка с причиной ровно того чека, что положил кандидата.
      process.env.SCAN_DEBUG = "1";
      cap = captureErr();
      try {
        on = await runScan();
      } finally {
        cap.restore();
      }
      linesOn.push(...cap.lines);
    });

    const noisy = linesOff.filter((l) => l.includes("ОТБРАКОВКА") || l.includes("СИГНАЛ"));
    assert.equal(noisy.length, 0, `без SCAN_DEBUG лог молчит, а напечатал: ${noisy.join(" | ")}`);

    const rej = linesOn.find((l) => l.startsWith("[скан] ОТБРАКОВКА"));
    assert.ok(rej, "с SCAN_DEBUG есть строка отбраковки");
    assert.match(
      rej!,
      /^\[скан\] ОТБРАКОВКА T\d+ слой 1 burned_liq: значение 50, порог ≥70%$/,
      `формат строки причины: ${rej}`,
    );

    // 3) by_check считает причины и в рабочем режиме, и с debug; сходится со слоями.
    const offCheck = (off!.rejected_by_layer as unknown as WithCheck).by_check;
    assert.ok(offCheck && offCheck.burned_liq >= 1, "by_check присутствует и без debug");
    const byCheck = (on!.rejected_by_layer as unknown as WithCheck).by_check!;
    assert.equal(byCheck.burned_liq, on!.rejected_by_layer["1"], "все отбраковки слоя 1 — burned_liq");
    const checkSum = Object.values(byCheck).reduce((a, b) => a + b, 0);
    const layerSum = Object.entries(on!.rejected_by_layer)
      .filter(([k, v]) => /^[1-5]$/.test(k) && typeof v === "number")
      .reduce((a, [, v]) => a + (v as number), 0);
    assert.equal(checkSum, layerSum, `by_check ${checkSum} ≠ слои ${layerSum}`);
  } finally {
    teardown();
  }
});

test("добор ротации: событийные кандидаты первыми, ротация добирает остаток", async () => {
  liveSetup();
  process.env.SCAN_DEBUG = "1";
  const tokens = makeTokens(80);
  const db = getDb();
  db.exec("DELETE FROM events");
  // Две свежие монеты-события (статус new) на адресах вне вселенной ротации.
  const ins = db.prepare(
    "INSERT INTO events(ts,token_addr,symbol,code,label_ru,note,metrics_json,status,signal_id)" +
      " VALUES(?,?,?,?,?,?,?,'new',NULL)",
  );
  const ts = nowSec();
  const evA = "EVaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const evB = "EVbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  ins.run(ts, evA, "EVA", "breakout", "пробой", "", "{}");
  ins.run(ts, evB, "EVB", "lp_inflow", "приток", "", "{}");
  const order: string[] = [];
  try {
    await withFetch(burnedHandler(tokens), async () => {
      const cap = captureErr();
      try {
        await runScan();
      } finally {
        cap.restore();
      }
      // Порядок оценки кандидатов = порядок строк отбраковки/сигнала.
      for (const l of cap.lines) {
        const m = l.match(/^\[скан\] (?:ОТБРАКОВКА|СИГНАЛ) (\S+)/);
        if (m) order.push(m[1]);
      }
    });
    assert.ok(order.includes("EVA") && order.includes("EVB"), `событийные монеты оценены: ${order.slice(0, 4)}`);
    assert.ok(order.indexOf("EVA") < 3 && order.indexOf("EVB") < 3, "событийные идут первыми");
    assert.ok(order.length > 2, `после событийных ротация добрала монеты (оценено ${order.length})`);
    assert.ok(
      order.slice(2).every((s) => /^T\d+$/.test(s)),
      `после событийных — только монеты ротации: ${order.slice(2, 5)}`,
    );
  } finally {
    try {
      getDb().exec("DELETE FROM events");
    } catch {
      /* БД уже закрыта — не мешаем уборке */
    }
    teardown();
  }
});
