/**
 * live.test.ts — живой контур (DATA_MODE=live) БЕЗ реальной сети.
 *
 * Каждый тест подменяет глобальный fetch мок-функцией: ни одного настоящего
 * запроса. Проверяем маппинг ответов источников (DexScreener → цена/ликвидность/
 * возраст; GeckoTerminal OHLCV → Candle; RugCheck → слой 1; RPC → доля топ-10 с
 * исключением пула), экономию кэша, поведение при недоступном источнике и то,
 * что значение ключа из FLUX_RPC_URL не утекает в текст ошибки.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { cacheClear, netJson, requestCount } from "../sources/net.ts";
import { dexMarket, setRangeDays } from "../sources/dexscreener.ts";
import { ohlcv } from "../sources/geckoterminal.ts";
import { rug } from "../sources/rugcheck.ts";
import { holders } from "../sources/helius.ts";
import { runScan, MAX_SCAN_REQUESTS } from "../screener.ts";
import { setSettings, DEFAULT_SETTINGS, getDb } from "../db.ts";
import { RETRY_429_PAUSE_MS } from "../config.ts";

const realFetch = globalThis.fetch;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
interface Ctx {
  calls: () => number;
}

async function withFetch(handler: Handler, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
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

const DAY_MS = 86_400_000;

test("live: DexScreener pair → цена/ликвидность/возраст (возраст из pairCreatedAt)", async () => {
  process.env.DATA_MODE = "live";
  cacheClear();
  setRangeDays(14);
  const mint = "DEXMAPmint000000000000000000000000000000";
  const pair = {
    chainId: "solana",
    pairAddress: "DEXPOOL1",
    baseToken: { address: mint, symbol: "AAA", name: "Aaa" },
    priceUsd: "0.5",
    liquidity: { usd: 50_000 },
    marketCap: 1_200_000,
    fdv: 1_200_000,
    pairCreatedAt: Date.now() - 40 * DAY_MS,
    volume: { h24: 25_000 },
  };
  // Дневные свечи: hi=140, lo=90 (mid=115) → коридор ~43.5%; ATH=140, close=130 → просадка ~7.1%.
  const daily = {
    data: {
      attributes: {
        ohlcv_list: [
          [4, 120, 140, 115, 130, 10],
          [3, 110, 130, 105, 120, 10],
          [2, 100, 120, 95, 110, 10],
          [1, 100, 110, 90, 100, 10],
        ],
      },
    },
  };
  await withFetch(
    (url) => {
      if (url.includes("/latest/dex/tokens/")) return jsonResp({ pairs: [pair] });
      if (url.includes("/ohlcv/")) return jsonResp(daily);
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const m = await dexMarket({ token_addr: mint, pair_addr: "DEXPOOL1", symbol: "AAA", name: "Aaa" });
      assert.equal(m.price, 0.5);
      assert.equal(m.liq_usd, 50_000);
      assert.equal(m.mc_usd, 1_200_000);
      assert.equal(m.volume_24h_usd, 25_000);
      assert.ok(Math.abs(m.age_days - 40) < 1, `возраст ~40 дн, получено ${m.age_days}`);
      assert.ok(Math.abs(m.range_pct - 43.5) < 0.2, `коридор ~43.5%, получено ${m.range_pct}`);
      assert.ok(Math.abs(m.drawdown_from_ath_pct - 7.1) < 0.2, `просадка ~7.1%, получено ${m.drawdown_from_ath_pct}`);
    },
  );
  process.env.DATA_MODE = "mock";
});

test("live: GeckoTerminal OHLCV → Candle, отсортирован по возрастанию", async () => {
  cacheClear();
  // API отдаёт от новых к старым и вперемешку — источник обязан выровнять порядок.
  const list = [
    [300, 3, 3, 3, 3, 3],
    [100, 1, 1, 1, 1, 1],
    [200, 2, 2, 2, 2, 2],
  ];
  await withFetch(
    () => jsonResp({ data: { attributes: { ohlcv_list: list } } }),
    async () => {
      const c = await ohlcv("OHLCVpool", "1h", 3);
      assert.equal(c.length, 3);
      assert.deepEqual(
        c.map((x) => x[0]),
        [100, 200, 300],
        "свечи идут от старых к новым",
      );
      assert.deepEqual(c[0], [100, 1, 1, 1, 1, 1]);
      assert.deepEqual(c[2], [300, 3, 3, 3, 3, 3]);
    },
  );
});

test("live: RugCheck → слой 1 (lpLockedPct, права, danger)", async () => {
  cacheClear();
  const good = {
    mintAuthority: null,
    freezeAuthority: null,
    risks: [{ name: "Honeypot", level: "danger" }],
    markets: [{ lp: { lpLockedPct: 99 } }],
    topHolders: [],
    knownAccounts: {},
    totalHolders: 42,
  };
  await withFetch(
    () => jsonResp(good),
    async () => {
      const r = await rug({ token_addr: "RUGA000000000000000000000000000000000000", pair_addr: "", symbol: "", name: "" });
      assert.equal(r.burned_liq, 100, "lpLockedPct>=95 ⇒ ликвидность сожжена");
      assert.equal(r.mint_authority_revoked, true);
      assert.equal(r.freeze_authority_revoked, true);
      assert.equal(r.danger, true, "риск уровня danger должен блокировать");
    },
  );

  cacheClear();
  const bad = {
    mintAuthority: "AUTHority00000000000000000000000000000000",
    freezeAuthority: "FZauth00000000000000000000000000000000000",
    risks: [],
    markets: [{ lp: { lpLockedPct: 12.4 } }],
  };
  await withFetch(
    () => jsonResp(bad),
    async () => {
      const r = await rug({ token_addr: "RUGB000000000000000000000000000000000000", pair_addr: "", symbol: "", name: "" });
      assert.equal(r.burned_liq, 12);
      assert.equal(r.mint_authority_revoked, false);
      assert.equal(r.freeze_authority_revoked, false);
      assert.equal(r.danger, false);
    },
  );
});

test("live: RPC largest accounts + supply → доля топ-10, счёт пула исключён", async () => {
  process.env.DATA_MODE = "live";
  cacheClear();
  const mint = "RPCMINT0000000000000000000000000000000000";
  const poolAcc = "PoolTokenAccount000000000000000000000000000";
  const poolOwner = "PoolOwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=TESTKEY";

  const rugRep = {
    mintAuthority: null,
    freezeAuthority: null,
    risks: [],
    markets: [{ lp: { lpLockedPct: 100 } }],
    topHolders: [{ address: poolAcc, owner: poolOwner }],
    knownAccounts: { [poolOwner]: { name: "Pump Fun AMM", type: "AMM" } },
    totalHolders: 5440,
  };
  const pair = {
    chainId: "solana",
    pairAddress: "P",
    baseToken: { address: mint, symbol: "Z", name: "Z" },
    priceUsd: "1",
    liquidity: { usd: 100 },
    pairCreatedAt: Date.now(),
  };
  await withFetch(
    (url, init) => {
      if (url.includes("rugcheck")) return jsonResp(rugRep);
      if (url.includes("/latest/dex/tokens/")) return jsonResp({ pairs: [pair] });
      if (url.includes("geckoterminal") && url.includes("/trades"))
        return jsonResp({
          data: [
            { attributes: { tx_from_address: "m1" } },
            { attributes: { tx_from_address: "m1" } },
            { attributes: { tx_from_address: "m2" } },
          ],
        });
      if (url.includes("flux.example")) {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getTokenSupply")
          return jsonResp({ result: { value: { amount: "1000000000000", decimals: 6, uiAmount: 1_000_000 } } });
        if (body.method === "getTokenLargestAccounts")
          return jsonResp({
            result: {
              value: [
                { address: poolAcc, uiAmount: 500_000 }, // пул — исключаем
                { address: "H1", uiAmount: 50_000 },
                { address: "H2", uiAmount: 30_000 },
                { address: "H3", uiAmount: 20_000 },
              ],
            },
          });
        return jsonResp({ error: { code: -1, message: "x" } });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      // rug() регистрирует счета пула, holders() их исключает.
      await rug({ token_addr: mint, pair_addr: "", symbol: "", name: "" });
      const h = await holders({ token_addr: mint, pair_addr: "P", symbol: "Z", name: "Z" });
      // Без пула: (50000+30000+20000)/1_000_000 = 10%.
      assert.equal(h.top10_holders_pct, 10);
      assert.equal(h.makers_24h, 2, "уникальные адреса мейкеров из выборки сделок");
      assert.equal(h.makers_partial, true, "выборка частичная — помечено");
      assert.equal(h.holders_growth_na, true, "роста холдеров нет — не блокирует");
      assert.equal(h.holders, 5440, "число холдеров из отчёта RugCheck");
    },
  );
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
});

test("live: кэш реально экономит запрос (второй вызов не идёт в сеть)", async () => {
  cacheClear();
  await withFetch(
    () => jsonResp({ data: { attributes: { ohlcv_list: [[100, 1, 1, 1, 1, 1]] } } }),
    async (ctx) => {
      await ohlcv("CACHEpool", "1h", 1);
      await ohlcv("CACHEpool", "1h", 1);
      assert.equal(ctx.calls(), 1, "второй вызов должен обслужить кэш");
    },
  );
});

test("live: источники недоступны — пометки «нет данных», скан не падает", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  await withFetch(
    (url) => {
      if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
      if (url.includes("geckoterminal")) return jsonResp({ data: [] });
      if (url.includes("rugcheck")) return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [] });
      if (url.includes("/latest/dex/tokens/")) return jsonResp({ pairs: [] });
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const h = await holders({ token_addr: "NOPC00000000000000000000000000000000000000", pair_addr: "", symbol: "", name: "" });
      assert.equal(h.top10_na, true, "без RPC доля топ-10 помечена как неизмеренная");
      assert.equal(h.top10_holders_pct, 0);
      // Скан на пустых источниках не должен бросать исключение.
      const r = await runScan();
      assert.equal(typeof r.found, "number");
      assert.ok("rejected_by_layer" in r);
    },
  );
  process.env.DATA_MODE = "mock";
});

test("live: FLUX_RPC_URL без рабочего ключа не ломает слой 2", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/%3Fno-key";
  cacheClear();
  await withFetch(
    (url) => {
      if (url.includes("flux.example")) return jsonResp({ error: { code: -32600, message: "invalid key" } });
      if (url.includes("geckoterminal")) return jsonResp({ data: [] });
      if (url.includes("/latest/dex/tokens/"))
        return jsonResp({
          pairs: [
            {
              chainId: "solana",
              pairAddress: "P2",
              baseToken: { address: "MINTNOKEY0000000000000000000000000000000", symbol: "N", name: "N" },
              priceUsd: "1",
              liquidity: { usd: 1 },
              pairCreatedAt: Date.now(),
            },
          ],
        });
      if (url.includes("dexscreener")) return jsonResp([]);
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const h = await holders({ token_addr: "MINTNOKEY0000000000000000000000000000000", pair_addr: "P2", symbol: "N", name: "N" });
      assert.equal(h.top10_na, true, "ошибка RPC ⇒ честное «нет данных», без падения");
    },
  );
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
});

test("live: значение ключа из FLUX_RPC_URL не попадает в текст ошибки", async () => {
  const secret = "FLUXSECRET-abcdef0123456789";
  const url = `https://flux.invalid/?key=${secret}`;
  cacheClear();
  await withFetch(
    () => {
      throw new Error("network down");
    },
    async () => {
      await assert.rejects(
        () => netJson(url, { minIntervalMs: 1 }),
        (e: unknown) => {
          const msg = String((e as Error).message);
          assert.ok(!msg.includes(secret), "значение ключа не должно быть в тексте ошибки");
          assert.ok(msg.includes("key=***"), "query-значение заменено на маску");
          return true;
        },
      );
    },
  );
});

/* ─────────── живой отбор кандидатов: предфильтр, 429, пустоты, бюджет ─────────── */

