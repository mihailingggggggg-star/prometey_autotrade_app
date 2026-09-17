import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CandlestickSeries, createChart, LineStyle,
         type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { ChevronLeft, Inbox, Maximize2, OctagonX, SlidersHorizontal, TrendingDown, TrendingUp, X } from "lucide-react";
import { Glass, Modal, Press, Sheet, Title, tone, SPRING } from "../ui/kit";
import { useApp, posPnl } from "../lib/store";
import type { Position } from "../lib/mock";
import { money, price, pct, rr, ago } from "../lib/format";
import { haptic } from "../lib/tg";
import { useCandles, useTickers } from "../lib/useMarket";
import { decimalsOf, INTERVALS, type Interval } from "../lib/market";

export function Market() {
  const { positions, feed } = useApp();
  const [open, setOpen] = useState<Position | null>(null);
  const live = positions.find((p) => p.id === open?.id) || null;

  return (
    <div className="pb-2">
      <Title sub={feed === "live" ? "Цены Bybit · в реальном времени"
                : feed === "connecting" ? "подключаемся к бирже…"
                : "нет связи с биржей — цены могли устареть"}>Рынок</Title>

      {!positions.length && (
        <div className="px-4">
          <Glass className="p-8 text-center">
            <Inbox size={34} className="mx-auto mb-3" style={{ color: "var(--label-3)" }} />
            <div className="text-[17px] font-semibold">Открытых позиций нет</div>
            <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
              Бот ждёт сигнал от скринера. Как только он придёт — позиция появится здесь.
            </p>
          </Glass>
        </div>
      )}

      <div className="px-4 space-y-2.5" data-coach="positions">
        {positions.map((p) => <PositionCard key={p.id} p={p} onOpen={() => setOpen(p)} />)}
      </div>

      <AnimatePresence>
        {live && <Detail p={live} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </div>
  );
}

function PositionCard({ p, onOpen }: { p: Position; onOpen: () => void }) {
  const { usd, r, pct: ppct } = posPnl(p);
  const up = p.side === "long";
  const progress = Math.max(0, Math.min(1, Math.abs(p.mark - p.entry) / Math.abs(p.tp - p.entry)));
  return (
    <Press onClick={onOpen} className="block w-full" scale={0.975} feel="press">
      <Glass className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center justify-center w-7 h-7 rounded-full shrink-0"
                  style={{ background: `color-mix(in srgb, ${up ? "var(--green)" : "var(--red)"} 18%, transparent)` }}>
              {up ? <TrendingUp size={15} style={{ color: "var(--green)" }} />
                  : <TrendingDown size={15} style={{ color: "var(--red)" }} />}
            </span>
            <span className="text-[17px] font-semibold tracking-tight truncate">
              {p.symbol.replace("USDT", "")}
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[11px] font-semibold shrink-0"
                  style={{ background: "var(--label-3)", color: "var(--label-2)" }}>
              {up ? "LONG" : "SHORT"} {p.lev}×
            </span>
            {/* Лимитка ещё не налилась — позиции физически нет, и называть её
                позицией нельзя: PnL по ней не существует. */}
            {p.status === "pending" && (
              <span className="px-1.5 py-0.5 rounded-md text-[11px] font-semibold shrink-0"
                    style={{ background: "color-mix(in srgb, var(--orange) 20%, transparent)",
                             color: "var(--orange)" }}>лимитка</span>
            )}
          </div>
          <motion.div key={Math.round(usd * 100)} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }}
                      className="text-right shrink-0">
            <div className="text-[17px] font-bold" style={{ color: tone(usd) }}>{money(usd, true)}</div>
            <div className="text-[12px]" style={{ color: tone(usd) }}>{rr(r)} · {pct(ppct)}</div>
          </motion.div>
        </div>

        {/* Полоса «где цена между входом и целью» — быстрее любых цифр. */}
        <div className="mt-3 h-[5px] rounded-full overflow-hidden" style={{ background: "var(--label-3)" }}>
          <motion.div animate={{ width: `${progress * 100}%` }} transition={SPRING}
                      className="h-full rounded-full"
                      style={{ background: usd >= 0 ? "var(--green)" : "var(--red)" }} />
        </div>

        <div className="flex items-center justify-between mt-2.5 text-[12px]" style={{ color: "var(--label-2)" }}>
          <span>вход {price(p.entry)}</span>
          <span>сейчас <b style={{ color: "var(--label)" }}>{price(p.mark)}</b></span>
          <span>цель {price(p.tp)}</span>
        </div>
      </Glass>
    </Press>
  );
}

