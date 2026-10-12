/**
 * sources/mock.ts — детерминированная синтетика демо-контура (без сети и ключей).
 *
 * Здесь же объявлен единый интерфейс источника данных (DataSource) — эталон,
 * которому обязаны соответствовать live-источники (§2 плана: screener и demo
 * не знают, откуда данные).
 *
 * Ключевое требование: генератор цены ОДИН на всё. И текущая цена, и свечи
 * /api/candles, и PnL позиций считаются одной функцией mockPrice(addr, t) —
 * иначе линия графика разойдётся с состоянием позиции.
 *
 * ВАЖНО (честность демо): вся вселенная — ВЫДУМАННЫЕ токены (тикеры/имена ниже
 * не принадлежат реальным монетам), адреса — псевдо-base58 из сида, а не адреса
 * существующих токенов. Цена и свечи не «подставляются» под реальные тикеры.
 *
 * Цена — функция абсолютного «времени мира» t и момента пробуждения мира
 * (epoch): до epoch идёт историческое накопление (узкий боковик), после — у
 * ~30% токенов разгон до ~x2.9 за 3–10 дней, остальные падают или ходят боком.
 *
 * Доходности НЕ гладкие: поверх тренда лежит многооктавный фрактальный шум
 * (12 октав, лакунарность 2.5), который не даёт выраженной периодичности, плюс
 * редкие узкие «шипы» — отсюда длинные тени на свечах. OHLC получаются
 * под-выборкой единой функции цены внутри бара, поэтому тени настоящие, а
 * закрытие последней свечи совпадает с mockPrice.
 */
import type { Candle, ChartTf, DataMode } from "../../shared/types.ts";

/* ─────────────── интерфейс источника ─────────────── */

export interface SourceRef {
  token_addr: string;
  pair_addr: string;
  symbol: string;
  name: string;
}

/** Рыночные данные пула. Все суммы — USDT. */
export interface MarketData {
  price: number;
  liq_usd: number;
  mc_usd: number;
  age_days: number;
  volume_24h_usd: number;
  onchain_volume_usd: number;
  liquidity_flow_usd: number;
  drawdown_from_ath_pct: number;
  range_pct: number;
  tf_accum: string;
  svd: number;
  /** Только live: возраст пула измерить не удалось (нет даты создания) → проверка не пройдена, value=null. */
  age_na?: boolean;
  /** Только live: дневные свечи недоступны → коридор/просадка не измерены (value=null). */
  candles_na?: boolean;
  /** Только live (Jupiter): изменение ликвидности пула за 24ч, % (знак = направление). null — нет данных. */
  liquidity_change_24h_pct?: number | null;
  /**
   * Только live: источник ВОЗРАСТА токена для checks. «Jupiter» — основной
   * (источник вселенной: то же значение, что отобрал предфильтр); «DexScreener» —
   * резерв для свежего добора, которого нет в вселенной Jupiter. undefined — не live.
   */
  age_source?: "Jupiter" | "DexScreener";
  /** Только live: источник ЛИКВИДНОСТИ токена для checks (см. age_source). */
  liq_source?: "Jupiter" | "DexScreener";
}

export interface RugData {
  /** Доля сожжённой ликвидности, %, для слоя 1. */
  burned_liq: number;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  /** Только live: отчёт RugCheck пометил риск уровня danger. mock не ставит. */
  danger?: boolean;
  /** Только live (Jupiter audit): право фриза отозвано по данным Jupiter. null — нет данных. */
  jupiter_freeze_disabled?: boolean | null;
  /** Только live (Jupiter audit): право минта отозвано по данным Jupiter. null — нет данных. */
  jupiter_mint_disabled?: boolean | null;
}