/** Пул GeckoTerminal для фикстуры: mint, возраст (дней) и ликвидность (USD). */
function geckoPoolFixture(mint: string, daysAgo: number, liq: number, now: number) {
  return {
    attributes: {
      address: `POOL_${mint}`,
      name: `${mint}/SOL`,
      pool_created_at: new Date(now - daysAgo * DAY_MS).toISOString(),
      reserve_in_usd: String(liq),
      base_token_price_usd: "1",
      volume_usd: { h24: "10000" },
    },
    relationships: { base_token: { data: { id: `solana_${mint}` } } },
  };
}

/** Пара DexScreener для батча /latest/dex/tokens/<csv>. */
function dexPairFixture(mint: string, now: number) {
  return {
    chainId: "solana",
    pairAddress: `POOL_${mint}`,
    baseToken: { address: mint, symbol: mint.slice(0, 4), name: mint },
    priceUsd: "1",
    liquidity: { usd: 50_000 },
    marketCap: 1_000_000,
    pairCreatedAt: now - 60 * DAY_MS,
    volume: { h24: 1000 },
  };
}

test("live: предфильтр отсекает по возрасту/ликвидности ДО дорогих вызовов", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=T";
  cacheClear();
  setSettings({
    ...DEFAULT_SETTINGS,
    screener: { ...DEFAULT_SETTINGS.screener, age_min: 30, age_max: 180, liq_min: 20000, liq_max: 150000 },
  });
  const now = Date.now();
  const pools = [
    geckoPoolFixture("MintPass", 60, 50_000, now), // проходит
    geckoPoolFixture("MintOld", 400, 50_000, now), // возраст: старый
    geckoPoolFixture("MintYoung", 5, 50_000, now), // возраст: молодой
    geckoPoolFixture("MintRich", 60, 900_000, now), // ликвидность: слишком большая
    geckoPoolFixture("MintThin", 60, 5_000, now), // ликвидность: слишком малая
  ];
  const rugCalls: string[] = [];
  const rpcCalls: string[] = [];

  await withFetch(
    (url, init) => {
      if (url.includes("trending_pools") || url.includes("new_pools")) return jsonResp({ data: [] });
      if (url.includes("/networks/solana/pools")) return jsonResp({ data: url.includes("page=1") ? pools : [] });
      if (url.includes("/ohlcv/")) return jsonResp({ data: { attributes: { ohlcv_list: [[1, 29, 30, 28, 29, 5]] } } });
      if (url.includes("/trades")) return jsonResp({ data: [] });
      if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
      if (url.includes("/latest/dex/tokens/")) {
        const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
        return jsonResp({ pairs: addrs.map((a) => dexPairFixture(a, now)) });
      }
      if (url.includes("rugcheck")) {
        rugCalls.push(url);
        return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
      }
      if (url.includes("flux.example")) {
        // Считаем только запросы ЭТОГО теста (key=T): хвост от соседнего теста
        // (Promise.all отвергается раньше второго rpc) не должен искажать счёт.
        if (url.includes("key=T")) rpcCalls.push(url);
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getTokenSupply") return jsonResp({ result: { value: { amount: "1000000000", decimals: 6, uiAmount: 1000 } } });
        return jsonResp({ result: { value: [{ address: "H1", uiAmount: 100 }] } });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      assert.equal(typeof r.found, "number");
      assert.equal(rugCalls.length, 1, "до RugCheck должен дойти РОВНО прошедший предфильтр");
      assert.ok(rugCalls[0].includes("MintPass"), "к RugCheck ушёл не тот токен");
      // getTokenLargestAccounts + getTokenSupply + getMultipleAccounts (опознание пулов
      // по программе). Второго батча нет: счета не разобраны — владельца нет.
      assert.equal(rpcCalls.length, 3, "RPC опрошен только по прошедшему кандидату (3 вызова): " + JSON.stringify(rpcCalls));
      for (const m of ["MintOld", "MintYoung", "MintRich", "MintThin"]) {
        assert.ok(!rugCalls.some((u) => u.includes(m)), `${m} не должен дойти до RugCheck`);
      }
    },
  );

  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("live: 429 от Gecko — пауза и повтор, скан не падает", async () => {
  process.env.DATA_MODE = "live";
  cacheClear();
  let poolsCalls = 0;
  const started = Date.now();
  await withFetch(
    (url) => {
      if (url.includes("/networks/solana/pools")) {
        poolsCalls++;
        if (poolsCalls === 1) return jsonResp({ error: "rate limited" }, 429);
        return jsonResp({ data: [] });
      }
      if (url.includes("trending_pools") || url.includes("new_pools")) return jsonResp({ data: [] });
      if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      assert.equal(r.found, 0);
      assert.ok(poolsCalls >= 2, "после 429 должен быть повторный запрос");
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= RETRY_429_PAUSE_MS - 500, `пауза перед повтором не выдержана: ${elapsed} мс`);
  process.env.DATA_MODE = "mock";
});

test("live: нет данных по кандидату — он отбрасывается, скан продолжается", async () => {
  process.env.DATA_MODE = "live";
  setSettings({
    ...DEFAULT_SETTINGS,
    screener: { ...DEFAULT_SETTINGS.screener, age_min: 30, age_max: 180, liq_min: 20000, liq_max: 150000 },
  });
  const now = Date.now();

  // (a) пустые страницы → кандидатов нет, скан не падает.
  cacheClear();
  await withFetch(
    (url) => {
      if (url.includes("geckoterminal")) return jsonResp({ data: [] });
      if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
      if (url.includes("/latest/dex/tokens/")) return jsonResp({ pairs: [] });
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      assert.equal(r.found, 0);
    },
  );

  // (b) пул прошёл предфильтр, но DexScreener не отдаёт пару → кандидат
  //     отбрасывается (error), скан продолжается.
  cacheClear();
  const ghost = geckoPoolFixture("MintGhost", 60, 50_000, now);
  await withFetch(
    (url) => {
      if (url.includes("/networks/solana/pools")) return jsonResp({ data: url.includes("page=1") ? [ghost] : [] });
      if (url.includes("geckoterminal")) return jsonResp({ data: [] });
      if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
      if (url.includes("/latest/dex/tokens/")) return jsonResp({ pairs: [] });
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      assert.equal(r.found, 0);
      assert.ok((r.rejected_by_layer["error"] ?? 0) >= 1, "кандидат без пары должен попасть в error");
    },
  );

  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("live: бюджет сетевых запросов на скан не превышается, остаток → budget", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=T";
  cacheClear();
  setSettings({
    ...DEFAULT_SETTINGS,
    screener: { ...DEFAULT_SETTINGS.screener, age_min: 30, age_max: 180, liq_min: 20000, liq_max: 150000 },
  });
  const now = Date.now();
  const main = Array.from({ length: 12 }, (_, i) => geckoPoolFixture(`Main${i}`, 60, 50_000, now));
  const trend = Array.from({ length: 3 }, (_, i) => geckoPoolFixture(`Trend${i}`, 60, 50_000, now));

  await withFetch(
    (url, init) => {
      if (url.includes("trending_pools")) return jsonResp({ data: trend });
      if (url.includes("new_pools")) return jsonResp({ data: [] });
      if (url.includes("/networks/solana/pools")) return jsonResp({ data: url.includes("page=1") ? main : [] });
      if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
      if (url.includes("/latest/dex/tokens/")) {
        const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
        return jsonResp({ pairs: addrs.map((a) => dexPairFixture(a, now)) });
      }
      if (url.includes("/ohlcv/")) return jsonResp({ data: { attributes: { ohlcv_list: [[1, 29, 30, 28, 29, 5]] } } });
      if (url.includes("/trades")) return jsonResp({ data: [] });
      if (url.includes("rugcheck")) return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
      if (url.includes("flux.example")) {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getTokenSupply") return jsonResp({ result: { value: { amount: "1000000000", decimals: 6, uiAmount: 1000 } } });
        return jsonResp({ result: { value: [{ address: "H1", uiAmount: 100 }] } });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      const reqs = requestCount();
      // Перебор на одного «пограничного» кандидата: бюджет проверяется МЕЖДУ
      // кандидатами, а внутри одного кандидата дорогой гейт может стоить до
      // ~10 запросов (свечи + владельцы по RPC). Отсюда допуск.
      assert.ok(reqs <= MAX_SCAN_REQUESTS + 12, `запросов ${reqs} при бюджете ${MAX_SCAN_REQUESTS}`);
      assert.ok((r.rejected_by_layer["budget"] ?? 0) >= 1, "остаток кандидатов должен уйти в budget");
    },
  );

  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});


/* ─────── вселенная Jupiter как ОСНОВНОЙ источник кандидатов ─────── */

/** Дневные свечи зрелой монеты: ATH=105, последняя цена 20 (просадка ~81%),
 *  последние 14 баров в узком коридоре 19..24 (range ~23%) → слой 4 проходит. */
function matureDaily(): number[][] {
  const nowS = Math.floor(Date.now() / 1000);
  const early: number[][] = [
    [100, 105, 95, 100, 1000],
    [100, 100, 80, 85, 900],
    [85, 85, 60, 65, 800],
    [65, 65, 45, 50, 700],
    [50, 50, 35, 40, 600],
    [40, 40, 28, 30, 500],
  ];
  const flat = Array.from({ length: 14 }, () => [20, 24, 19, 20, 50]);
  const rows = [...early, ...flat];
  // ts: от старых к новым, по дню.
  return rows.map((r, i) => [nowS - (rows.length - i) * 86400, ...r]);
}

const MATURE_MINT = "MatureMint0000000000000000000000000000000";

/** Запись вселенной Jupiter: возраст, ликвидность, FDV, объём, audit, stats24h. */
function jupiterTokenFixture(mint: string, daysAgo: number, liq: number, fdv: number) {
  return {
    id: mint,
    symbol: "MTR",
    name: "Mature",
    decimals: 6,
    createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    firstPool: { id: `POOL_${mint}`, createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString() },
    liquidity: liq,
    fdv,
    mcap: fdv,
    usdPrice: 1,
    holderCount: 5000,
    organicScore: 90,
    organicScoreLabel: "high",
    audit: {
      topHoldersPercentage: 8, // уже в процентах
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      devMints: 0,
    },
    stats24h: { buyVolume: 12_000, sellVolume: 8_000, holderChange: 5, liquidityChange: -1 },
  };
}

/** Обработчик: вселенная Jupiter + минимальная обвязка воронки (RugCheck/Dex/Gecko). */
function matureHandler(daily: unknown, tokens: unknown[] = [jupiterTokenFixture(MATURE_MINT, 60, 50_000, 5_000_000)]) {
  return (url: string, init?: RequestInit): Response => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp(tokens);
    if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
    // Точечные подпути /pools/<addr>/... проверяем РАНЬШЕ общего /pools.
    if (url.includes("/ohlcv/")) return jsonResp(daily);
    // ≥maker_min уникальных мейкеров — иначе слой 4 режет по защите от накрутки.
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
          baseToken: { address: a, symbol: "MTR", name: "Mature" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
          marketCap: 5_000_000,
          pairCreatedAt: Date.now() - 60 * DAY_MS,
          volume: { h24: 20_000 },
        })),
      });
    }
    if (url.includes("rugcheck"))
      return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
    if (url.includes("flux.example")) {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "getTokenSupply") return jsonResp({ result: { value: { amount: "1000000000", decimals: 6, uiAmount: 1000 } } });
      return jsonResp({ result: { value: [{ address: "H1", uiAmount: 100 }] } });
    }
    throw new Error("неожиданный запрос: " + url);
  };
}

