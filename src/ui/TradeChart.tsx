/**
 * TradeChart — один график на все случаи: в карточке позиции, на весь экран и
 * по закрытой сделке.
 *
 * Почему один, а не три: уровни, панели индикаторов, значок PnL и метки входа
 * с выходом нужны во всех трёх местах, и три копии этой машинерии разъехались
 * бы при первой же правке — как это уже случилось с легендой.
 *
 * Внутри lightweight-charts (TradingView, Apache-2.0). Всё, чего в нём нет —
 * перетаскивание уровней, кружки крупных сделок, значок PnL, линейка между
 * входом и выходом, — сделано НАКЛАДКОЙ НА DOM поверх канваса, а не рисованием
 * в канвасе: это позволяет и жидкое стекло, и обычные жесты браузера, и не
 * требует своего рендера на каждый кадр.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart,
         type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { GripHorizontal } from "lucide-react";
import { useCandles } from "../lib/useMarket";
import { decimalsOf, type Candle, type Interval } from "../lib/market";
import { ema, type Trade as FlowTrade } from "../lib/flow";
import { deltas, useCvd, useLiqs, useOi, useVolume, useWhales } from "../lib/useFlow";
import { liquidityMap, heatColor, HEAT_FLOOR } from "../lib/liquidity";
import { money, price as fmtPrice } from "../lib/format";

/* ── Что можно показать ─────────────────────────────────────────────────── */

export type PaneKind = "longs" | "shorts" | "oi" | "flow" | "cvd" | "liq";

export const PANES: { id: PaneKind; label: string; note: string; live?: boolean }[] = [
  { id: "longs",  label: "Лонги (ОИ)", note: "сколько денег стоит в лонгах · свечами, две биржи" },
  { id: "shorts", label: "Шорты (ОИ)", note: "сколько денег стоит в шортах · свечами, две биржи" },
  { id: "flow",   label: "Приток лонгов / шортов", note: "насколько прибавилось за свечу" },
  { id: "cvd",    label: "СВД", note: "кто агрессивнее: покупатели или продавцы", live: true },
  { id: "liq",    label: "Ликвидации", note: "кого вынесло по рынку", live: true },
  { id: "oi",     label: "Открытый интерес", note: "лонги и шорты вместе · свечами, две биржи" },
];

/** Рекомендованный набор — тот, о котором просил владелец. Порядок не
 *  случаен: сверху стороны рынка, потом их приток, внизу то, что идёт только
 *  потоком и начинается с момента открытия. */
export const PANES_DEFAULT: PaneKind[] = ["longs", "shorts", "flow", "cvd", "liq"];

export type Lens = {
  ema50: boolean; ema200: boolean; whales: boolean;
  volume: boolean; liquidity: boolean;
};
export const LENS_OFF: Lens = {
  ema50: false, ema200: false, whales: false, volume: false, liquidity: false,
};

export type Level = {
  kind: "entry" | "tp" | "sl" | "be" | "leg";
  price: number; title: string; color: string;
  /** Уровень можно перетащить — то есть за ним стоит РЕАЛЬНАЯ заявка. */
  drag?: boolean;
};

export type Mark = {
  time: number; price: number; kind: "in" | "out";
  side: "long" | "short"; text?: string;
  /** Цвет точки. Решает вызывающий: выход прибыльной сделки зелёный, убыточной
   *  красный, а знает об этом только он — графику результат неизвестен. */
  color?: string;
};

type Props = {
  symbol: string;
  interval: Interval;
  full?: boolean;
  height?: number;
  levels?: Level[];
  marks?: Mark[];
  panes?: PaneKind[];
  lens?: Lens;
  /** Нереализованный результат — значком прямо на линии входа. */
  pnl?: { usd: number; r: number } | null;
  /** Готовые свечи вместо живых (закрытая сделка: своё окно, без потока). */
  candles?: Candle[];
  onLevel?: (kind: Level["kind"], price: number) => void;
};

/* Высота панели индикатора. Узкая, но читаемая: смысл панелей в том, чтобы
   видеть их ВМЕСТЕ с ценой, а не вместо неё. */
const PANE_H = 74;

