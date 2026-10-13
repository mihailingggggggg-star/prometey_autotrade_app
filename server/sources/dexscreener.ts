/**
 * sources/dexscreener.ts — LIVE-источник: кандидаты, пулы, цена, ликвидность,
 * возраст (DexScreener, без ключа) + слой накопления по дневным свечам GeckoTerminal.
 *
 * Отбор кандидатов: ОСНОВНОЙ источник — ПОЛНЫЙ список верифицированных токенов
 * Jupiter (jupiter.jupiterUniverse): GeckoTerminal «топ пулов по объёму» и
 * DexScreener отдают почти только что созданные токены, поэтому в окно стратегии
 * (30–180 дн) не попадал никто. Jupiter сразу даёт возраст токена (createdAt /
 * firstPool.createdAt), ликвидность, FDV и суточный объём — поэтому предфильтр по
 * настройкам (age_min..age_max, liq_min..liq_max), потолок FDV и положительный
 * объём режут вселенную ДО любых дорогих вызовов. Лишь по прошедшим идёт ОДИН
 * батч DexScreener по лучшей Solana-паре — эта пара (bestPairCache) уйдёт в
 * market()/candles() как адрес пула, цена, объём и источник свечей.
 * «Свежие» источники (token-profiles + token-boosts DexScreener, trending/new
 * GeckoTerminal) остаются ДОПОЛНИТЕЛЬНЫМИ с малым весом (не более FRESH_CANDIDATES
 * кандидатов); топ пулов GeckoTerminal — резервный добор при недоборе основного.
 *
 * ОДИН ИСТОЧНИК НА ПРИЗНАК (чтобы слой 3 не мерил признак по другому источнику,
 * чем предфильтр):
 *  • возраст и ликвидность ТОКЕНА — Jupiter (createdAt/firstPool.createdAt,
 *    liquidity): предфильтр и слой 3 читают РОВНО одно значение (market_age/liq);
 *  • цена, свечи, адрес пула, объём — DexScreener (его пара = пул Gecko).
 * Если минта нет в вселенной Jupiter (свежий добор) — возраст/ликвидность честно
 * падают на пару DexScreener, а checks помечают источник (age_source/liq_source).
 *
 * Коридор накопления (range_pct) и падение от максимума (drawdown_from_ath_pct) —
 * из ДНЕВНЫХ свечей выбранного пула (окно = настройка range_days), а не из
 * выдуманных чисел. Свечи для /api/candles тоже оттуда. Слив ликвидности / рост
 * холдеров / органичность — из Jupiter (market/holders), см. screener.
 */
import { netJson } from "./net.ts";
import { metaGet, metaSet } from "../db.ts";
import { ApiError } from "../config.ts";
import { ohlcv, bestPoolForToken, newPools, trendingPools, topVolumePools, type GeckoPoolInfo } from "./geckoterminal.ts";
import { jupiterUniverse, jupiterToken, type JupiterToken } from "./jupiter.ts";
import type { Candle, ChartTf, ScreenerSettings } from "../../shared/types.ts";
import type { SourceRef, MarketData } from "./mock.ts";

const BASE = "https://api.dexscreener.com";
const DEX_INTERVAL_MS = 150;
const TTL_PAIRS = 150_000;
/**
 * Потолок кандидатов, которых пускаем в воронку слоёв (RugCheck/свечи/RPC).
 * Расширен с 15 до 40: на прежнем потолке до слоёв доходило ~13 монет — мало,
 * чтобы проверять стратегию. Дорогие проверки (владельцы по RPC, свечи)
 * выполняются НЕ для всех, а только для прошедших слои 1 и 3 (см. screener),
 * поэтому широкий список не взрывает ни бюджет запросов, ни время скана.
 */
export const MAX_CANDIDATES = 40;
/** Из них малая доля — под «свежие» источники (profiles/boosts/trending/new). */
const FRESH_CANDIDATES = 3;
/** Сколько прошедших предфильтр Jupiter-минтов гоняем в батч DexScreener (30 адресов на запрос). */
const JUPITER_MINT_LIMIT = 60;
const BATCH = 30;
/** История дневных свечей для оценки ATH/коридора. */
const DAY_LIMIT = 180;
/** Часов в сутках — для склейки часовых свечей в дневные (fallback слоя 4). */
const HOURS_PER_DAY = 24;