export interface HolderData {
  top10_holders_pct: number;
  holders: number;
  holders_growth_pct: number;
  makers_24h: number;
  avg_trade_usd: number;
  /** Только live: долю топ-10 измерить не удалось (нет RPC) → проверка ok:false. */
  top10_na?: boolean;
  /** Только live: прирост холдеров недоступен → проверка не блокирует. */
  holders_growth_na?: boolean;
  /** Только live: мейкеры оценены по частичной выборке сделок. */
  makers_partial?: boolean;
  /**
   * Только live: замер мейкеров НЕ состоялся (GeckoTerminal 429/недоступен, пул
   * не найден). Отличается от ЧЕСТНОГО нуля мейкеров, полученного из данных:
   * при makers_na проверка wash_filter не блокирует (value=null), честный ноль —
   * блокирует как раньше.
   */
  makers_na?: boolean;
  /** Только live: причина недоступности замера мейкеров (для подписи в checks). */
  makers_note?: string;
  /** Только live (Jupiter): органичность 0..100 (0 у ярлыка «low»). null — нет данных. */
  organic_score?: number | null;
  /** Только live (Jupiter): ярлык органичности low/medium/high. null — нет данных. */
  organic_label?: string | null;
  /**
   * Только live: ОТКУДА взята доля топ-10 (порог и подпись в checks зависят от
   * метода). «rpc» — FluxRPC, счета пулов исключены (сравнимо с top10_max);
   * «jupiter» — audit.topHoldersPercentage, ВКЛЮЧАЯ счёт пула (верхняя оценка,
   * с top10_max несопоставима, сигнал по ней не блокируем). undefined — mock.
   */
  top10_source?: "rpc" | "jupiter" | "mock";
}

export interface SocialData {
  sentiment: number;
  is_organic: boolean;
  summary: string;
  mentions: { ts: number; source: string; title: string; url: string; score: number }[];
  /** Только live: LLM недоступен (нет ключа) → слой не блокирует и не создаёт сигнал. */
  llm_unavailable?: boolean;
  /** Только live (медиаслой): сколько упоминаний за 24ч; null — данных нет. */
  media_mentions_24h?: number | null;
  /** Только live (медиаслой): чем закончился сбор (для подписи чека слоя 5). */
  media_note?: string;
  /** Только live (медиаслой): откуда данные — кэш/актор/нет. */
  media_source?: "cache" | "apify" | "none";
  /** Только live (медиаслой): чем считалась тональность — моделью или словарём. */
  media_method?: "gemini" | "lexicon";
}

export interface DataSource {
  mode: DataMode;
  listCandidates(): Promise<SourceRef[]>;
  market(ref: SourceRef, now: number): Promise<MarketData>;
  price(tokenAddr: string, now: number): Promise<number>;
  rug(ref: SourceRef): Promise<RugData>;
  holders(ref: SourceRef, now: number): Promise<HolderData>;
  candles(ref: SourceRef, tf: ChartTf, limit: number, now: number): Promise<Candle[]>;
  overview(ref: SourceRef, market: MarketData): Promise<string>;
  social(ref: SourceRef, market: MarketData, now: number): Promise<SocialData>;
}

