/**
 * sources/dexscreener.ts — LIVE-источник: пулы, цена, ликвидность, возраст.
 *
 * Используется только при DATA_MODE=live. В mock не вызывается, но обязан
 * компилироваться и не тянуть за собой ключи на этапе импорта (ключи читаются
 * внутри функций).
 */
import { httpJson, ApiError } from "../config.ts";
import type { Candle, ChartTf } from "../../shared/types.ts";
import type { SourceRef, MarketData } from "./mock.ts";

const BASE = "https://api.dexscreener.com";

/** Часть схемы ответа DexScreener, которую мы реально читаем (документация API). */
interface DexPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // мс
  volume?: { h24?: number };
}

/** Пул с максимальной ликвидностью — он репрезентативен для токена. */
function bestPair(pairs: DexPair[]): DexPair | undefined {
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

export async function dexPairsForToken(tokenAddr: string): Promise<DexPair[]> {
  const j = await httpJson<{ pairs?: DexPair[] }>(`${BASE}/latest/dex/tokens/${tokenAddr}`);
  return j.pairs ?? [];
}

export async function dexSearch(query: string): Promise<SourceRef[]> {
  const j = await httpJson<{ pairs?: DexPair[] }>(
    `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const p of j.pairs ?? []) {
    const addr = p.baseToken?.address;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    out.push({
      token_addr: addr,
      pair_addr: p.pairAddress ?? addr,
      symbol: p.baseToken?.symbol ?? "?",
      name: p.baseToken?.name ?? p.baseToken?.symbol ?? "?",
    });
  }
  return out;
}

export async function dexMarket(ref: SourceRef): Promise<MarketData> {
  const pair = bestPair(await dexPairsForToken(ref.token_addr));
  if (!pair) throw new ApiError("not_found", 404, `DexScreener: пул не найден для ${ref.symbol}`);
  const ageDays = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 86_400_000 : 0;
  return {
    price: Number(pair.priceUsd ?? 0),
    liq_usd: Number(pair.liquidity?.usd ?? 0),
    mc_usd: Number(pair.marketCap ?? pair.fdv ?? 0),
    age_days: ageDays,
    volume_24h_usd: Number(pair.volume?.h24 ?? 0),
    onchain_volume_usd: Number(pair.volume?.h24 ?? 0),
    // Поля ниже публичный API DexScreener не отдаёт. Не выдумываем: 0 означает
    // «измерить не удалось», слой 4 в live на этих значениях честно упадёт.
    liquidity_flow_usd: 0,
    drawdown_from_ath_pct: 0,
    range_pct: 0,
    tf_accum: "1D",
    svd: 0,
  };
}

export async function dexCandles(ref: SourceRef, tf: ChartTf, limit: number): Promise<Candle[]> {
  // Документированного публичного OHLCV у DexScreener нет. В V1 график в live
  // остаётся пустым: лучше честный пробел, чем выдуманные свечи.
  void ref;
  void tf;
  void limit;
  return [];
}
