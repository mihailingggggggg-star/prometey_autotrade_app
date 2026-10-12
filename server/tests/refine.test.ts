/**
 * refine.test.ts — точечный добор воронки (дополнение к решениям владельца):
 *  • wash_filter при НЕсостоявшемся замере мейкеров (429/недоступность) НЕ
 *    блокирует (value=null, «нет данных о сделках»); честный ноль мейкеров,
 *    полученный из данных, — блокирует как раньше;
 *  • holders_growth трактуется как рост ЗА 7 ДНЕЙ — оценка из суточного (×7);
 *  • бюджет скана поднят до 140 и ограничен ещё и потолком времени (дедлайн).
 * Сеть не трогаем: подменяем globalThis.fetch моками.
 */
import "./_setup.ts";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { holders } from "../sources/helius.ts";
import { cacheClear, requestCount } from "../sources/net.ts";
import { runScan, MAX_SCAN_REQUESTS, MAX_SCAN_MS } from "../screener.ts";
import { getDb, setSettings, DEFAULT_SETTINGS } from "../db.ts";

const realFetch = globalThis.fetch;
const DAY_MS = 86_400_000;
const DAY_S = 86_400;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function withFetch(handler: Handler, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

afterEach(() => {
  delete process.env.SCAN_MAX_MS;
  delete process.env.FLUX_RPC_URL;
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
  cacheClear();
});

/* ─────────── фикстуры ─────────── */

/** Дневные свечи зрелой монеты: коридор 19..24 (последние 14), ATH=105, close=20. */
function dailyRows(): number[][] {
  const nowS = Math.floor(Date.now() / 1000);
  const rows: number[][] = [
    [100, 105, 95, 100, 1000],
    [50, 50, 35, 40, 600],
    ...Array.from({ length: 14 }, () => [20, 24, 19, 20, 50]),
  ];
  return rows.map((r, i) => [nowS - (rows.length - i) * DAY_S, ...r]);
}

function jupTok(mint: string, holderChange = 5) {
  return {
    id: mint,
    symbol: "R",
    name: "R",
    decimals: 6,
    createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    firstPool: { id: `POOL_${mint}`, createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString() },
    liquidity: 50_000,
    fdv: 5e6,
    mcap: 5e6,
    usdPrice: 1,
    holderCount: 5000,
    organicScore: 90,
    organicScoreLabel: "high",
    audit: { topHoldersPercentage: 8, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devMints: 0 },
    stats24h: { buyVolume: 12_000, sellVolume: 8_000, holderChange, liquidityChange: -1 },
  };
}

/**
 * Обвязка живой воронки: слои 1/3/4 проходные, медиаслой без ключа не блокирует.
 * trades — как отвечать на выборку сделок (по умолчанию 130 мейкеров);
 * rpc — включать ли FluxRPC (утяжеляет кандидата, нужен для теста бюджета).
 */
function funnelHandler(tokens: unknown[], opts: { trades?: () => Response; rpc?: boolean } = {}): Handler {
  const daily = { data: { attributes: { ohlcv_list: dailyRows() } } };
  return (url, init) => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp(tokens);
    // Подпути /pools/<addr>/ohlcv|trades проверяем РАНЬШЕ списка пулов сети.
    if (url.includes("/ohlcv/")) return jsonResp(daily);
    if (url.includes("/trades"))
      return opts.trades
        ? opts.trades()
        : jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
    if (
      url.includes("token-profiles") ||
      url.includes("token-boosts") ||
      url.includes("trending_pools") ||
      url.includes("new_pools") ||
      url.includes("/networks/solana/pools")
    )
      return jsonResp([]);
    if (url.includes("/latest/dex/tokens/")) {
      const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
      return jsonResp({
        pairs: addrs.map((a) => ({
          chainId: "solana",
          pairAddress: `POOL_${a}`,
          baseToken: { address: a, symbol: "R", name: "R" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
          marketCap: 5e6,
          pairCreatedAt: Date.now() - 60 * DAY_MS,
          volume: { h24: 20_000 },
        })),
      });
    }
    if (url.includes("rugcheck"))
      return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
    if (opts.rpc && url.includes("flux.example")) {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "getTokenSupply")
        return jsonResp({ result: { value: { amount: "1000000000", decimals: 6, uiAmount: 1000 } } });
      if (body.method === "getTokenLargestAccounts") return jsonResp({ result: { value: [{ address: "A", uiAmount: 100 }] } });
      return jsonResp({ result: { value: [{ owner: "Tokenkeg", data: { parsed: { info: { owner: "auth" } } } }] } });
    }
    throw new Error("неожиданный запрос: " + url);
  };
}

/* ─────────── 1. wash_filter: 429 — замер не состоялся, не честный ноль ─────────── */

test("wash_filter: 429 в сделках — makers_na (нет данных о сделках), не честный ноль", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  const mint = "REF429MINT000000000000000000000000000000";
  await withFetch(funnelHandler([jupTok(mint)], { trades: () => jsonResp({ error: "rate limited" }, 429) }), async () => {
    const h = await holders({ token_addr: mint, pair_addr: `POOL_${mint}`, symbol: "R", name: "R" });
    assert.equal(h.makers_na, true, "429 ⇒ замер мейкеров не состоялся");
    assert.equal(h.makers_24h, 0);
    assert.match(h.makers_note ?? "", /нет данных о сделках/);
  });
});

