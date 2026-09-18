/**
 * liquidity.ts — карта ликвидности: где стоят стопы и ликвидации.
 *
 * ЧТО ЭТО ТАКОЕ И ЧЕМ НЕ ЯВЛЯЕТСЯ. Настоящих данных о том, где чьи ликвидации,
 * не публикует ни одна биржа — ни Bybit, ни Binance. Терминалы вроде Coinglass
 * строят такую карту МОДЕЛЬЮ: берут, по какой цене шли объёмы, предполагают
 * обычные плечи и считают, на какой цене такие позиции вынесет. Мы делаем ровно
 * то же, поэтому в интерфейсе это подписано «оценка», а не «данные биржи».
 *
 * Ключевая механика — РАСХОД ЛИКВИДНОСТИ. Уровень живёт, пока цена его не
 * прошла: прошла — позиции там уже вынесены, и рисовать там яркую полосу
 * значит показывать то, чего больше нет. Без этого карта превращается в
 * размазанное пятно вокруг всей истории.
 */

import type { Candle } from "./market";

/** Плечи, которые действительно используют на перпах, и их вес. Сотка редка, но
 *  именно она даёт самые заметные скопления у цены. */
/* Плечи БЕЗ десятки. Её ликвидации стоят в десяти процентах от цены, то есть
   почти всегда за краем видимого окна — в карту они попадали одной сплошной
   полосой у верхней и нижней границы и заливали половину графика ровным
   цветом. Работают те плечи, чьи выносы лежат внутри дневного хода. */
const LEVERAGE = [
  { x: 25, w: 0.30 },
  { x: 50, w: 0.34 },
  { x: 100, w: 0.36 },
];

export type LiqLevel = { price: number; long: number; short: number };

/**
 * @param candles свечи (по ним считаем и объём, и «прошла ли цена»)
 * @param bins    сколько ценовых корзин; 90 хватает, чтобы полосы не сливались
 */
export function liquidityMap(candles: Candle[], bins = 110): LiqLevel[] {
  if (candles.length < 10) return [];
  const lo = Math.min(...candles.map((c) => c.low)) * 0.985;
  const hi = Math.max(...candles.map((c) => c.high)) * 1.015;
  const step = (hi - lo) / bins;
  if (!(step > 0)) return [];
  const idx = (p: number) => Math.floor((p - lo) / step);

  /* ШАГ ПЕРВЫЙ — ГДЕ ТОРГОВАЛИ. Позиции открываются не «в среднем по свече», а
     на уровнях, где реально шла торговля: там их и много. Поэтому сначала
     строим профиль — размазываем ход каждой свечи по её диапазону, — и только
     потом считаем выносы.

     Без этого шага карта получалась ровной заливкой: у каждой свечи своя
     середина, выносы от них ложились подряд и сливались в сплошную полосу
     сверху и снизу. Профиль собирает их в узлы, и на карте появляются полосы —
     то, ради чего её и смотрят. */
  const prof = new Float64Array(bins);
  const seenAfter = new Float64Array(bins);      // когда цена в последний раз была в корзине
  candles.forEach((c, i) => {
    const a = Math.max(0, idx(c.low)), b = Math.min(bins - 1, idx(c.high));
    const share = 1 / Math.max(1, b - a + 1);
    const fresh = 0.35 + 0.65 * (i / candles.length);
    for (let k = a; k <= b; k++) {
      prof[k] += share * fresh;
      seenAfter[k] = i;                          // последний индекс свечи в этой цене
    }
  });

  /* ШАГ ВТОРОЙ — КУДА ИХ ВЫНЕСЕТ. Для каждой корзины профиля считаем цену
     ликвидации на каждом плече. Уровень, который цена УЖЕ прошла после того,
     как там набрали позиции, не рисуем: позиции там вынесены, и яркая полоса
     показывала бы то, чего больше нет. */
  const long = new Float64Array(bins);
  const short = new Float64Array(bins);
  const futHigh = new Float64Array(candles.length);
  const futLow = new Float64Array(candles.length);
  let fh = -Infinity, fl = Infinity;
  for (let i = candles.length - 1; i >= 0; i--) {
    futHigh[i] = fh; futLow[i] = fl;
    fh = Math.max(fh, candles[i].high);
    fl = Math.min(fl, candles[i].low);
  }

  for (let k = 0; k < bins; k++) {
    if (prof[k] <= 0) continue;
    const price = lo + step * (k + 0.5);
    const born = seenAfter[k] | 0;               // последняя свеча, стоявшая тут
    LEVERAGE.forEach(({ x, w }) => {
      const dn = price * (1 - 1 / x);
      const up = price * (1 + 1 / x);
      if (dn > lo && futLow[born] > dn) {
        const j = idx(dn);
        if (j >= 0 && j < bins) long[j] += prof[k] * w;
      }
      if (up < hi && futHigh[born] < up) {
        const j = idx(up);
        if (j >= 0 && j < bins) short[j] += prof[k] * w;
      }
    });
  }

  const out: LiqLevel[] = [];
  for (let k = 0; k < bins; k++) {
    if (long[k] <= 0 && short[k] <= 0) continue;
    out.push({ price: lo + step * (k + 0.5), long: long[k], short: short[k] });
  }
  const max = Math.max(...out.map((l) => l.long + l.short), 1e-12);
  /* Контраст: слабые корзины гасим сильнее сильных (степень > 1). Без этого
     карта выходит равномерно подкрашенной, а нужна обратная картина —
     несколько ярких полос там, где скопление, и пустота между ними. */
  const sharpen = (v: number) => Math.pow(Math.max(0, v), 1.9);
  return out.map((l) => ({
    price: l.price,
    long: sharpen(l.long / max),
    short: sharpen(l.short / max),
  }));
}

export function heatColor(long: number, short: number): string {
  /* Прозрачность НИЗКАЯ, и это принципиально: карта — фон, а не картинка.
     На первой версии верхний предел был 0.48, и полосы заливали половину
     графика сплошной плашкой — свечи под ней читались хуже, чем без карты
     вовсе. Здесь работает не яркость полосы, а то, что соседние полосы
     складываются: скопление само становится заметным пятном. */
  const v = Math.min(1, long + short);
  const a = 0.04 + v * 0.20;
  return long >= short
    ? `rgba(255, ${Math.round(80 + 110 * (1 - v))}, 55, ${a})`
    : `rgba(70, ${Math.round(160 + 60 * (1 - v))}, 255, ${a})`;
}

/** Ниже этого уровня полосу не рисуем вовсе: редкие одиночные ликвидации — это
 *  шум, из которого карта складывается в мутное пятно. */
export const HEAT_FLOOR = 0.07;
