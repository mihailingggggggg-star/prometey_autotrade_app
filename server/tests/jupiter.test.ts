/**
 * jupiter.test.ts — источник вселенной Jupiter БЕЗ реальной сети.
 *
 * Проверяем: разбор ответа Tokens v2 (audit, stats24h, возраст из createdAt /
 * firstPool.createdAt, topHoldersPercentage уже в процентах); дешёвый предфильтр
 * отсекает непроходных ДО дорогих вызовов (счётчик запросов/батч); слой 2
 * (концентрация) работает БЕЗ RPC на данных Jupiter и не блокирует скан; кэш
 * реально экономит запросы; 429/недоступность не роняют скан; CoinGecko нигде не
 * упоминается в исходниках.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cacheClear, requestCount, resetRequests } from "../sources/net.ts";
import { jupiterUniverse, jupiterToken } from "../sources/jupiter.ts";
import { listCandidates, setCandidateFilter } from "../sources/dexscreener.ts";
import { holders } from "../sources/helius.ts";
import { runScan } from "../screener.ts";
import { rug } from "../sources/rugcheck.ts";
import { setSettings, DEFAULT_SETTINGS, getDb } from "../db.ts";
import { RETRY_429_PAUSE_MS } from "../config.ts";

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

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function withFetch(handler: Handler, fn: (ctx: { calls: () => number }) => Promise<void>): Promise<void> {
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls++;
    return await handler(String(input), init);
  }) as typeof fetch;
  try {
    await fn({ calls: () => calls });
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Запись вселенной Jupiter с настраиваемыми полями. */
function token(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "MINTdefault0000000000000000000000000000000",
    symbol: "DEF",
    name: "Default",
    decimals: 6,
    createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    firstPool: { id: "POOLX", createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString() },
    liquidity: 50_000,
    fdv: 5_000_000,
    mcap: 5_000_000,
    usdPrice: 1,
    holderCount: 1000,
    organicScore: 90,
    organicScoreLabel: "high",
    audit: { topHoldersPercentage: 8, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devMints: 0 },
    stats24h: { buyVolume: 12_000, sellVolume: 8_000, holderChange: 5, liquidityChange: -1 },
    ...over,
  };
}

const BAND = { age_min: 30, age_max: 180, liq_min: 20_000, liq_max: 150_000 };

test("jupiter: разбор ответа (audit, stats24h, возраст, topHolders в процентах)", async () => {
  cacheClear();
  const raw = token({
    id: "PARSEME00000000000000000000000000000000000",
    symbol: "PRS",
    name: "Parse Me",
    createdAt: null, // нет даты токена → возраст берём из первого пула
    firstPool: { id: "P", createdAt: new Date(Date.now() - 42 * DAY_MS).toISOString() },
    liquidity: 123_000,
    fdv: 7_500_000,
    mcap: 6_000_000,
    holderCount: 4321,
    organicScore: 55.5,
    organicScoreLabel: "medium",
    audit: { topHoldersPercentage: 33.3, mintAuthorityDisabled: false, freezeAuthorityDisabled: true, devMints: 3 },
    stats24h: { buyVolume: 1000, sellVolume: 250, holderChange: 4.2, liquidityChange: -2.5 },
  });
  await withFetch(
    (url) => {
      if (url.includes("/tokens/v2/tag")) return jsonResp([raw]);
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const t = await jupiterToken("PARSEME00000000000000000000000000000000000");
      assert.ok(t, "токен должен разобраться");
      assert.equal(t!.symbol, "PRS");
      assert.equal(t!.liq_usd, 123_000);
      assert.equal(t!.fdv_usd, 7_500_000);
      assert.equal(t!.volume_24h_usd, 1250, "суточный объём = buyVolume + sellVolume");
      assert.ok(t!.age_days !== null && Math.abs(t!.age_days - 42) < 1, `возраст из firstPool ~42 дн, ${t!.age_days}`);
      assert.equal(t!.holders_change_24h_pct, 4.2, "прирост холдеров из stats24h.holderChange");
      assert.equal(t!.liquidity_change_24h_pct, -2.5, "изменение ликвидности из stats24h.liquidityChange");
      assert.equal(t!.top10_holders_pct, 33.3, "topHoldersPercentage берётся КАК ЕСТЬ (уже проценты)");
      assert.equal(t!.organic_label, "medium");
      assert.equal(t!.organic_score, 55.5);
      assert.equal(t!.freeze_authority_disabled, true);
      assert.equal(t!.mint_authority_disabled, false);
      assert.equal(t!.dev_mints, 3);
    },
  );
});