/* Потолок капитализации ($50M) снят решением владельца 13.10.2026: он отсекал
   всего 8 монет из 1966, то есть работал как формальность. Размер пула воронка
   и так видит: у крупных монет коридор не сжимается, и их режет слой накопления
   по существу, а не отсечка заранее. */

/** Часть схемы ответа DexScreener, которую мы реально читаем (документация API). */
export interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // мс
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
}

interface ProfileItem {
  chainId?: string;
  tokenAddress?: string;
}
interface ProfilesResp extends Array<ProfileItem> {}
interface TokensResp {
  pairs?: DexPair[];
}

/* ─────────────── кэш «лучший пул на токен» ─────────────── */

interface BestEntry {
  exp: number;
  pair: DexPair;
}
const bestPairCache = new Map<string, BestEntry>();

/** Окно коридора накопления в днях. Скринер выставляет из настроек (range_days). */
let rangeDays = 14;
export function setRangeDays(n: number): void {
  if (Number.isFinite(n) && n > 0) rangeDays = Math.round(n);
}
export function getRangeDays(): number {
  return rangeDays;
}

function rememberBest(pairs: DexPair[]): void {
  const exp = Date.now() + TTL_PAIRS;
  for (const p of pairs) {
    if (p.chainId !== "solana") continue;
    const addr = p.baseToken?.address;
    if (!addr) continue;
    const cur = bestPairCache.get(addr);
    if (!cur || cur.exp < Date.now() || (p.liquidity?.usd ?? 0) > (cur.pair.liquidity?.usd ?? 0)) {
      bestPairCache.set(addr, { exp, pair: p });
    }
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Лучшая пара токена из кэша (её же вернёт getBestPair). Так возраст и
 * ликвидность кандидата считаются ровно по той паре, что уйдёт в market() и
 * candles() — без повторного запроса и без расхождения.
 */
function bestCachedPair(addr: string): DexPair | null {
  const hit = bestPairCache.get(addr);
  return hit && hit.exp > Date.now() ? hit.pair : null;
}

/* ─────────────── ротация выборки кандидатов ─────────────── */

/**
 * Ключ курсора ротации в таблице meta (БД): с какого индекса начинать следующую
 * порцию. Хранение в БД, а не в памяти, — чтобы курсор пережил перезапуск службы.
 */
const CURSOR_KEY = "scan_candidate_cursor";

/** Позиция последней выборки (1-based, включительно) — для лога планового скана. */
let lastRotation: { from: number; to: number; total: number } | null = null;

/** Прочитать курсор ротации; мусор/вне диапазона → 0 (начнём список сначала). */
function readCursor(total: number): number {
  const raw = metaGet(CURSOR_KEY);
  const n = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n) % total;
}

/** Записать курсор ротации (лежит в meta — переживает перезапуск службы). */
function writeCursor(v: number): void {
  metaSet(CURSOR_KEY, String(v));
}

/** Взять `count` подряд идущих элементов начиная с `start`, по кругу. */
function rotate<T>(arr: T[], start: number, count: number): T[] {
  if (arr.length === 0 || count <= 0) return [];
  const n = Math.min(count, arr.length);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[(start + i) % arr.length]);
  return out;
}

/** Какая порция кандидатов ушла в последний listCandidates (для лога). */
export function getLastCandidateRotation(): { from: number; to: number; total: number } | null {
  return lastRotation;
}

/* ─────────────── предфильтр кандидатов ─────────────── */

interface Prefilter {
  ageMin: number;
  ageMax: number;
  liqMin: number;
  liqMax: number;
}

/** Настройки отбора. Скринер выставляет их из настроек ДО listCandidates(). */
let prefilter: Prefilter | null = null;

/** Предфильтр кандидатов по возрасту/ликвидности. Ставится из runScan. */
export function setCandidateFilter(s: ScreenerSettings): void {
  prefilter = { ageMin: s.age_min, ageMax: s.age_max, liqMin: s.liq_min, liqMax: s.liq_max };
}

/**
 * Дешёвая отсечка по возрасту и ликвидности — выполняется ДО обращения к
 * дорогим источникам (RugCheck, RPC, свечи). Нет настроек — пропускаем всех.
 */