/* ─────────────── детерминированный «рандом» ─────────────── */

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function range(r: () => number, a: number, b: number): number {
  return a + (b - a) * r();
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Псевдо-Solana-адрес: детерминированная base58-строка (для демо, не настоящий ключ). */
function pseudoAddr(seedStr: string, len = 44): string {
  const r = mulberry32(fnv1a(seedStr));
  let s = "";
  for (let i = 0; i < len; i++) s += B58[Math.floor(r() * B58.length) % B58.length];
  return s;
}

/* ─────────────── вселенная токенов ─────────────── */
/**
 * ВЫДУМАННЫЕ токены: совпадения с реальными монетами/тикерами случайны и не
 * предполагались. Реальные символы (BONK, JUP, JITO, PYTH и т.п.) намеренно не
 * используются — демо не должно выдавать синтетику за настоящий рынок.
 */
const UNIVERSE: { symbol: string; name: string }[] = [
  { symbol: "ZEPHYR", name: "Zephyr Pay" },
  { symbol: "KRYPT", name: "Krypton Labs" },
  { symbol: "VOLNA", name: "Volna Wave" },
  { symbol: "ORBITA", name: "Orbita Network" },
  { symbol: "NIMBUS", name: "Nimbus Compute" },
  { symbol: "HALCYON", name: "Halcyon Grid" },
  { symbol: "SFRG", name: "Solar Forge" },
  { symbol: "QNTM", name: "Quantum Vault" },
  { symbol: "GLXY", name: "Galaxy Index" },
  { symbol: "MIST", name: "Mistral AI Net" },
  { symbol: "KOBA", name: "Kobalt Finance" },
  { symbol: "RIFT", name: "Rift Protocol" },
  { symbol: "VAPR", name: "Vapor DEX" },
  { symbol: "NEBU", name: "Nebula Compute" },
  { symbol: "HELIOS", name: "Helios Nodes" },
  { symbol: "LUMEN", name: "Lumen Storage" },
  { symbol: "ZOLAR", name: "Zolar Energy" },
  { symbol: "MORIA", name: "Moria Vault" },
  { symbol: "TUNDRA", name: "Tundra Finance" },
  { symbol: "QUARK", name: "Quark Layer" },
  { symbol: "VERDANT", name: "Verdant Growth" },
  { symbol: "AURUM", name: "Aurum Reserve" },
  { symbol: "PELAGO", name: "Pelago DEX" },
  { symbol: "CINERA", name: "Cinera Media" },
];

/** Первые CLEAN_COUNT — «чистые» токены: проходят все слои, чтобы скан всегда
 *  что-то находил. Из них все восходящие (7 из 24). */
export const CLEAN_COUNT = 7;
/** Индекс токена, у которого после входа подсасывается ликвидность (для liq-drain).
 *  Выбран из первых MAX_PER_SCAN «чистых», иначе сигнал по нему не попадёт в ленту. */
export const DRAIN_INDEX = 4;

type Mode = "rising" | "falling" | "sideways";

interface Profile {
  seed: number;
  symbol: string;
  name: string;
  mode: Mode;
  base: number;
  /** Базовая лог-амплитуда многооктавного шума (доля цены). */
  noiseAmp: number;
  pumpDays: number;
  /** Через сколько дней после старта мира начинается разгон (для «свежих» сканов). */
  pumpStartDays: number;
  decayPerDay: number;
  cycleDays: number;
  phase: number;
  liqBase: number;
  liqDecayPerDay: number;
  top10: number;
  holders: number;
  holdersGrowth: number;
  makers: number;
  avgTrade: number;
  drawdown: number;
  burnedLiq: number;
  mintRevoked: boolean;
  freezeRevoked: boolean;
  ageDays: number;
  sentiment: number;
  organic: boolean;
  supply: number;
}

const profiles = new Map<string, Profile>();

function addrFor(i: number, symbol: string): string {
  return pseudoAddr(`token:${i}:${symbol}`);
}

export function refFor(i: number): SourceRef {
  const t = UNIVERSE[i];
  return {
    token_addr: addrFor(i, t.symbol),
    pair_addr: pseudoAddr(`pair:${i}:${t.symbol}`),
    symbol: t.symbol,
    name: t.name,
  };
}

/** Список символов вселенной (для тестов честности данных). */
export function mockSymbols(): string[] {
  return UNIVERSE.map((t) => t.symbol);
}

function buildProfile(i: number): Profile {
  const t = UNIVERSE[i];
  const seed = fnv1a(`${t.symbol}#${i}`);
  const r = mulberry32(seed);
  const clean = i < CLEAN_COUNT;
  const mode: Mode = clean ? "rising" : r() < 0.32 ? "rising" : r() < 0.6 ? "falling" : "sideways";

  return {
    seed,
    symbol: t.symbol,
    name: t.name,
    mode,
    base: clean ? range(r, 0.0005, 3) : 10 ** range(r, -4, 0.6),
    // Амплитуда шума: у «чистых» спокойнее, у мусорных — шире разброс.
    noiseAmp: clean ? range(r, 0.05, 0.1) : range(r, 0.06, 0.24),
    pumpDays: range(r, 3, 10),
    // Разгон растянут по времени: первый «чистый» токен стартует сразу, остальные —
    // позже. Так повторные сканы ещё долго находят кого-то в фазе накопления.
    pumpStartDays: clean ? (i === 0 ? 0 : i * 15) : range(r, 0, 120),
    decayPerDay: range(r, 0.02, 0.09),
    cycleDays: range(r, 20, 60),
    phase: range(r, 0, 6.283),
    liqBase: clean ? range(r, 45000, 120000) : 10 ** range(r, 3.9, 5.7),
    // Утечка ликвидности: у drain-токена заметная (видна за 7 дней), у падающих —
    // умеренная, у остальных пул стоит на месте.
    liqDecayPerDay: i === DRAIN_INDEX ? range(r, 0.09, 0.13) : mode === "falling" ? range(r, 0.05, 0.11) : 0,
    top10: clean ? range(r, 6, 12) : range(r, 4, 45),
    holders: Math.round(clean ? range(r, 900, 3200) : 10 ** range(r, 2.7, 4.3)),
    holdersGrowth: clean ? range(r, 4, 10) : range(r, -6, 14),
    makers: Math.round(clean ? range(r, 150, 380) : 10 ** range(r, 1.6, 2.8)),
    avgTrade: clean ? range(r, 300, 900) : range(r, 40, 1500),
    drawdown: clean ? range(r, 72, 88) : mode === "falling" ? range(r, 75, 93) : range(r, 65, 88),
    burnedLiq: clean ? 100 : r() < 0.75 ? 100 : range(r, 82, 99),
    mintRevoked: clean ? true : r() < 0.85,
    freezeRevoked: clean ? true : r() < 0.8,
    ageDays: clean ? range(r, 60, 150) : 10 ** range(r, 0.9, 2.6),
    sentiment: clean ? range(r, 6.2, 9.2) : range(r, 1.5, 8),
    organic: clean ? true : r() < 0.55,
    supply: 10 ** range(r, 7, 10),
  };
}

function profileFor(addr: string): Profile {
  const hit = profiles.get(addr);
  if (hit) return hit;
  let p: Profile | null = null;
  for (let i = 0; i < UNIVERSE.length; i++) {
    if (addrFor(i, UNIVERSE[i].symbol) === addr) {
      p = buildProfile(i);
      break;
    }
  }
  // Незнакомый адрес (например, из live-сигнала при переключении режима) —
  // строим профиль по хэшу самого адреса, лишь бы не падать.
  if (!p) {
    const idx = fnv1a(addr) % UNIVERSE.length;
    p = { ...buildProfile(idx), seed: fnv1a(addr) };
  }
  profiles.set(addr, p);
  return p;
}

/** Для тестов/отладки: режим и базовые параметры токена. */
export function mockProfile(addr: string): { mode: Mode; pumpDays: number; pumpStartDays: number } {
  const p = profileFor(addr);
  return { mode: p.mode, pumpDays: p.pumpDays, pumpStartDays: p.pumpStartDays };
}

/* ─────────────── многооктавный детерминированный шум ─────────────── */

const DAY = 86400;

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Хэш целочисленного узла решётки → [-1, 1). Детерминирован во всех средах. */
function lattice(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i | 0, 0x27d4eb2d)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

/** Хэш узла решётки → [0, 1). */
function hash01(seed: number, i: number): number {
  return (lattice(seed, i) + 1) / 2;
}

/** Гладкий value-noise (квинтическая интерполяция между узлами решётки). */
function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = lattice(seed, i);
  const b = lattice(seed, i + 1);
  return a + (b - a) * u;
}

