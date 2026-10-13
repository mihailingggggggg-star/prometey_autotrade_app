/**
 * График монеты с ПЕРЕТАСКИВАЕМОЙ линией ТП (lightweight-charts v5).
 *
 * Что здесь важно и почему:
 *
 *  • Таймфреймы 1m/5m/1h/1D. Смена ТФ и смена монеты ПЕРЕСОБИРАЮТ график
 *    целиком: у свечей разных ТФ разная ось времени, и «доклеить» новые данные
 *    к старому графику значило бы на миг показать смесь двух рядов.
 *
 *  • Линия ТП тянется за ЯВНУЮ РУЧКУ, а не «касанием рядом с линией». За этой
 *    линией стоит реальное решение о выходе: случайный мазок пальцем по графику
 *    не имеет права её двигать. Ручка — отдельный элемент, поэтому жесты самого
 *    графика (щипок, протяжка) остаются целыми.
 *
 *  • Слушаем движение на ОКНЕ, а не на ручке: ручка уезжает из-под пальца, и
 *    следующее событие прилетело бы уже другому элементу.
 *
 *  • Ручку возвращаем на МЕСТО ЛИНИИ при каждом изменении масштаба (подписка на
 *    visible logical range + ResizeObserver): иначе после протяжки она осталась
 *    бы висеть там, где была, и указывала бы не на ту цену.
 *
 *  • Под свечами — ГИСТОГРАММА ОБЪЁМА на отдельной шкале, прижатая к низу:
 *    объём должен читаться вместе со свечой, а не отбирать у неё высоту.
 *
 *  • Режим `full` — тот же график на весь экран: тянется по высоте родителя и
 *    возвращает вертикальный жест и колесо, которых у встроенного нет.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, HistogramSeries, LineStyle, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { GripHorizontal, Loader2, Maximize2 } from "lucide-react";
import { candles as fetchCandles } from "../lib/api";
import type { Candle, ChartTf, Position } from "../../shared/types";
import { cssVar } from "../ui/kit";
import { price as fmtPrice, pct } from "../lib/format";

const TFS: { id: ChartTf; label: string }[] = [
  { id: "1m", label: "1m" },
  { id: "5m", label: "5m" },
  { id: "1h", label: "1ч" },
  { id: "1d", label: "1D" },
];

/** Точность цены: дешёвые монеты нельзя схлопнуть в «0.00». Те же пороги, что
 *  в lib/format.price, чтобы подпись на оси не расходилась с текстом карточки. */
function decimalsOf(v: number): number {
  if (!v) return 2;
  if (v >= 100) return 2;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  return 8;
}

