/**
 * flow.ts — поток ордеров и открытый интерес: данные для индикаторных панелей
 * под графиком и для «входов китов» поверх него.
 *
 * Всё берётся напрямую у Bybit, публичными эндпоинтами, как и свечи: бот
 * торгует там же, и показывать надо ровно тот рынок, на котором исполнится
 * ордер.
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ, о котором нельзя молчать в интерфейсе: у части этих
 * данных ИСТОРИИ НЕ СУЩЕСТВУЕТ. Открытый интерес Bybit отдаёт за месяцы, а
 * ленту сделок — только последнюю тысячу, а ликвидации вообще лишь потоком в
 * реальном времени. Значит СВД и ликвидации честно начинаются с момента, когда
 * экран открыли, и панель обязана это подписывать. Дорисовать им прошлое
 * нечем, а выдумать — значит показать человеку сделки, которых не было.
 */

import { subscribe } from "./market";
import type { Interval } from "./market";

const HOSTS = ["https://api.bybit.com", "https://api.bytick.com"];

async function api(path: string): Promise<any> {
  for (let i = 0; i < HOSTS.length; i++) {
    try {
      const r = await fetch(HOSTS[i] + path, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.retCode !== 0) throw new Error(j.retMsg || "bybit error");
      return j.result;
    } catch (e) {
      if (i === HOSTS.length - 1) throw e;
    }
  }
}

/** Сколько секунд в свече — по этому шагу складываются все панели, чтобы их
 *  столбики стояли ровно под свечами, а не рядом. */
export const stepOf = (i: Interval): number =>
  ({ "5": 300, "15": 900, "60": 3600, "240": 14400 } as Record<string, number>)[i] || 300;

export const bucket = (ms: number, i: Interval): number => {
  const st = stepOf(i);
  return Math.floor(ms / 1000 / st) * st;
};

/* ── Открытый интерес ───────────────────────────────────────────────────────
   Единственный из этих рядов, у которого есть НАСТОЯЩАЯ история. */

export type OiPoint = { time: number; oi: number };

/** У ОИ свои шаги, и они не совпадают с нашими: 1м у Bybit нет вовсе. */
const OI_STEP: Record<string, string> = { "5": "5min", "15": "15min", "60": "1h", "240": "4h" };

export async function fetchOi(symbol: string, interval: Interval, limit = 200): Promise<OiPoint[]> {
  const r = await api(`/v5/market/open-interest?category=linear&symbol=${symbol}`
    + `&intervalTime=${OI_STEP[interval] || "5min"}&limit=${limit}`);
  return (r.list as any[])
    .map((x) => ({ time: Math.floor(+x.timestamp / 1000), oi: +x.openInterest }))
    .sort((a, b) => a.time - b.time);
}

/**
 * «Новые лонги» и «новые шорты» — ОЦЕНКА, и подписывать её надо оценкой.
 *
 * Прямых данных о том, кто открылся, у биржи нет ни у кого. Но есть связка,
 * которой пользуются все терминалы: изменение открытого интереса вместе с
 * направлением свечи. Открытый интерес вырос на растущей свече — в рынок
 * пришли НОВЫЕ ЛОНГИ; вырос на падающей — новые шорты; упал на растущей —
 * закрывались шорты; упал на падающей — закрывались лонги.
 *
 * Считаем в ДОЛЛАРАХ: рост ОИ на 10 000 монет ничего не говорит, пока не
 * известна цена монеты.
 */
export type FlowBar = { time: number; longs: number; shorts: number; closed: number };

export function newPositions(oi: OiPoint[], candles: { time: number; open: number; close: number }[]): FlowBar[] {
  const byTime = new Map(candles.map((c) => [c.time, c]));
  const out: FlowBar[] = [];
  for (let i = 1; i < oi.length; i++) {
    const c = byTime.get(oi[i].time);
    if (!c) continue;
    const d = (oi[i].oi - oi[i - 1].oi) * c.close;
    const up = c.close >= c.open;
    out.push({
      time: oi[i].time,
      longs: d > 0 && up ? d : 0,
      shorts: d > 0 && !up ? d : 0,
      closed: d < 0 ? -d : 0,
    });
  }
  return out;
}

