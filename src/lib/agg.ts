/**
 * agg.ts — данные СРАЗУ С ДВУХ БИРЖ: Bybit и Binance.
 *
 * Зачем две. Открытый интерес одной биржи — это её доля рынка, а не рынок.
 * На монете, где Binance держит 60% интереса, картинка «по Bybit» покажет
 * меньшую половину и развернётся раньше или позже настоящей. Поэтому ряды
 * складываются по ведру времени, как это делает Coinglass.
 *
 * ЧЕСТНОСТЬ ИСТОЧНИКА ОБЯЗАТЕЛЬНА. Каждая функция возвращает не только ряд, но
 * и список бирж, которые РЕАЛЬНО ответили. Binance в части стран отдаёт 451, и
 * молча показать половину рынка под подписью «две биржи» — худшее, что тут
 * можно сделать: человек примет решение по данным, которых не видел.
 *
 * ЛОНГИ И ШОРТЫ ОТДЕЛЬНО — ЭТО ОЦЕНКА, и другой не бывает. Ни одна биржа не
 * публикует, сколько в открытом интересе лонгов, а сколько шортов: интерес —
 * одно число на обе стороны. Публикуется ДОЛЯ счетов (account ratio), и на неё
 * умножается интерес — так считают все терминалы, включая Coinglass. Поэтому в
 * интерфейсе это подписано оценкой, а не замером.
 */

import type { Interval } from "./market";

export type Ex = "bybit" | "binance";

/** Свеча любого ряда: интерес, лонги, шорты. */
export type OhlcPoint = { time: number; open: number; high: number; low: number; close: number };
export type Series = { rows: OhlcPoint[]; from: Ex[] };

const BYBIT = ["https://api.bybit.com", "https://api.bytick.com"];
const BINANCE = ["https://fapi.binance.com"];

