/**
 * stats.ts — метрики по закрытым сделкам. Чистые функции над журналом бота:
 * ни сети, ни состояния, ни React — поэтому их можно считать в любом месте и
 * проверять глазами по одной цифре.
 *
 * ГЛАВНОЕ ПРАВИЛО, общее с отчётами бота: деньги считаются ТОЛЬКО по закрытым
 * сделкам. У открытой позиции результата ещё нет — есть состояние, и записав
 * его в статистику, мы обещали бы деньги, которых нет.
 *
 * Второе правило: безубыток — НЕ проигрыш и НЕ победа. Винрейт считается по
 * сделкам с результатом, иначе схема с переносом стопа в безубыток выглядела
 * бы тем хуже, чем лучше она защищает.
 */

import type { Trade } from "./mock";

export type Day = { day: string; ts: number; n: number; wins: number; loss: number;
                    pnl: number; r: number; minutes: number };

const DAY = 864e5;

/** Локальная дата сделки. По локальной, а не UTC: человек живёт в своём дне, и
 *  сделка в 2 ночи по Бишкеку не должна попадать во вчерашний отчёт. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Сделки по дням, БЕЗ пропусков: день без сделок — это тоже факт, и на графике
 *  он обязан быть провалом, а не сжатием оси. */
export function byDay(trades: Trade[], days = 0): Day[] {
  if (!trades.length) return [];
  const map = new Map<string, Day>();
  const mk = (ts: number): Day => ({ day: dayKey(ts), ts, n: 0, wins: 0, loss: 0, pnl: 0, r: 0, minutes: 0 });

  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const from = days ? Date.now() - days * DAY : sorted[0].closedAt;
  for (let t = from; t <= Date.now() + DAY / 2; t += DAY) {
    const d = mk(t);
    map.set(d.day, d);
  }
  sorted.forEach((t) => {
    const key = dayKey(t.closedAt);
    const d = map.get(key) || mk(t.closedAt);
    d.n += 1;
    if (t.pnl > 0) d.wins += 1;
    else if (t.pnl < 0) d.loss += 1;
    d.pnl += t.pnl;
    d.r += t.r;
    d.minutes += t.heldMin;
    map.set(key, d);
  });
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

/** Кумулятивная прибыль по сделкам (не по дням): каждая точка — сделка, потому
 *  что просадку внутри дня иначе не увидеть вовсе. */
export function equity(trades: Trade[], start = 0): { x: number; y: number; label: string }[] {
  const rows = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  let v = start;
  return rows.map((t) => {
    v += t.pnl;
    return { x: t.closedAt, y: +v.toFixed(2), label: t.symbol.replace("USDT", "") };
  });
}

export type Summary = {
  n: number; wins: number; loss: number; be: number;
  net: number; netR: number;
  winrate: number | null;          // null — считать не на чем
  pf: number | null;               // профит-фактор
  expR: number | null;             // мат. ожидание в R на сделку
  expUsd: number | null;
  avgWin: number; avgLoss: number;
  avgMin: number;
  maxDd: number;                   // максимальная просадка кривой, $
  streakWin: number; streakLoss: number;
  capture: number | null;          // какую долю лучшего хода забрали
};

export function summary(trades: Trade[]): Summary {
  const wins = trades.filter((t) => t.pnl > 0);
  const loss = trades.filter((t) => t.pnl < 0);
  const be = trades.length - wins.length - loss.length;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(loss.reduce((s, t) => s + t.pnl, 0));
  const decided = wins.length + loss.length;

  let eq = 0, peak = 0, dd = 0, sw = 0, sl = 0, curW = 0, curL = 0;
  [...trades].sort((a, b) => a.closedAt - b.closedAt).forEach((t) => {
    eq += t.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak);
    if (t.pnl > 0) { curW += 1; curL = 0; } else if (t.pnl < 0) { curL += 1; curW = 0; }
    sw = Math.max(sw, curW); sl = Math.max(sl, curL);
  });

  /* «Сколько забрали от лучшего хода» — метрика про СХЕМУ ВЫХОДА, а не про
     отбор сделок: если сделки регулярно ходили в +3R, а забирали 1R, дело не в
     сигналах, а в том, где стоят цели. Считаем только по сделкам, которые
     вообще были в плюсе: у сделки, не сходившей в прибыль, забирать было нечего. */
  const moved = trades.filter((t) => t.mfe > 0.05);
  const capture = moved.length
    ? +(moved.reduce((s, t) => s + t.r, 0) / moved.reduce((s, t) => s + t.mfe, 0)).toFixed(3)
    : null;

  return {
    n: trades.length, wins: wins.length, loss: loss.length, be,
    net: +(gp - gl).toFixed(2),
    netR: +trades.reduce((s, t) => s + t.r, 0).toFixed(2),
    winrate: decided ? Math.round((wins.length / decided) * 100) : null,
    pf: gl ? +(gp / gl).toFixed(2) : null,
    expR: trades.length ? +(trades.reduce((s, t) => s + t.r, 0) / trades.length).toFixed(3) : null,
    expUsd: trades.length ? +((gp - gl) / trades.length).toFixed(2) : null,
    avgWin: wins.length ? +(gp / wins.length).toFixed(2) : 0,
    avgLoss: loss.length ? +(gl / loss.length).toFixed(2) : 0,
    avgMin: trades.length ? Math.round(trades.reduce((s, t) => s + t.heldMin, 0) / trades.length) : 0,
    maxDd: +dd.toFixed(2),
    streakWin: sw, streakLoss: sl,
    capture,
  };
}