/* ── Лента сделок: СВД, крупные входы ───────────────────────────────────────
   У Bybit нет исторического СВД ни в каком виде. Есть последняя тысяча сделок
   (это минуты на живой монете) и поток в реальном времени. Из них и строим,
   а панель подписываем «с момента открытия». */

export type Trade = { time: number; price: number; size: number; usd: number; buy: boolean };

export async function fetchRecentTrades(symbol: string, limit = 1000): Promise<Trade[]> {
  const r = await api(`/v5/market/recent-trade?category=linear&symbol=${symbol}&limit=${limit}`);
  return (r.list as any[])
    .map((t) => ({
      time: Math.floor(+t.time / 1000), price: +t.price, size: +t.size,
      usd: +t.price * +t.size, buy: t.side === "Buy",
    }))
    .sort((a, b) => a.time - b.time);
}

/** Поток сделок. Отдаём пачками, как приходят: на живой монете это десятки
 *  событий в секунду, и вызывать обработчик на каждую сделку значит перерисовать
 *  экран сорок раз за секунду ни для чего. */
export function onTrades(symbol: string, h: (t: Trade[]) => void): () => void {
  return subscribe(`publicTrade.${symbol}`, (data: any[]) => {
    if (!Array.isArray(data)) return;
    h(data.map((x) => ({
      time: Math.floor(+x.T / 1000), price: +x.p, size: +x.v,
      usd: +x.p * +x.v, buy: x.S === "Buy",
    })));
  });
}

/* ── Ликвидации ─────────────────────────────────────────────────────────────
   Только поток: истории нет вовсе. Снесённый лонг — это принудительная продажа,
   поэтому сторона у нас называется по позиции, а не по ордеру. */

export type Liq = { time: number; price: number; usd: number; long: boolean };

export function onLiquidations(symbol: string, h: (l: Liq[]) => void): () => void {
  return subscribe(`allLiquidation.${symbol}`, (data: any[]) => {
    if (!Array.isArray(data)) return;
    h(data.map((x) => ({
      time: Math.floor(+x.T / 1000), price: +x.p, usd: +x.p * +x.v,
      // S — сторона ОРДЕРА ликвидации: продажей закрывают лонг, покупкой шорт.
      long: x.S === "Sell",
    })));
  });
}

/* ── Скользящие средние ─────────────────────────────────────────────────────
   Считаем сами: тащить библиотеку ради двух формул незачем. EMA, а не SMA —
   по ней смотрят тренд на всех терминалах, и подмена изменила бы уровни. */

export function ema(values: { time: number; close: number }[], len: number):
    { time: number; value: number }[] {
  if (values.length < len) return [];
  const k = 2 / (len + 1);
  const out: { time: number; value: number }[] = [];
  // Первая точка — простое среднее за период: без разгона EMA первые бары
  // тянулись бы от нуля и врали бы на самом интересном участке.
  let e = values.slice(0, len).reduce((s, v) => s + v.close, 0) / len;
  out.push({ time: values[len - 1].time, value: e });
  for (let i = len; i < values.length; i++) {
    e = values[i].close * k + e * (1 - k);
    out.push({ time: values[i].time, value: e });
  }
  return out;
}

/** Порог «крупной» сделки. Считается ОТ САМОГО РЫНКА, а не константой: $50k
 *  на BTC — рутина, а на монете с оборотом в миллион — событие. Медиана
 *  устойчива к выбросам, поэтому база считается по ней. */
export function whaleFloor(trades: Trade[], mult = 25): number {
  const usd = trades.map((t) => t.usd).filter((v) => v > 0).sort((a, b) => a - b);
  if (!usd.length) return 0;
  const med = usd[Math.floor(usd.length / 2)];
  return Math.max(med * mult, 5000);
}
