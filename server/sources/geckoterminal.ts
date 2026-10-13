/**
 * sources/geckoterminal.ts — LIVE-источник: свечи OHLCV, пулы, сделки (Solana).
 *
 * GeckoTerminal отдаёт свечи ровно в нашем формате Candle = [ts,o,h,l,c,v]
 * (список идёт от новых к старым — разворачиваем в возрастающий, как mock).
 * Публичный лимит ~30 запросов в минуту на IP, поэтому ВСЕ вызовы идут через
 * net.netJson с TTL и интервалом; без кэша скан быстро упёрся бы в 429.
 *
 * API без ключа. Ключ владельца — от другого сервиса (FluxRPC), здесь не нужен.
 */
import { netJson } from "./net.ts";
import { getEnvNum } from "../config.ts";
import type { Candle, ChartTf } from "../../shared/types.ts";

const BASE = "https://api.geckoterminal.com/api/v2";
const NET = "solana";

/**
 * Сортировка списка пулов по объёму за сутки. Это ОСНОВНОЙ источник кандидатов:
 * стратегия ищет зрелые монеты в накоплении, а не только что созданные, поэтому
 * берём пулы с реальным оборотом, а не «trending/new».
 */
const SORT_VOLUME = "h24_volume_usd_desc";
/**
 * Сколько страниц топ-пулов листать по умолчанию. Публичный лимит GeckoTerminal
 * отдаёт не более ~10 страниц (страница 11 → 401), поэтому N зажат в 1..10.
 * Параметр вынесен в конфиг (GECKO_POOL_PAGES), одна страница = ~20 пулов.
 */
const DEFAULT_POOL_PAGES = 5;
const MAX_POOL_PAGES = 10;

/** Число страниц топ-пулов из окружения (GECKO_POOL_PAGES), зажатое в 1..10. */
function poolPages(): number {
  const n = getEnvNum("GECKO_POOL_PAGES") || DEFAULT_POOL_PAGES;
  return Math.max(1, Math.min(MAX_POOL_PAGES, Math.floor(n)));
}

/** Пауза между запросами к GeckoTerminal: ~30/мин — держим ровно 30/мин.
 *  GECKO_INTERVAL_MS переопределяется в тестах, чтобы не ждать реальных пауз. */
const GECKO_INTERVAL_MS = getEnvNum("GECKO_INTERVAL_MS") || 2000;
/** TTL списков пулов. */
const TTL_LISTS = 150_000;
/**
 * TTL кэша свечей, мс. График в приложении опрашивает /api/candles часто, и без
 * кэша каждый просмотр бил бы в GeckoTerminal заново (лимит ~30 запросов/мин).
 * Держим окно 30–60 с: повторные запросы по (пул=минт, ТФ) обслуживаются из
 * ОБЩЕГО кэша net.netJson, не выходя в сеть, но данные остаются свежими.
 */
const TTL_CANDLES = 45_000;
/** TTL выборки сделок (для числа мейкеров). */
const TTL_TRADES = 60_000;

interface GeckoTokenRef {
  data?: { id?: string; type?: string };
}

interface GeckoPool {
  attributes?: {
    address?: string;
    name?: string;
    base_token_price_usd?: string;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    pool_created_at?: string;
    reserve_in_usd?: string;
    volume_usd?: { h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number; buyers?: number; sellers?: number } };
  };
  relationships?: {
    base_token?: GeckoTokenRef;
    quote_token?: GeckoTokenRef;
    dex?: GeckoTokenRef;
  };
}

interface GeckoListResp {
  data?: GeckoPool[];
}

