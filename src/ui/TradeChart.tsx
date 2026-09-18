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
         createSeriesMarkers,
         type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useCandles } from "../lib/useMarket";
import { decimalsOf, type Candle, type Interval } from "../lib/market";
import { ema, type Trade as FlowTrade } from "../lib/flow";
import { useCvd, useLiqs, useOi, useWhales } from "../lib/useFlow";
import { money, price as fmtPrice } from "../lib/format";

/* ── Что можно показать ─────────────────────────────────────────────────── */

export type PaneKind = "oi" | "flow" | "cvd" | "liq";

export const PANES: { id: PaneKind; label: string; note: string; live?: boolean }[] = [
  { id: "oi",   label: "Открытый интерес", note: "сколько денег стоит в позициях" },
  { id: "flow", label: "Новые лонги / шорты", note: "оценка по ΔОИ и направлению свечи" },
  { id: "cvd",  label: "СВД", note: "кто агрессивнее: покупатели или продавцы", live: true },
  { id: "liq",  label: "Ликвидации", note: "кого вынесло по рынку", live: true },
];

/** Рекомендованный набор — тот, о котором просил владелец: ОИ, СВД, новые
 *  позиции и ликвидации. Порядок не случаен: сверху то, у чего есть история. */
export const PANES_DEFAULT: PaneKind[] = ["oi", "flow", "cvd", "liq"];

export type Lens = { ema50: boolean; ema200: boolean; whales: boolean };
export const LENS_OFF: Lens = { ema50: false, ema200: false, whales: false };

export type Level = {
  kind: "entry" | "tp" | "sl" | "be" | "leg";
  price: number; title: string; color: string;
  /** Уровень можно перетащить — то есть за ним стоит РЕАЛЬНАЯ заявка. */
  drag?: boolean;
};