function passPrefilter(ageDays: number, liqUsd: number): boolean {
  if (!prefilter) return true;
  return (
    ageDays >= prefilter.ageMin &&
    ageDays <= prefilter.ageMax &&
    liqUsd >= prefilter.liqMin &&
    // Потолок ликвидности снят по решению владельца (13.10.2026): он отсекал
    // монеты формально, по размеру пула, а не по существу. Значение 0 в
    // настройках означает «без потолка».
    (prefilter.liqMax <= 0 || liqUsd <= prefilter.liqMax)
  );
}

/**
 * Дешёвый предфильтр кандидата по полям Jupiter — БЕЗ сети (данные уже в
 * кэшированной вселенной). Отсекает всё, что заведомо не пройдёт слой 3:
 * неизвестный возраст (не выдумываем 0), возраст/ликвидность вне настроек,
 * FDV выше потолка (гиганты) и нулевой суточный оборот (мёртвые монеты).
 */
/**
 * Теги Jupiter, которые выводят токен из нашей вселенной целиком.
 *
 * Живой скан показал, почему это необходимо: из 3965 «проверенных» токенов
 * Jupiter 1999 — токенизированные акции и RWA (теги rwa/stocks/xstocks), и 56 из
 * них попадали в наше окно ликвидности. Это бумаги на акции, выпущенные
 * эмитентом: ликвидность пула у них не сжигается по природе, а «накопление» —
 * это поведение фондового рынка, а не монеты. В отбраковке они выглядели как
 * «сожжённая ликвидность 0 из 13 кандидатов» и съедали бюджет скана, пока
 * настоящие монеты оставались непроверенными. Теперь их отсекает дешёвый
 * предфильтр — до единого сетевого запроса.
 */
const EXCLUDED_TAGS = new Set([
  // Бумаги на акции и RWA: их выпускает эмитент, а не пул (1999 монет из 3965).
  "rwa", "stocks", "xstocks", "prestocks",
  // Обёрнутый стейкинг и LST (145 монет: mSOL, JitoSOL, JupSOL, INF, rkuSOL,
  // japanSOL). У них НЕ БЫВАЕТ просадки 50% — они растут монотонно, поэтому
  // воронка пропускала бы их честно по всем проверкам, и они попадали бы в
  // ленту как «сигналы». После снятия потолков это стало особенно важно.
  "lst", "original-lst", "yield",
]);

/**
 * Второй признак стейкинга — по имени, потому что тег `lst` есть не у всех:
 * у стейкинг-долларов вроде sUSDai теги только verified и token-2022. Ловим две
 * формы: «…SOL» (кроме голого SOL) и «s/st + доллар» (sUSD, sUSDe, stUSD).
 */
function isWrappedOrStaked(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (!s) return false;
  if (s !== "SOL" && s.endsWith("SOL")) return true;
  if (/^(S|ST)(USD|USDT|USDC|USDE)/.test(s)) return true;
  return false;
}

function jupiterPass(t: JupiterToken): boolean {
  if (t.age_days === null) return false;
  if (!passPrefilter(t.age_days, t.liq_usd)) return false;
  if (t.volume_24h_usd <= 0) return false;
  if (t.tags.some((tag) => EXCLUDED_TAGS.has(tag.toLowerCase()))) return false;
  if (isWrappedOrStaked(t.symbol)) return false;
  return true;
}

/** Возраст пула из GeckoTerminal (created_ts — секунды) в днях; 0 = неизвестно. */
function poolAgeDays(p: GeckoPoolInfo, nowMs: number): number {
  return p.created_ts > 0 ? (nowMs - p.created_ts * 1000) / 86_400_000 : 0;
}

/** GeckoPoolInfo → SourceRef (адрес пула и базового токена уже известны). */
function refFromGecko(p: GeckoPoolInfo): SourceRef {
  return { token_addr: p.mint, pair_addr: p.pool, symbol: p.symbol, name: p.name };
}

/* ─────────────── кандидаты ─────────────── */

