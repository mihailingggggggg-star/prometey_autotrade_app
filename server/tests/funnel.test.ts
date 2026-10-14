/**
 * funnel.test.ts — история проходов воронки (scan_runs): запись/чтение прохода,
 * сводка по периодам с группировкой по дню Бишкера и вынос порога сожжённой
 * ликвидности (burned_liq_min) в настройки.
 *
 * Часть про burned_liq_min идёт в live-ветке с подменённым fetch (сети нет):
 * проверяем, что порог из настроек РЕАЛЬНО управляет слоем 1, а не константа.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  insertScanRun,
  listScanRuns,
  funnelSummary,
  getDb,
  getSettings,
  setSettings,
  DEFAULT_SETTINGS,
  metaSet,
  nowSec,
} from "../db.ts";
import { runScan } from "../screener.ts";
import { cacheClear } from "../sources/net.ts";
import type { ScanRun } from "../../shared/types.ts";

/** Полная очистка истории воронки: при агрегаторе все тесты делят одну БД. */
function clearRuns(): void {
  getDb().exec("DELETE FROM scan_runs");
}

function runRec(over: Partial<Omit<ScanRun, "id">>): Omit<ScanRun, "id"> {
  return {
    ts: nowSec(),
    candidates_total: 0,
    candidates_done: 0,
    signals_found: 0,
    elapsed_ms: 0,
    budget_used: 0,
    by_layer: {},
    by_check: {},
    ...over,
  };
}

test("воронка: insertScanRun + listScanRuns возвращают проход целиком", () => {
  clearRuns();
  insertScanRun(
    runRec({
      ts: 1_000,
      candidates_total: 40,
      candidates_done: 38,
      signals_found: 3,
      elapsed_ms: 1234,
      budget_used: 139,
      by_layer: { "1": 2, "3": 5, budget: 2 },
      by_check: { burned_liq: 2, age: 5 },
    }),
  );
  insertScanRun(runRec({ ts: 2_000, candidates_total: 10, signals_found: 0 }));

  const all = listScanRuns(10);
  assert.equal(all.length, 2, "обе записи читаются");
  // Свежие первыми (ts=2000 — последняя вставка с большим ts).
  assert.equal(all[0]!.ts, 2_000);
  const first = all[1]!;
  assert.equal(first.candidates_total, 40);
  assert.equal(first.candidates_done, 38);
  assert.equal(first.signals_found, 3);
  assert.equal(first.elapsed_ms, 1234);
  assert.equal(first.budget_used, 139);
  // JSON разобран в ОБЪЕКТЫ, а не остался строкой.
  assert.deepEqual(first.by_layer, { "1": 2, "3": 5, budget: 2 });
  assert.deepEqual(first.by_check, { burned_liq: 2, age: 5 });
  assert.equal(typeof first.by_layer["1"], "number");

  // limit реально ограничивает.
  assert.equal(listScanRuns(1).length, 1);
  clearRuns();
});

test("воронка: сводка суммирует два дня и группирует по дню Бишкера", () => {
  clearRuns();
  const OFF = 6 * 3600; // Бишкек, UTC+6
  const DAY = 86_400;
  // День Бишкера = floor((ts + OFF)/day)*day − OFF — РЕАЛЬНЫЕ unix-секунды
  // начала суток (тот же сдвиг, что на главной, src/screens/Home.tsx).
  const d2 = Math.floor((nowSec() + OFF) / DAY) * DAY - OFF;
  const d1 = d2 - DAY;
  const tsA = d2 + 3600; // сегодня 01:00 по Бишкеку (d2 — настоящая полночь)
  const tsB = d2 + 7200; // сегодня 02:00 — тот же день
  const tsC = d1 + 3600; // вчера 01:00 — другой день

  insertScanRun(runRec({ ts: tsA, candidates_total: 10, signals_found: 1, by_layer: { "1": 2, "3": 5 }, by_check: { burned_liq: 2 } }));
  insertScanRun(runRec({ ts: tsB, candidates_total: 20, signals_found: 2, by_layer: { "1": 3 }, by_check: { burned_liq: 1, age: 2 } }));
  insertScanRun(runRec({ ts: tsC, candidates_total: 5, signals_found: 0, by_layer: { "2": 1 } }));

  const s = funnelSummary(0, nowSec() + 3600);
  assert.equal(s.runs, 3);
  assert.equal(s.candidates_total, 35, "10 + 20 + 5");
  assert.equal(s.signals_found, 3, "1 + 2 + 0");
  assert.deepEqual(s.by_layer, { "1": 5, "3": 5, "2": 1 });
  assert.deepEqual(s.by_check, { burned_liq: 3, age: 2 });

  // Два прохода в один (сегодняшний) день + один во вчерашний → ровно 2 дня.
  assert.equal(s.days.length, 2, "дни с проходами: сегодня и вчера");
  assert.equal(s.days[0]!.day, d2, "свежий день впереди");
  assert.equal(s.days[0]!.runs, 2);
  assert.equal(s.days[0]!.candidates, 30);
  assert.equal(s.days[0]!.signals, 3);
  assert.equal(s.days[1]!.day, d1);
  assert.equal(s.days[1]!.runs, 1);
  assert.equal(s.days[1]!.candidates, 5);

  // recent — последние проходы, свежие первыми (tsB — самый свежий).
  assert.equal(s.recent.length, 3);
  assert.equal(s.recent[0]!.ts, tsB);
  assert.ok(s.recent.length <= 20, "по умолчанию recent не больше 20");

  // Период уважается: окно [tsC, tsC] содержит только вчерашний проход.
  const one = funnelSummary(tsC, tsC);
  assert.equal(one.runs, 1);
  assert.equal(one.days.length, 1);
  clearRuns();
});