export type Mark = {
  time: number; price: number; kind: "in" | "out";
  side: "long" | "short"; text?: string;
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
  const fitted = useRef(false);
  const drag = useRef<{ kind: Level["kind"]; price: number } | null>(null);
  const [dragging, setDragging] = useState<{ kind: Level["kind"]; price: number } | null>(null);

  const feed = useCandles(symbol, interval);
  const candles = fixed ?? feed.candles;
  const live = fixed ? null : feed.live;
  const loading = fixed ? false : feed.loading;
  const error = fixed ? false : feed.error;

  const wantOi = panes.includes("oi") || panes.includes("flow");
  const oi = useOi(symbol, interval, candles, wantOi);
  const cvd = useCvd(symbol, interval, panes.includes("cvd"));
  const liq = useLiqs(symbol, interval, panes.includes("liq"));
  const { whales } = useWhales(symbol, Boolean(lens.whales));

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
      ro?.disconnect(); c.remove();
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
      if (kind === "oi") {
        mk("oi", () => c.addSeries(LineSeries, {
          color: v("--tint", "#0a84ff"), lineWidth: 2, priceLineVisible: false,
          priceFormat: { type: "volume" },
        }, idx));
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
    requestAnimationFrame(() => {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = panes.length; i >= 1; i--) {
          try { c.panes()[i]?.setHeight(PANE_H); } catch { /* панели ещё нет */ }
        }
      }
    });
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
    lines.current.forEach((l) => s.removePriceLine(l));
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
      if (!want.some((w) => w.key === key)) { c.removeSeries(s); emas.current.delete(key); }
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

  /* ── Метки входа и выхода (закрытая сделка) ───────────────────────────── */
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const api = createSeriesMarkers(s, marks.map((m) => ({
      time: m.time as UTCTimestamp,
      // Треугольник смотрит ПО СДЕЛКЕ: вход в лонг — вверх, выход из лонга —
      // вниз. Одинаковые метки на входе и выходе не отличить, а именно это и
      // нужно прочитать с графика первым делом.
      position: (m.kind === "in") === (m.side === "long") ? "belowBar" : "aboveBar",
      shape: (m.kind === "in") === (m.side === "long") ? "arrowUp" : "arrowDown",
      color: m.kind === "in" ? v("--tint", "#0a84ff")
             : v(m.side === "long" ? "--green" : "--red", "#30d158"),
      text: m.text || (m.kind === "in" ? "вход" : "выход"),
      size: 1.4,
    })));
    return () => api.setMarkers([]);
  }, [JSON.stringify(marks), candles.length > 0]);

  /* ── Панели ───────────────────────────────────────────────────────────── */
  useEffect(() => {
    const s = paneSeries.current.get("oi");
    if (s && oi.oi.length) {
      s.setData(oi.oi.map((p) => ({ time: p.time as UTCTimestamp, value: p.oi })));
    }
    const l = paneSeries.current.get("flow:l"), sh = paneSeries.current.get("flow:s");
    if (l && sh && oi.flow.length) {
      l.setData(oi.flow.map((b) => ({ time: b.time as UTCTimestamp, value: b.longs })));
      sh.setData(oi.flow.map((b) => ({ time: b.time as UTCTimestamp, value: -b.shorts })));
    }
  }, [oi.oi, oi.flow]);

  useEffect(() => {
    const s = paneSeries.current.get("cvd");
    if (s && cvd.bars.length) s.setData(cvd.bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.value })));
  }, [cvd.bars]);

  useEffect(() => {
    const l = paneSeries.current.get("liq:l"), sh = paneSeries.current.get("liq:s");
    if (l && sh) {
      l.setData(liq.bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.longs })));
      sh.setData(liq.bars.map((b) => ({ time: b.time as UTCTimestamp, value: -b.shorts })));
    }
  }, [liq.bars]);

  /* ── Накладка: положения значков ──────────────────────────────────────────
     Считаем в одном месте и дёргаем на изменение окна, на новых данных и
     низкочастотным таймером. Через состояние React это делать нельзя: окно
     меняется на каждом кадре жеста, и перерисовка экрана сорок раз в секунду —
     ровно та работа, которой тут быть не должно. */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const bump = () => setTick((t) => (t + 1) % 1e6);
    const un = c.timeScale().subscribeVisibleLogicalRangeChange(bump);
    const iv = setInterval(bump, 250);
    return () => { clearInterval(iv); c.timeScale().unsubscribeVisibleLogicalRangeChange(un as any); };
  }, [symbol, interval, full, panes.join(",")]);

  const sync = () => setTick((t) => (t + 1) % 1e6);

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
      if (Math.abs(d.price - was) > was * 0.0002) onLevel(d.kind, d.price);
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
        {/* Крупные сделки: кружок-линза с объёмом. */}
        {lens.whales && g && whales.map((w, i) => <Whale key={`${w.time}-${i}`} w={w} g={g} />)}

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
            || (kind === "oi" && !oi.oi.length)
            || (kind === "flow" && !oi.flow.length);
          return (
            <div key={kind}>
              <div className="absolute left-1.5 text-[9px] font-semibold uppercase tracking-wide"
                   style={{ top: r.top + 2, color: "var(--label-3)" }}>
                {p.label}
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

        {/* Ручки уровней. Только у тех, за которыми стоит настоящая заявка. */}
        {onLevel && g && dragLevels.map((l) => {
          const cur = dragging?.kind === l.kind ? dragging.price : l.price;
          const raw = g.y(cur);
          if (raw == null) return null;
          /* Ручку, в отличие от значка, ПРИЖИМАЕМ к краю: за уровнем стоит
             заявка, и взять её нужно даже когда цена ушла далеко. Прижимаем к
             границам панели ЦЕНЫ — уехав ниже, ручка попала бы в панель
             индикатора, где никакой цены нет. */
          const y = Math.max(g.main.top + 14, Math.min(raw, g.main.bottom - 16));
          return (
            <div key={l.kind}
                 onPointerDown={(e) => startDrag(e, l)}
                 className="absolute right-[52px] -translate-y-1/2 px-2 py-[5px] rounded-[9px]
                            text-[11px] font-bold tabular-nums pointer-events-auto select-none
                            flex items-center gap-1"
                 style={{ top: y, background: "color-mix(in srgb, var(--bg) 72%, transparent)",
                          border: `1px solid ${l.color}`, color: l.color,
                          touchAction: "none", cursor: "ns-resize",
                          boxShadow: dragging?.kind === l.kind ? `0 0 0 4px color-mix(in srgb, ${l.color} 22%, transparent)` : "none" }}>
              <span className="opacity-70">⇅</span>{l.title} {fmtPrice(cur)}
            </div>
          );
        })}
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

/* ── Кружок крупной сделки ──────────────────────────────────────────────────
   Размер — от объёма, но в узких границах: сделка на миллион не должна
   закрывать собой полграфика. Стекло и подсветка — чтобы кружок читался
   поверх свечей, не пряча их. */
function Whale({ w, g }: { w: FlowTrade; g: any }) {
  const x = g.x(w.time), y = g.y(w.price);
  if (x == null || y == null || x < 0 || x > g.w) return null;
  const d = Math.max(18, Math.min(38, 18 + Math.log10(Math.max(w.usd, 1)) * 3));
  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full glass-lens
                    flex items-center justify-center"
         style={{ left: x, top: y, width: d, height: d,
                  borderColor: w.buy ? "color-mix(in srgb,var(--green) 60%,transparent)"
                                     : "color-mix(in srgb,var(--red) 60%,transparent)" }}>
      <span className="text-[9px] font-bold leading-none"
            style={{ color: w.buy ? "var(--green)" : "var(--red)" }}>
        {shortUsd(w.usd)}
      </span>
    </div>
  );
}

function Ruler({ marks, g }: { marks: Mark[]; g: any }) {
  const [a, b] = marks;
  const x1 = g.x(a.time), x2 = g.x(b.time), y1 = g.y(a.price), y2 = g.y(b.price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return null;
  const move = ((b.price - a.price) / a.price) * 100 * (a.side === "long" ? 1 : -1);
  const good = move >= 0;
  const col = good ? "var(--green)" : "var(--red)";
  return (
    <>
      <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth="1.2" strokeDasharray="3 3" />
      </svg>
      <div className="absolute -translate-x-1/2 -translate-y-1/2 px-1.5 py-[2px] rounded-full
                      text-[10px] font-bold tabular-nums glass-lens"
           style={{ left: (x1 + x2) / 2, top: (y1 + y2) / 2, color: col,
                    borderColor: `color-mix(in srgb, ${col} 55%, transparent)` }}>
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