export function PriceChart({
  token, symbol, position, height = 268, onTpChange, tp2Percent = 400,
  full = false, onExpand,
}: {
  token: string;
  symbol?: string;
  position?: Position | null;
  height?: number;
  /** Сохранение перенесённой линии ТП (запрос к серверу делает вызывающий). */
  onTpChange?: (price: number) => void;
  /** Цель 2 (остаток), рост от входа в процентах. Приходит из настроек:
   *  быстрое действие обязано ставить ту же цель, что ждёт движок. */
  tp2Percent?: number;
  /** Полноэкранный режим: график тянется по высоте родителя, а навигация
   *  включает вертикальный жест и колесо — прокручивать за ним нечего. */
  full?: boolean;
  /** Показать кнопку «развернуть» (встроенный режим карточки монеты). */
  onExpand?: () => void;
}) {
  const [tf, setTf] = useState<ChartTf>("1h");
  const [data, setData] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const box = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const entryLine = useRef<IPriceLine | null>(null);
  const tpLine = useRef<IPriceLine | null>(null);
  const [ready, setReady] = useState(false);
  // Перерисовка накладки (ручки) при смене масштаба/размера: цена → экран
  // считается заново, а React об этом сам не узнаёт.
  const [geom, setGeom] = useState(0);
  const bump = useCallback(() => setGeom((v) => v + 1), []);

  const [tp, setTp] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  // Сервер — источник правды по ТП: как только позиция изменилась (докупили,
  // сработал Free Ride), линия обязана встать на server-значение.
  useEffect(() => {
    setTp(position && position.tp_price > 0 ? position.tp_price : null);
  }, [position?.id, position?.tp_price]);

  /* ── свечи ── */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    // Старый ряд убираем сразу: иначе при смене ТФ/монеты новый график на миг
    // показал бы свечи ПРЕДЫДУЩЕГО ТФ, приклеенные к новому.
    setData(null);
    fetchCandles(token, tf, 300)
      .then((rows) => { if (alive) { setData(rows); setError(null); } })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setData(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, tf]);

  /* ── сам график ── */
  useEffect(() => {
    const host = box.current;
    if (!host) return;
    const up = cssVar("--green", "#30d158");
    const down = cssVar("--red", "#ff453a");

    const c = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { color: "transparent" },
        textColor: cssVar("--label-2", "#8e8e93"),
        attributionLogo: false,
        fontFamily: "-apple-system, system-ui, sans-serif",
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,.06)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.14 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      crosshair: {
        horzLine: { labelBackgroundColor: cssVar("--tint", "#f0293f") },
        vertLine: { labelBackgroundColor: cssVar("--tint", "#f0293f") },
      },
      /* Вертикальное перетаскивание и колесо отняты во встроенном режиме:
         график живёт внутри прокручиваемого экрана, и жест вверх обязан
         прокручивать страницу, а не двигать цену. На весь экран прокручивать
         нечего — навигация включена целиком, как в терминале. */
      handleScroll: full
        ? { horzTouchDrag: true, vertTouchDrag: true, mouseWheel: true, pressedMouseMove: true }
        : { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false, pressedMouseMove: true },
      handleScale: full
        ? { pinch: true, mouseWheel: true,
            axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true }
        : { pinch: true, mouseWheel: false,
            axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true },
      kineticScroll: { touch: true, mouse: false },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderVisible: false,
      wickUpColor: up, wickDownColor: down, priceLineVisible: false,
    });
    /* Объём — гистограмма НА ПАНЕЛИ ЦЕНЫ, но на своей шкале (priceScaleId) и
       прижата к низу: он читается вместе со свечой, а не отбирает у неё высоту
       отдельной панелью. Серый — цвет тут ничего не кодирует, зелёно-красный
       спорил бы со свечами. */
    const vol = c.addSeries(HistogramSeries, {
      color: "rgba(160,160,170,.42)", priceFormat: { type: "volume" },
      priceScaleId: "vol", priceLineVisible: false, lastValueVisible: false,
    });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chart.current = c;
    series.current = s;
    volume.current = vol;
    setReady(true);

    c.subscribeCrosshairMove((param) => {
      const el = legend.current;
      if (!el) return;
      const bar = param.seriesData.get(s) as { open: number; high: number; low: number; close: number } | undefined;
      el.textContent = bar
        ? `O ${fmtPrice(bar.open)}  H ${fmtPrice(bar.high)}  L ${fmtPrice(bar.low)}  C ${fmtPrice(bar.close)}`
        : "";
    });

    const ro = new ResizeObserver(() => {
      c.applyOptions({ width: host.clientWidth, height: host.clientHeight });
      bump();
    });
    ro.observe(host);
    const onRange = () => bump();
    c.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    return () => {
      ro.disconnect();
      try { c.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch { /* уже снят */ }
      // autoSize снимаем ДО удаления: иначе внутренний наблюдатель библиотеки
      // успевает сработать по снесённому графику и пишет «Object is disposed».
      try { c.applyOptions({ autoSize: false }); } catch { /* уже снесён */ }
      try { c.remove(); } catch { /* уже снесён */ }
      chart.current = null; series.current = null;
      volume.current = null;
      entryLine.current = null; tpLine.current = null;
      setReady(false);
    };
  }, [token, tf, full, bump]);

  /* ── данные ── */
  useEffect(() => {
    const c = chart.current, s = series.current;
    if (!c || !s || !data || !data.length) return;
    const last = data[data.length - 1][4];
    const dec = decimalsOf(last);
    s.applyOptions({ priceFormat: { type: "price", precision: dec, minMove: 10 ** -dec } });
    s.setData(data.map((d) => ({
      time: d[0] as UTCTimestamp, open: d[1], high: d[2], low: d[3], close: d[4],
    })));
    // Объём: шестое поле свечи [ts, o, h, l, c, volume].
    volume.current?.setData(data.map((d) => ({
      time: d[0] as UTCTimestamp, value: d[5],
    })));
    // Последние ~90 свечей: на двух сотнях тело становится волоском.
    if (data.length > 90) {
      c.timeScale().setVisibleLogicalRange({ from: data.length - 90, to: data.length + 3 });
    } else {
      c.timeScale().fitContent();
    }
    const raf = requestAnimationFrame(bump);
    return () => cancelAnimationFrame(raf);
  }, [data, ready, bump]);

  /* ── линии входа и ТП ── */
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const entry = position?.entry_price ?? 0;

    if (entry > 0 && !entryLine.current) {
      entryLine.current = s.createPriceLine({
        price: entry, color: cssVar("--label-3", "#8e8e93"), lineWidth: 1,
        lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "вход",
      });
    }
    if (entry <= 0 && entryLine.current) {
      s.removePriceLine(entryLine.current); entryLine.current = null;
    }
    entryLine.current?.applyOptions({ price: entry });

    const p = drag ?? tp;
    // Линия ТП на графике ОДНА — это цель 2 (остаток). Подписываем явно
    // «Цель 2 (+X%)», чтобы не путать с триггером фиксации, — но ТОЛЬКО в
    // режиме free_ride. У manual-позиции никакого остатка после фиксации нет,
    // это просто «ТП». Режим хранится в note ("tp_mode=manual").
    const manual = position?.note.includes("manual") ?? false;
    const tpTitle = position && !manual && !position.free_ride_done
      ? `Цель 2 (+${Math.round(position.tp_percent)}%)`
      : "ТП";
    if (p && p > 0 && !tpLine.current) {
      tpLine.current = s.createPriceLine({
        price: p, color: cssVar("--green", "#30d158"), lineWidth: 2,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: tpTitle,
      });
    }
    if ((!p || p <= 0) && tpLine.current) {
      s.removePriceLine(tpLine.current); tpLine.current = null;
    }
    if (tpLine.current && p) tpLine.current.applyOptions({ price: p, title: tpTitle });
  }, [position?.entry_price, position?.free_ride_done, position?.tp_percent, position?.note, tp, drag, ready]);

  /* ── перетаскивание ТП ── */
  const startDrag = useCallback((e: React.PointerEvent) => {
    const host = box.current, s = series.current;
    if (!host || !s || !onTpChange) return;
    e.preventDefault();
    e.stopPropagation();
    const base = host.getBoundingClientRect();
    const priceAt = (clientY: number) => {
      const p = s.coordinateToPrice(clientY - base.top);
      return p == null ? null : +p;
    };
    const start = priceAt(e.clientY);
    setDrag(start ?? tp);

    const move = (ev: PointerEvent) => {
      const p = priceAt(ev.clientY);
      if (p != null && p > 0) {
        setDrag(p);
        // Двигаем саму линию сразу, не дожидаясь ответа сервера: иначе линия
        // отставала бы от пальца на круг запроса.
        tpLine.current?.applyOptions({ price: p });
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const p = priceAt(ev.clientY);
      setDrag(null);
      const base0 = tp ?? 0;
      // Сдвиг в доли процента — это промах, а не новая цель: сохранять его
      // незачем. Возвращаем линию на прежнюю цену.
      if (p != null && p > 0 && Math.abs(p - base0) > Math.max(base0, 1e-9) * 0.0005) {
        setTp(p);
        onTpChange(p);
      } else if (base0 > 0) {
        tpLine.current?.applyOptions({ price: base0 });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [onTpChange, tp]);

  /* ── кнопка цели 2: остаток «бесплатного полёта» ──
   * Ставим именно ЦЕЛЬ 2 (по умолчанию x5), а не +100%: триггер фиксации
   * половины двигает движок сам, и если быстрая кнопка ставила линию на его
   * уровень, остаток продавался бы сразу после фиксации — стратегия
   * Free Riding превращалась бы в обычную сделку с одной целью. */
  const entry = position?.entry_price ?? 0;
  const freeRide = () => {
    if (entry <= 0 || !onTpChange) return;
    const target = entry * (1 + tp2Percent / 100);
    setTp(target);
    onTpChange(target);
  };

  const yOf = (p: number): number | null => {
    const s = series.current;
    if (!s) return null;
    const y = s.priceToCoordinate(p);
    return y == null ? null : y;
  };

  // Ручка показывается, только если линия есть и её цена попала в поле графика.
  const shown = drag ?? tp;
  const handleY = shown && ready ? yOf(shown) : null;
  void geom; // зависимость перерисовки ручки при смене масштаба

  const up = (position?.pnl_pct ?? 0) >= 0;

  return (
    <div className={full ? "select-none h-full flex flex-col" : "select-none"}>
      {/* Тулбар: таймфреймы + быстрый ТП */}
      <div className="flex items-center gap-2 px-5 pb-2 shrink-0">
        <div className="glass glass-flat p-[3px] flex gap-[3px] rounded-[11px]">
          {TFS.map((t) => (
            <button key={t.id} onClick={() => setTf(t.id)}
                    className="relative px-3 py-1 rounded-[9px] text-[13px] font-medium"
                    style={{ color: tf === t.id ? "#fff" : "var(--label-2)",
                             background: tf === t.id ? "var(--tint-grad)" : "transparent" }}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 truncate text-[12px]" style={{ color: "var(--label-3)" }}>
          {symbol ? symbol : ""}
        </div>
        {position && onTpChange && (
          <button onClick={freeRide}
                  title={`Поставить цель 2 на +${Math.round(tp2Percent)}% от входа (остаток после фиксации половины)`}
                  className="px-2.5 py-1 rounded-[9px] text-[12px] font-semibold shrink-0"
                  style={{ background: "color-mix(in srgb, var(--green) 16%, transparent)",
                           color: "var(--green)", border: "1px solid color-mix(in srgb, var(--green) 40%, transparent)" }}>
            Цель 2 · x{(1 + tp2Percent / 100).toFixed(1)}
          </button>
        )}
        {onExpand && (
          <button onClick={onExpand} aria-label="Развернуть график на весь экран"
                  className="flex items-center justify-center w-7 h-7 rounded-[9px] shrink-0"
                  style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>
            <Maximize2 size={15} />
          </button>
        )}
      </div>

      <div className={`relative rounded-[16px] overflow-hidden glass glass-flat ${full ? "flex-1 min-h-0 mx-2" : "mx-3"}`}
           style={full ? undefined : { height }}>
        <div ref={legend}
             className="absolute left-3 top-2 z-20 text-[11px] tabular-nums pointer-events-none"
             style={{ color: "var(--label-2)" }} />

        <div ref={box} className="w-full h-full" />

        {/* Накладка: по умолчанию событий не ловит — только ручка их получает. */}
        <div className="absolute inset-0 z-10 pointer-events-none">
          {handleY != null && (
            <div onPointerDown={startDrag}
                 className="absolute left-0 right-0 pointer-events-auto"
                 style={{ top: handleY, height: 32, marginTop: -16,
                          touchAction: "none", cursor: "ns-resize" }}>
              {/* Подпись-ручка: за неё и тянут линию. */}
              <div className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-[5px] rounded-[9px]
                              text-[11px] font-bold tabular-nums flex items-center gap-1.5"
                   style={{ background: "color-mix(in srgb, var(--bg) 82%, transparent)",
                            border: "1px solid var(--green)", color: "var(--green)" }}>
                <GripHorizontal size={13} />ТП {fmtPrice(shown!)}
              </div>
            </div>
          )}

          {/* Значок «сколько уже в плюсе» на линии входа — если позиция открыта. */}
          {position && entry > 0 && ready && (() => {
            const y = yOf(entry);
            if (y == null || y < 6 || y > height - 14) return null;
            return (
              <div className="absolute left-3 -translate-y-1/2 px-2 py-[3px] rounded-full text-[11px]
                              font-bold tabular-nums"
                   style={{ top: y, color: up ? "var(--green)" : "var(--red)",
                            background: "color-mix(in srgb, var(--bg) 78%, transparent)",
                            border: `1px solid color-mix(in srgb, ${up ? "var(--green)" : "var(--red)"} 50%, transparent)` }}>
                {pct(position.pnl_pct)}
              </div>
            );
          })()}
        </div>

        {/* Состояния поверх графика: сначала загрузка, потом ошибка/пусто.
            Пустой ответ — не поломка: говорим об этом честно, а не оставляем
            голую рамку без объяснения. Пока данные в пути — индикатор загрузки;
            пришла ошибка — её текст, а не пустота. */}
        {loading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 text-[13px]"
               style={{ color: "var(--label-3)", background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}>
            <Loader2 size={16} className="animate-spin" />
            загружаем свечи…
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 z-20 flex items-center justify-center px-6 text-center text-[13px]"
               style={{ color: "var(--orange)", background: "color-mix(in srgb, var(--bg) 72%, transparent)" }}>
            {error}
          </div>
        )}
        {!loading && !error && data && data.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center px-6 text-center text-[13px]"
               style={{ color: "var(--label-3)" }}>
            по этой монете свечей в источнике нет
          </div>
        )}
      </div>
    </div>
  );
}