/* ── Детальный экран тикера ─────────────────────────────────────────────────── */
function Detail({ p, onClose }: { p: Position; onClose: () => void }) {
  const { closePosition, updateLevels } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [edit, setEdit] = useState(false);
  const [tp, setTp] = useState(p.tp);
  const [sl, setSl] = useState(p.sl);
  const [tf, setTf] = useState<Interval>("15");
  const [fullChart, setFullChart] = useState(false);
  const tk = useTickers([p.symbol])[p.symbol];
  const { usd, r } = posPnl(p);

  return (
    <motion.div
      initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="fixed inset-0 z-50 scroll"
      style={{ background: "var(--bg)", paddingTop: "var(--safe-t)" }}>
      <div className="mesh" />
      <div className="relative z-10 pb-24">
        <div className="sticky top-0 z-20 chrome hairline px-2 py-2 flex items-center gap-1">
          <Press onClick={onClose} className="px-1.5 py-1.5 rounded-full">
            <span className="flex items-center gap-0.5 text-[17px]" style={{ color: "var(--tint)" }}>
              <ChevronLeft size={22} /> Назад
            </span>
          </Press>
          <span className="ml-auto mr-1 text-[16px] font-semibold">{p.symbol}</span>
          {tk && (
            <span className="mr-2 text-[13px] font-semibold"
                  style={{ color: tk.pct24h >= 0 ? "var(--green)" : "var(--red)" }}>
              {pct(tk.pct24h)}
            </span>
          )}
        </div>

        <div className="px-4 pt-4">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[13px] uppercase tracking-wide" style={{ color: "var(--label-2)" }}>
                {p.side === "long" ? "Лонг" : "Шорт"} · {p.lev}× · открыта {ago(p.openedAt)}
              </div>
              <div className="num-hero mt-1" style={{ color: tone(usd) }}>{money(usd, true)}</div>
              <div className="text-[15px] mt-0.5" style={{ color: tone(usd) }}>{rr(r)}</div>
            </div>
            {/* Цена и сутки — прямо с биржи: PnL считается от них, и человек
                должен видеть тот же источник, а не «примерно такое» число. */}
            <div className="text-right">
              <div className="text-[19px] font-bold tabular-nums">{price(p.mark)}</div>
              {tk && (
                <div className="text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>
                  сутки {price(tk.low24h)} — {price(tk.high24h)}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 mt-4">
          <Glass className="p-3 overflow-hidden">
            <div className="flex gap-1 mb-2">
              {INTERVALS.map((i) => (
                <Press key={i.id} onClick={() => { haptic.select(); setTf(i.id); }}
                       className="flex-1" scale={0.94}>
                  <div className="py-1.5 rounded-[10px] text-center text-[13px] font-medium"
                       style={tf === i.id
                         ? { background: "var(--tint)", color: "#fff" }
                         : { color: "var(--label-2)" }}>{i.label}</div>
                </Press>
              ))}
            </div>
            <div className="relative">
              <Chart p={p} interval={tf} />
              <Press onClick={() => { haptic.tap(); setFullChart(true); }}
                     className="absolute right-1 top-1 z-10" scale={0.9}>
                <span className="flex items-center justify-center w-8 h-8 rounded-[10px] chrome">
                  <Maximize2 size={15} style={{ color: "var(--label-2)" }} />
                </span>
              </Press>
            </div>
            {/* Цвета подписи обязаны совпадать с цветами линий на графике —
                иначе легенда объясняет не тот график, который нарисован. */}
            <div className="flex items-center justify-center flex-wrap gap-x-3.5 gap-y-1 mt-2 text-[11px]"
                 style={{ color: "var(--label-2)" }}>
              <Legend color="var(--label-2)" text={`вход ${price(p.entry)}`} />
              <Legend color="var(--green)" text={`цель ${price(p.tp)}`} />
              <Legend color="var(--red)" text={`стоп ${price(p.sl)}`} />
              {p.be && <Legend color="var(--orange)" text={`БУ ${price(p.be)}`} />}
            </div>
          </Glass>
        </div>

        <div className="px-4 mt-3">
          <Glass flat className="overflow-hidden">
            <KV k="Размер позиции" v={`${p.size.toLocaleString("ru-RU")} монет`} />
            <KV k="Риск на сделку" v={`$${p.risk.toFixed(2)}`} />
            <KV k="Схема выхода" v={p.scheme} />
            <KV k="Безубыток" v={p.be ? `при ${price(p.be)}` : "не переносим"} last />
          </Glass>
        </div>

        <div className="px-4 mt-3 grid grid-cols-2 gap-2.5">
          <Press onClick={() => { setTp(p.tp); setSl(p.sl); setEdit(true); }} className="block">
            <Glass flat className="py-3.5 flex items-center justify-center gap-2 text-[15px] font-medium">
              <SlidersHorizontal size={17} /> Уровни
            </Glass>
          </Press>
          <Press onClick={() => setConfirm(true)} feel="heavy" className="block">
            <div className="py-3.5 rounded-[16px] flex items-center justify-center gap-2 text-[15px] font-semibold text-white"
                 style={{ background: "var(--red)" }}>
              <OctagonX size={17} /> Закрыть
            </div>
          </Press>
        </div>
      </div>

      <AnimatePresence>
        {fullChart && (
          <FullChart p={p} interval={tf} onInterval={setTf} onClose={() => setFullChart(false)} />
        )}
      </AnimatePresence>

      <Sheet open={edit} onClose={() => setEdit(false)} title="Уровни позиции">
        <div className="pb-3 space-y-4">
          <NumField label="Тейк-профит" value={tp} onChange={setTp} step={p.entry * 0.002} tint="var(--green)" />
          <NumField label="Стоп-лосс" value={sl} onChange={setSl} step={p.entry * 0.002} tint="var(--red)" />
          <p className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
            Новые уровни уедут на биржу сразу. Перенос стопа в безубыток после этого
            выполняться не будет — вы взяли управление на себя.
          </p>
          <Press feel="press" className="block w-full"
                 onClick={() => { updateLevels(p.id, tp, sl); haptic.ok(); setEdit(false); }}>
            <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint)" }}>Сохранить</div>
          </Press>
        </div>
      </Sheet>

      <Modal open={confirm} onClose={() => setConfirm(false)}>
        <div className="text-center">
          <div className="mx-auto mb-3 flex items-center justify-center w-12 h-12 rounded-full"
               style={{ background: "color-mix(in srgb, var(--red) 18%, transparent)" }}>
            <OctagonX size={24} style={{ color: "var(--red)" }} />
          </div>
          <h3 className="text-[19px] font-bold">Закрыть {p.symbol.replace("USDT", "")}?</h3>
          <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
            Позиция закроется по рыночной цене. Результат {money(usd, true)} зафиксируется.
          </p>
          <div className="flex gap-2.5 mt-5">
            <Press onClick={() => setConfirm(false)} className="flex-1">
              <div className="glass glass-flat py-3 text-center text-[16px] font-medium">Отмена</div>
            </Press>
            <Press feel="heavy" className="flex-1"
                   onClick={() => { closePosition(p.id); haptic.ok(); setConfirm(false); onClose(); }}>
              <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--red)" }}>Закрыть</div>
            </Press>
          </div>
        </div>
      </Modal>
    </motion.div>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-3 h-[2px] rounded-full" style={{ background: color }} />{text}
    </span>
  );
}

