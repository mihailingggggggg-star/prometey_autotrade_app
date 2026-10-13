/**
 * thresholds.test.ts — решения владельца от 12.10.2026 и починка замера:
 *   • слой 1: порог сожжённой ликвидности 70% (принимает 70 и 100, отвергает 69);
 *   • слой 2: счета пулов опознаются ПО ПРОГРАММЕ AMM и исключаются; при
 *     неопознанном владельце исключается крупнейший счёт с честной подписью;
 *     без RPC верхняя оценка Jupiter (ориентир 30%) НЕ блокирует;
 *   • слой 4: короткий/пустой дневной ряд собирается из часовых свечей;
 *   • потолок кандидатов (~40) соблюдается вместе с бюджетом запросов.
 * Сеть не трогаем: подменяем fetch и RPC моками.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { cacheClear } from "../sources/net.ts";
import { holders } from "../sources/helius.ts";
import { rug } from "../sources/rugcheck.ts";
import { dexDailyCandles, listCandidates, MAX_CANDIDATES, setCandidateFilter, setRangeDays } from "../sources/dexscreener.ts";
import { runScan, MAX_SCAN_REQUESTS } from "../screener.ts";
import { setSettings, DEFAULT_SETTINGS, getDb } from "../db.ts";
import { requestCount } from "../sources/net.ts";

const realFetch = globalThis.fetch;
const DAY_MS = 86_400_000;
const DAY_S = 86_400;
/** Raydium AMM v4 — та же программа, что в AMM_PROGRAMS (helius.ts). */
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ─────────── слой 1: порог 70% (решение владельца) ─────────── */

/** Обвязка воронки: все слои, кроме слоя 1, проходные. Свечей/пары/трейдов хватает. */
function layer1Handler(lpByMint: Record<string, number>, tokens: unknown[]) {
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  const early = [
    [100, 105, 95, 100, 1000],
    [50, 50, 35, 40, 600],
  ];
  const flat = Array.from({ length: 14 }, () => [20, 24, 19, 20, 50]);
  const rows = [...early, ...flat];
  const daily = { data: { attributes: { ohlcv_list: rows.map((r, i) => [nowS - (rows.length - i) * DAY_S, ...r]) } } };
  return (url: string, init?: RequestInit): Response => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp(tokens);
    if (url.includes("token-profiles") || url.includes("token-boosts") || url.includes("trending_pools") || url.includes("new_pools"))
      return jsonResp([]);
    if (url.includes("/ohlcv/")) return jsonResp(daily);
    if (url.includes("/trades"))
      return jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
    if (url.includes("/networks/solana/pools")) return jsonResp({ data: [] });
    if (url.includes("/latest/dex/tokens/")) {
      const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
      return jsonResp({
        pairs: addrs.map((a) => ({
          chainId: "solana",
          pairAddress: `POOL_${a}`,
          baseToken: { address: a, symbol: "T", name: "T" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
          marketCap: 5_000_000,
          pairCreatedAt: now - 60 * DAY_MS,
          volume: { h24: 20_000 },
        })),
      });
    }
    if (url.includes("rugcheck")) {
      const mint = url.split("/tokens/")[1].split("/")[0];
      const pct = lpByMint[mint] ?? 100;
      return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: pct } }] });
    }
    throw new Error("неожиданный запрос: " + url);
  };
}

function jupTok(mint: string, liq = 50_000, top10 = 8, daysAgo = 60) {
  return {
    id: mint,
    symbol: "T",
    name: "T",
    decimals: 6,
    createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    firstPool: { id: `POOL_${mint}`, createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString() },
    liquidity: liq,
    fdv: 5_000_000,
    mcap: 5_000_000,
    usdPrice: 1,
    holderCount: 5000,
    organicScore: 90,
    organicScoreLabel: "high",
    audit: { topHoldersPercentage: top10, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devMints: 0 },
    stats24h: { buyVolume: 12_000, sellVolume: 8_000, holderChange: 5, liquidityChange: -1 },
  };
}