async function get(hosts: string[], path: string, ms = 9000): Promise<any> {
  let last: unknown;
  for (const h of hosts) {
    try {
      const r = await fetch(h + path, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`http ${r.status}`);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error("нет ответа");
}

/* ── Шаги ────────────────────────────────────────────────────────────────────
   У бирж свои наборы периодов, и они не совпадают. Берём период НА СТУПЕНЬ
   МЕЛЬЧЕ графика: из нескольких точек внутри свечи и собирается свеча (open —
   первая, high/low — крайние, close — последняя). Один в один с графиком дал бы
   плоские свечи без тела, а это уже не свечной график, а линия в маске. */

const FINER: Record<Interval, { bybit: string; binance: string; sec: number }> = {
  "5":   { bybit: "5min",  binance: "5m",  sec: 300 },
  "15":  { bybit: "5min",  binance: "5m",  sec: 300 },
  "60":  { bybit: "15min", binance: "15m", sec: 900 },
  "240": { bybit: "1h",    binance: "1h",  sec: 3600 },
};

export const stepSec = (i: Interval): number =>
  ({ "5": 300, "15": 900, "60": 3600, "240": 14400 } as Record<string, number>)[i] || 300;

const bucket = (sec: number, i: Interval) => {
  const st = stepSec(i);
  return Math.floor(sec / st) * st;
};

/* ── Открытый интерес ─────────────────────────────────────────────────────── */

type Pt = { t: number; v: number };

async function oiBybit(symbol: string, iv: Interval, limit: number): Promise<Pt[]> {
  const j = await get(BYBIT, `/v5/market/open-interest?category=linear&symbol=${symbol}`
    + `&intervalTime=${FINER[iv].bybit}&limit=${limit}`);
  if (j.retCode !== 0) throw new Error(j.retMsg || "bybit");
  // openInterest у Bybit — в МОНЕТАХ; в доллары переводим ценой той же свечи.
  return (j.result.list as any[]).map((x) => ({ t: Math.floor(+x.timestamp / 1000), v: +x.openInterest }));
}

async function oiBinance(symbol: string, iv: Interval, limit: number): Promise<Pt[]> {
  const j = await get(BINANCE, `/futures/data/openInterestHist?symbol=${symbol}`
    + `&period=${FINER[iv].binance}&limit=${Math.min(limit, 500)}`);
  if (!Array.isArray(j)) throw new Error("binance");
  // sumOpenInterestValue — уже в USDT, брать его надёжнее: не нужна цена.
  return j.map((x: any) => ({ t: Math.floor(+x.timestamp / 1000), v: +x.sumOpenInterestValue }));
}

/** Доля лонгов по счетам (0..1). Обе биржи публикуют именно доли счетов. */
async function ratioBybit(symbol: string, iv: Interval, limit: number): Promise<Pt[]> {
  const j = await get(BYBIT, `/v5/market/account-ratio?category=linear&symbol=${symbol}`
    + `&period=${FINER[iv].bybit}&limit=${limit}`);
  if (j.retCode !== 0) throw new Error(j.retMsg || "bybit");
  return (j.result.list as any[]).map((x) => ({ t: Math.floor(+x.timestamp / 1000), v: +x.buyRatio }));
}

async function ratioBinance(symbol: string, iv: Interval, limit: number): Promise<Pt[]> {
  const j = await get(BINANCE, `/futures/data/globalLongShortAccountRatio?symbol=${symbol}`
    + `&period=${FINER[iv].binance}&limit=${Math.min(limit, 500)}`);
  if (!Array.isArray(j)) throw new Error("binance");
  return j.map((x: any) => ({ t: Math.floor(+x.timestamp / 1000), v: +x.longAccount }));
}

/** Цена для перевода монет в доллары (нужна только Bybit-интересу). */
async function priceBybit(symbol: string, iv: Interval, limit: number): Promise<Map<number, number>> {
  const j = await get(BYBIT, `/v5/market/kline?category=linear&symbol=${symbol}`
    + `&interval=${FINER[iv].bybit === "5min" ? 5 : FINER[iv].bybit === "15min" ? 15 : 60}&limit=${limit}`);
  if (j.retCode !== 0) throw new Error(j.retMsg || "bybit");
  const m = new Map<number, number>();
  (j.result.list as string[][]).forEach((k) => m.set(Math.floor(+k[0] / 1000), +k[4]));
  return m;
}

function toCandles(points: Pt[], iv: Interval): OhlcPoint[] {
  const by = new Map<number, number[]>();
  points.sort((a, b) => a.t - b.t).forEach((p) => {
    if (!isFinite(p.v) || p.v <= 0) return;
    const b = bucket(p.t, iv);
    const arr = by.get(b);
    if (arr) arr.push(p.v); else by.set(b, [p.v]);
  });
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([time, vs]) => ({
    time, open: vs[0], high: Math.max(...vs), low: Math.min(...vs), close: vs[vs.length - 1],
  }));
}

/** Сложить ряды разных бирж по ведру времени. Ведро, где ответила только одна
 *  биржа, остаётся — но помечать источники обязан вызывающий. */
function sum(all: Pt[][]): Pt[] {
  const m = new Map<number, number>();
  all.forEach((rows) => rows.forEach((p) => m.set(p.t, (m.get(p.t) || 0) + p.v)));
  return [...m.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

/**
 * Открытый интерес и его разбивка на лонги и шорты — свечами, с двух бирж.
 *
 * Возвращает три ряда и список ответивших бирж. Никогда не бросает: часть
 * данных лучше, чем пустой экран, но подписать, чего не хватает, обязательно.
 */
export async function openInterest(symbol: string, iv: Interval, limit = 200): Promise<{
  total: Series; longs: Series; shorts: Series;
}> {
  const from: Ex[] = [];
  const oiParts: Pt[][] = [];
  const ratios: Pt[][] = [];

  const [byOi, byPx, byR, bnOi, bnR] = await Promise.allSettled([
    oiBybit(symbol, iv, limit), priceBybit(symbol, iv, limit), ratioBybit(symbol, iv, limit),
    oiBinance(symbol, iv, limit), ratioBinance(symbol, iv, limit),
  ]);

  if (byOi.status === "fulfilled" && byPx.status === "fulfilled") {
    // Монеты → доллары по закрытию той же свечи. Без этого нельзя складывать с
    // Binance, который отдаёт сразу в USDT.
    const px = byPx.value;
    const usd = byOi.value
      .map((p) => ({ t: p.t, v: p.v * (px.get(p.t) || 0) }))
      .filter((p) => p.v > 0);
    if (usd.length) { oiParts.push(usd); from.push("bybit"); }
  }
  if (bnOi.status === "fulfilled" && bnOi.value.length) {
    oiParts.push(bnOi.value);
    from.push("binance");
  }
  if (byR.status === "fulfilled" && byR.value.length) ratios.push(byR.value);
  if (bnR.status === "fulfilled" && bnR.value.length) ratios.push(bnR.value);

  const total = sum(oiParts);
  // Доля лонгов — СРЕДНЕЕ по биржам, а не сумма: это доля, а не объём.
  const rMap = new Map<number, number[]>();
  ratios.forEach((rows) => rows.forEach((p) => {
    if (!(p.v > 0 && p.v < 1)) return;
    const a = rMap.get(p.t); if (a) a.push(p.v); else rMap.set(p.t, [p.v]);
  }));
  const ratioAt = (t: number): number => {
    const a = rMap.get(t);
    if (a && a.length) return a.reduce((s, v) => s + v, 0) / a.length;
    return 0.5;            // доли нет — считаем поровну и не выдумываем перекос
  };

  const longs = total.map((p) => ({ t: p.t, v: p.v * ratioAt(p.t) }));
  const shorts = total.map((p) => ({ t: p.t, v: p.v * (1 - ratioAt(p.t)) }));

  return {
    total: { rows: toCandles(total, iv), from },
    longs: { rows: toCandles(longs, iv), from },
    shorts: { rows: toCandles(shorts, iv), from },
  };
}

/* ── Объём ────────────────────────────────────────────────────────────────── */

export type VolBar = { time: number; usd: number; up: boolean };

async function volBybit(symbol: string, iv: Interval, limit: number): Promise<VolBar[]> {
  const j = await get(BYBIT, `/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${limit}`);
  if (j.retCode !== 0) throw new Error(j.retMsg || "bybit");
  return (j.result.list as string[][]).map((k) => ({
    time: Math.floor(+k[0] / 1000), usd: +k[6], up: +k[4] >= +k[1],
  }));
}

async function volBinance(symbol: string, iv: Interval, limit: number): Promise<VolBar[]> {
  const iname = ({ "5": "5m", "15": "15m", "60": "1h", "240": "4h" } as Record<string, string>)[iv] || "15m";
  const j = await get(BINANCE, `/fapi/v1/klines?symbol=${symbol}&interval=${iname}&limit=${limit}`);
  if (!Array.isArray(j)) throw new Error("binance");
  return j.map((k: any[]) => ({
    time: Math.floor(+k[0] / 1000), usd: +k[7], up: +k[4] >= +k[1],
  }));
}

/** Оборот в долларах, сложенный по двум биржам. */
export async function volume(symbol: string, iv: Interval, limit = 200):
    Promise<{ rows: VolBar[]; from: Ex[] }> {
  const from: Ex[] = [];
  const [a, b] = await Promise.allSettled([
    volBybit(symbol, iv, limit), volBinance(symbol, iv, limit),
  ]);
  const m = new Map<number, VolBar>();
  if (a.status === "fulfilled" && a.value.length) {
    from.push("bybit");
    a.value.forEach((v) => m.set(v.time, { ...v }));
  }
  if (b.status === "fulfilled" && b.value.length) {
    from.push("binance");
    b.value.forEach((v) => {
      const cur = m.get(v.time);
      // Направление свечи берём у первой биржи: оно про цену, а не про объём,
      // и суммировать его бессмысленно.
      if (cur) cur.usd += v.usd; else m.set(v.time, { ...v });
    });
  }
  return { rows: [...m.values()].sort((x, y) => x.time - y.time), from };
}