export function TradeChart({
  symbol, interval, full = false, height = 240,
  levels = [], marks = [], panes = [], lens = LENS_OFF, pnl = null,
  candles: fixed, onLevel,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const over = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<Map<string, IPriceLine>>(new Map());
  const emas = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const paneSeries = useRef<Map<string, ISeriesApi<"Histogram" | "Line">>>(new Map());
  const legend = useRef<HTMLDivElement>(null);
  const heatBox = useRef<HTMLCanvasElement>(null);
  const fitted = useRef(false);
  const drag = useRef<{ kind: Level["kind"]; price: number } | null>(null);
  const [dragging, setDragging] = useState<{ kind: Level["kind"]; price: number } | null>(null);
  /* Уровень «взят в работу»: сначала тап по линии, и только потом её можно
     тянуть. Постоянные ручки на краю графика мешали жестам и позволяли задеть
     заявку случайным мазком; тап — намеренное действие, и он же показывает,
     что линия вообще подвижна. */
  const [armed, setArmed] = useState<Level["kind"] | null>(null);

  const feed = useCandles(symbol, interval);
  const candles = fixed ?? feed.candles;
  const live = fixed ? null : feed.live;
  const loading = fixed ? false : feed.loading;
  const error = fixed ? false : feed.error;

  const wantOi = panes.includes("oi") || panes.includes("flow")
    || panes.includes("longs") || panes.includes("shorts");
  const oi = useOi(symbol, interval, wantOi);
  const cvd = useCvd(symbol, interval, panes.includes("cvd"));
  const liq = useLiqs(symbol, interval, panes.includes("liq"));
  const vol = useVolume(symbol, interval, Boolean(lens.volume));
  const { whales } = useWhales(symbol, Boolean(lens.whales));
  /* Карта ликвидности — чистый расчёт по свечам, без сети. Memo обязателен:
     пересчитывать её на каждый тик цены значит перебирать историю по десять
     раз в секунду ради картинки, которая меняется раз в свечу. */
  const heat = useMemo(
    () => (lens.liquidity ? liquidityMap(candles) : []),
    [lens.liquidity, candles.length, candles[candles.length - 1]?.close]);

  const dec = useMemo(
    () => (candles.length ? Math.max(...candles.slice(-40).map((c) => decimalsOf(c.close)), 2) : 2),
    [candles.length && candles[candles.length - 1]?.close]);

  /* ── Сам график ───────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!box.current) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const green = v("--green", "#30d158"), red = v("--red", "#ff453a");

    const c = createChart(box.current, {
      ...(full ? { autoSize: true } : { height: height + panes.length * PANE_H }),
      layout: {
        background: { color: "transparent" }, textColor: v("--label-2", "#8e8e93"),
        attributionLogo: false, fontFamily: "-apple-system, system-ui, sans-serif",
        panes: { separatorColor: "rgba(255,255,255,.10)", separatorHoverColor: "rgba(255,255,255,.2)",
                 enableResize: full },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,.06)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      crosshair: { horzLine: { labelBackgroundColor: v("--tint", "#0a84ff") },
                   vertLine: { labelBackgroundColor: v("--tint", "#0a84ff") } },
      /* Навигация зависит от режима, и это не придирка. ВСТРОЕННЫЙ график живёт
         внутри прокручиваемого экрана: вертикальное перетаскивание и колесо у
         него отняты, иначе жест вверх вместо прокрутки страницы двигал бы цену.
         НА ВЕСЬ ЭКРАН прокручивать нечего — включено всё, как в TradingView. */
      handleScroll: full
        ? { horzTouchDrag: true, vertTouchDrag: true, mouseWheel: true, pressedMouseMove: true }
        : { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false, pressedMouseMove: true },
      handleScale: full
        ? { pinch: true, mouseWheel: true,
            axisPressedMouseMove: { time: true, price: true },
            axisDoubleClickReset: { time: true, price: true } }
        : { pinch: true, mouseWheel: false, axisPressedMouseMove: false, axisDoubleClickReset: true },
      kineticScroll: { touch: true, mouse: false },
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: green, downColor: red, borderVisible: false,
      wickUpColor: green, wickDownColor: red, priceLineVisible: false,
    });
    chart.current = c;
    fitted.current = false;
    lines.current = new Map();
    emas.current = new Map();
    paneSeries.current = new Map();

    if (full) {
      c.subscribeCrosshairMove((param) => {
        const el = legend.current;
        if (!el) return;
        const b = param.seriesData.get(series.current!) as any;
        el.textContent = b
          ? `O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}  L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}`
          : "";
      });
    }

    const ro = full ? null : new ResizeObserver(() => c.applyOptions({ width: box.current!.clientWidth }));
    ro?.observe(box.current);
    return () => {
      ro?.disconnect();
      /* autoSize снимаем ДО удаления. С ним библиотека держит свой наблюдатель
         за размером контейнера, и когда React убирает контейнер из дерева,
         наблюдатель успевает сработать уже по снесённому графику — в консоль
         летит «Object is disposed» из его же внутренностей. */
      try { c.applyOptions({ autoSize: false }); } catch { /* уже снесён */ }
      try { c.remove(); } catch { /* уже снесён */ }
      chart.current = null; series.current = null;
      lines.current = new Map(); emas.current = new Map(); paneSeries.current = new Map();
    };
  }, [symbol, interval, full, height]);

  /* ── Панели индикаторов ───────────────────────────────────────────────────
     Добавляются и снимаются НА ЖИВОМ графике, а не пересборкой его целиком.
     Пересборка стоила бы дважды: у человека слетал бы масштаб (он только что
     нашёл нужное место), а сам график на миг оставался бы без свечей — и в
     этот миг автомасштаб цены успевал уехать в ноль, из-за чего вместо свечей
     оставалась одна растянутая на весь экран полоса. Так и выглядело.

     Своими pane'ами того же графика — потому что ось времени обязана быть
     ОДНОЙ. Два графика рядом рассинхронизируются на первом же жесте, и
     столбик объёма встаёт не под своей свечой. */
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const green = v("--green", "#30d158"), red = v("--red", "#ff453a");

    // Снимаем лишнее: серия выключенной панели продолжала бы обновляться.
    paneSeries.current.forEach((sr, key) => {
      const kind = key.split(":")[0] as PaneKind;
      if (!panes.includes(kind)) {
        try { c.removeSeries(sr); } catch { /* уже снята */ }
        paneSeries.current.delete(key);
      }
    });

    panes.forEach((kind, i) => {
      const idx = i + 1;
      const mk = (key: string, make: () => ISeriesApi<"Histogram" | "Line">) => {
        if (!paneSeries.current.has(key)) paneSeries.current.set(key, make());
      };
      if (kind === "longs" || kind === "shorts" || kind === "oi") {
        /* СВЕЧАМИ, а не линией: у открытого интереса внутри свечи есть свой ход,
           и именно он показывает, набирали позицию плавно или вынесли рывком.
           Линия этот рывок прячет — остаётся одна точка закрытия. */
        const col = kind === "longs" ? green : kind === "shorts" ? red : v("--tint", "#f0293f");
        const dim = kind === "longs" ? "#1d7a3a" : kind === "shorts" ? "#8f2018" : "#7a1420";
        mk(kind, () => c.addSeries(CandlestickSeries, {
          upColor: col, downColor: dim, borderVisible: false,
          wickUpColor: col, wickDownColor: dim,
          priceLineVisible: false, priceFormat: { type: "volume" },
        }, idx) as unknown as ISeriesApi<"Histogram" | "Line">);
      } else if (kind === "flow") {
        mk("flow:l", () => c.addSeries(HistogramSeries, {
          color: green, priceFormat: { type: "volume" }, priceLineVisible: false }, idx));
        mk("flow:s", () => c.addSeries(HistogramSeries, {
          color: red, priceFormat: { type: "volume" }, priceLineVisible: false }, idx));
      } else if (kind === "cvd") {
        mk("cvd", () => c.addSeries(LineSeries, {
          color: v("--orange", "#ff9f0a"), lineWidth: 2, priceLineVisible: false,
          priceFormat: { type: "volume" } }, idx));
      } else if (kind === "liq") {
        mk("liq:l", () => c.addSeries(HistogramSeries, {
          color: red, priceFormat: { type: "volume" }, priceLineVisible: false }, idx));
        mk("liq:s", () => c.addSeries(HistogramSeries, {
          color: green, priceFormat: { type: "volume" }, priceLineVisible: false }, idx));
      }
    });

    // Встроенный график тянется под число панелей: они не должны отбирать
    // высоту у цены — она здесь главная.
    if (!full) c.applyOptions({ height: height + panes.length * PANE_H });

    /* Высоты панелей. Задаём СНИЗУ ВВЕРХ и дважды, и это не суеверие: график
       нормирует сумму высот под свой размер, то есть каждый вызов слегка
       раздаёт остаток соседям. При проходе сверху вниз весь остаток доставался
       последней панели — «Ликвидации» выходили втрое выше открытого интереса
       просто потому, что стояли внизу. Панель цены не трогаем вовсе: ей
       достаётся то, что осталось, и это правильный порядок — цена главная. */
    const raf = requestAnimationFrame(() => {
      /* График мог быть пересобран за этот кадр (смена таймфрейма, уход с
         экрана). Обращение к снесённому бросает «Object is disposed» уже
         ВНУТРИ библиотеки, мимо нашего try, поэтому проверяем, что перед нами
         всё ещё тот же график. */
      if (chart.current !== c) return;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = panes.length; i >= 1; i--) {
          try { c.panes()[i]?.setHeight(PANE_H); } catch { /* панели ещё нет */ }
        }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [panes.join(","), full, height]);

  /* ── Свечи ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const s = series.current;
    if (!s || !candles.length) return;
    s.applyOptions({ priceFormat: { type: "price", precision: dec, minMove: 10 ** -dec } });
    s.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    if (!fitted.current && chart.current) {
      // Закрытой сделке показываем ВСЁ её окно, живой — последние ~70 свечей:
      // на двух сотнях тело свечи становится волоском.
      if (fixed) chart.current.timeScale().fitContent();
      else chart.current.timeScale().setVisibleLogicalRange(
        { from: candles.length - 70, to: candles.length + 3 });
      fitted.current = true;
    }
  }, [candles, dec, fixed]);

  useEffect(() => {
    if (live && series.current) series.current.update({ ...live, time: live.time as UTCTimestamp });
  }, [live]);

  /* ── Уровни сделки ────────────────────────────────────────────────────── */
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    try { lines.current.forEach((l) => s.removePriceLine(l)); } catch { /* снят */ }
    lines.current = new Map();
    levels.filter((l) => l.price > 0).forEach((l, i) => {
      lines.current.set(`${l.kind}:${i}`, s.createPriceLine({
        price: l.price, color: l.color, lineWidth: 1,
        lineStyle: l.kind === "entry" ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true, title: l.title,
      }));
    });
    sync();
  }, [JSON.stringify(levels), candles.length > 0]);

  /* ── Линзы: EMA ───────────────────────────────────────────────────────── */
  useEffect(() => {
    const c = chart.current;
    if (!c || !candles.length) return;
    const css = getComputedStyle(document.documentElement);
    const want: { key: string; len: number; color: string }[] = [
      ...(lens.ema50 ? [{ key: "ema50", len: 50, color: css.getPropertyValue("--yellow").trim() || "#ffd60a" }] : []),
      ...(lens.ema200 ? [{ key: "ema200", len: 200, color: "#0a84ff" }] : []),
    ];
    // Снимаем то, что выключили: серия, оставшаяся на графике, продолжала бы
    // обновляться и врать про включённую линзу.
    emas.current.forEach((s, key) => {
      if (!want.some((w) => w.key === key)) {
        try { c.removeSeries(s); } catch { /* снят вместе с графиком */ }
        emas.current.delete(key);
      }
    });
    want.forEach(({ key, len, color }) => {
      let s = emas.current.get(key);
      if (!s) {
        s = c.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false,
                                      lastValueVisible: false, crosshairMarkerVisible: false }, 0);
        emas.current.set(key, s);
      }
      s.applyOptions({ color });
      s.setData(ema(candles, len).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    });
  }, [lens.ema50, lens.ema200, candles]);

  /* Метки входа и выхода рисуются НАКЛАДКОЙ, а не маркерами библиотеки.
     Причина простая: маркер библиотеки крепится к свече — «над баром» или
     «под баром», — то есть по цене он стоит не там, где сделка. На спокойном
     участке разница невелика, а на широкой свече вход уезжает на половину её
     тела, и график показывает не ту цену, по которой вы вошли. Накладка
     считает и время, и цену через те же координаты, что и всё остальное
     поверх графика, поэтому точка стоит ровно на пересечении. */

  /* ── Данные панелей ───────────────────────────────────────────────────── */
  useEffect(() => {
    const put = (key: string, rows: { time: number }[]) => {
      const sr = paneSeries.current.get(key);
      if (!sr || !rows.length) return;
      try { sr.setData(rows.map((r) => ({ ...r, time: r.time as UTCTimestamp })) as any); }
      catch { /* серия уже снята вместе с графиком */ }
    };
    put("longs", oi.longs);
    put("shorts", oi.shorts);
    put("oi", oi.total);

    /* Приток: прибавку лонгов рисуем вверх, прибавку шортов — вниз. Отток тоже
       виден: у лонгов он уходит вниз, у шортов вверх — то есть столбик всегда
       читается как «чья сторона выросла». */
    const dl = paneSeries.current.get("flow:l"), ds = paneSeries.current.get("flow:s");
    if (dl && ds) try {
      dl.setData(deltas(oi.longs).map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
      ds.setData(deltas(oi.shorts).map((d) => ({ time: d.time as UTCTimestamp, value: -d.value })));
    } catch { /* серия уже снята */ }
  }, [oi.longs, oi.shorts, oi.total]);

  useEffect(() => {
    const s = paneSeries.current.get("cvd");
    if (s && cvd.bars.length) try {
      s.setData(cvd.bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.value })));
    } catch { /* серия уже снята */ }
  }, [cvd.bars]);

  useEffect(() => {
    const l = paneSeries.current.get("liq:l"), sh = paneSeries.current.get("liq:s");
    if (l && sh) try {
      l.setData(liq.bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.longs })));
      sh.setData(liq.bars.map((b) => ({ time: b.time as UTCTimestamp, value: -b.shorts })));
    } catch { /* серия уже снята */ }
  }, [liq.bars]);

  /* ── Объём под ценой ────────────────────────────────────────────────────
     Гистограмма НА ПАНЕЛИ ЦЕНЫ, но на своей шкале (priceScaleId) и прижата к
     низу: объём должен читаться вместе со свечой, а не отбирать у неё высоту
     отдельной панелью. Серый — потому что цвет тут ничего не кодирует, а
     зелёно-красный спорил бы со свечами. */
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const has = paneSeries.current.get("vol");
    if (!lens.volume) {
      if (has) { try { c.removeSeries(has); } catch { /* уже снята */ } paneSeries.current.delete("vol"); }
      return;
    }
    let sr = has;
    try {
    if (!sr) {
      sr = c.addSeries(HistogramSeries, {
        color: "rgba(160,160,170,.42)", priceFormat: { type: "volume" },
        priceScaleId: "vol", priceLineVisible: false, lastValueVisible: false,
      }, 0);
      c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      paneSeries.current.set("vol", sr);
    }
    if (vol.rows.length) {
      sr.setData(vol.rows.map((b) => ({ time: b.time as UTCTimestamp, value: b.usd })));
    }
    } catch { /* график снесён между тактами — объём подождёт следующего */ }
  }, [lens.volume, vol.rows]);

  /* ── Накладка: положения значков ──────────────────────────────────────────
     Считаем в одном месте и дёргаем на изменение окна, на новых данных и
     низкочастотным таймером. Через состояние React это делать нельзя: окно
     меняется на каждом кадре жеста, и перерисовка экрана сорок раз в секунду —
     ровно та работа, которой тут быть не должно. */
  const [tick, setTick] = useState(0);
  /* Тик нужен ТОЛЬКО тем, кто рисуется поверх графика. Нет ни взятого уровня,
     ни значка PnL, ни кружков, ни карты — нет и перерисовок: раньше экран
     обновлялся четыре раза в секунду всегда, даже когда поверх графика не было
     ничего. Это и были микрофризы на слабом телефоне. */
  const needTick = Boolean(armed || pnl || lens.whales || lens.liquidity || marks.length);
  useEffect(() => {
    const c = chart.current;
    if (!c || !needTick) return;
    const bump = () => setTick((t) => (t + 1) % 1e6);
    const un = c.timeScale().subscribeVisibleLogicalRangeChange(bump);
    const iv = setInterval(bump, 400);
    return () => { clearInterval(iv); c.timeScale().unsubscribeVisibleLogicalRangeChange(un as any); };
  }, [symbol, interval, full, panes.join(","), needTick]);

  const sync = () => setTick((t) => (t + 1) % 1e6);

  /* Рисуем карту при каждом изменении окна: полосы привязаны к ЦЕНЕ, а не к
     пикселям, и при сдвиге шкалы обязаны ехать вместе с ней. */
  useEffect(() => {
    const cv = heatBox.current, host = box.current;
    if (!cv || !host || !lens.liquidity) return;
    const gg = geom();
    if (!gg || !heat.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = host.clientWidth, hh = host.clientHeight;
    if (cv.width !== w * dpr || cv.height !== hh * dpr) {
      cv.width = w * dpr; cv.height = hh * dpr;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const stepPx = heat.length > 1
      ? Math.abs((gg.y(heat[1].price) || 0) - (gg.y(heat[0].price) || 0)) : 4;
    heat.forEach((l) => {
      if (l.long + l.short < HEAT_FLOOR) return;
      const y = gg.y(l.price);
      // Полосу за пределами панели цены не рисуем: она попала бы в панель
      // индикатора, где никакой цены нет.
      if (y == null || y < gg.main.top || y > gg.main.bottom) return;
      ctx.fillStyle = heatColor(l.long, l.short);
      ctx.fillRect(0, y - stepPx / 2, w, Math.max(1.5, stepPx));
    });
  }, [heat, tick, lens.liquidity, full, height, panes.join(",")]);

  /* Тап ловит САМ ГРАФИК (subscribeClick), а не прозрачная полоса поверх него.
     Полоса перехватывала бы и протяжку времени на высоте линии — то есть
     ломала бы обычную навигацию ради редкого действия. */
  useEffect(() => {
    const c = chart.current;
    if (!c || !onLevel) return;
    const near = (param: any) => {
      if (!param?.point) { setArmed(null); return; }
      const gg = geom();
      if (!gg) return;
      const y = param.point.y + gg.main.top;
      let best: Level["kind"] | null = null;
      let bestD = 16;                     // палец толще линии — 16px по вертикали
      levels.filter((l) => l.drag && l.price > 0).forEach((l) => {
        const ly = gg.y(l.price);
        if (ly == null) return;
        const d = Math.abs(ly - y);
        if (d < bestD) { bestD = d; best = l.kind; }
      });
      // Повторный тап по той же линии снимает её с ручки: иначе снять уровень
      // можно было бы только промахом, а промах — плохой способ управления.
      setArmed((cur) => (best && cur === best ? null : best));
    };
    c.subscribeClick(near);
    return () => c.unsubscribeClick(near);
  }, [JSON.stringify(levels), onLevel, panes.join(",")]);

  /* Геометрия накладки. Всё считается ОТ pane 0: у каждой панели своя система
     координат, и цена живёт только в первой. Границы панелей берём у самого
     графика, а не считаем из высот: он их распределяет сам, и наша арифметика
     разъезжалась бы с ним на каждом изменении размера. */
  const geom = () => {
    const c = chart.current, s = series.current, host = box.current;
    if (!c || !s || !host) return null;
    const base = host.getBoundingClientRect();
    const rect = (i: number) => {
      const el = c.panes()[i]?.getHTMLElement();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top - base.top, bottom: r.bottom - base.top, h: r.height };
    };
    const main = rect(0) || { top: 0, bottom: host.clientHeight, h: host.clientHeight };
    return {
      y: (p: number) => { const y = s.priceToCoordinate(p); return y == null ? null : y + main.top; },
      p: (y: number) => s.coordinateToPrice(y - main.top),
      x: (t: number) => c.timeScale().timeToCoordinate(t as UTCTimestamp),
      w: host.clientWidth,
      main,
      pane: rect,
    };
  };
  const g = geom();

  /* ── Перетаскивание уровня ──────────────────────────────────────────────
     Не «поймать касание рядом с линией», а ЯВНАЯ РУЧКА на краю графика.
     Причин две. Во-первых, за этими линиями стоят настоящие заявки на бирже, и
     случайный мазок пальцем по графику не имеет права двигать стоп. Во-вторых,
     жесты самого графика (щипок, протяжка) остаются целыми: ручка — отдельный
     элемент, и график про неё не знает. */
  const startDrag = (e: React.PointerEvent, l: Level) => {
    if (!onLevel) return;
    e.stopPropagation();
    drag.current = { kind: l.kind, price: l.price };
    setDragging({ kind: l.kind, price: l.price });

    /* Слушаем движение НА ОКНЕ, а не на самой ручке, и это не перестраховка:
       ручка едет за пальцем, то есть уходит из-под него, и следующее событие
       прилетело бы уже другому элементу. Захват указателя решал бы то же, но
       он есть не во всех webview и падает на синтетических событиях. */
    const move = (ev: PointerEvent) => {
      if (!drag.current || !box.current) return;
      const gg = geom();
      if (!gg) return;
      const y = ev.clientY - box.current.getBoundingClientRect().top;
      const np = gg.p(y);
      if (np == null || +np <= 0) return;
      drag.current = { ...drag.current, price: +np };
      setDragging({ ...drag.current });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const d = drag.current;
      drag.current = null;
      setDragging(null);
      if (!d) return;
      const was = levels.find((x) => x.kind === d.kind)?.price || 0;
      // Мазок в пару пикселей — это промах, а не заявка: отправлять на биржу
      // «перенос» на нулевое расстояние незачем.
      if (Math.abs(d.price - was) > was * 0.0002) { onLevel(d.kind, d.price); setArmed(null); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const dragLevels = levels.filter((l) => l.drag && l.price > 0);

  return (
    <div className={full ? "relative h-full" : "relative"}>
      {full && (
        <div ref={legend}
             className="absolute left-2 top-1 z-20 text-[11px] tabular-nums pointer-events-none"
             style={{ color: "var(--label-2)" }} />
      )}

      <div ref={box} className={full ? "w-full h-full" : "w-full"}
           style={full ? undefined : { minHeight: height }} />

      {/* Накладка. pointer-events по умолчанию нет: она не должна перехватывать
          жесты графика — только собственные ручки их получают. */}
      <div ref={over} className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
        {/* Карта ликвидности — канвасом, а не сотней div-ов: девяносто полос в
            DOM пересчитывались бы вёрсткой на каждом жесте. */}
        {/* screen: тёмные полосы исчезают сами, светлые только подсвечивают —
            свечи под картой остаются читаемыми. */}
        {lens.liquidity && (
          <canvas ref={heatBox} className="absolute inset-0 w-full h-full"
                  style={{ mixBlendMode: "screen" }} />
        )}
        {/* Крупные сделки: кружок-линза с объёмом. */}
        {lens.whales && g && (() => {
          /* Подписываем не все: сумма у каждой точки — это снова сплошная
             стена текста. Берём порог по САМОЙ ленте (шестая по величине из
             видимых), поэтому на спокойной монете подписаны почти все, а на
             потоке — только то, что действительно выделяется. */
          const big = [...whales].sort((a, b) => b.usd - a.usd)[5]?.usd ?? 0;
          return whales.map((w, i) => (
            <Whale key={`${w.time}-${i}`} w={w} g={g} label={w.usd >= big} />
          ));
        })()}

        {/* Значок PnL прямо на линии входа: «в рынке и сколько» — первое, что
            нужно увидеть, а не то, за чем лезут в цифры. */}
        {pnl && g && (() => {
          const entry = levels.find((l) => l.kind === "entry");
          const y = entry ? g.y(entry.price) : null;
          // Линия входа уехала за край цены — значка нет. Прилипший к краю
          // значок показывал бы результат не на своём месте, а это вранье; а
          // уехав ниже, он оказался бы внутри панели индикатора.
          if (y == null || y < g.main.top + 8 || y > g.main.bottom - 12) return null;
          const up = pnl.usd >= 0;
          return (
            <div className="absolute left-2 -translate-y-1/2 px-2 py-[3px] rounded-full text-[11px]
                            font-bold tabular-nums glass-lens"
                 style={{ top: y, color: up ? "var(--green)" : "var(--red)",
                          borderColor: up ? "color-mix(in srgb,var(--green) 55%,transparent)"
                                          : "color-mix(in srgb,var(--red) 55%,transparent)" }}>
              {money(pnl.usd, true)} · {pnl.r >= 0 ? "+" : ""}{pnl.r.toFixed(2)}R
            </div>
          );
        })()}

        {/* Точки входа и выхода — ровно на пересечении своей цены и своего
            времени. */}
        {g && marks.map((m, i) => <TradeDot key={`${m.kind}-${i}`} m={m} g={g} />)}

        {/* Линейка между входом и выходом закрытой сделки: расстояние в
            процентах — то, ради чего на такой график и смотрят. */}
        {marks.length === 2 && g && <Ruler marks={marks} g={g} />}

        {/* Подписи панелей. Без них панель с цифрами «463K» не отличить от
            панели с цифрами «4.4K»: обе просто линии под графиком. */}
        {g && panes.map((kind, i) => {
          const r = g.pane(i + 1);
          if (!r) return null;
          const p = PANES.find((x) => x.id === kind)!;
          const empty = (kind === "cvd" && !cvd.bars.length)
            || (kind === "liq" && !liq.bars.length)
            || (kind === "oi" && !oi.total.length)
            || (kind === "longs" && !oi.longs.length)
            || (kind === "shorts" && !oi.shorts.length)
            || (kind === "flow" && oi.longs.length < 2);
          return (
            <div key={kind}>
              <div className="absolute left-1.5 text-[9px] font-semibold uppercase tracking-wide"
                   style={{ top: r.top + 2, color: "var(--label-3)" }}>
                {p.label}
                {/* С КАКИХ БИРЖ. Если Binance не ответил (в части стран он
                    отдаёт отказ), человек обязан это видеть: иначе он примет
                    половину рынка за весь рынок. */}
                {["longs", "shorts", "oi", "flow"].includes(kind) && (
                  <span style={{ color: oi.from.length > 1 ? "var(--label-3)" : "var(--orange)" }}>
                    {" · "}{oi.from.length ? oi.from.join(" + ") : "нет данных"}
                  </span>
                )}
              </div>
              {/* Пустая панель без объяснения читается как поломка. А у СВД и
                  ликвидаций пусто — нормальное состояние: истории у них нет
                  вовсе, ряд начинается с момента открытия графика. */}
              {empty && (
                <div className="absolute left-0 right-0 text-center text-[10px]"
                     style={{ top: r.top + r.h / 2 - 6, color: "var(--label-3)" }}>
                  {p.live ? "идёт с момента открытия — событий ещё не было" : "биржа не ответила"}
                </div>
              )}
            </div>
          );
        })}

        {/* Взятый в работу уровень: подсветка линии во всю ширину и ручка на
            ней. Тянется САМА ЛИНИЯ — палец может взяться где угодно на ней. */}
        {onLevel && g && dragLevels.filter((l) => l.kind === armed).map((l) => {
          const cur = dragging?.kind === l.kind ? dragging.price : l.price;
          const raw = g.y(cur);
          if (raw == null) return null;
          /* Ручку, в отличие от значка, ПРИЖИМАЕМ к краю: за уровнем стоит
             заявка, и взять её нужно даже когда цена ушла далеко. Прижимаем к
             границам панели ЦЕНЫ — уехав ниже, ручка попала бы в панель
             индикатора, где никакой цены нет. */
          const y = Math.max(g.main.top + 14, Math.min(raw, g.main.bottom - 16));
          const hot = dragging?.kind === l.kind;
          return (
            <div key={l.kind} onPointerDown={(e) => startDrag(e, l)}
                 className="absolute left-0 right-0 pointer-events-auto select-none"
                 style={{ top: y, height: 30, marginTop: -15, touchAction: "none",
                          cursor: "ns-resize" }}>
              {/* Сама линия: рисуем поверх графиковой, чтобы было видно, что
                  именно взято. */}
              <div className="absolute left-0 right-0" style={{
                     top: 14, height: 2, background: l.color,
                     boxShadow: `0 0 10px 1px color-mix(in srgb, ${l.color} 55%, transparent)` }} />
              <div className="absolute right-[52px] top-1/2 -translate-y-1/2 px-2 py-[5px] rounded-[9px]
                              text-[11px] font-bold tabular-nums flex items-center gap-1.5"
                   style={{ background: "color-mix(in srgb, var(--bg) 82%, transparent)",
                            border: `1px solid ${l.color}`, color: l.color,
                            boxShadow: hot ? `0 0 0 5px color-mix(in srgb, ${l.color} 20%, transparent)` : "none" }}>
                <GripHorizontal size={13} />{l.title} {fmtPrice(cur)}
              </div>
            </div>
          );
        })}

        {/* Подсказка появляется ровно один раз — в момент, когда уровень взят.
            Постоянная строка внизу графика съедала бы место ради того, что
            нужно узнать однажды. */}
        {armed && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-1 px-2 py-[3px] rounded-full
                          text-[10px] glass-lens whitespace-nowrap"
               style={{ color: "var(--label-2)" }}>
            тяните линию · повторный тап отменяет
          </div>
        )}
      </div>

      {(loading || error) && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]"
             style={{ color: "var(--label-2)" }}>
          {error ? "Свечи недоступны — биржа не ответила" : "Загружаем свечи…"}
        </div>
      )}
    </div>
  );
}