test("слой 1: порог 70% принимает 70 и 100, отвергает 69", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mints = { A: "L1BURN100000000000000000000000000000000000", B: "L1BURN700000000000000000000000000000000000", C: "L1BURN690000000000000000000000000000000000" };
  const lp = { [mints.A]: 100, [mints.B]: 70, [mints.C]: 69 };
  await withFetch(
    layer1Handler(lp, [jupTok(mints.A), jupTok(mints.B), jupTok(mints.C)]),
    async () => {
      const r = await runScan();
      assert.equal(r.found, 2, `70% и 100% проходят, 69% — нет: ${JSON.stringify(r.rejected_by_layer)}`);
      assert.equal(r.rejected_by_layer["1"], 1, "ровно 69% отбракован на слое 1");
    },
  );
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

/* ─────────── слой 2: опознание пулов по программе AMM ─────────── */

/** RPC-ответ: аккаунты топ-аккаунтов с authority и программы владельцев. */
interface RpcFixture {
  supply: number;
  accounts: { address: string; uiAmount: number }[];
  /** authority каждого токен-аккаунта (или null — счёт не разобран). */
  authorities: Record<string, string | null>;
  /** программа, которой принадлежит authority (owner второго уровня). */
  programs: Record<string, string>;
}

function rpcHandlers(fx: RpcFixture) {
  let multi = 0;
  return (url: string, init?: RequestInit): Response => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (body.method === "getTokenSupply")
      return jsonResp({ result: { value: { amount: String(fx.supply * 1e6), decimals: 6, uiAmount: fx.supply } } });
    if (body.method === "getTokenLargestAccounts") return jsonResp({ result: { value: fx.accounts } });
    if (body.method === "getMultipleAccounts") {
      multi++;
      const addrs = (body.params[0] as string[]) ?? [];
      if (multi === 1) {
        // Первый батч — authority каждого токен-аккаунта (jsonParsed).
        return jsonResp({
          result: {
            value: addrs.map((a) => {
              const auth = fx.authorities[a];
              return auth ? { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { owner: auth } } } } : { owner: "Tokenkeg" };
            }),
          },
        });
      }
      // Второй батч — программа, которой принадлежит authority.
      return jsonResp({ result: { value: addrs.map((a) => ({ owner: fx.programs[a] ?? SYSTEM_PROGRAM })) } });
    }
    return jsonResp({ error: { code: -1, message: "x" } });
  };
}

/** Общая обвязка для holders(): Jupiter-вселенная + DexScreener-пара + трейды. */
function holdersHandler(mint: string, rpc?: (url: string, init?: RequestInit) => Response, top10Jup: number | null = 5) {
  return (url: string, init?: RequestInit): Response => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag"))
      return jsonResp([
        { id: mint, symbol: "H", name: "H", liquidity: 50_000, fdv: 1e6, mcap: 1e6, audit: top10Jup === null ? {} : { topHoldersPercentage: top10Jup } },
      ]);
    if (url.includes("/latest/dex/tokens/"))
      return jsonResp({ pairs: [{ chainId: "solana", pairAddress: "HPOOL", baseToken: { address: mint, symbol: "H", name: "H" }, priceUsd: "1", liquidity: { usd: 50_000 }, pairCreatedAt: Date.now() }] });
    if (url.includes("/trades")) return jsonResp({ data: [] });
    if (url.includes("flux.example") && rpc) return rpc(url, init);
    throw new Error("неожиданный запрос: " + url);
  };
}

test("слой 2: счёт, чей владелец принадлежит программе AMM, исключается из топ-10", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=TEST";
  cacheClear();
  const mint = "AMMPOOL00000000000000000000000000000000000";
  const fx: RpcFixture = {
    supply: 1_000_000,
    accounts: [
      { address: "POOLTOKENACC", uiAmount: 500_000 }, // пул Raydium
      { address: "H1", uiAmount: 50_000 },
      { address: "H2", uiAmount: 30_000 },
      { address: "H3", uiAmount: 20_000 },
    ],
    authorities: { POOLTOKENACC: "POOLAUTH", H1: "H1AUTH", H2: "H2AUTH", H3: "H3AUTH" },
    programs: { POOLAUTH: RAYDIUM_AMM, H1AUTH: SYSTEM_PROGRAM, H2AUTH: SYSTEM_PROGRAM, H3AUTH: SYSTEM_PROGRAM },
  };
  await withFetch(holdersHandler(mint, rpcHandlers(fx)), async () => {
    const h = await holders({ token_addr: mint, pair_addr: "HPOOL", symbol: "H", name: "H" });
    assert.equal(h.top10_source, "rpc");
    assert.equal(h.top10_holders_pct, 10, "пул (500k) исключён по программе: (50k+30k+20k)/1M = 10%");
    assert.match(h.top10_excluded_note ?? "", /программе AMM/, "подпись объясняет способ исключения");
  });
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
});