const FBM_OCT = 12;
const FBM_LAC = 2.5;
const FBM_GAIN = 0.76;
/** Нормировка суммы октав к единичному масштабу (подобрана замером). */
const FBM_NORM = 1 / 1.25;

/** Фрактальный шум: 12 октав value-noise — крупнейшая ~сутки, мельчайшая ~4 c.
 *  Многооктавность даёт негладкие доходности без выраженной периодичности. */
function fbm(seed: number, t: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1 / DAY;
  for (let k = 0; k < FBM_OCT; k++) {
    sum += amp * valueNoise((seed + Math.imul(k + 1, 0x9e3779b1)) | 0, t * freq);
    amp *= FBM_GAIN;
    freq *= FBM_LAC;
  }
  return sum * FBM_NORM;
}

const SPIKE_CELL = 900;

/** Редкие узкие «шипы»: ~1 на 1–2 часа, ширина 1–4 минуты — длинные тени свечей. */
function spikes(seed: number, t: number): number {
  let v = 0;
  const c = Math.floor(t / SPIKE_CELL);
  for (let k = c - 1; k <= c + 1; k++) {
    if (hash01((seed ^ 0x51a7c0de) | 0, k) < 0.8) continue; // ~20% ячеек дают шип
    const center = (k + 0.15 + 0.7 * hash01((seed ^ 0x2f0e1c4a) | 0, k)) * SPIKE_CELL;
    const width = 45 + 260 * hash01((seed ^ 0x7be3a911) | 0, k);
    const dir = hash01((seed ^ 0x1b873593) | 0, k) < 0.5 ? -1 : 1;
    const amp = dir * (0.006 + 0.022 * hash01((seed ^ 0x6d2b79f5) | 0, k));
    const d = (t - center) / width;
    if (Math.abs(d) < 3.5) v += amp * Math.exp(-d * d);
  }
  return v;
}

