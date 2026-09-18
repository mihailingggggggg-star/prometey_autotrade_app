/**
 * useFlow.ts — хуки индикаторных данных.
 *
 * Каждый включается ОТДЕЛЬНО и только когда его панель открыта (`on`). Это не
 * экономия на спичках: лента сделок живой монеты — это десятки сообщений в
 * секунду, и держать её ради панели, которую никто не смотрит, значит греть
 * телефон и жечь трафик впустую.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle, Interval } from "./market";
import { bucket, fetchOi, fetchRecentTrades, newPositions, onLiquidations, onTrades,
         stepOf, whaleFloor, type FlowBar, type Liq, type OiPoint, type Trade } from "./flow";

/** Сколько живых сделок держим в памяти. Больше незачем: кружки китов на
 *  графике всё равно рисуются только за видимое окно. */
const KEEP_WHALES = 60;

/* ── Открытый интерес и «новые позиции» ─────────────────────────────────── */

export function useOi(symbol: string, interval: Interval, candles: Candle[], on: boolean) {
  const [oi, setOi] = useState<OiPoint[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!on) { setOi([]); return; }
    let alive = true;
    setError(false);
    fetchOi(symbol, interval).then((r) => alive && setOi(r)).catch(() => alive && setError(true));
    /* Перезапрашиваем на шаге свечи: ОИ меняется непрерывно, но точка ряда
       появляется раз в интервал — чаще опрашивать нечего. */
    const t = setInterval(() => {
      fetchOi(symbol, interval, 50).then((r) => alive && setOi((prev) => merge(prev, r)))
        .catch(() => {});
    }, Math.min(stepOf(interval), 300) * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol, interval, on]);

  const flow = useMemo<FlowBar[]>(
    () => (oi.length && candles.length ? newPositions(oi, candles) : []), [oi, candles]);
  return { oi, flow, error };
}

function merge(prev: OiPoint[], next: OiPoint[]): OiPoint[] {
  const m = new Map(prev.map((p) => [p.time, p]));
  next.forEach((p) => m.set(p.time, p));
  return [...m.values()].sort((a, b) => a.time - b.time);
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

    const off = onTrades(symbol, (batch) => {
      if (!floor.current) return;
      const big = batch.filter((t) => t.usd >= floor.current);
      if (big.length) setList((prev) => [...prev, ...big].slice(-KEEP_WHALES));
    });
    return () => { alive = false; off(); };
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
      // Кумулятив собираем на каждом обновлении: ряд короткий (десятки точек),
      // а инкрементальный пересчёт на нём стоил бы больше, чем экономил.
      const times = [...delta.current.keys()].sort((a, b) => a - b);
      let sum = 0;
      const out = times.map((tm) => { sum += delta.current.get(tm) || 0; return { time: tm, value: sum }; });
      if (alive) setBars(out);
    };

    fetchRecentTrades(symbol).then((seed) => alive && add(seed)).catch(() => {});
    const off = onTrades(symbol, add);
    return () => { alive = false; off(); };
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
    const off = onLiquidations(symbol, (batch) => {
      batch.forEach((l) => {
        const b = bucket(l.time * 1000, interval);
        const cur = acc.current.get(b) || { time: b, longs: 0, shorts: 0 };
        if (l.long) cur.longs += l.usd; else cur.shorts += l.usd;
        acc.current.set(b, cur);
      });
      setBars([...acc.current.values()].sort((a, b) => a.time - b.time));
      setLast(batch[batch.length - 1] || null);
    });
    return () => off();
  }, [symbol, interval, on]);

  return { bars, last };
}