/** Адреса «свежих» токенов из DexScreener (профили/бусты) — вспомогательный источник. */
async function freshDexAddresses(): Promise<string[]> {
  const seen = new Set<string>();
  const push = (a?: string) => {
    if (a && !seen.has(a)) seen.add(a);
  };
  for (const [kind, url] of [
    ["profiles", `${BASE}/token-profiles/latest/v1`],
    ["boosts", `${BASE}/token-boosts/latest/v1`],
  ] as const) {
    try {
      const list = await netJson<ProfilesResp>(url, {
        ttlMs: TTL_PAIRS,
        minIntervalMs: DEX_INTERVAL_MS,
        cacheKey: `dex:${kind}`,
      });
      for (const it of list) if (it.chainId === "solana") push(it.tokenAddress);
    } catch {
      // Один источник упал — не рушим отбор целиком.
    }
  }
  return [...seen];
}

/** Батч-запрос по адресам (до 30 за раз) — один вызов на всю пачку. */
async function pairsForAddrs(addrs: string[]): Promise<DexPair[]> {
  const out: DexPair[] = [];
  for (let i = 0; i < addrs.length; i += BATCH) {
    const csv = addrs.slice(i, i + BATCH).join(",");
    const j = await netJson<TokensResp>(`${BASE}/latest/dex/tokens/${csv}`, {
      ttlMs: TTL_PAIRS,
      minIntervalMs: DEX_INTERVAL_MS,
      cacheKey: `dex:batch:${csv}`,
    });
    out.push(...(j.pairs ?? []));
  }
  return out;
}

/**
 * Список кандидатов для скана (только Solana с реальным пулом).
 *
 * Порядок важен для бюджета: сначала ОСНОВНОЙ источник (вселенная Jupiter) и
 * дешёвый предфильтр по её полям — БЕЗ сети на каждого токена; лишь по прошедшим
 * ОДИН батч DexScreener (наполняет кэш лучших пар), затем резервный добор (топ
 * пулов по объёму) и «свежие» малым весом.
 */
