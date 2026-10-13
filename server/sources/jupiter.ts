/**
 * sources/jupiter.ts — LIVE-источники Jupiter: цена токена и ПОЛНЫЙ список
 * верифицированных токенов сети — вселенная кандидатов.
 *
 * Два запроса, оба бесплатные и без ключа:
 *
 *  1) Цена — Jupiter Price API v2. Ключ опционален (без него жёстче лимиты).
 *
 *  2) Вселенная — GET https://lite-api.jup.ag/tokens/v2/tag?query=verified.
 *     Отдаёт ~3800 верифицированных токенов Solana с полями, которых НЕ дают
 *     DexScreener и GeckoTerminal (там почти сплошь только что созданные монеты,
 *     и в окно стратегии 30–180 дней не попадал никто): возраст токена
 *     (createdAt) и первого пула (firstPool.createdAt), ликвидность в USD,
 *     FDV/mcap, суточный объём (stats24h.buyVolume+sellVolume), концентрация
 *     топ-холдеров (audit.topHoldersPercentage, уже в процентах), права минта и
 *     фриза (audit.mintAuthorityDisabled/freezeAuthorityDisabled), органичность
 *     (organicScore 0..100 и организменный ярлык organicScoreLabel:
 *     low/medium/high), динамика холдеров и ликвидности за сутки
 *     (stats24h.holderChange/liquidityChange, в процентах). Это и есть ОСНОВНОЙ
 *     источник кандидатов — зрелые мид-капы, ради которых построена стратегия.
 *
 * Список кэшируется целиком (~12 мин): он большой, а состав меняется медленно.
 * Кэш и троттлинг — в net.netJson (общий на всех источников). Обработка ошибок:
 * нет ответа — честная пустота, источник НЕ выдумывает монеты.
 */
import { netJson } from "./net.ts";
import { httpJson, getEnv, getEnvNum } from "../config.ts";

interface PriceResp {
  data?: Record<string, { id?: string; price?: string } | null>;
}

/** Цена токена в USD. Ненайденный токен — 0 (не выдумываем значение). */
export async function jupiterPrice(mint: string): Promise<number> {
  const apiKey = getEnv("JUPITER_API_KEY");
  const headers: Record<string, string> = {};
  // Ключ опционален: без него Jupiter отвечает с более жёсткими лимитами.
  if (apiKey) headers["x-api-key"] = apiKey;
  const j = await httpJson<PriceResp>(`https://api.jup.ag/price/v2?ids=${mint}`, { headers });
  const entry = j.data?.[mint];
  return entry?.price ? Number(entry.price) : 0;
}

/* ─────────────── вселенная кандидатов ─────────────── */

const TOKENS_URL = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
/** Пауза между запросами к Jupiter. JUPITER_INTERVAL_MS переопределяется в тестах. */
const JUP_INTERVAL_MS = getEnvNum("JUPITER_INTERVAL_MS") || 300;
/** Кэш списка токенов: большой и медленно меняется — 12 минут. */
const TTL_UNIVERSE = 12 * 60_000;

interface JupiterStats {
  priceChange?: number | null;
  holderChange?: number | null;
  liquidityChange?: number | null;
  volumeChange?: number | null;
  buyVolume?: number | null;
  sellVolume?: number | null;
}

interface JupiterAudit {
  topHoldersPercentage?: number | null;
  devMints?: number | null;
  devBalancePercentage?: number | null;
  freezeAuthorityDisabled?: boolean | null;
  mintAuthorityDisabled?: boolean | null;
}

/** Сырая запись ответа Tokens v2 (читаем только нужные поля). */
interface JupiterTokenRaw {
  id?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  createdAt?: string | null;
  firstPool?: { id?: string; createdAt?: string | null } | null;
  liquidity?: number | null;
  fdv?: number | null;
  mcap?: number | null;
  usdPrice?: number | null;
  holderCount?: number | null;
  organicScore?: number | null;
  organicScoreLabel?: string | null;
  audit?: JupiterAudit | null;
  stats24h?: JupiterStats | null;
  tags?: string[] | null;
}