/** Пул GeckoTerminal, приведённый к нашим полям. */
export interface GeckoPoolInfo {
  pool: string;
  /** Адрес базового токена (mint). */
  mint: string;
  symbol: string;
  name: string;
  liq_usd: number;
  price_usd: number;
  vol_24h_usd: number;
  created_ts: number;
  /** Уникальные покупатели+продавцы за 24ч из данных пула (если API их дал). */
  traders_24h: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Из id вида "solana_<mint>" достаём mint. */
function mintFromId(id: string | undefined): string {
  if (!id) return "";
  const i = id.indexOf("_");
  return i >= 0 ? id.slice(i + 1) : id;
}

/** Имя пула обычно "SYMBOL / QUOTE" — берём базовый тикер. */
function symbolFromName(name: string): string {
  const t = (name.split("/")[0] ?? "").trim();
  return t || "?";
}

function toPoolInfo(p: GeckoPool): GeckoPoolInfo | null {
  const a = p.attributes ?? {};
  const pool = a.address ?? "";
  const mint = mintFromId(p.relationships?.base_token?.data?.id);
  if (!pool || !mint) return null;
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
  const t = a.transactions?.h24;
  return {
    pool,
    mint,
    symbol: symbolFromName(a.name ?? ""),
    name: a.name ?? symbolFromName(a.name ?? ""),
    liq_usd: num(a.reserve_in_usd),
    price_usd: num(a.base_token_price_usd),
    vol_24h_usd: num(a.volume_usd?.h24),
    created_ts: Number.isFinite(created) ? Math.floor(created / 1000) : 0,
    traders_24h: num(t?.buyers) + num(t?.sellers),
  };
}

async function pools(kind: "trending" | "new"): Promise<GeckoPoolInfo[]> {
  const url = `${BASE}/networks/${NET}/${kind}_pools?page=1`;
  const j = await netJson<GeckoListResp>(url, {
    ttlMs: TTL_LISTS,
    minIntervalMs: GECKO_INTERVAL_MS,
    cacheKey: `gecko:${kind}`,
  });
  const out: GeckoPoolInfo[] = [];
  for (const p of j.data ?? []) {
    const info = toPoolInfo(p);
    if (info) out.push(info);
  }
  return out;
}

export function trendingPools(): Promise<GeckoPoolInfo[]> {
  return pools("trending");
}
export function newPools(): Promise<GeckoPoolInfo[]> {
  return pools("new");
}

/**
 * ОСНОВНОЙ источник кандидатов: топ пулов сети по объёму за 24ч, постранично
 * (sort=h24_volume_usd_desc). Возраст (pool_created_at) и ликвидность
 * (reserve_in_usd) уже в ответе — предфильтр по ним НЕ стоит ни одного запроса.
 *
 * Листание прекращается на первой недоступной/пустой странице: за лимитом
 * страниц Gecko отдаёт 401, а при исчерпании частоты — 429 (его пауза-повтор
 * уже отработал в httpJson). Ошибка одной страницы НЕ роняет скан — уже
 * собранные пулы пойдут дальше.
 */
export async function topVolumePools(): Promise<GeckoPoolInfo[]> {
  const out: GeckoPoolInfo[] = [];
  const seen = new Set<string>();
  const pages = poolPages();
  for (let page = 1; page <= pages; page++) {
    const url = `${BASE}/networks/${NET}/pools?page=${page}&sort=${SORT_VOLUME}`;
    let j: GeckoListResp;
    try {
      j = await netJson<GeckoListResp>(url, {
        ttlMs: TTL_LISTS,
        minIntervalMs: GECKO_INTERVAL_MS,
        cacheKey: `gecko:pools:volume:${page}`,
      });
    } catch {
      break; // страница недоступна (401 за лимитом / 429 исчерпан) — не роняем скан
    }
    const list = j.data ?? [];
    if (!list.length) break; // пустая страница = конец списка
    for (const p of list) {
      const info = toPoolInfo(p);
      if (info && !seen.has(info.pool)) {
        seen.add(info.pool);
        out.push(info);
      }
    }
  }
  return out;
}

/** Все пулы токена (для выбора самого ликвидного). */
export async function poolsForToken(mint: string): Promise<GeckoPoolInfo[]> {
  const url = `${BASE}/networks/${NET}/tokens/${mint}/pools?page=1`;
  const j = await netJson<GeckoListResp>(url, {
    ttlMs: TTL_LISTS,
    minIntervalMs: GECKO_INTERVAL_MS,
    cacheKey: `gecko:tokens:${mint}`,
  });
  const out: GeckoPoolInfo[] = [];
  for (const p of j.data ?? []) {
    const info = toPoolInfo(p);
    if (info) out.push(info);
  }
  return out;
}

/** Самый ликвидный пул токена или null, если пулов нет. */
export async function bestPoolForToken(mint: string): Promise<GeckoPoolInfo | null> {
  const list = await poolsForToken(mint);
  let best: GeckoPoolInfo | null = null;
  for (const p of list) if (!best || p.liq_usd > best.liq_usd) best = p;
  return best;
}

const TF_MAP: Record<ChartTf, { timeframe: string; aggregate: number }> = {
  "1m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "1d": { timeframe: "day", aggregate: 1 },
};

interface OhlcvResp {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

/**
 * Свечи пула. Возврат — возрастающий по времени список Candle; пустой ответ
 * отдаём как пустой список, а не выдуманный ряд.
 */
export async function ohlcv(pool: string, tf: ChartTf, limit: number): Promise<Candle[]> {
  const m = TF_MAP[tf];
  const lim = Math.min(1000, Math.max(1, Math.floor(limit)));
  const url = `${BASE}/networks/${NET}/pools/${pool}/ohlcv/${m.timeframe}?aggregate=${m.aggregate}&limit=${lim}`;
  const j = await netJson<OhlcvResp>(url, {
    ttlMs: TTL_CANDLES,
    minIntervalMs: GECKO_INTERVAL_MS,
    cacheKey: `gecko:ohlcv:${pool}:${tf}:${lim}`,
  });
  const raw = j.data?.attributes?.ohlcv_list ?? [];
  const out: Candle[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const c: Candle = [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])];
    if (c.some((x) => !Number.isFinite(x))) continue;
    out.push(c);
  }
  out.sort((a, b) => a[0] - b[0]); // от старых к новым, как mock
  return out;
}

interface TradesResp {
  data?: { attributes?: { tx_from_address?: string } }[];
}

/**
 * Уникальные мейкеры по доступной странице сделок. GeckoTerminal отдаёт одну
 * страницу (≈300 сделок) — это ЧАСТИЧНАЯ выборка, а не все мейкеры за сутки.
 * Возвращаем и признак partial, чтобы проверка честно это показывала.
 */
export async function tradesMakers(pool: string): Promise<{ makers: number; partial: boolean }> {
  const url = `${BASE}/networks/${NET}/pools/${pool}/trades`;
  const j = await netJson<TradesResp>(url, {
    ttlMs: TTL_TRADES,
    minIntervalMs: GECKO_INTERVAL_MS,
    cacheKey: `gecko:trades:${pool}`,
  });
  const set = new Set<string>();
  for (const t of j.data ?? []) {
    const a = t.attributes?.tx_from_address;
    if (a) set.add(a);
  }
  return { makers: set.size, partial: true };
}