test("слой 2: владельца определить нельзя — исключается крупнейший счёт с честной подписью", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=TEST";
  cacheClear();
  const mint = "NOOWNER00000000000000000000000000000000000";
  const fx: RpcFixture = {
    supply: 1_000_000,
    accounts: [
      { address: "BIGACC", uiAmount: 400_000 },
      { address: "H1", uiAmount: 100_000 },
      { address: "H2", uiAmount: 50_000 },
    ],
    authorities: { BIGACC: null, H1: null, H2: null }, // jsonParsed не разобрал счета
    programs: {},
  };
  await withFetch(holdersHandler(mint, rpcHandlers(fx)), async () => {
    const h = await holders({ token_addr: mint, pair_addr: "HPOOL", symbol: "H", name: "H" });
    assert.equal(h.top10_holders_pct, 15, "крупнейший (400k) исключён: (100k+50k)/1M = 15%");
    assert.match(h.top10_excluded_note ?? "", /без крупнейшего счёта/, "подпись честно говорит, что именно исключено");
    assert.match(h.top10_excluded_note ?? "", /предположительно пул/);
  });
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
});

test("слой 2: счёт пула, помеченный RugCheck по АДРЕСУ (Meteora), тоже исключается", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=TEST";
  cacheClear();
  const mint = "METEO000000000000000000000000000000000000";
  const poolAcc = "MeteoraVaultTokenAccount000000000000000000";
  await withFetch(
    (url, init) => {
      if (url.includes("lite-api.jup.ag/tokens/v2/tag"))
        return jsonResp([{ id: mint, symbol: "M", name: "M", liquidity: 50_000, audit: { topHoldersPercentage: 5 } }]);
      if (url.includes("/latest/dex/tokens/"))
        return jsonResp({ pairs: [{ chainId: "solana", pairAddress: "MPOOL", baseToken: { address: mint, symbol: "M", name: "M" }, priceUsd: "1", liquidity: { usd: 50_000 }, pairCreatedAt: Date.now() }] });
      if (url.includes("/trades")) return jsonResp({ data: [] });
      if (url.includes("rugcheck"))
        return jsonResp({
          mintAuthority: null,
          freezeAuthority: null,
          risks: [],
          markets: [{ lp: { lpLockedPct: 100 }, liquidityA: poolAcc }],
          // RugCheck помечает ВЛАДЕЛЬЦА (owner) и СЧЁТ (address) по-разному: у Meteora
          // владелец vault'а — обычный System-кошелёк, помечен сам адрес счёта.
          topHolders: [{ address: poolAcc, owner: "SystemOwnedWallet0000000000000000000000000" }],
          knownAccounts: { [poolAcc]: { name: "Meteora DAMM v2 Pool", type: "AMM" } },
        });
      if (url.includes("flux.example")) {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getTokenSupply") return jsonResp({ result: { value: { amount: "1000000000", decimals: 6, uiAmount: 1_000_000 } } });
        if (body.method === "getTokenLargestAccounts")
          return jsonResp({ result: { value: [{ address: "WHALE", uiAmount: 400_000 }, { address: poolAcc, uiAmount: 300_000 }, { address: "H1", uiAmount: 100_000 }] } });
        // Программу определить нельзя (счета не разобраны) — проверяем именно матч по адресу.
        return jsonResp({ result: { value: [{ owner: "Tokenkeg" }] } });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      await rug({ token_addr: mint, pair_addr: "MPOOL", symbol: "M", name: "M" });
      const h = await holders({ token_addr: mint, pair_addr: "MPOOL", symbol: "M", name: "M" });
      assert.equal(h.top10_holders_pct, 10, "исключены WHALE (крупнейший) и vault Meteora: (100k)/1M = 10%");
    },
  );
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
});