/** Токен вселенной, приведённый к нашим полям. null — «измерить нельзя». */
export interface JupiterToken {
  mint: string;
  symbol: string;
  name: string;
  liq_usd: number;
  fdv_usd: number;
  mcap_usd: number;
  usd_price: number;
  /** Возраст в днях: createdAt токена, иначе firstPool.createdAt. null — нет дат. */
  age_days: number | null;
  /** Оборот за сутки, USD (buyVolume + sellVolume). */
  volume_24h_usd: number;
  holder_count: number;
  /** Изменение числа холдеров за 24ч, %. */
  holders_change_24h_pct: number | null;
  /** Изменение ликвидности пула за 24ч, %. */
  liquidity_change_24h_pct: number | null;
  /** Изменение цены за 24ч, % (stats24h.priceChange). null — нет данных. */
  price_change_24h_pct: number | null;
  /** Теги Jupiter (verified, meme, community, rwa, stocks…). */
  tags: string[];
  /** Органичность 0..100 (0 у ярлыка «low»). */
  organic_score: number | null;
  /** Ярлык органичности Jupiter: low/medium/high. */
  organic_label: string | null;
  /** Доля топ-10 холдеров, % (уже в процентах, не доля). */
  top10_holders_pct: number | null;
  freeze_authority_disabled: boolean | null;
  mint_authority_disabled: boolean | null;
  dev_mints: number | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function optNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Возраст в днях по ISO-дате; null — даты нет/не разобрана (не выдумываем 0). */
function ageDaysFrom(iso: unknown, nowMs: number): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 86_400_000;
}

function toToken(raw: JupiterTokenRaw, nowMs: number): JupiterToken | null {
  const mint = raw.id;
  if (!mint) return null;
  // Возраст: createdAt токена, если его нет — дата первого пула.
  const age = ageDaysFrom(raw.createdAt, nowMs) ?? ageDaysFrom(raw.firstPool?.createdAt, nowMs);
  const s = raw.stats24h ?? {};
  const a = raw.audit ?? {};
  return {
    mint,
    symbol: raw.symbol ?? "?",
    name: raw.name ?? raw.symbol ?? "?",
    liq_usd: num(raw.liquidity),
    fdv_usd: num(raw.fdv),
    mcap_usd: num(raw.mcap),
    usd_price: num(raw.usdPrice),
    age_days: age,
    volume_24h_usd: num(s.buyVolume) + num(s.sellVolume),
    holder_count: num(raw.holderCount),
    holders_change_24h_pct: optNum(s.holderChange),
    liquidity_change_24h_pct: optNum(s.liquidityChange),
    price_change_24h_pct: optNum(s.priceChange),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [],
    organic_score: optNum(raw.organicScore),
    organic_label: typeof raw.organicScoreLabel === "string" && raw.organicScoreLabel ? raw.organicScoreLabel : null,
    // topHoldersPercentage приходит УЖЕ в процентах (0..100), не долей.
    top10_holders_pct: optNum(a.topHoldersPercentage),
    freeze_authority_disabled:
      typeof a.freezeAuthorityDisabled === "boolean" ? a.freezeAuthorityDisabled : null,
    mint_authority_disabled:
      typeof a.mintAuthorityDisabled === "boolean" ? a.mintAuthorityDisabled : null,
    dev_mints: optNum(a.devMints),
  };
}

/**
 * Вселенная верифицированных токенов Solana: карта mint → поля. Кэш 12 минут
 * (net.netJson, ключ jup:universe). Разбор — по нужным полям, мусор отбрасываем.
 * Ошибка источника НЕ глохнет здесь: вызывающий решает (скан не роняем выше).
 */
export async function jupiterUniverse(): Promise<Map<string, JupiterToken>> {
  const now = Date.now();
  const arr = await netJson<JupiterTokenRaw[]>(TOKENS_URL, {
    ttlMs: TTL_UNIVERSE,
    minIntervalMs: JUP_INTERVAL_MS,
    cacheKey: "jup:universe",
  });
  const map = new Map<string, JupiterToken>();
  for (const r of arr ?? []) {
    const t = toToken(r, now);
    if (t && !map.has(t.mint)) map.set(t.mint, t);
  }
  return map;
}

/** Поля токена из (кэшированной) вселенной Jupiter. Нет в списке — null. */
export async function jupiterToken(mint: string): Promise<JupiterToken | null> {
  const map = await jupiterUniverse();
  return map.get(mint) ?? null;
}