test("live: монета Jupiter доходит до сигнала БЕЗ RPC (весь контур на одной паре)", async () => {
  process.env.DATA_MODE = "live";
  // RPC НЕ задан: слой 2 обязан работать на audit.topHoldersPercentage из Jupiter.
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const daily = { data: { attributes: { ohlcv_list: matureDaily() } } };
  await withFetch(matureHandler(daily), async () => {
    const r = await runScan();
    assert.equal(r.found, 1, `ожидали 1 сигнал от монеты Jupiter, получили ${r.found} (${JSON.stringify(r.rejected_by_layer)})`);
    assert.equal(r.ids.length, 1);
    const s = getDb().prepare("SELECT token_addr, pair_addr, age_days, liq_usd, checks_json FROM signals WHERE id=?").get(r.ids[0]) as {
      token_addr: string;
      pair_addr: string;
      age_days: number;
      liq_usd: number;
      checks_json: string;
    };
    assert.equal(s.token_addr, MATURE_MINT, "сигнал по минту из вселенной Jupiter");
    assert.equal(s.pair_addr, `POOL_${MATURE_MINT}`, "свечи/слой 4 считаются по той же паре");
    assert.ok(Math.abs(s.age_days - 60) < 1, `возраст ~60 дн, получено ${s.age_days}`);
    assert.equal(s.liq_usd, 50_000);
    // Слой 2 пройден на данных Jupiter (без RPC): доля топ-10 = 8%.
    const checks = JSON.parse(s.checks_json) as { code: string; ok: boolean; value: unknown }[];
    const top10 = checks.find((c) => c.code === "top10_holders");
    assert.ok(top10, "проверка слоя 2 присутствует");
    assert.equal(top10!.ok, true, "слой 2 не должен блокировать без RPC");
    assert.equal(top10!.value, 8, "доля топ-10 берётся из audit.topHoldersPercentage");
  });
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("live: нет дневных свечей у монеты Jupiter — слой 4 даёт null, скан продолжается", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const empty = { data: { attributes: { ohlcv_list: [] } } };
  await withFetch(matureHandler(empty), async () => {
    const r = await runScan();
    assert.equal(r.found, 0, "без дневной истории сигнала быть не должно");
    assert.ok((r.rejected_by_layer["4"] ?? 0) >= 1, "кандидат должен дойти до слоя 4 и упасть на нём: " + JSON.stringify(r.rejected_by_layer));
  });
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});