test("воронка: битый JSON в базе не роняет сводку", () => {
  clearRuns();
  const ts = nowSec();
  insertScanRun(runRec({ ts, candidates_total: 7, signals_found: 1, by_layer: { "1": 4 } }));
  // Прямая запись порченых строк: невалидный JSON и JSON-массив (не объект).
  getDb()
    .prepare(
      "INSERT INTO scan_runs(ts, candidates_total, candidates_done, signals_found, elapsed_ms, budget_used, by_layer_json, by_check_json) " +
        "VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(ts + 1, 5, 5, 0, 10, 10, "{oops", "[1,2]");

  let s!: ReturnType<typeof funnelSummary>;
  assert.doesNotThrow(() => {
    s = funnelSummary(0, ts + 10);
  }, "битые строки не должны ронять сводку");
  assert.equal(s.runs, 2);
  assert.equal(s.candidates_total, 12);
  // Битые счётчики считаются за «{}» и не портят суммы корректной строки.
  assert.deepEqual(s.by_layer, { "1": 4 });
  assert.deepEqual(s.by_check, {});
  clearRuns();
});

/* ─────────────── burned_liq_min: порог из настроек ─────────────── */

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

/** Одна зрелая монета в окне стратегии, проходящая предфильтр возраста/ликвидности. */
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

/** Fetch-заглушка live-контура: ликвидность пула сожжена ровно на lpLockedPct%. */
function liqHandler(tokens: unknown[], lpLockedPct: number): (url: string) => Response {
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
      return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct } }] });
    throw new Error("неожиданный запрос: " + url);
  };
}

async function withFetch(handler: (url: string) => Response, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

type WithCheck = { by_check?: Record<string, number> };

test("burned_liq_min: есть в дефолтах и спеке, зажимается валидацией", () => {
  // Дефолт обязан остаться 70 (бывшая константа).
  assert.equal(DEFAULT_SETTINGS.screener.burned_liq_min, 70);
  assert.equal(getSettings().screener.burned_liq_min, 70);

  // Настройка читается/пишется.
  const applied = setSettings({ screener: { burned_liq_min: 50 } });
  assert.equal(applied.screener.burned_liq_min, 50);
  assert.equal(getSettings().screener.burned_liq_min, 50);

  // Границы спеки 0..100: 150 — вне диапазона, setSettings обязан отказать.
  assert.throws(
    () => setSettings({ screener: { burned_liq_min: 150 } }),
    /вне диапазона/,
    "порог вне 0..100 должен отклоняться спекой",
  );
  assert.equal(getSettings().screener.burned_liq_min, 50, "отказ не должен менять настройку");

  setSettings(DEFAULT_SETTINGS);
});

test("burned_liq_min: порог из настроек реально управляет слоем 1", async () => {
  const prevMode = process.env.DATA_MODE;
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  setSettings(DEFAULT_SETTINGS);
  metaSet("scan_candidate_cursor", "0");
  cacheClear();
  // Сожжено 60%: при пороге 50 монета проходит слой 1, при пороге 70 — срезается.
  const tokens = makeTokens(3);
  try {
    await withFetch(liqHandler(tokens, 60), async () => {
      // Порог 50 → слой 1 НЕ отбраковывает по burned_liq (падает дальше по другим
      // причинам, но не на сожжённой ликвидности).
      setSettings({ screener: { ...DEFAULT_SETTINGS.screener, burned_liq_min: 50 } });
      cacheClear();
      metaSet("scan_candidate_cursor", "0");
      const loose = await runScan();
      const looseCheck = (loose.rejected_by_layer as unknown as WithCheck).by_check ?? {};
      assert.equal(loose.rejected_by_layer["1"], 0, "при пороге 50 слой 1 не рубит монету с 60%");
      assert.equal(looseCheck.burned_liq, undefined, "burned_liq не попадает в причины отбраковки");

      // Порог 70 → тот же кандидат срезается ровно на слое 1 по коду burned_liq.
      setSettings({ screener: { ...DEFAULT_SETTINGS.screener, burned_liq_min: 70 } });
      cacheClear();
      metaSet("scan_candidate_cursor", "0");
      const strict = await runScan();
      const strictCheck = (strict.rejected_by_layer as unknown as WithCheck).by_check ?? {};
      assert.ok(strict.rejected_by_layer["1"] >= 1, "при пороге 70 слой 1 рубит монету с 60%");
      assert.ok((strictCheck.burned_liq ?? 0) >= 1, "причина — именно burned_liq");
    });
  } finally {
    if (prevMode === undefined) delete process.env.DATA_MODE;
    else process.env.DATA_MODE = prevMode;
    setSettings(DEFAULT_SETTINGS);
    cacheClear();
    clearRuns();
  }
});