/* ── Крупная сделка: точка ──────────────────────────────────────────────────
   Раньше это был кружок 18–38px с суммой внутри, и на живой монете он
   закрывал собой свечи: в ленте десятки крупных сделок в минуту, кружки
   налезали друг на друга, и график под ними было не разобрать.

   Теперь метка — ТОЧКА в 6px точно на цене и времени сделки, а сумма стоит
   подписью РЯДОМ и только у самых крупных. Размер точки чуть растёт с
   объёмом, но в узких границах: её работа — показать место, а не кричать.
   Свечение вместо обводки — точка читается поверх свечи, не выедая её. */
function Whale({ w, g, label }: { w: FlowTrade; g: any; label: boolean }) {
  const x = g.x(w.time), y = g.y(w.price);
  if (x == null || y == null || x < 0 || x > g.w) return null;
  const d = Math.max(5, Math.min(9, 4 + Math.log10(Math.max(w.usd, 1))));
  const col = w.buy ? "var(--green)" : "var(--red)";
  return (
    <div className="absolute pointer-events-none" style={{ left: x, top: y }}>
      <span className="absolute rounded-full"
            style={{ width: d, height: d, marginLeft: -d / 2, marginTop: -d / 2,
                     background: col,
                     boxShadow: `0 0 0 1.5px rgba(0,0,0,.55), 0 0 8px 1px color-mix(in srgb, ${col} 55%, transparent)` }} />
      {label && (
        /* Подпись слева от точки: справа у графика идёт шкала цены и последние
           свечи — самое ценное место, и закрывать его суммой нельзя. */
        <span className="absolute text-[9px] font-semibold tabular-nums whitespace-nowrap"
              style={{ right: d, top: -7, paddingRight: 4, color: col,
                       textShadow: "0 1px 3px rgba(0,0,0,.9)" }}>
          {shortUsd(w.usd)}
        </span>
      )}
    </div>
  );
}