test("jupiter: нет дат создания → возраст null (не выдумываем 0)", async () => {
  cacheClear();
  const raw = token({ id: "NOAGE000000000000000000000000000000000000", createdAt: null, firstPool: null });
  await withFetch(
    () => jsonResp([raw]),
    async () => {
      const t = await jupiterToken("NOAGE000000000000000000000000000000000000");
      assert.equal(t!.age_days, null);
    },
  );
});

test("jupiter: кэш экономит запрос (второй раз — сеть не трогаем)", async () => {
  cacheClear();
  await withFetch(
    () => jsonResp([token({})]),
    async (ctx) => {
      await jupiterUniverse();
      await jupiterUniverse();
      assert.equal(ctx.calls(), 1, "второй раз должен обслужить кэш");
    },
  );
});

test("jupiter: 429 — пауза и повтор (httpJson), вселенная собирается", async () => {
  cacheClear();
  let calls = 0;
  const started = Date.now();
  await withFetch(
    () => {
      calls++;
      if (calls === 1) return jsonResp({ error: "rate limited" }, 429);
      return jsonResp([token({})]);
    },
    async () => {
      const m = await jupiterUniverse();
      assert.equal(m.size, 1, "после 429 список всё же получен");
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= RETRY_429_PAUSE_MS - 500, `пауза перед повтором не выдержана: ${elapsed} мс`);
});

test("jupiter: недоступный источник не роняет скан (честная пустота)", async () => {
  process.env.DATA_MODE = "live";
  cacheClear();
  await withFetch(
    () => {
      throw new Error("network down");
    },
    async () => {
      const r = await runScan();
      assert.equal(typeof r.found, "number");
      assert.ok("rejected_by_layer" in r);
    },
  );
  process.env.DATA_MODE = "mock";
});

test("jupiter: предфильтр отсекает до дорогих вызовов (в батч идут только прошедшие)", async () => {
  process.env.DATA_MODE = "live";
  cacheClear();
  resetRequests();
  setCandidateFilter({ ...DEFAULT_SETTINGS.screener, ...BAND });

  const PASS = "PassMint000000000000000000000000000000000";
  const tokens = [
    token({ id: PASS, symbol: "PASS" }),
    token({ id: "OldMint0000000000000000000000000000000000", createdAt: new Date(Date.now() - 400 * DAY_MS).toISOString(), firstPool: null }),
    token({ id: "YoungMint00000000000000000000000000000000", createdAt: new Date(Date.now() - 5 * DAY_MS).toISOString(), firstPool: null }),
    token({ id: "RichLiq000000000000000000000000000000000", liquidity: 900_000 }),
    token({ id: "ThinLiq000000000000000000000000000000000", liquidity: 5_000 }),
    token({ id: "Giant00000000000000000000000000000000000", fdv: 500_000_000 }),
    token({ id: "Dead000000000000000000000000000000000000", stats24h: { buyVolume: 0, sellVolume: 0 } }),
    token({ id: "NoAge00000000000000000000000000000000000", createdAt: null, firstPool: null }),
  ];

  const batchCsv: string[] = [];
  await withFetch(
    (url) => {
      if (url.includes("/tokens/v2/tag")) return jsonResp(tokens);
      if (url.includes("token-profiles") || url.includes("token-boosts") || url.includes("trending_pools") || url.includes("new_pools"))
        return jsonResp([]);
      if (url.includes("/networks/solana/pools")) return jsonResp({ data: [] });
      if (url.includes("/latest/dex/tokens/")) {
        const csv = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]);
        batchCsv.push(csv);
        const addrs = csv.split(",");
        return jsonResp({
          pairs: addrs.map((a) => ({
            chainId: "solana",
            pairAddress: `POOL_${a}`,
            baseToken: { address: a, symbol: "X", name: "X" },
            priceUsd: "1",
            liquidity: { usd: 50_000 },
            pairCreatedAt: Date.now() - 60 * DAY_MS,
          })),
        });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const cands = await listCandidates();
      assert.deepEqual(cands.map((c) => c.token_addr), [PASS], "в кандидаты должен пройти ровно один токен");
      const joined = batchCsv.join(",");
      assert.ok(joined.includes(PASS), "прошедший предфильтр уходит в батч");
      for (const bad of ["OldMint", "YoungMint", "RichLiq", "ThinLiq", "Giant", "Dead", "NoAge"]) {
        assert.ok(!joined.includes(bad), `${bad} НЕ должен доходить до батча DexScreener`);
      }
      // Дорогие вызовы (RugCheck/RPC/свечи) в отборе кандидатов не участвуют.
      assert.ok(requestCount() <= 8, `бюджет отбора должен быть мал, израсходовано ${requestCount()}`);
    },
  );

  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("jupiter: слой 2 работает БЕЗ RPC на данных Jupiter", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  const mint = "L2MINT00000000000000000000000000000000000";
  await withFetch(
    (url) => {
      if (url.includes("/tokens/v2/tag")) return jsonResp([token({ id: mint, audit: { topHoldersPercentage: 7.5, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } })]);
      if (url.includes("/latest/dex/tokens/"))
        return jsonResp({ pairs: [{ chainId: "solana", pairAddress: "P", baseToken: { address: mint, symbol: "Z", name: "Z" }, priceUsd: "1", liquidity: { usd: 50_000 }, pairCreatedAt: Date.now() - 60 * DAY_MS }] });
      if (url.includes("/trades")) return jsonResp({ data: [] });
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const h = await holders({ token_addr: mint, pair_addr: "P", symbol: "Z", name: "Z" });
      assert.notEqual(h.top10_na, true, "без RPC доля топ-10 берётся из Jupiter");
      assert.equal(h.top10_holders_pct, 7.5);
      assert.equal(h.holders_growth_na, false, "прирост холдеров из stats24h.holderChange");
      assert.equal(h.holders_growth_pct, 5);
      assert.equal(h.organic_label, "high");
    },
  );
  process.env.DATA_MODE = "mock";
});

test("jupiter: без RPC скан не блокируется слоем 2 (сигнал доходит)", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "SCANMINT000000000000000000000000000000000";
  const nowS = Math.floor(Date.now() / 1000);
  const early = [
    [100, 105, 95, 100, 1000],
    [85, 85, 60, 65, 800],
    [50, 50, 35, 40, 600],
  ];
  const flat = Array.from({ length: 14 }, () => [20, 24, 19, 20, 50]);
  const rows = [...early, ...flat];
  const ohlcv = rows.map((r, i) => [nowS - (rows.length - i) * 86400, ...r]);
  await withFetch(
    (url) => {
      if (url.includes("/tokens/v2/tag")) return jsonResp([token({ id: mint, symbol: "SCN", name: "Scan", createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString() })]);
      if (url.includes("token-profiles") || url.includes("token-boosts") || url.includes("trending_pools") || url.includes("new_pools"))
        return jsonResp([]);
      if (url.includes("/ohlcv/")) return jsonResp({ data: { attributes: { ohlcv_list: ohlcv } } });
      if (url.includes("/trades"))
        return jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
      if (url.includes("/networks/solana/pools")) return jsonResp({ data: [] });
      if (url.includes("/latest/dex/tokens/")) {
        const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
        return jsonResp({
          pairs: addrs.map((a) => ({ chainId: "solana", pairAddress: `POOL_${a}`, baseToken: { address: a, symbol: "SCN", name: "Scan" }, priceUsd: "1", liquidity: { usd: 50_000 }, marketCap: 5_000_000, pairCreatedAt: Date.now() - 60 * DAY_MS, volume: { h24: 20_000 } })),
        });
      }
      if (url.includes("rugcheck")) return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      assert.equal(r.found, 1, `без RPC скан должен давать сигнал, получили ${JSON.stringify(r.rejected_by_layer)}`);
      assert.ok(!(r.rejected_by_layer["2"] ?? 0), "слой 2 без RPC не должен ничего отбраковывать");
    },
  );
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

/* ─────── ОДИН ИСТОЧНИК НА ПРИЗНАК: возраст/ликвидность — Jupiter ─────── */

/** Дневные свечи зрелой монеты: ATH=105, последняя цена 20 (просадка ~81%),
 *  последние 14 баров в узком коридоре 19..24 → слой 4 проходит. */
function matureDaily(): number[][] {
  const nowS = Math.floor(Date.now() / 1000);
  const early = [
    [100, 105, 95, 100, 1000],
    [85, 85, 60, 65, 800],
    [50, 50, 35, 40, 600],
  ];
  const flat = Array.from({ length: 14 }, () => [20, 24, 19, 20, 50]);
  const rows = [...early, ...flat];
  return rows.map((r, i) => [nowS - (rows.length - i) * 86400, ...r]);
}

interface FunnelOpts {
  tokens: unknown[];
  /** Ликвидность и возраст пары DexScreener — СПЕЦИАЛЬНО расходящиеся с Jupiter. */
  pairLiq: number;
  pairAgeDaysAgo: number;
  /** Если задан — включаем FluxRPC-ветку слоя 2 (счета пулов исключаются). */
  rpc?: { poolAcc: string; poolOwner: string; supply: number; accounts: { address: string; uiAmount: number }[] };
}

/** Обвязка воронки (Jupiter + RugCheck/Dex/Gecko/опц. RPC) для тестов без сети. */
function funnelHandler(opts: FunnelOpts): (url: string, init?: RequestInit) => Response {
  const daily = { data: { attributes: { ohlcv_list: matureDaily() } } };
  return (url: string, init?: RequestInit): Response => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp(opts.tokens);
    if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
    if (url.includes("/ohlcv/")) return jsonResp(daily);
    if (url.includes("/trades"))
      return jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
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
          liquidity: { usd: opts.pairLiq },
          marketCap: 5_000_000,
          pairCreatedAt: Date.now() - opts.pairAgeDaysAgo * DAY_MS,
          volume: { h24: 20_000 },
        })),
      });
    }
    if (url.includes("rugcheck")) {
      const rep: Record<string, unknown> = {
        mintAuthority: null,
        freezeAuthority: null,
        risks: [],
        markets: [{ lp: { lpLockedPct: 100 } }],
      };
      if (opts.rpc) {
        rep.topHolders = [{ address: opts.rpc.poolAcc, owner: opts.rpc.poolOwner }];
        rep.knownAccounts = { [opts.rpc.poolOwner]: { name: "AMM", type: "AMM" } };
        rep.totalHolders = 5000;
      }
      return jsonResp(rep);
    }
    if (opts.rpc && url.includes("flux.example")) {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "getTokenSupply")
        return jsonResp({ result: { value: { amount: String(opts.rpc.supply * 1e6), decimals: 6, uiAmount: opts.rpc.supply } } });
      if (body.method === "getTokenLargestAccounts")
        return jsonResp({ result: { value: opts.rpc.accounts } });
      return jsonResp({ error: { code: -1, message: "x" } });
    }
    throw new Error("неожиданный запрос: " + url);
  };
}

