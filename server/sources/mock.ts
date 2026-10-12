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
 * Цена — функция абсолютного «времени мира» t и момента пробуждения мира
 * (epoch): до epoch идёт историческое накопление (узкий боковик), после — у
 * ~30% токенов разгон до x2 за 3–10 дней, остальные падают или ходят боком.
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
}

export interface RugData {
  /** Доля сожжённой ликвидности, %, для слоя 1. */
  burned_liq: number;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
}

export interface HolderData {
  top10_holders_pct: number;
  holders: number;
  holders_growth_pct: number;
  makers_24h: number;
  avg_trade_usd: number;
}

export interface SocialData {
  sentiment: number;
  is_organic: boolean;
  summary: string;
  mentions: { ts: number; source: string; title: string; url: string; score: number }[];
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

const UNIVERSE: { symbol: string; name: string }[] = [
  { symbol: "BONK", name: "Bonk" },
  { symbol: "JUP", name: "Jupiter" },
  { symbol: "WIF", name: "dogwifhat" },
  { symbol: "PYTH", name: "Pyth Network" },
  { symbol: "JTO", name: "Jito" },
  { symbol: "RAY", name: "Raydium" },
  { symbol: "ORCA", name: "Orca" },
  { symbol: "TNSR", name: "Tensor" },
  { symbol: "DRIFT", name: "Drift Protocol" },
  { symbol: "MEW", name: "cat in a dogs world" },
  { symbol: "POPCAT", name: "Popcat" },
  { symbol: "BOME", name: "Book of Meme" },
  { symbol: "GLXY", name: "Galaxy Index" },
  { symbol: "NEBU", name: "Nebula Compute" },
  { symbol: "SFRG", name: "Solar Forge" },
  { symbol: "QNTM", name: "Quantum Vault" },
  { symbol: "HELIOS", name: "Helios Nodes" },
  { symbol: "VAPR", name: "Vapor DEX" },
  { symbol: "MIST", name: "Mistral AI Net" },
  { symbol: "KOBA", name: "Kobalt Finance" },
  { symbol: "ZEPH", name: "Zephyr Pay" },
  { symbol: "RIFT", name: "Rift Protocol" },
  { symbol: "AERO", name: "Aerodrome Sol" },
  { symbol: "LUMEN", name: "Lumen Storage" },
];

/** Первые CLEAN_COUNT — «чистые» токены: проходят все слои, чтобы скан всегда
 *  что-то находил. Из них ~30% вселенной восходящие (7 из 24). */
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
  vol: number;
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
    vol: range(r, 0.006, 0.03),
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
export function mockProfile(addr: string): { mode: Mode; pumpDays: number } {
  const p = profileFor(addr);
  return { mode: p.mode, pumpDays: p.pumpDays };
}

/* ─────────────── цена и свечи ─────────────── */

const DAY = 86400;

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/** Гладкий детерминированный шум из суммы синусов — без разрывов между свечами. */
function smoothNoise(seed: number, t: number): number {
  const r = mulberry32(seed);
  let v = 0;
  let amp = 1;
  let freq = 1 / (DAY * 1.7);
  let ph = r() * 6.283185;
  for (let k = 0; k < 5; k++) {
    v += amp * Math.sin(2 * Math.PI * freq * t + ph);
    amp *= 0.55;
    freq *= 2.3;
    ph += r() * 6.283185;
  }
  return v;
}

function roundPrice(v: number): number {
  if (v <= 0) return 0;
  return Number(v.toPrecision(6));
}

/** ЕДИНЫЙ генератор цены: и текущая цена, и свечи, и PnL — отсюда. */
export function mockPrice(addr: string, t: number, epoch: number): number {
  const p = profileFor(addr);
  let mult: number;
  if (t < epoch) {
    // История до пробуждения мира — накопление: узкий боковик вокруг базы.
    mult = 1 + 0.04 * Math.sin(t / (5 * DAY) + p.phase) + 0.01 * smoothNoise(p.seed, t);
  } else {
    const since = (t - epoch) / DAY;
    if (p.mode === "rising") {
      // Разгон 1x → ~2.2x (с запасом над x2: шум не должен помешать Free Riding).
      const x = (since - p.pumpStartDays) / p.pumpDays;
      mult = 1 + 1.2 * smoothstep(Math.min(1, Math.max(0, x)));
    } else if (p.mode === "falling") {
      mult = Math.exp(-p.decayPerDay * since);
    } else {
      mult = 1 + 0.07 * Math.sin((since * 2 * Math.PI) / p.cycleDays + p.phase);
    }
    mult *= 1 + 0.012 * smoothNoise(p.seed, t);
  }
  return roundPrice(Math.max(p.base * mult, p.base * 1e-4));
}

const TF_SECONDS: Record<ChartTf, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };

export function mockCandles(addr: string, tf: ChartTf, limit: number, now: number, epoch: number): Candle[] {
  const p = profileFor(addr);
  const iv = TF_SECONDS[tf];
  const lastOpen = Math.floor(now / iv) * iv;
  const out: Candle[] = [];
  for (let i = limit - 1; i >= 0; i--) {
    const ts = lastOpen - i * iv;
    const o = mockPrice(addr, ts, epoch);
    const c = mockPrice(addr, Math.min(ts + iv, now), epoch); // не заглядываем в будущее
    const wig = 0.0015 + p.vol * 0.4;
    const h = Math.max(o, c) * (1 + wig);
    const l = Math.min(o, c) * (1 - wig);
    const r = mulberry32(p.seed ^ (ts & 0xffffffff));
    const v = roundPrice(p.liqBase * (0.01 + 0.03 * r()));
    out.push([ts, o, h, l, c, v]);
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
    `${p.name} (${p.symbol}) — токен экосистемы Solana. Пул живёт около ${Math.round(m.age_days)} дн. ` +
    `при ликвидности ${liq} USDT; за последние две недели цена держится в коридоре шириной ~${corridor}%, ` +
    `что похоже на фазу накопления. Прирост уникальных холдеров — около ${p.holdersGrowth.toFixed(1)}% за неделю, ` +
    `число уникальных мейкеров за сутки — ${p.makers}. Основной нарратив — ${nar}. ` +
    `Основатель публично не раскрыт; комьюнити активное, без признаков накрутки объёма.`
  );
}

function socialSummary(p: Profile, m: MarketData): string {
  const tone = p.sentiment >= 6 ? "скорее позитивный" : "смешанный";
  return (
    `Обсуждения в соцсетях ${tone} (${p.sentiment.toFixed(1)}/10): проект ${p.symbol} чаще связывают с темой ` +
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