export async function listCandidates(): Promise<SourceRef[]> {
  const now = Date.now();
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  // Ротация начинается заново: если вселенную получить не удалось, не отдаём
  // прошлогоднюю позицию как «текущую» (getLastCandidateRotation вернёт null).
  lastRotation = null;
  const add = (ref: SourceRef): boolean => {
    if (!ref.token_addr || seen.has(ref.token_addr) || out.length >= MAX_CANDIDATES) return false;
    seen.add(ref.token_addr);
    out.push(ref);
    return true;
  };

  // 1) ОСНОВНОЙ источник — вселенная верифицированных токенов Jupiter. Jupiter
  //    сам даёт возраст/ликвидность/FDV/объём, поэтому предфильтр по настройкам
  //    дешёв: сеть трогается ОДИН раз (кэш списка), дорогие вызовы не тратятся на
  //    заведомо непроходных. По прошедшим (отсортированным по ликвидности) идёт
  //    ОДИН батч DexScreener по лучшей Solana-паре — та же пара (bestPairCache)
  //    уйдёт в market()/candles(), значит возраст, ликвидность и свечи считаются
  //    по ОДНОЙ паре, без расхождения.
  const mainQuota = MAX_CANDIDATES - FRESH_CANDIDATES;
  // Вселенная Jupiter нужна и НИЖЕ — свежему добору: чтобы фильтровать его ТЕМ
  // ЖЕ значением признака, что прочтёт слой 3 (см. freshPass).
  let uni: Map<string, JupiterToken> | null = null;
  try {
    uni = await jupiterUniverse();
    const pass: { ref: SourceRef; liq: number }[] = [];
    for (const t of uni.values()) {
      if (!jupiterPass(t)) continue;
      pass.push({
        ref: { token_addr: t.mint, pair_addr: t.mint, symbol: t.symbol.toUpperCase(), name: t.name },
        liq: t.liq_usd,
      });
    }
    pass.sort((a, b) => b.liq - a.liq); // крупнее пул — надёжнее исполнение
    // РОТАЦИЯ выборки: каждый следующий скан берёт СЛЕДУЮЩУЮ порцию ТОГО ЖЕ
    // размера из стабильно отсортированного списка (по ликвидности), а не один
    // и тот же топ. Курсор хранится в meta и переживает перезапуск службы; за
    // ceil(total/portion) сканов (20 минут между ними) проверяются ВСЕ монеты
    // окна, а не первые 40. Позиция видна в логе планового скана (см. screener).
    const total = pass.length;
    const portion = Math.min(mainQuota, JUPITER_MINT_LIMIT, total);
    const start = total > 0 ? readCursor(total) : 0;
    if (total > 0) {
      lastRotation = { from: start + 1, to: start + portion, total };
      writeCursor((start + portion) % total);
    }
    const probe = rotate(pass, start, portion);
    if (probe.length) {
      rememberBest(await pairsForAddrs(probe.map((p) => p.ref.token_addr)));
      for (const p of probe) {
        if (out.length >= mainQuota) break;
        const pair = bestCachedPair(p.ref.token_addr);
        if (!pair) continue; // у минта нет Solana-пары в DexScreener — не выдумываем
        add({ ...p.ref, pair_addr: pair.pairAddress ?? p.ref.token_addr });
      }
    }
  } catch {
    // Jupiter недоступен/пуст — скан не рушим, добор идёт топ-пулами по объёму.
  }

  // Свежий добор обязан согласоваться со слоем 3. Если минт есть в вселенной
  // Jupiter — возраст/ликвидность мерит Jupiter (слой 3 прочтёт ТО ЖЕ значение),
  // поэтому свежий кандидат проходит те же ворота jupiterPass, что и основной
  // отбор. Нет минта в вселенной — Jupiter признак не даёт, и слой 3 честно
  // падает на пару DexScreener: тогда фильтруем по данным источника (как раньше).
  const freshPass = (ageDays: number, liqUsd: number, mint: string): boolean => {
    const t = uni?.get(mint);
    if (t) return jupiterPass(t);
    return passPrefilter(ageDays, liqUsd);
  };

  // 1b) ДОБОР при недоборе основного — топ пулов сети по объёму (GeckoTerminal).
  //     Возраст и ликвидность уже в ответе, предфильтр бесплатен. Почти все такие
  //     пулы — новорождённые, и предфильтр их режет; источник оставлен как резерв
  //     на случай, если Jupiter пуст или отдал мало монет.
  if (out.length < mainQuota) {
    try {
      const pools = await topVolumePools();
      const pass = pools
        .filter((p) => freshPass(poolAgeDays(p, now), p.liq_usd, p.mint))
        .sort((a, b) => b.liq_usd - a.liq_usd);
      for (const p of pass) {
        if (out.length >= mainQuota) break;
        add(refFromGecko(p));
      }
    } catch {
      // Добор недоступен — скан не рушим, добираем свежими.
    }
  }

  // 2) СВЕЖИЕ источники МАЛЫМ весом (не более FRESH_CANDIDATES). trending/new
  //    GeckoTerminal: метаданные (age/liq) уже есть → предфильтр без сети.
  const fresh: { ref: SourceRef; liq: number }[] = [];
  for (const kind of ["trending", "new"] as const) {
    try {
      const pools = kind === "trending" ? await trendingPools() : await newPools();
      for (const p of pools) {
        if (freshPass(poolAgeDays(p, now), p.liq_usd, p.mint)) fresh.push({ ref: refFromGecko(p), liq: p.liq_usd });
      }
    } catch {
      /* см. выше */
    }
  }

  // 2b) profiles/boosts DexScreener: адреса без метаданных, поэтому нужен ОДИН
  //     батч, чтобы предфильтровать их по возрасту/ликвидности из данных пары.
  const dexAddrs = await freshDexAddresses();
  if (dexAddrs.length) {
    const dexSet = new Set(dexAddrs);
    try {
      const pairs = await pairsForAddrs(dexAddrs);
      rememberBest(pairs);
      for (const p of pairs) {
        if (p.chainId !== "solana") continue;
        const addr = p.baseToken?.address;
        if (!addr || !dexSet.has(addr)) continue;
        const age = p.pairCreatedAt ? (now - p.pairCreatedAt) / 86_400_000 : 0;
        if (!freshPass(age, num(p.liquidity?.usd), addr)) continue;
        fresh.push({
          ref: {
            token_addr: addr,
            pair_addr: p.pairAddress ?? addr,
            symbol: p.baseToken?.symbol ?? "?",
            name: p.baseToken?.name ?? p.baseToken?.symbol ?? "?",
          },
          liq: num(p.liquidity?.usd),
        });
      }
    } catch {
      /* см. выше */
    }
  }
  fresh.sort((a, b) => b.liq - a.liq);
  let freshAdded = 0;
  for (const f of fresh) {
    if (freshAdded >= FRESH_CANDIDATES) break;
    if (add(f.ref)) freshAdded++;
  }

  // 3) ОДИН батч DexScreener по финальным минтам: market() возьмёт лучший пул из
  //    кэша и не потратит запрос на каждого кандидата. Нет пары в DexScreener —
  //    market() честно бросит not_found (не выдумываем данные).
  if (out.length) {
    try {
      rememberBest(await pairsForAddrs(out.map((c) => c.token_addr)));
    } catch {
      /* см. выше */
    }
  }
  return out;
}

