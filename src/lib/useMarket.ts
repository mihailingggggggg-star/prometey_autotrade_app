/**
 * Реактивная обёртка над market.ts. Хуки держат подписку ровно на время жизни
 * экрана и отдают компонентам уже готовые числа.
 */
import { useEffect, useRef, useState } from "react";
import {
  fetchCandles, fetchTicker, feedState, onFeed, subscribe,
  type Candle, type Feed, type Interval, type Ticker,
} from "./market";

/** Состояние связи с биржей — отдельным хуком, чтобы плашку «нет связи»
 *  можно было повесить куда угодно, не таща её через пропсы. */
export function useFeed(): Feed {
  const [f, setF] = useState<Feed>(feedState);
  useEffect(() => { const off = onFeed(setF); return () => { off(); }; }, []);
  return f;
}

/**
 * Живые тикеры по списку монет. Возвращает карту символ → тикер.
 * Дельты Bybit приходят ЧАСТИЧНЫМИ (в сообщении может быть только lastPrice),
 * поэтому поля сливаются с предыдущими, а не заменяют их целиком: иначе после
 * первого же тика обнулялись бы суточный максимум и процент к суткам.
 */
export function useTickers(symbols: string[]): Record<string, Ticker> {
  const key = symbols.join(",");
  const [map, setMap] = useState<Record<string, Ticker>>({});

  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    let alive = true;

    list.forEach((s) => {
      fetchTicker(s)
        .then((t) => { if (alive && t) setMap((m) => ({ ...m, [s]: { ...m[s], ...t } })); })
        .catch(() => {});
    });

    const offs = list.map((s) =>
      subscribe(`tickers.${s}`, (d) => {
        setMap((m) => {
          const prev = m[s] || { last: 0, pct24h: 0, high24h: 0, low24h: 0, ts: 0 };
          return {
            ...m,
            [s]: {
              last: d.lastPrice !== undefined ? +d.lastPrice : prev.last,
              pct24h: d.price24hPcnt !== undefined ? +d.price24hPcnt * 100 : prev.pct24h,
              high24h: d.highPrice24h !== undefined ? +d.highPrice24h : prev.high24h,
              low24h: d.lowPrice24h !== undefined ? +d.lowPrice24h : prev.low24h,
              ts: Date.now(),
            },
          };
        });
      })
    );
    return () => { alive = false; offs.forEach((off) => off()); };
  }, [key]);

  return map;
}

export type CandleFeed = {
  candles: Candle[];
  /** Последняя свеча приходит НЕЗАКРЫТОЙ и обновляется тиками — держим её
   *  отдельно, чтобы не пересобирать весь массив на каждое движение цены. */
  live: Candle | null;
  loading: boolean;
  error: boolean;
};

export function useCandles(symbol: string, interval: Interval): CandleFeed {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [live, setLive] = useState<Candle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const last = useRef(0);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(false); setCandles([]); setLive(null); last.current = 0;

    fetchCandles(symbol, interval)
      .then((c) => {
        if (!alive) return;
        setCandles(c);
        last.current = c.length ? c[c.length - 1].time : 0;
        setLoading(false);
      })
      .catch(() => { if (alive) { setError(true); setLoading(false); } });

    const off = subscribe(`kline.${interval}.${symbol}`, (d) => {
      const k = Array.isArray(d) ? d[d.length - 1] : d;
      if (!k) return;
      const c: Candle = {
        time: Math.floor(+k.start / 1000),
        open: +k.open, high: +k.high, low: +k.low, close: +k.close,
      };
      // Закрытая свеча уезжает в историю, незакрытая живёт отдельно: график
      // обновляет одну точку, а не перерисовывает серию.
      if (k.confirm) {
        setCandles((prev) => (prev.length && c.time <= prev[prev.length - 1].time
          ? prev.map((x) => (x.time === c.time ? c : x))
          : [...prev, c]));
        last.current = Math.max(last.current, c.time);
        setLive(null);
      } else if (c.time >= last.current) {
        setLive(c);
      }
    });
    return () => { alive = false; off(); };
  }, [symbol, interval]);

  return { candles, live, loading, error };
}