test("jupiter: возраст/ликвидность слоя 3 — из Jupiter, а не из пары DexScreener", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "ONSRC000000000000000000000000000000000000";
  // Jupiter: ликвидность $100k В окне $20k–150k, возраст 60 дн.
  const j = token({
    id: mint,
    symbol: "ONS",
    name: "One Source",
    liquidity: 100_000,
    createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    firstPool: { id: "P", createdAt: new Date(Date.now() - 60 * DAY_MS).toISOString() },
  });
  // Пара DexScreener: ликвидность $900k (ВЫШЕ потолка) и возраст 10 дн (ВНЕ окна).
  // Раньше слой 3 мерил по паре и «добивал» прошедшего предфильтр кандидата.
  await withFetch(funnelHandler({ tokens: [j], pairLiq: 900_000, pairAgeDaysAgo: 10 }), async () => {
    const r = await runScan();
    assert.equal(r.found, 1, `расхождение источников не должно решать судьбу: ${JSON.stringify(r.rejected_by_layer)}`);
    assert.ok(!(r.rejected_by_layer["3"] ?? 0), "слой 3 не должен отбраковывать по данным пары");
    const s = getDb()
      .prepare("SELECT liq_usd, age_days, checks_json FROM signals WHERE id=?")
      .get(r.ids[0]) as { liq_usd: number; age_days: number; checks_json: string };
    assert.equal(s.liq_usd, 100_000, "ликвидность сигнала = Jupiter, а не пара DexScreener");
    assert.ok(Math.abs(s.age_days - 60) < 1, `возраст ~60 (Jupiter), а не 10: ${s.age_days}`);
    const checks = JSON.parse(s.checks_json) as { code: string; ok: boolean; value: unknown; threshold: string }[];
    const liq = checks.find((c) => c.code === "liquidity")!;
    const age = checks.find((c) => c.code === "age")!;
    assert.equal(liq.value, 100_000, "слой 3 мерит ликвидность тем же значением Jupiter, что и предфильтр");
    assert.ok(liq.ok, "прошедший предфильтр не может упасть на слое 3 по тому же признаку");
    assert.ok(age.ok, "возраст из Jupiter в окне");
    assert.ok(Math.abs((age.value as number) - 60) < 1, `возраст в checks ~60: ${age.value}`);
    assert.match(liq.threshold, /Jupiter/, "в checks виден источник значения");
    assert.match(age.threshold, /Jupiter/, "в checks виден источник значения");
  });
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("jupiter: слой 2 БЕЗ RPC — верхняя оценка (включая пул) не блокирует", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "UPBOUND0000000000000000000000000000000000";
  // audit.topHoldersPercentage=60% — ЗАВЕДОМО выше top10_max=15%, но это верхняя
  // оценка Jupiter (включает счёт пула) → сигнал не блокируем.
  const j = token({
    id: mint,
    symbol: "UP",
    name: "Upper",
    liquidity: 100_000,
    audit: { topHoldersPercentage: 60, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
  });
  await withFetch(funnelHandler({ tokens: [j], pairLiq: 100_000, pairAgeDaysAgo: 60 }), async () => {
    const r = await runScan();
    assert.equal(r.found, 1, `без RPC слой 2 не блокирует даже при 60%: ${JSON.stringify(r.rejected_by_layer)}`);
    assert.ok(!(r.rejected_by_layer["2"] ?? 0), "слой 2 без RPC не должен ничего отбраковывать");
    const s = getDb().prepare("SELECT checks_json FROM signals WHERE id=?").get(r.ids[0]) as { checks_json: string };
    const c = (JSON.parse(s.checks_json) as { code: string; ok: boolean; value: unknown; threshold: string }[]).find(
      (x) => x.code === "top10_holders",
    )!;
    assert.equal(c.ok, true, "верхняя оценка не блокирует");
    assert.equal(c.value, 60, "значение Jupiter показываем как есть");
    assert.match(c.threshold, /включая пул/, "подпись: значение включает пул");
  });
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("jupiter: слой 2 С RPC — строгий порог top10_max блокирует, источник помечен RPC", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=TESTKEY";
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "RPCSTRICT00000000000000000000000000000000";
  const poolAcc = "PoolTokenAccount000000000000000000000000000";
  const poolOwner = "PoolOwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const j = token({
    id: mint,
    symbol: "RPC",
    name: "Rpc",
    liquidity: 100_000,
    audit: { topHoldersPercentage: 5, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
  });
  const rpc = {
    poolAcc,
    poolOwner,
    supply: 1_000_000,
    // Пул исключаем: (200k+100k)/1M = 30% — выше строгого порога 15%.
    accounts: [
      { address: poolAcc, uiAmount: 500_000 },
      { address: "H1", uiAmount: 200_000 },
      { address: "H2", uiAmount: 100_000 },
    ],
  };
  await withFetch(funnelHandler({ tokens: [j], pairLiq: 100_000, pairAgeDaysAgo: 60, rpc }), async () => {
    // Прямая проверка: с RPC доля считается по RPC (пул исключён) и источник помечен.
    await rug({ token_addr: mint, pair_addr: "", symbol: "", name: "" });
    const h = await holders({ token_addr: mint, pair_addr: `POOL_${mint}`, symbol: "RPC", name: "Rpc" });
    assert.equal(h.top10_source, "rpc", "с RPC источник измерения — RPC");
    assert.equal(h.top10_holders_pct, 30, "счёт пула исключён: 300k/1M = 30%");
    // Полный скан: строгий порог 15% обязан срезать кандидата на слое 2.
    const r = await runScan();
    assert.equal(r.found, 0, "30% > 15% — сигнала быть не должно");
    assert.ok((r.rejected_by_layer["2"] ?? 0) >= 1, "слой 2 с RPC блокирует: " + JSON.stringify(r.rejected_by_layer));
  });
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("jupiter: слой 2 С RPC — низкая концентрация даёт сигнал, подпись указывает RPC", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=T";
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "RPCLOW00000000000000000000000000000000000";
  const poolAcc = "PoolTokenAccount000000000000000000000000000";
  const poolOwner = "PoolOwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const j = token({
    id: mint,
    symbol: "LOW",
    name: "Low",
    liquidity: 100_000,
    audit: { topHoldersPercentage: 5, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
  });
  const rpc = {
    poolAcc,
    poolOwner,
    supply: 1_000_000,
    // Без пула: (50k+30k+20k)/1M = 10% < 15 → слой 2 пройден.
    accounts: [
      { address: poolAcc, uiAmount: 500_000 },
      { address: "H1", uiAmount: 50_000 },
      { address: "H2", uiAmount: 30_000 },
      { address: "H3", uiAmount: 20_000 },
    ],
  };
  await withFetch(funnelHandler({ tokens: [j], pairLiq: 100_000, pairAgeDaysAgo: 60, rpc }), async () => {
    const r = await runScan();
    assert.equal(r.found, 1, `низкая концентрация должна пройти с RPC: ${JSON.stringify(r.rejected_by_layer)}`);
    const s = getDb().prepare("SELECT checks_json FROM signals WHERE id=?").get(r.ids[0]) as { checks_json: string };
    const c = (JSON.parse(s.checks_json) as { code: string; ok: boolean; value: unknown; threshold: string }[]).find(
      (x) => x.code === "top10_holders",
    )!;
    assert.equal(c.ok, true);
    assert.equal(c.value, 10, "счёт пула исключён: 100k/1M = 10%");
    assert.match(c.threshold, /RPC/, "подпись указывает источник RPC");
    assert.doesNotMatch(c.threshold, /включая пул/);
  });
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("jupiter: свежий добор согласован со слоем 3 (токен вне окна Jupiter не берём)", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setCandidateFilter({ ...DEFAULT_SETTINGS.screener, age_min: 30, age_max: 180, liq_min: 20_000, liq_max: 150_000 });
  const OLD = "FreshOld000000000000000000000000000000000";
  const NEW = "FreshNew000000000000000000000000000000000";
  // OLD есть в вселенной Jupiter, но возраст токена 400 дн (вне окна); его ПУЛ в
  // DexScreener свежий (60 дн). Раньше OLD прошёл бы свежим добором по возрасту
  // пары, а слой 3 «добил» бы его значением Jupiter. Теперь свежий добор проходит
  // ТЕ ЖЕ ворота Jupiter и не берёт его.
  // NEW в вселенной Jupiter НЕТ → фильтруем по данным пары (слой 3 померит ту же).
  const tokens = [token({ id: OLD, symbol: "OLD", createdAt: new Date(Date.now() - 400 * DAY_MS).toISOString(), firstPool: null })];
  await withFetch(
    (url) => {
      if (url.includes("/tokens/v2/tag")) return jsonResp(tokens);
      if (url.includes("token-profiles") || url.includes("token-boosts"))
        return jsonResp([
          { chainId: "solana", tokenAddress: OLD },
          { chainId: "solana", tokenAddress: NEW },
        ]);
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
            pairCreatedAt: Date.now() - 60 * DAY_MS,
          })),
        });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const cands = await listCandidates();
      const mints = cands.map((c) => c.token_addr);
      assert.ok(!mints.includes(OLD), "токен вне окна Jupiter не должен попасть даже свежим добором");
      assert.ok(mints.includes(NEW), "токен вне вселенной Jupiter проходит по данным пары");
    },
  );
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("jupiter: CoinGecko нигде не упоминается в исходниках сервера", () => {
  const here = fileURLToPath(import.meta.url);
  const root = join(dirname(here), "..");
  const forbidden = new RegExp("coin" + "gecko", "i");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith(".ts")) continue;
      if (p === here) continue; // сам тест-страж не считаем
      if (forbidden.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  assert.deepEqual(hits, [], "в исходниках сервера не должно быть упоминаний CoinGecko");
});