/** Поиск по строке (совместимость с интерфейсом источника). */
export async function dexSearch(query: string): Promise<SourceRef[]> {
  const j = await netJson<TokensResp>(`${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`, {
    ttlMs: TTL_PAIRS,
    minIntervalMs: DEX_INTERVAL_MS,
    cacheKey: `dex:search:${query}`,
  });
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

/** Самый ликвидный пул токена (кэш от батча, иначе точечный запрос). */
export async function getBestPair(addr: string): Promise<DexPair | null> {
  const hit = bestPairCache.get(addr);
  if (hit && hit.exp > Date.now()) return hit.pair;
  const j = await netJson<TokensResp>(`${BASE}/latest/dex/tokens/${addr}`, {
    ttlMs: TTL_PAIRS,
    minIntervalMs: DEX_INTERVAL_MS,
    cacheKey: `dex:batch:${addr}`,
  });
  const pairs = (j.pairs ?? []).filter((p) => p.chainId === "solana");
  let best: DexPair | null = null;
  for (const p of pairs) if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  if (best && best.baseToken?.address) bestPairCache.set(best.baseToken.address, { exp: Date.now() + TTL_PAIRS, pair: best });
  return best;
}

/** Адрес самого ликвидного пула токена (для свечей и выборки сделок). */
export async function poolForToken(addr: string): Promise<string | null> {
  const best = await getBestPair(addr);
  return best?.pairAddress ?? null;
}

/** Цена из DexScreener (запасной путь, если Jupiter недоступен). */
export async function dexPrice(addr: string): Promise<number> {
  const best = await getBestPair(addr);
  return best ? num(best.priceUsd) : 0;
}

/* ─────────────── рыночные данные + слой накопления ─────────────── */

interface Layer4 {
  range_pct: number;
  drawdown: number;
}

/** Коридор за окно range_days и падение от максимума по дневным свечам. */
function layer4FromDaily(candles: Candle[]): Layer4 {
  if (!candles.length) return { range_pct: 0, drawdown: 0 };
  const win = candles.slice(-Math.max(1, rangeDays));
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of win) {
    if (c[2] > hi) hi = c[2];
    if (c[3] < lo) lo = c[3];
  }
  const mid = (hi + lo) / 2;
  const rangePct = mid > 0 ? ((hi - lo) / mid) * 100 : 0;
  let ath = -Infinity;
  for (const c of candles) if (c[2] > ath) ath = c[2];
  const last = candles[candles.length - 1][4];
  const drawdown = ath > 0 ? ((ath - last) / ath) * 100 : 0;
  return {
    range_pct: Math.round(rangePct * 10) / 10,
    drawdown: Math.round(drawdown * 10) / 10,
  };
}

/**
 * Склеить часовые свечи в дневные (UTC-сутки): open — первый час, close —
 * последний, high/low — экстремумы, объём — сумма. Нужно, когда дневной ряд
 * короткий (GeckoTerminal отдаёт дневные с задержкой/троттлингом), а часовые
 * есть — тогда коридор и просадку честно считаем по склейке, а не «не измерено».
 */