/* ─────────────── цена ─────────────── */

/** Амплитуда шума по фазам: накопление — спокойно, импульс — волатильно, падение затухает. */
function noiseAmp(p: Profile, t: number, epoch: number): number {
  if (t < epoch) return p.noiseAmp * 0.55;
  const since = (t - epoch) / DAY;
  if (p.mode === "rising") {
    const x = (since - p.pumpStartDays) / p.pumpDays;
    if (x <= 0) return p.noiseAmp * 0.55;
    if (x <= 1) return p.noiseAmp * (0.55 + 0.5 * Math.sin(Math.PI * x));
    return p.noiseAmp * (0.55 + 0.3 * Math.exp(-(x - 1)));
  }
  if (p.mode === "falling") return p.noiseAmp * (0.9 * Math.exp(-0.12 * since) + 0.45);
  return p.noiseAmp * 0.6;
}

const PUMP_GAIN = 1.9;

/** Множитель тренда относительно базы. До epoch тренд плоский (накопление). */
function trendMult(p: Profile, t: number, epoch: number): number {
  if (t < epoch) return 1;
  const since = (t - epoch) / DAY;
  if (p.mode === "rising") {
    const x = clamp01((since - p.pumpStartDays) / p.pumpDays);
    return 1 + PUMP_GAIN * smoothstep(x);
  }
  if (p.mode === "falling") return Math.exp(-p.decayPerDay * since);
  // Боковик — медленная апериодичная волна, а не синус: без явной периодичности.
  return 1 + 0.07 * valueNoise((p.seed ^ 0x2545f491) | 0, t / (p.cycleDays * DAY) + p.phase);
}

function roundPrice(v: number): number {
  if (v <= 0) return 0;
  return Number(v.toPrecision(6));
}

/** Внутренняя цена без округления: ядро mockPrice (mockPrice = roundPrice(rawPrice)).
 *  И свечи, и текущая цена, и PnL берутся из этого ОДНОГО генератора; отдельная
 *  функция нужна лишь чтобы округление не съедало тени свечей. */
function rawPrice(addr: string, t: number, epoch: number): number {
  const p = profileFor(addr);
  const logNoise = noiseAmp(p, t, epoch) * fbm(p.seed, t) + spikes(p.seed, t);
  return p.base * trendMult(p, t, epoch) * Math.exp(logNoise);
}