test("wash_filter: 429 в сделках НЕ блокирует сигнал (value=null, подпись причины)", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "REF429SIG0000000000000000000000000000000";
  await withFetch(funnelHandler([jupTok(mint)], { trades: () => jsonResp({ error: "rate limited" }, 429) }), async () => {
    const r = await runScan();
    assert.equal(r.found, 1, `429 в сделках не должен блокировать: ${JSON.stringify(r.rejected_by_layer)}`);
    const row = getDb().prepare("SELECT checks_json FROM signals WHERE id=?").get(r.ids[0]) as { checks_json: string };
    const c = (
      JSON.parse(row.checks_json) as { code: string; ok: boolean; value: unknown; threshold: string }[]
    ).find((x) => x.code === "wash_filter")!;
    assert.equal(c.ok, true, "нет данных — не блокируем");
    assert.equal(c.value, null, "значение честно null");
    assert.match(c.threshold, /нет данных о сделках/);
  });
});

/* ─────────── 2. wash_filter: честный ноль мейкеров — блокирует ─────────── */

test("wash_filter: честный ноль мейкеров (данные пришли) блокирует кандидата", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "REFZEROMINT000000000000000000000000000000";
  await withFetch(funnelHandler([jupTok(mint)], { trades: () => jsonResp({ data: [] }) }), async () => {
    const h = await holders({ token_addr: mint, pair_addr: `POOL_${mint}`, symbol: "R", name: "R" });
    assert.notEqual(h.makers_na, true, "данные пришли (200) ⇒ это честный замер, а не «нет данных»");
    assert.equal(h.makers_24h, 0, "адресов в выборке нет — честный ноль");

    const r = await runScan();
    assert.equal(r.found, 0, "честный ноль мейкеров → слой 4 блокирует");
    assert.ok((r.rejected_by_layer["4"] ?? 0) >= 1, `отбраковка на слое 4: ${JSON.stringify(r.rejected_by_layer)}`);
  });
});

/* ─────────── 3. holders_growth: оценка за 7 дней из суточных (×7) ─────────── */

test("holders_growth: порог за 7 дней — оценка из суточного изменения (×7)", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "REFGROWTH00000000000000000000000000000000";
  await withFetch(funnelHandler([jupTok(mint, 0.59)]), async () => {
    const h = await holders({ token_addr: mint, pair_addr: `POOL_${mint}`, symbol: "R", name: "R" });
    assert.equal(h.holders_growth_pct, 4.13, "0.59% за сутки ⇒ 4.13% за 7 дней (×7)");

    const r = await runScan();
    assert.equal(r.found, 1, `недельная оценка 4.13% ≥ 3 должна пройти: ${JSON.stringify(r.rejected_by_layer)}`);
    const row = getDb().prepare("SELECT checks_json FROM signals WHERE id=?").get(r.ids[0]) as { checks_json: string };
    const g = (
      JSON.parse(row.checks_json) as { code: string; ok: boolean; value: unknown; threshold: string }[]
    ).find((x) => x.code === "holders_growth")!;
    assert.equal(g.ok, true);
    assert.equal(g.value, 4.13);
    assert.match(g.threshold, /7 дней/);
    assert.match(g.threshold, /×7/, "подпись честно говорит, что это оценка из суточных данных");
  });
});

/* ─────────── 4. бюджет 140 и потолок времени скана ─────────── */

test("бюджет скана: 140 запросов соблюдается вместе с потолком времени", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=T";
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  assert.equal(MAX_SCAN_REQUESTS, 220, "бюджет поднят до 220: 140 не хватало на всех кандидатов");
  const tokens = Array.from({ length: 60 }, (_, i) => jupTok(`REFBUD${String(i).padStart(32, "0")}`));
  const started = Date.now();
  await withFetch(funnelHandler(tokens, { rpc: true }), async () => {
    const r = await runScan();
    assert.equal(typeof r.found, "number");
    assert.ok((r.rejected_by_layer["budget"] ?? 0) >= 1, `остаток должен уйти в budget: ${JSON.stringify(r.rejected_by_layer)}`);
    assert.ok(requestCount() <= MAX_SCAN_REQUESTS + 12, `запросов ${requestCount()} при бюджете ${MAX_SCAN_REQUESTS}`);
  });
  assert.ok(Date.now() - started <= MAX_SCAN_MS, `скан дольше потолка времени ${MAX_SCAN_MS} мс`);
});

test("дедлайн скана: SCAN_MAX_MS останавливает скан, остаток → budget", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  process.env.SCAN_MAX_MS = "1"; // крошечный потолок времени: скан обязан встать сразу
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const tokens = Array.from({ length: 15 }, (_, i) => jupTok(`REFDL${String(i).padStart(32, "0")}`));
  await withFetch(funnelHandler(tokens), async () => {
    const r = await runScan();
    // Бюджет 140 эти 15 зрелых монет НЕ исчерпают (~3 запроса каждая) — значит
    // остановку дал именно дедлайн, а не бюджет запросов.
    assert.equal(r.found, 0, "за дедлайном кандидаты не оцениваются");
    assert.ok((r.rejected_by_layer["budget"] ?? 0) >= 1, `остаток ушёл в budget: ${JSON.stringify(r.rejected_by_layer)}`);
  });
});