/* ── Точка входа или выхода ────────────────────────────────────────────────
   Точка, а не стрелка. Стрелка библиотеки крепится к свече сверху или снизу и
   по цене врёт; к тому же на закрытой сделке важны ДВА числа — где вошли и
   где вышли, — а треугольник показывает только направление.

   Кольцо вокруг точки тёмное: на зелёной свече зелёная точка выхода без него
   сливается со свечой. */
function TradeDot({ m, g }: { m: Mark; g: any }) {
  const x = g.x(m.time), y = g.y(m.price);
  if (x == null || y == null) return null;
  if (y < g.main.top - 4 || y > g.main.bottom + 4) return null;
  const col = m.color || (m.kind === "in" ? "var(--label)" : "var(--label-2)");
  return (
    <div className="absolute pointer-events-none" style={{ left: x, top: y }}>
      <span className="absolute rounded-full"
            style={{ width: 11, height: 11, marginLeft: -5.5, marginTop: -5.5,
                     background: col, border: "2px solid rgba(0,0,0,.72)",
                     boxShadow: `0 0 9px 1px color-mix(in srgb, ${col} 60%, transparent)` }} />
      <span className="absolute text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
            style={{ left: -6, top: m.kind === "in" ? 9 : -22, color: col,
                     textShadow: "0 1px 3px rgba(0,0,0,.9)" }}>
        {m.text || (m.kind === "in" ? "вход" : "выход")}
      </span>
    </div>
  );
}