function mergeToDaily(hourly: Candle[]): Candle[] {
  if (!hourly.length) return [];
  const DAY = 86_400;
  const buckets = new Map<number, Candle>();
  for (const c of [...hourly].sort((a, b) => a[0] - b[0])) {
    const day = Math.floor(c[0] / DAY) * DAY;
    const b = buckets.get(day);
    if (!b) {
      buckets.set(day, [day, c[1], c[2], c[3], c[4], c[5]]);
    } else {
      b[2] = Math.max(b[2], c[2]);
      b[3] = Math.min(b[3], c[3]);
      b[4] = c[4];
      b[5] += c[5];
    }
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Дневной ряд пула для слоя 4. Если дневных свечей нет или их меньше окна
 * накопления (range_days), добираем часовые (range_days суток) и склеиваем в
 * дневные сами. Пусто и там и там — честный пустой ряд (слой 4 = «не измерено»).
 */
async function dailySeries(pool: string): Promise<Candle[]> {
  let daily: Candle[] = [];
  try {
    daily = await ohlcv(pool, "1d", DAY_LIMIT);
  } catch {
    // Дневные недоступны — попробуем часовые ниже.
  }
  if (daily.length >= Math.min(rangeDays, DAY_LIMIT)) return daily;
  try {
    const hourly = await ohlcv(pool, "1h", HOURS_PER_DAY * rangeDays);
    const merged = mergeToDaily(hourly);
    if (merged.length) return merged;
  } catch {
    // Часовые тоже недоступны.
  }
  return daily;
}

/**
 * Пул свечей с запасным путём. Сначала пул лучшей пары DexScreener (её адрес =
 * адрес пула GeckoTerminal). Если оттуда свечей нет (часть монет Gecko в таком
 * виде не отдаёт) — ищем самый ликвидный пул токена через GeckoTerminal
 * `/networks/solana/tokens/{mint}/pools` и читаем уже по нему.
 *
 * Запасной пул ищется ТОЛЬКО когда основной не дал свечей: иначе лишний запрос
 * к Gecko на каждый вызов приблизил бы лимит (~30/мин) и породил бы 429.
 */
async function candlesViaPools(
  ref: SourceRef,
  label: string,
  load: (pool: string) => Promise<Candle[]>,
): Promise<Candle[]> {
  const tried: string[] = [];
  const primary = await poolForToken(ref.token_addr);
  if (primary) {
    tried.push(primary);
    const c = await safeLoad(() => load(primary));
    if (c.length) return c;
  }
  const alt = await safeBestPool(ref.token_addr);
  if (alt && alt !== primary) {
    tried.push(alt);
    const c = await safeLoad(() => load(alt));
    if (c.length) return c;
  }
  // Оба пути пусты — честная пустота, но одна строка с причиной в лог (без ключей).
  console.error(
    `[свечи] нет данных (${label}): ${ref.symbol} (${ref.token_addr}); пулы: ${tried.join(", ") || "не найдены"}`,
  );
  return [];
}

/** Выполнить загрузку свечей, любым сбоем отдав пустой ряд (не роняем путь). */
async function safeLoad(fn: () => Promise<Candle[]>): Promise<Candle[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/** Адрес самого ликвидного пула через Gecko; сбой/пустота → null. */
async function safeBestPool(mint: string): Promise<string | null> {
  try {
    const best = await bestPoolForToken(mint);
    return best?.pool ?? null;
  } catch {
    return null;
  }
}

/** Ряд дневных свечей токена (для слоя 4). Оба пула пусты — пустой ряд. */
export async function dexDailyCandles(ref: SourceRef): Promise<Candle[]> {
  return candlesViaPools(ref, "1d", (pool) => dailySeries(pool));
}

/** Итог слоя 4: коридор и просадка. candles_na — ряд измерить не удалось. */
export interface Accumulation {
  range_pct: number;
  drawdown_pct: number;
  candles_na: boolean;
}

/** Коридор+просадка из дневного ряда; пустой ряд — «не измерено». */
export function accumulationFromDaily(daily: Candle[]): Accumulation {
  if (!daily.length) return { range_pct: 0, drawdown_pct: 0, candles_na: true };
  const l4 = layer4FromDaily(daily);
  return { range_pct: l4.range_pct, drawdown_pct: l4.drawdown, candles_na: false };
}

/**
 * Рыночные метаданные пула БЕЗ свечей (возраст/ликвидность/цена/объём).
 * Отделено от свечей нарочно: слой 3 меряет возраст/ликвидность, и эти данные
 * дешёвые (кэш вселенной Jupiter + кэш пары DexScreener), а дневные свечи —
 * дорогой запрос к GeckoTerminal. Скринер берёт метаданные ДО дорогих проверок
 * и качает свечи только для прошедших слои 1 и 3 (см. screener).
 */
export async function dexMarketMeta(ref: SourceRef): Promise<MarketData> {
  const pair = await getBestPair(ref.token_addr);
  if (!pair) throw new ApiError("not_found", 404, `DexScreener: пул не найден для ${ref.symbol}`);
  // Метаданные Jupiter (кэш вселенной уже прогрет отбором кандидатов): возраст и
  // ликвидность ТОКЕНА + изменение ликвидности за сутки. Ошибка не роняет market.
  let jup: JupiterToken | null = null;
  try {
    jup = await jupiterToken(ref.token_addr);
  } catch {
    // Jupiter недоступен — возраст/ликвидность берём из пары, изменение — null.
  }
  // ВОЗРАСТ и ЛИКВИДНОСТЬ — из Jupiter (он источник вселенной и даёт оба признака
  // одним запросом). Это РОВНО те значения, по которым предфильтр отобрал
  // кандидата: слой 3 не может отбраковать уже прошедшего по тому же признаку.
  // Пара DexScreener даёт ДРУГИЕ ликвидность/возраст (у MINI $224k против $142k
  // в Jupiter), поэтому её числа для слоя 3 НЕ используем. Если минта нет в
  // вселенной Jupiter (свежий добор Gecko/DexScreener) — честно падаем на данные
  // пары и помечаем источник в checks.
  const inUniverse = jup !== null;
  const jupAge = typeof jup?.age_days === "number" ? (jup.age_days as number) : null;
  const pairAgeKnown = typeof pair.pairCreatedAt === "number" && pair.pairCreatedAt > 0;
  let ageDays = 0;
  let ageSource: MarketData["age_source"];
  if (jupAge !== null) {
    ageDays = jupAge;
    ageSource = "Jupiter";
  } else if (!inUniverse && pairAgeKnown) {
    ageDays = (Date.now() - (pair.pairCreatedAt as number)) / 86_400_000;
    ageSource = "DexScreener";
  }
  // Возраст НЕ измерен (age_na), только если нет ни Jupiter-даты, ни даты пары.
  const ageKnown = ageSource !== undefined;
  const liqSource: MarketData["liq_source"] = inUniverse ? "Jupiter" : "DexScreener";
  const liqUsd = jup ? jup.liq_usd : num(pair.liquidity?.usd);
  return {
    price: num(pair.priceUsd),
    liq_usd: liqUsd,
    mc_usd: num(pair.marketCap) || num(pair.fdv),
    age_days: ageDays,
    volume_24h_usd: num(pair.volume?.h24),
    onchain_volume_usd: num(pair.volume?.h24),
    // Изменение ликвидности за сутки: Jupiter stats24h.liquidityChange, %.
    liquidity_change_24h_pct: jup?.liquidity_change_24h_pct ?? null,
    liquidity_flow_usd: 0,
    // Свечи в метаданные НЕ входят: слой 4 добирает их отдельно (dexDailyCandles),
    // чтобы не платить за запрос до прохождения слоёв 1 и 3.
    drawdown_from_ath_pct: 0,
    range_pct: 0,
    // Боковик ищем на дневном окне.
    tf_accum: "1D",
    // Индикатор сжатия в V1 не считается (нет модели) — 0 = «не измерить».
    svd: 0,
    // Честность: возраст не измерен — проверка покажет value=null.
    age_na: !ageKnown,
    candles_na: true,
    age_source: ageSource,
    liq_source: liqSource,
  };
}

/**
 * Рыночные данные пула СО свечами (коридор/просадка слоя 4). Оставлено для
 * путей, которым нужен полный MarketData одним вызовом (демо-контур торговли:
 * ему нужна цена входа). Скринер живым контуром идёт путём
 * dexMarketMeta + dexDailyCandles — там свечи качаются только после слоёв 1 и 3.
 */
export async function dexMarket(ref: SourceRef): Promise<MarketData> {
  const meta = await dexMarketMeta(ref);
  const acc = accumulationFromDaily(await dexDailyCandles(ref));
  return {
    ...meta,
    range_pct: acc.range_pct,
    drawdown_from_ath_pct: acc.drawdown_pct,
    candles_na: acc.candles_na,
  };
}

/**
 * Свечи для /api/candles: OHLCV GeckoTerminal по пулу лучшей пары DexScreener,
 * при пустом ответе — по самому ликвидному пулу токена (запасной путь). Формат
 * ответа не меняем: Candle = [ts,o,h,l,c,v], от старых к новым.
 */
export async function dexCandles(ref: SourceRef, tf: ChartTf, limit: number): Promise<Candle[]> {
  return candlesViaPools(ref, tf, (pool) => ohlcv(pool, tf, limit));
}
