/**
 * useFlow.ts — хуки индикаторных данных.
 *
 * Каждый включается ОТДЕЛЬНО и только когда его панель открыта (`on`). Это не
 * экономия на спичках: лента сделок живой монеты — это десятки сообщений в
 * секунду, и держать её ради панели, которую никто не смотрит, значит греть
 * телефон и жечь трафик впустую.
 */

import { useEffect, useRef, useState } from "react";
import type { Interval } from "./market";
import { bucket, fetchRecentTrades, onLiquidations, onTrades,
         stepOf, whaleFloor, type Liq, type Trade } from "./flow";
import { openInterest, volume, type Ex, type OhlcPoint, type VolBar } from "./agg";

/** Сколько живых сделок держим в памяти. Больше незачем: кружки китов на
 *  графике всё равно рисуются только за видимое окно. */
const KEEP_WHALES = 60;

/* ── Открытый интерес: свечами и с двух бирж ─────────────────────────────── */

export type OiData = {
  total: OhlcPoint[]; longs: OhlcPoint[]; shorts: OhlcPoint[];
  /** Что реально ответило. Пустой список — данных нет вовсе. */
  from: Ex[];
  loading: boolean;
};

export function useOi(symbol: string, interval: Interval, on: boolean): OiData {
  const [d, setD] = useState<OiData>({ total: [], longs: [], shorts: [], from: [], loading: false });

  useEffect(() => {
    if (!on) { setD({ total: [], longs: [], shorts: [], from: [], loading: false }); return; }
    let alive = true;
    setD((p) => ({ ...p, loading: true }));
    const load = () => openInterest(symbol, interval)
      .then((r) => alive && setD({ total: r.total.rows, longs: r.longs.rows, shorts: r.shorts.rows,
                                   from: r.total.from, loading: false }))
      .catch(() => alive && setD({ total: [], longs: [], shorts: [], from: [], loading: false }));
    load();
    /* Перезапрашиваем не чаще, чем появляется новая точка ряда, и не реже раза
       в пять минут: открытый интерес меняется непрерывно, но в ряд попадает
       шагом периода — чаще спрашивать нечего, а два лишних запроса в минуту на
       мобильной сети заметны. */
    const t = setInterval(load, Math.min(stepOf(interval), 300) * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol, interval, on]);

  return d;
}

/** Приток: насколько за свечу прибавилось лонгов и шортов. Раньше это была
 *  догадка по ΔОИ и направлению свечи; теперь у нас есть сами ряды лонгов и
 *  шортов, и приток — их прямая разность. Оценкой это быть не перестало (сами
 *  ряды оценочные), но гадать о направлении больше не нужно. */
export function deltas(rows: OhlcPoint[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (let i = 1; i < rows.length; i++) out.push({ time: rows[i].time, value: rows[i].close - rows[i - 1].close });
  return out;
}

/* ── Объём с двух бирж ───────────────────────────────────────────────────── */

export function useVolume(symbol: string, interval: Interval, on: boolean) {
  const [d, setD] = useState<{ rows: VolBar[]; from: Ex[] }>({ rows: [], from: [] });
  useEffect(() => {
    if (!on) { setD({ rows: [], from: [] }); return; }
    let alive = true;
    const load = () => volume(symbol, interval).then((r) => alive && setD(r)).catch(() => {});
    load();
    const t = setInterval(load, Math.min(stepOf(interval), 120) * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol, interval, on]);
  return d;
}

/* ── Крупные сделки («входы китов») ─────────────────────────────────────── */

export function useWhales(symbol: string, on: boolean) {
  const [list, setList] = useState<Trade[]>([]);
  const floor = useRef(0);

  useEffect(() => {
    if (!on) { setList([]); floor.current = 0; return; }
    let alive = true;
    /* Порог считаем по ленте самой монеты: $50k на BTC — рутина, а на мелкой
       монете — событие. Пока порога нет, крупных не показываем вовсе: лучше
       ничего, чем кружок над каждой сделкой. */
    fetchRecentTrades(symbol).then((seed) => {
      if (!alive) return;
      floor.current = whaleFloor(seed);
      setList(seed.filter((t) => t.usd >= floor.current).slice(-KEEP_WHALES));
    }).catch(() => {});

    /* Копим в ref и выкладываем в состояние два раза в секунду. На живой
       монете лента даёт десятки сообщений в секунду, и рендер на каждое — это
       те самые микрофризы: экран перерисовывается чаще, чем человек способен
       заметить, ради данных, которые всё равно видны кружками. */
    let buf: Trade[] = [];
    const off = onTrades(symbol, (batch) => {
      if (!floor.current) return;
      const big = batch.filter((t) => t.usd >= floor.current);
      if (big.length) buf = [...buf, ...big].slice(-KEEP_WHALES);
    });
    const flush = setInterval(() => {
      if (!buf.length) return;
      const add = buf; buf = [];
      setList((prev) => [...prev, ...add].slice(-KEEP_WHALES));
    }, 500);
    return () => { alive = false; off(); clearInterval(flush); };
  }, [symbol, on]);

  return { whales: list, floor: floor.current };
}

/* ── СВД (кумулятивная дельта объёма) ──────────────────────────────────────
   У Bybit исторического СВД нет ни в каком виде: есть последняя тысяча сделок
   и поток. Поэтому ряд начинается там, где его смогли начать, и панель это
   подписывает — дорисовать прошлое нечем. */

export type CvdBar = { time: number; value: number };

export function useCvd(symbol: string, interval: Interval, on: boolean) {
  const [bars, setBars] = useState<CvdBar[]>([]);
  const delta = useRef(new Map<number, number>());
  const since = useRef(0);

  useEffect(() => {
    if (!on) { setBars([]); delta.current = new Map(); since.current = 0; return; }
    let alive = true;
    delta.current = new Map();

    const add = (batch: Trade[]) => {
      batch.forEach((t) => {
        const b = bucket(t.time * 1000, interval);
        delta.current.set(b, (delta.current.get(b) || 0) + (t.buy ? t.usd : -t.usd));
      });
      if (!since.current && batch.length) since.current = batch[0].time;
      dirty = true;
    };

    /* Пересобираем ряд ДВА РАЗА В СЕКУНДУ, а не на каждую сделку. Лента живой
       монеты — десятки сообщений в секунду, и каждое тянуло за собой пересчёт
       кумулятива, рендер и setData графику. Это и есть микрофризы. */
    let dirty = false;
    const flush = setInterval(() => {
      if (!dirty || !alive) return;
      dirty = false;
      const times = [...delta.current.keys()].sort((a, b) => a - b);
      let sum = 0;
      setBars(times.map((tm) => { sum += delta.current.get(tm) || 0; return { time: tm, value: sum }; }));
    }, 500);

    fetchRecentTrades(symbol).then((seed) => { if (alive) { add(seed); } }).catch(() => {});
    const off = onTrades(symbol, add);
    return () => { alive = false; off(); clearInterval(flush); };
  }, [symbol, interval, on]);

  return { bars, since: since.current };
}

/* ── Ликвидации ─────────────────────────────────────────────────────────────
   Только поток: истории нет вовсе, и это единственная честная подпись. */

export type LiqBar = { time: number; longs: number; shorts: number };

export function useLiqs(symbol: string, interval: Interval, on: boolean) {
  const [bars, setBars] = useState<LiqBar[]>([]);
  const acc = useRef(new Map<number, LiqBar>());
  const [last, setLast] = useState<Liq | null>(null);

  useEffect(() => {
    if (!on) { setBars([]); acc.current = new Map(); setLast(null); return; }
    acc.current = new Map();
    let dirty = false, tail: Liq | null = null;
    const off = onLiquidations(symbol, (batch) => {
      batch.forEach((l) => {
        const b = bucket(l.time * 1000, interval);
        const cur = acc.current.get(b) || { time: b, longs: 0, shorts: 0 };
        if (l.long) cur.longs += l.usd; else cur.shorts += l.usd;
        acc.current.set(b, cur);
      });
      tail = batch[batch.length - 1] || tail;
      dirty = true;
    });
    // Каскад ликвидаций — это сотни событий за секунды, ровно в тот момент,
    // когда на график смотрят. Выкладываем их пачкой два раза в секунду.
    const flush = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      setBars([...acc.current.values()].sort((a, b) => a.time - b.time));
      setLast(tail);
    }, 500);
    return () => { off(); clearInterval(flush); };
  }, [symbol, interval, on]);

  return { bars, last };
}