/* ── Линейка сделки ────────────────────────────────────────────────────────
   Расстояние между входом и выходом — это разница ЦЕН, то есть величина
   вертикальная. Прежняя диагональ от точки к точке показывала не её: наклон
   зависел от того, сколько сделка длилась и как растянут график, и одна и та
   же сделка выглядела то крутой, то пологой. Читалась она вдобавок как
   траектория цены, которой не было.

   Поэтому теперь: две горизонтали по ценам входа и выхода и вертикальная
   линейка сбоку между ними. Сбоку — справа от выхода, а если там уже нет
   места, слева от входа; по диагонали не рисуем никогда. */
function Ruler({ marks, g }: { marks: Mark[]; g: any }) {
  const [a, b] = marks;
  const x1 = g.x(a.time), x2 = g.x(b.time), y1 = g.y(a.price), y2 = g.y(b.price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return null;
  const move = ((b.price - a.price) / a.price) * 100 * (a.side === "long" ? 1 : -1);
  const good = move >= 0;
  const col = good ? "var(--green)" : "var(--red)";

  const GAP = 30;
  const right = x2 + GAP < g.w - 44;
  const rail = right ? Math.min(x2 + GAP, g.w - 44) : Math.max(x1 - GAP, 10);
  const from = Math.min(x1, x2, rail), to = Math.max(x1, x2, rail);

  /* Линейка ОБРЕЗАЕТСЯ панелью цены. Уровень сделки легко оказывается за
     видимым диапазоном — стоит отлистать историю или приблизить свечи, — и
     без обрезки линейка уходила бы на сотни пикселей вниз, через панели
     индикаторов и за край карточки. На снимке это выглядело сплошной чертой
     поперёк всего графика. Число при этом остаётся верным: оно посчитано по
     ценам, а не по пикселям. */
  const lo = g.main.top + 6, hi = g.main.bottom - 6;
  const fit = (y: number) => Math.max(lo, Math.min(hi, y));
  const c1 = fit(y1), c2 = fit(y2);
  const vis = (y: number) => y >= lo && y <= hi;
  const top = Math.min(c1, c2), bot = Math.max(c1, c2);

  return (
    <>
      <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
        {/* Горизонтали уровней входа и выхода — тонкие и пунктирные: это
            вспомогательные линии, а не уровни заявок. Уровень за пределами
            видимой цены не рисуем вовсе: прижатая к краю линия показывала бы
            цену не там, где она есть. */}
        {vis(y1) && (
          <line x1={from} y1={y1} x2={to} y2={y1} stroke={col} strokeWidth="1"
                strokeDasharray="3 4" opacity="0.5" />
        )}
        {vis(y2) && (
          <line x1={from} y1={y2} x2={to} y2={y2} stroke={col} strokeWidth="1"
                strokeDasharray="3 4" opacity="0.5" />
        )}
        {/* Сама линейка. Шляпка ставится только на том конце, который виден:
            на обрезанном её не будет — там линейка продолжается за экран, и
            шляпка соврала бы, что это и есть уровень. */}
        <line x1={rail} y1={top} x2={rail} y2={bot} stroke={col} strokeWidth="1.4" />
        {vis(y1) && (
          <line x1={rail - 4} y1={c1} x2={rail + 4} y2={c1} stroke={col} strokeWidth="1.4" />
        )}
        {vis(y2) && (
          <line x1={rail - 4} y1={c2} x2={rail + 4} y2={c2} stroke={col} strokeWidth="1.4" />
        )}
      </svg>
      <div className="absolute -translate-y-1/2 px-1.5 py-[2px] rounded-full
                      text-[10px] font-bold tabular-nums glass-lens"
           style={{ [right ? "left" : "right"]: right ? rail + 6 : g.w - rail + 6,
                    top: (top + bot) / 2, color: col,
                    borderColor: `color-mix(in srgb, ${col} 55%, transparent)` } as React.CSSProperties}>
        {good ? "+" : ""}{move.toFixed(2)}%
      </div>
    </>
  );
}

function shortUsd(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