/** ЕДИНЫЙ генератор цены: и текущая цена, и свечи, и PnL — отсюда. */
export function mockPrice(addr: string, t: number, epoch: number): number {
  return roundPrice(rawPrice(addr, t, epoch));
}

const TF_SECONDS: Record<ChartTf, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };

/** Под-выборок внутри бара — из них берём максимум/минимум (настоящие тени). */
const CANDLE_SUBSAMPLES = 32;

export function mockCandles(addr: string, tf: ChartTf, limit: number, now: number, epoch: number): Candle[] {
  const p = profileFor(addr);
  const iv = TF_SECONDS[tf];
  const lastOpen = Math.floor(now / iv) * iv;
  const out: Candle[] = [];
  for (let i = limit - 1; i >= 0; i--) {
    const ts = lastOpen - i * iv;
    const end = Math.min(ts + iv, now); // не заглядываем в будущее
    const oRaw = rawPrice(addr, ts, epoch);
    const cRaw = rawPrice(addr, end, epoch);
    let hi = Math.max(oRaw, cRaw);
    let lo = Math.min(oRaw, cRaw);
    // Внутри бара идём по той же функции цены: экстремумы дают хай/лоу (тени).
    for (let j = 1; j <= CANDLE_SUBSAMPLES; j++) {
      const tt = ts + (iv * j) / (CANDLE_SUBSAMPLES + 1);
      if (tt > now) break;
      const s = rawPrice(addr, tt, epoch);
      if (s > hi) hi = s;
      if (s < lo) lo = s;
    }
    // Объём связан с движением бара: всплески на импульсах, спад в боковике,
    // плюс детерминированный разброс — объём не константа.
    const move = Math.abs(cRaw - oRaw) / oRaw;
    const jitter = 0.6 + 0.9 * hash01((p.seed ^ 0x7f4a7c15) | 0, ts);
    const vol = roundPrice(p.liqBase * (0.003 + 22 * move) * jitter);
    out.push([ts, roundPrice(oRaw), roundPrice(hi), roundPrice(lo), roundPrice(cRaw), vol]);
  }
  return out;
}

function rangePctOverDays(addr: string, now: number, epoch: number, days: number): number {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= days; i++) {
    const v = mockPrice(addr, now - i * DAY, epoch);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mid = (max + min) / 2;
  return mid > 0 ? ((max - min) / mid) * 100 : 0;
}

/* ─────────────── сборка источника ─────────────── */

function marketNow(addr: string, now: number, epoch: number, rangeDays: number): MarketData {
  const p = profileFor(addr);
  const since = Math.max(0, (now - epoch) / DAY);
  const liqFactor = p.liqDecayPerDay > 0 ? Math.exp(-p.liqDecayPerDay * since) : 1;
  const liq = Math.round(p.liqBase * liqFactor);
  const liqPrev = Math.round(
    p.liqBase * (p.liqDecayPerDay > 0 ? Math.exp(-p.liqDecayPerDay * Math.max(0, since - 1)) : 1),
  );
  const price = mockPrice(addr, now, epoch);
  const r = mulberry32(p.seed ^ 0x9e3779b9);
  const volume24 = Math.round(liq * (0.4 + 1.4 * r()));
  const tfPool = ["1D", "4H", "1H"];
  return {
    price,
    liq_usd: liq,
    mc_usd: Math.round(price * p.supply),
    age_days: p.ageDays,
    volume_24h_usd: volume24,
    onchain_volume_usd: volume24,
    liquidity_flow_usd: liq - liqPrev,
    drawdown_from_ath_pct: p.drawdown,
    range_pct: rangePctOverDays(addr, now, epoch, rangeDays),
    tf_accum: tfPool[Math.floor(r() * tfPool.length) % tfPool.length],
    svd: Math.round(range(r, 45, 92)),
  };
}