test("слой 2 без RPC: верхняя оценка Jupiter (ориентир 30%) не блокирует сигнал", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const mint = "UPPERREF0000000000000000000000000000000000";
  const nowS = Math.floor(Date.now() / 1000);
  const rows = [[100, 105, 95, 100, 1000], [50, 50, 35, 40, 600], ...Array.from({ length: 14 }, () => [20, 24, 19, 20, 50])];
  const daily = { data: { attributes: { ohlcv_list: rows.map((r, i) => [nowS - (rows.length - i) * DAY_S, ...r]) } } };
  const now = Date.now();
  await withFetch(
    (url) => {
      if (url.includes("lite-api.jup.ag/tokens/v2/tag"))
        return jsonResp([
          {
            id: mint, symbol: "UR", name: "Upper", createdAt: new Date(now - 60 * DAY_MS).toISOString(),
            liquidity: 50_000, fdv: 5e6, mcap: 5e6, usdPrice: 1, organicScore: 90, organicScoreLabel: "high",
            audit: { topHoldersPercentage: 60, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
            stats24h: { buyVolume: 1000, sellVolume: 1000, holderChange: 5, liquidityChange: -1 },
          },
        ]);
      // Подпути /pools/<addr>/ohlcv|trades проверяем РАНЬШЕ списка пулов сети.
      if (url.includes("/ohlcv/")) return jsonResp(daily);
      if (url.includes("/trades")) return jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
      if (url.includes("token-profiles") || url.includes("token-boosts") || url.includes("trending_pools") || url.includes("new_pools") || url.includes("/networks/solana/pools"))
        return jsonResp([]);
      if (url.includes("/latest/dex/tokens/"))
        return jsonResp({ pairs: [{ chainId: "solana", pairAddress: "POOL", baseToken: { address: mint, symbol: "UR", name: "Upper" }, priceUsd: "1", liquidity: { usd: 50_000 }, marketCap: 5e6, pairCreatedAt: now - 60 * DAY_MS, volume: { h24: 2000 } }] });
      if (url.includes("rugcheck")) return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      assert.equal(r.found, 1, `верхняя оценка не должна блокировать: ${JSON.stringify(r.rejected_by_layer)}`);
      const s = getDb().prepare("SELECT checks_json FROM signals WHERE id=?").get(r.ids[0]) as { checks_json: string };
      const c = (JSON.parse(s.checks_json) as { code: string; ok: boolean; value: unknown; threshold: string }[]).find(
        (x) => x.code === "top10_holders",
      )!;
      assert.equal(c.ok, true);
      assert.equal(c.value, 60, "значение Jupiter показываем как есть");
      assert.match(c.threshold, /включая пул/, "подписано, что оценка включает пул");
      assert.match(c.threshold, /≤30%/, "ориентир 30% виден в подписи");
    },
  );
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

/* ─────────── слой 4: склейка дневных свечей из часовых ─────────── */

test("слой 4: пустой дневной ряд собирается из часовых свечей (14 дней)", async () => {
  process.env.DATA_MODE = "live";
  cacheClear();
  setRangeDays(14);
  const mint = "HOURFALL0000000000000000000000000000000000";
  const base = Math.floor(Date.now() / 1000 / DAY_S) * DAY_S; // начало сегодняшних UTC-суток
  const hours: number[][] = [];
  for (let i = 0; i < 14 * 24; i++) {
    const ts = base - 14 * DAY_S + i * 3600;
    // open=1, high=2, low=0.5, close=1.5, volume=1 → день: O=1, H=2, L=0.5, C=1.5, V=24.
    hours.push([ts, 1, 2, 0.5, 1.5, 1]);
  }
  await withFetch(
    (url) => {
      if (url.includes("/latest/dex/tokens/"))
        return jsonResp({ pairs: [{ chainId: "solana", pairAddress: "HPOOL", baseToken: { address: mint, symbol: "H", name: "H" }, priceUsd: "1", liquidity: { usd: 50_000 }, pairCreatedAt: Date.now() }] });
      if (url.includes("/ohlcv/day")) return jsonResp({ data: { attributes: { ohlcv_list: [] } } }); // дневных нет
      if (url.includes("/ohlcv/hour")) return jsonResp({ data: { attributes: { ohlcv_list: hours } } });
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const daily = await dexDailyCandles({ token_addr: mint, pair_addr: "HPOOL", symbol: "H", name: "H" });
      assert.equal(daily.length, 14, `из 336 часовых должно получиться 14 дневных, получено ${daily.length}`);
      const [ts, o, h, l, c, v] = daily[0];
      assert.equal(ts, base - 14 * DAY_S, "метка дня — начало UTC-суток");
      assert.deepEqual([o, h, l, c, v], [1, 2, 0.5, 1.5, 24], "OHLC: open первого часа, high/low — экстремумы, объём — сумма");
    },
  );
  process.env.DATA_MODE = "mock";
});

/* ─────────── потолок кандидатов и бюджет ─────────── */

test("потолок кандидатов: список шире прежних 15, но не больше ~40", async () => {
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setCandidateFilter(DEFAULT_SETTINGS.screener);
  const now = Date.now();
  const tokens = Array.from({ length: 80 }, (_, i) =>
    jupTok(`CAP${String(i).padStart(38, "0")}`),
  );
  await withFetch(
    (url) => {
      if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp(tokens);
      if (url.includes("token-profiles") || url.includes("token-boosts") || url.includes("trending_pools") || url.includes("new_pools") || url.includes("/networks/solana/pools"))
        return jsonResp([]);
      if (url.includes("/latest/dex/tokens/")) {
        const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
        return jsonResp({
          pairs: addrs.map((a) => ({
            chainId: "solana", pairAddress: `POOL_${a}`, baseToken: { address: a, symbol: "T", name: "T" },
            priceUsd: "1", liquidity: { usd: 50_000 }, pairCreatedAt: now - 60 * DAY_MS, volume: { h24: 1000 },
          })),
        });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const cands = await listCandidates();
      assert.ok(cands.length <= MAX_CANDIDATES, `кандидатов ${cands.length} > потолка ${MAX_CANDIDATES}`);
      // Основной пул (Jupiter) заполняет MAX_CANDIDATES − FRESH_CANDIDATES; «свежих»
      // источников здесь нет, поэтому список доходит до 37 из 40.
      assert.ok(cands.length >= MAX_CANDIDATES - 3, `кандидатов ${cands.length}, ожидали почти потолок`);
      assert.ok(MAX_CANDIDATES >= 40, "потолок поднят до ~40 (было 15)");
    },
  );
  process.env.DATA_MODE = "mock";
});

test("бюджет скана: при обилии кандидатов остаток уходит в budget, запросы ограничены", async () => {
  process.env.DATA_MODE = "live";
  process.env.FLUX_RPC_URL = "https://flux.example/?key=T";
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  const rows = [[100, 105, 95, 100, 1000], [50, 50, 35, 40, 600], ...Array.from({ length: 14 }, () => [20, 24, 19, 20, 50])];
  const daily = { data: { attributes: { ohlcv_list: rows.map((r, i) => [nowS - (rows.length - i) * DAY_S, ...r]) } } };
  const tokens = Array.from({ length: 60 }, (_, i) => jupTok(`BUD${String(i).padStart(38, "0")}`));
  await withFetch(
    (url, init) => {
      if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp(tokens);
      if (url.includes("/ohlcv/")) return jsonResp(daily);
      if (url.includes("/trades"))
        return jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
      if (url.includes("token-profiles") || url.includes("token-boosts") || url.includes("trending_pools") || url.includes("new_pools") || url.includes("/networks/solana/pools"))
        return jsonResp([]);
      if (url.includes("/latest/dex/tokens/")) {
        const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
        return jsonResp({
          pairs: addrs.map((a) => ({
            chainId: "solana", pairAddress: `POOL_${a}`, baseToken: { address: a, symbol: "T", name: "T" },
            priceUsd: "1", liquidity: { usd: 50_000 }, marketCap: 5e6, pairCreatedAt: now - 60 * DAY_MS, volume: { h24: 2000 },
          })),
        });
      }
      if (url.includes("rugcheck")) {
        const mint = url.split("/tokens/")[1].split("/")[0];
        return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }], totalHolders: 5000 });
      }
      if (url.includes("flux.example")) {
        // Для бюджета важна лишь ОГРАНИЧЕННОСТЬ запросов, а не привязка к минту:
        // отвечаем валидным RPC-минимумом на любой кандидат.
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (body.method === "getTokenSupply") return jsonResp({ result: { value: { amount: "1000000000", decimals: 6, uiAmount: 1000 } } });
        if (body.method === "getTokenLargestAccounts") return jsonResp({ result: { value: [{ address: "A", uiAmount: 100 }] } });
        return jsonResp({ result: { value: [{ owner: "Tokenkeg", data: { parsed: { info: { owner: "auth" } } } }] } });
      }
      throw new Error("неожиданный запрос: " + url);
    },
    async () => {
      const r = await runScan();
      assert.equal(typeof r.found, "number");
      assert.ok((r.rejected_by_layer["budget"] ?? 0) >= 1, "при обилии кандидатов остаток обязан уйти в budget");
      assert.ok(requestCount() <= MAX_SCAN_REQUESTS + 12, `запросов ${requestCount()} при бюджете ${MAX_SCAN_REQUESTS}`);
      // Потолок кандидатов соблюдён: обработанных не больше потолка. Суммируем
      // только числовые слои — ключ by_check (разбивка по коду проверки) не число.
      const processed = Object.values(r.rejected_by_layer)
        .filter((v): v is number => typeof v === "number")
        .reduce((a, b) => a + b, 0);
      assert.ok(processed <= MAX_CANDIDATES, `обработано ${processed} > потолка ${MAX_CANDIDATES}`);
    },
  );
  process.env.FLUX_RPC_URL = "";
  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});