/** Распределение результата в R. Корзины фиксированные — так разные периоды
 *  сравнимы между собой, а «умные» границы по выборке сравнивать нельзя. */
export const R_BUCKETS = [
  { id: "<-1", from: -Infinity, to: -1, label: "хуже −1R" },
  { id: "-1..0", from: -1, to: 0, label: "−1…0" },
  { id: "0..1", from: 0, to: 1, label: "0…1R" },
  { id: "1..2", from: 1, to: 2, label: "1…2R" },
  { id: "2..3", from: 2, to: 3, label: "2…3R" },
  { id: ">3", from: 3, to: Infinity, label: "больше 3R" },
] as const;

export function rHist(trades: Trade[]): { label: string; n: number; good: boolean }[] {
  return R_BUCKETS.map((b) => ({
    label: b.label,
    n: trades.filter((t) => t.r >= b.from && t.r < b.to).length,
    good: b.from >= 0,
  }));
}

/** По часам суток (локальным). Сигналы приходят неравномерно, и знать свои
 *  часы полезнее, чем ещё один средний показатель. */
export function byHour(trades: Trade[]): { hour: number; n: number; pnl: number }[] {
  const out = Array.from({ length: 24 }, (_, hour) => ({ hour, n: 0, pnl: 0 }));
  trades.forEach((t) => {
    const h = new Date(t.closedAt - t.heldMin * 60000).getHours();
    out[h].n += 1;
    out[h].pnl += t.pnl;
  });
  return out;
}

/** По монетам — топ по вкладу в результат. */
export function bySymbol(trades: Trade[], top = 8):
    { symbol: string; n: number; pnl: number; r: number }[] {
  const m = new Map<string, { symbol: string; n: number; pnl: number; r: number }>();
  trades.forEach((t) => {
    const key = t.symbol.replace("USDT", "");
    const v = m.get(key) || { symbol: key, n: 0, pnl: 0, r: 0 };
    v.n += 1; v.pnl += t.pnl; v.r += t.r;
    m.set(key, v);
  });
  return [...m.values()].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, top);
}

/** Чем заканчивались сделки. Для этого бота метрика ключевая: доля стопов
 *  против взятых целей говорит о схеме выхода больше, чем винрейт. */
export function byReason(trades: Trade[]): { reason: string; n: number; pnl: number }[] {
  const m = new Map<string, { reason: string; n: number; pnl: number }>();
  trades.forEach((t) => {
    const v = m.get(t.reason) || { reason: t.reason, n: 0, pnl: 0 };
    v.n += 1; v.pnl += t.pnl;
    m.set(t.reason, v);
  });
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/** Сторона сделки: лонги против шортов. У бота они торгуются по РАЗНЫМ схемам
 *  (у шорта лесенка, у лонга одна цель), поэтому смешивать их в один винрейт —
 *  значит мерить две системы одним числом. */
export function bySide(trades: Trade[]): { side: "long" | "short"; s: Summary }[] {
  return (["long", "short"] as const)
    .map((side) => ({ side, s: summary(trades.filter((t) => t.side === side)) }))
    .filter((x) => x.s.n > 0);
}