function overviewText(p: Profile, m: MarketData): string {
  const corridor = m.range_pct.toFixed(1);
  const liq = Math.round(m.liq_usd).toLocaleString("ru-RU");
  const nar = p.mode === "rising" ? "инфраструктура и DeFi" : "мем-сектор и розничные потоки";
  return (
    `${p.name} (${p.symbol}) — выдуманный токен демо-контура (не реальный проект). Пул живёт около ${Math.round(m.age_days)} дн. ` +
    `при ликвидности ${liq} USDT; за последние две недели цена держится в коридоре шириной ~${corridor}%, ` +
    `что похоже на фазу накопления. Прирост уникальных холдеров — около ${p.holdersGrowth.toFixed(1)}% за неделю, ` +
    `число уникальных мейкеров за сутки — ${p.makers}. Основной нарратив — ${nar}. ` +
    `Основатель публично не раскрыт; комьюнити активное, без признаков накрутки объёма.`
  );
}

function socialSummary(p: Profile, m: MarketData): string {
  const tone = p.sentiment >= 6 ? "скорее позитивный" : "смешанный";
  return (
    `Обсуждения в соцсетях ${tone} (${p.sentiment.toFixed(1)}/10): выдуманный проект ${p.symbol} чаще связывают с темой ` +
    `«${p.mode === "rising" ? "накопление перед импульсом" : "отскок после коррекции"}». ` +
    `Признаков скоординированной накрутки не видно, доля топ-10 холдеров — ${p.top10.toFixed(1)}%. ` +
    `Он-чейн объём за сутки — ${Math.round(m.onchain_volume_usd).toLocaleString("ru-RU")} USDT.`
  );
}

export function createMockSource(epoch: number): DataSource {
  const rngFor = (addr: string) => mulberry32(fnv1a(addr) ^ 0x51ed270b);
  return {
    mode: "mock",
    async listCandidates() {
      return UNIVERSE.map((_, i) => refFor(i));
    },
    async market(ref, now) {
      return marketNow(ref.token_addr, now, epoch, 14);
    },
    async price(addr, now) {
      return mockPrice(addr, now, epoch);
    },
    async rug(ref) {
      const p = profileFor(ref.token_addr);
      return {
        burned_liq: Math.round(p.burnedLiq),
        mint_authority_revoked: p.mintRevoked,
        freeze_authority_revoked: p.freezeRevoked,
      };
    },
    async holders(ref) {
      const p = profileFor(ref.token_addr);
      return {
        top10_holders_pct: Number(p.top10.toFixed(2)),
        holders: p.holders,
        holders_growth_pct: Number(p.holdersGrowth.toFixed(2)),
        makers_24h: p.makers,
        avg_trade_usd: Number(p.avgTrade.toFixed(2)),
      };
    },
    async candles(ref, tf, limit, now) {
      return mockCandles(ref.token_addr, tf, limit, now, epoch);
    },
    async overview(ref, market) {
      return overviewText(profileFor(ref.token_addr), market);
    },
    async social(ref, market, now) {
      const p = profileFor(ref.token_addr);
      const r = rngFor(ref.token_addr);
      const sources = ["X", "Telegram", "Reddit"];
      const mentions = [];
      const n = 3 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        mentions.push({
          // Упоминания идут «назад» от виртуального сейчас — без заглядывания в будущее.
          ts: now - (i + 1) * 3600,
          source: sources[i % sources.length],
          title: `${p.symbol}: ${i % 2 ? "растёт обсуждение" : "накопление продолжается"}`,
          url: `https://example.invalid/search?q=${p.symbol}`,
          score: Math.round(Math.min(10, Math.max(0, p.sentiment + (r() - 0.5) * 3))),
        });
      }
      return {
        sentiment: Number(p.sentiment.toFixed(1)),
        is_organic: p.organic,
        summary: socialSummary(p, market),
        mentions,
      };
    },
  };
}

/** Экспорт для тестов: ссылка на «чистый» токен по тикеру. */
export function tokenRefBySymbol(symbol: string): SourceRef | null {
  const i = UNIVERSE.findIndex((t) => t.symbol === symbol);
  return i >= 0 ? refFor(i) : null;
}