function KV({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-4 py-2.5 ${last ? "" : "hairline"}`}>
      <span className="text-[15px]" style={{ color: "var(--label-2)" }}>{k}</span>
      <span className="text-[15px] font-medium">{v}</span>
    </div>
  );
}

function NumField({ label, value, onChange, step, tint }: {
  label: string; value: number; onChange: (v: number) => void; step: number; tint: string;
}) {
  return (
    <div>
      <div className="text-[13px] mb-1.5" style={{ color: "var(--label-2)" }}>{label}</div>
      <div className="glass glass-flat flex items-center">
        <Press onClick={() => onChange(+(value - step).toFixed(10))} className="px-4 py-3 text-[20px] font-medium">−</Press>
        <div className="flex-1 text-center text-[19px] font-semibold" style={{ color: tint }}>{price(value)}</div>
        <Press onClick={() => onChange(+(value + step).toFixed(10))} className="px-4 py-3 text-[20px] font-medium">+</Press>
      </div>
    </div>
  );
}

/* ── График на весь экран ────────────────────────────────────────────────────
   Отдельный слой поверх всего, в портрете (альбомная ориентация в приложении не
   поддерживается). Здесь у графика полная навигация TradingView, а экрана под
   ним нет — значит ни один жест ни с чем не спорит. */
function FullChart({ p, interval, onInterval, onClose }: {
  p: Position; interval: Interval; onInterval: (i: Interval) => void; onClose: () => void;
}) {
  const tk = useTickers([p.symbol])[p.symbol];
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
      className="fixed inset-0 z-[80] flex flex-col"
      style={{ background: "var(--bg)", paddingTop: "var(--safe-t)", paddingBottom: "var(--safe-b)" }}>

      <div className="flex items-center gap-2 px-3 py-2 hairline">
        <span className="text-[16px] font-semibold">{p.symbol}</span>
        <span className="text-[15px] tabular-nums" style={{ color: "var(--label)" }}>{price(p.mark)}</span>
        {tk && (
          <span className="text-[13px] font-semibold"
                style={{ color: tk.pct24h >= 0 ? "var(--green)" : "var(--red)" }}>{pct(tk.pct24h)}</span>
        )}
        <Press onClick={() => { haptic.tap(); onClose(); }} className="ml-auto" scale={0.9}>
          <span className="flex items-center justify-center w-9 h-9 rounded-full glass glass-flat">
            <X size={18} />
          </span>
        </Press>
      </div>

      <div className="flex gap-1 px-3 py-2">
        {INTERVALS.map((i) => (
          <Press key={i.id} onClick={() => { haptic.select(); onInterval(i.id); }} className="flex-1" scale={0.94}>
            <div className="py-1.5 rounded-[10px] text-center text-[13px] font-medium"
                 style={interval === i.id ? { background: "var(--tint)", color: "#fff" } : { color: "var(--label-2)" }}>
              {i.label}
            </div>
          </Press>
        ))}
      </div>

      <div className="flex-1 min-h-0 px-1">
        <Chart p={p} interval={interval} full />
      </div>

      <div className="px-3 pt-1.5 pb-1 flex items-center justify-center flex-wrap gap-x-3.5 gap-y-1 text-[11px]"
           style={{ color: "var(--label-2)" }}>
        <Legend color="var(--label-2)" text={`вход ${price(p.entry)}`} />
        <Legend color="var(--green)" text={`цель ${price(p.tp)}`} />
        <Legend color="var(--red)" text={`стоп ${price(p.sl)}`} />
        {p.be && <Legend color="var(--orange)" text={`БУ ${price(p.be)}`} />}
      </div>
      {/* Жесты осей неочевидны — один раз сказать про них дешевле, чем надеяться,
          что их найдут наугад. */}
      <div className="px-3 pb-1 text-center text-[10px]" style={{ color: "var(--label-3)" }}>
        щипок — масштаб · тяните ось времени, чтобы сжать свечи · ось цены — растянуть · двойное касание оси — сброс
      </div>
    </motion.div>
  );
}

/* ── Свечной график ──────────────────────────────────────────────────────────
   lightweight-charts (TradingView, Apache-2.0) на НАСТОЯЩИХ свечах Bybit:
   история приходит по REST, текущая свеча дорисовывается тиками по WS.
   Поверх — линии входа, цели, стопа и безубытка: без них график красивый, но
   не отвечает на единственный вопрос, с которым сюда заходят, — далеко ли до
   цели и близко ли стоп. */
function Chart({ p, interval, full = false }: { p: Position; interval: Interval; full?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const legend = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const { candles, live, loading, error } = useCandles(p.symbol, interval);

  useEffect(() => {
    if (!box.current) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const green = v("--green", "#30d158"), red = v("--red", "#ff453a");

    const c = createChart(box.current, {
      // На весь экран график меряет себя сам, встроенный — фиксированной высоты.
      ...(full ? { autoSize: true } : { height: 240 }),
      layout: {
        background: { color: "transparent" }, textColor: v("--label-2", "#8e8e93"),
        attributionLogo: false, fontFamily: "-apple-system, system-ui, sans-serif",
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,.06)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      crosshair: { horzLine: { labelBackgroundColor: v("--tint", "#0a84ff") },
                   vertLine: { labelBackgroundColor: v("--tint", "#0a84ff") } },
      /* Навигация зависит от режима, и это не придирка.
         ВСТРОЕННЫЙ график живёт внутри прокручиваемого экрана: вертикальное
         перетаскивание и колесо у него отняты, иначе жест вверх вместо
         прокрутки страницы двигал бы цену, а колесо «проваливалось» бы в
         график посреди скролла.
         НА ВЕСЬ ЭКРАН прокручивать нечего — включено всё, как в TradingView:
         перетаскивание в обе стороны, щипок, колесо, растяжение осей
         перетаскиванием (ось времени — сжать/растянуть свечи, ось цены —
         масштаб по вертикали), двойной клик по оси — сброс. Инерция включена
         в обоих: без неё свайп по котировкам ощущается как рывок. */
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

    /* Показания под курсором пишем НАПРЯМУЮ в DOM, а не через состояние React:
       крестик двигается на каждом кадре жеста, и перерисовка экрана на каждое
       движение пальца — ровно та работа, которой тут быть не должно. */
    if (full) {
      c.subscribeCrosshairMove((param) => {
        const el = legend.current;
        if (!el) return;
        const b = param.seriesData.get(series.current!) as any;
        el.textContent = b
          ? `O ${price(b.open)}  H ${price(b.high)}  L ${price(b.low)}  C ${price(b.close)}`
          : "";
      });
    }

    // autoSize уже следит за размером — свой наблюдатель нужен только встроенному.
    const ro = full ? null : new ResizeObserver(() => c.applyOptions({ width: box.current!.clientWidth }));
    ro?.observe(box.current);
    return () => { ro?.disconnect(); c.remove(); chart.current = null; series.current = null; lines.current = []; };
  }, [p.id, interval, full]);

  /* История. Точность оси берём из самой цены: с точностью по умолчанию (2
     знака) монета за $0.0143 превращается в прямую линию. */
  useEffect(() => {
    const s = series.current;
    if (!s || !candles.length) return;
    const dec = Math.max(...candles.slice(-40).map((c) => decimalsOf(c.close)), 2);
    s.applyOptions({ priceFormat: { type: "price", precision: dec, minMove: 10 ** -dec } });
    s.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    if (!fitted.current && chart.current) {
      // Показываем последние ~70 свечей, а не всю историю: на 200 барах тело
      // свечи становится волоском.
      chart.current.timeScale().setVisibleLogicalRange({ from: candles.length - 70, to: candles.length + 3 });
      fitted.current = true;
    }
  }, [candles]);

  /* Незакрытая свеча — одна точка, а не пересборка серии. */
  useEffect(() => {
    if (live && series.current) series.current.update({ ...live, time: live.time as UTCTimestamp });
  }, [live]);

  /* Уровни сделки. Пересоздаём при правке TP/SL — иначе на графике осталась бы
     старая линия рядом с новой. */
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    lines.current.forEach((l) => s.removePriceLine(l));
    const mk = (price: number, color: string, title: string, dashed = true) =>
      s.createPriceLine({ price, color, lineWidth: 1, lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
                          axisLabelVisible: true, title });
    // Ступеней может быть несколько: у шорта лесенка из трёх. Рисовать одну
    // цель там, где в стакане стоят три, значит показать треть плана.
    const legs = p.tps?.length ? p.tps : [{ price: p.tp, weight: 1 }];
    lines.current = [
      mk(p.entry, v("--label-2", "#8e8e93"), "вход", false),
      ...legs.filter((l) => l.price > 0).map((l, i) =>
        mk(l.price, v("--green", "#30d158"),
           legs.length > 1 ? `TP${i + 1} ${Math.round(l.weight * 100)}%` : "TP")),
      mk(p.sl, v("--red", "#ff453a"), "SL"),
      ...(p.be ? [mk(p.be, v("--orange", "#ff9f0a"), "БУ")] : []),
    ];
  }, [p.entry, p.tp, p.tps, p.sl, p.be, candles.length > 0, interval]);

  return (
    <div className={full ? "relative h-full" : "relative"}>
      {full && (
        <div ref={legend}
             className="absolute left-2 top-1 z-10 text-[11px] tabular-nums pointer-events-none"
             style={{ color: "var(--label-2)" }} />
      )}
      <div ref={box} className={full ? "w-full h-full" : "w-full"}
           style={full ? undefined : { minHeight: 240 }} />
      {(loading || error) && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]"
             style={{ color: "var(--label-2)" }}>
          {error ? "Свечи недоступны — биржа не ответила" : "Загружаем свечи…"}
        </div>
      )}
    </div>
  );
}

