/**
 * Жидкое стекло: элементы управления.
 *
 * Перенос двух открытых реализаций (обе MIT) на веб:
 *
 *   • DnV1eX/LiquidGlassKit — бэкпорт компонентов iOS 26. Отсюда ПОВЕДЕНИЕ:
 *     два состояния бегунка (сжатый непрозрачный / раскрытый стеклянный),
 *     переключение по достижении края дорожки, резиновое сопротивление за
 *     границей, деформация дорожки при перетяге, отдача на краях, и физика
 *     линзы панели вкладок — сжатие-растяжение по УСКОРЕНИЮ.
 *   • ybouane/liquidglass — фрагментный шейдер. Отсюда ОПТИКА: кромка,
 *     четыре источника бликов, френель, холодный оттенок. Она живёт в
 *     theme.css (класс `.lg`), там же написано, почему перенесена модель, а
 *     не конвейер библиотеки.
 *
 * Размеры взяты из оригинала и сжаты под наши строки: у Apple переключатель
 * 63×28 при бегунке 37×24, у нас 56×30 при 33×26 — пропорции те же.
 *
 * Важная деталь оригинала, которую легко потерять: сжатое и раскрытое
 * состояния бегунка отличаются ПОЧТИ РОВНО одним множителем (37/58 = 0.638 по
 * ширине, 24/38.33 = 0.626 по высоте). То есть это не морф двух разных форм, а
 * масштаб одной капсулы — поэтому здесь один элемент и одно число `SC`, а не
 * две анимации ширины и высоты, от которых поехал бы радиус скругления.
 *
 * Анимации идут через MotionValue: ни один кадр перетяга не вызывает рендер
 * React. Это не стилистика, а условие — перетяг живёт рядом с работающим
 * графиком, и лишний рендер дерева виден пальцем.
 */

import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { haptic } from "../lib/tg";

/* Пружины оригинала. В UIKit их задают длительностью и коэффициентом
   затухания; здесь то же самое через duration + bounce (bounce ≈ 1 − damping). */
const SP_EXPAND = { type: "spring", duration: 0.4, bounce: 0.4 } as const;
const SP_CONTRACT = { type: "spring", duration: 0.6, bounce: 0.3 } as const;
const SP_SLIDE = { type: "spring", duration: 0.5, bounce: 0 } as const;

/** Резиновое сопротивление за границей — формула оригинала (корень от выхода). */
function rubber(v: number, lo: number, hi: number) {
  if (v < lo) return lo - Math.sqrt(lo - v);
  if (v > hi) return hi + Math.sqrt(v - hi);
  return v;
}

/* ── Переключатель ─────────────────────────────────────────────────────────
   Порт LiquidGlassSwitch. Тап переключает; перетяг тоже — и переключает
   РАНЬШЕ, чем палец отпущен, как только бегунок дошёл до края дорожки
   (`EDGE`), с отдачей в этот момент. Именно из-за этого переключатель iOS
   ощущается «живым»: состояние меняется там, где его меняет физика, а не
   после отпускания. */

const W = 56, H = 30, PAD = 2;      // дорожка
const EW = 52, EH = 41;             // бегунок раскрытый
const SC = 0.635;                   // он же сжатый = раскрытый × SC
const EDGE = 5;                     // порог края, px
const MINX = PAD + (EW * SC) / 2;
const MAXX = W - PAD - (EW * SC) / 2;

export function Toggle({ on, onChange, disabled }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  const cx = useMotionValue(on ? MAXX : MINX);
  const sc = useMotionValue(SC);
  const glass = useMotionValue(0);          // 0 — матовая пилюля, 1 — стекло
  const solid = useTransform(glass, (v) => 1 - v);
  const x = useTransform(cx, (v) => v - EW / 2);

  const st = useRef({ drag: false, moved: false, x0: 0, cx0: 0, flipped: false });
  const onRef = useRef(on);
  onRef.current = on;

  /* Пока палец на бегунке, позицией распоряжается палец: иначе приход нового
     `on` (в том числе нашего же, из переключения по краю) дёрнул бы бегунок
     из-под пальца в конечную точку. */
  useEffect(() => {
    if (st.current.drag) return;
    animate(cx, on ? MAXX : MINX, SP_SLIDE);
  }, [on]);

  const expand = () => {
    animate(sc, 1, SP_EXPAND);
    animate(glass, 1, { duration: 0.22, ease: "easeOut" });
  };
  const contract = () => {
    animate(sc, SC, SP_CONTRACT);
    animate(glass, 0, { duration: 0.28, ease: "easeOut" });
  };

  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    /* Захват указателя — чтобы палец, уехавший за пределы 56-пиксельной
       дорожки, продолжал вести бегунок. В try: у события, пришедшего не от
       настоящего указателя (тесты, синтетика), браузер бросает исключение, и
       без него перетяг не начинался бы вовсе. */
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* не указатель */ }
    st.current = { drag: true, moved: false, x0: e.clientX, cx0: cx.get(), flipped: false };
    expand();
  };

  const move = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s.drag) return;
    const dx = e.clientX - s.x0;
    /* Пока палец не сдвинулся на 6px — это ещё тап, а не перетяг. Оригинал
       отличает их по времени (150мс); по расстоянию честнее: быстрый
       решительный свайп по времени не отличался бы от тапа. */
    if (!s.moved && Math.abs(dx) < 6) return;
    s.moved = true;
    const nx = rubber(s.cx0 + dx, MINX, MAXX);
    cx.set(nx);
    const hitL = nx <= MINX + EDGE && onRef.current;
    const hitR = nx >= MAXX - EDGE && !onRef.current;
    if (hitL || hitR) {
      s.flipped = true;
      haptic.press();
      onChange(hitR);
    }
  };

  const up = () => {
    const s = st.current;
    if (!s.drag) return;
    s.drag = false;
    contract();
    /* Отпустили, не дойдя до края, — считаем это намерением переключить
       (поведение оригинала: перетяг без края всё равно меняет состояние). */
    const next = s.flipped ? onRef.current : !onRef.current;
    if (!s.flipped) { haptic.select(); onChange(next); }
    animate(cx, next ? MAXX : MINX, SP_SLIDE);
  };

  return (
    /* data-noswipe — не мелочь: горизонтальный жест здесь ПРИНАДЛЕЖИТ
       переключателю. Без пометки перетяг бегунка вправо доходил бы до общего
       обработчика свайпов и означал «назад» — шторка настроек закрывалась бы
       ровно в тот момент, когда человек тянет тумблер. Проверено: закрывалась. */
    <div role="switch" aria-checked={on} aria-disabled={disabled} data-noswipe
         onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
         className="relative shrink-0 select-none"
         style={{ width: W, height: H, touchAction: "none", opacity: disabled ? 0.4 : 1,
                  cursor: disabled ? "default" : "pointer" }}>
      {/* Дорожка. Два слоя вместо смены цвета: градиент не анимируется
          переходом, а гасить один слой поверх другого браузер умеет. */}
      <div className="absolute inset-0 rounded-full overflow-hidden lg-track"
           style={{ background: "var(--label-3)" }}>
        <div className="absolute inset-0 rounded-full"
             style={{ background: "var(--tint-grad)", opacity: on ? 1 : 0,
                      transition: "opacity .22s ease" }} />
      </div>

      {/* Бегунок. Один элемент раскрытого размера; сжатое состояние — тот же
          элемент под масштабом SC. Выходит за дорожку по высоте, поэтому
          обрезки здесь нет. */}
      <motion.div className="absolute rounded-full"
                  style={{ width: EW, height: EH, top: (H - EH) / 2, left: 0, x, scale: sc }}>
        <motion.div className="absolute inset-0 rounded-full"
                    style={{ opacity: solid, background: "#fff",
                             boxShadow: "0 2px 6px rgba(0,0,0,.28), inset 0 -1px 1px rgba(0,0,0,.06)" }} />
        <motion.div className="absolute inset-0 rounded-full lg" style={{ opacity: glass }} />
      </motion.div>
    </div>
  );
}

/* ── Ползунок ──────────────────────────────────────────────────────────────
   Порт LiquidGlassSlider. Кроме тех же двух состояний бегунка здесь есть то,
   ради чего оригинал и интересен: за границей дорожка НЕ просто упирается —
   она уезжает за бегунком, растягивается и утончается, будто её тянут. Числа
   деформации взяты из оригинала как есть. */

const SH = 30, TRACK = 6;
const S_EW = 44, S_EH = 34, S_SC = 0.64;
const S_CW = S_EW * S_SC;

export function Slider({
  value, min, max, step = 1, onInput, onChange, disabled,
}: {
  value: number; min: number; max: number; step?: number;
  /** Живое значение во время перетяга — для подписи рядом. */
  onInput?: (v: number) => void;
  /** Итоговое значение, когда палец отпущен. Сюда вешают запись на сервер:
   *  посылать каждый пиксель перетяга значило бы слать десятки запросов на
   *  одно движение. */
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const wMv = useMotionValue(0);

  const cx = useMotionValue(0);
  const sc = useMotionValue(S_SC);
  const glass = useMotionValue(0);
  const solid = useTransform(glass, (v) => 1 - v);
  const x = useTransform(cx, (v) => v - S_EW / 2);
  const fill = useTransform([cx, wMv], ([c, ww]: number[]) => (ww ? Math.max(0, Math.min(1, c / ww)) : 0));

  /* Деформация дорожки при выходе за границу. */
  const off = useMotionValue(0);
  const trX = useTransform(off, (o) => (o / 4) * 3 - Math.abs(o) / 4);
  const trSy = useTransform(off, (o) => Math.max(2, TRACK - Math.abs(o) / 3) / TRACK);
  const trSx = useTransform([off, wMv], ([o, ww]: number[]) => (ww ? (ww + Math.abs(o) / 2) / ww : 1));

  const st = useRef({ drag: false, minHit: false, maxHit: false });
  const live = useRef(value);

  useEffect(() => {
    const fit = () => {
      const n = box.current?.clientWidth || 0;
      setW(n); wMv.set(n);
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const lo = S_CW / 2, hi = Math.max(lo, w - S_CW / 2);
  const toX = (v: number) => lo + ((v - min) / (max - min)) * (hi - lo);
  const toV = (px: number) => {
    const r = (px - lo) / (hi - lo);
    const raw = min + r * (max - min);
    return Math.max(min, Math.min(max, Math.round(raw / step) * step));
  };

  useEffect(() => { if (!st.current.drag && w) cx.set(toX(value)); }, [value, w]);

  const emit = (px: number) => {
    const v = toV(px);
    if (v === live.current) return;
    live.current = v;
    onInput?.(v);
  };

  const down = (e: React.PointerEvent) => {
    if (disabled || !w) return;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* не указатель */ }
    st.current = { drag: true, minHit: false, maxHit: false };
    animate(sc, 1, SP_EXPAND);
    animate(glass, 1, { duration: 0.22, ease: "easeOut" });
    const px = e.clientX - (box.current?.getBoundingClientRect().left || 0);
    const clamped = Math.max(lo, Math.min(hi, px));
    animate(cx, clamped, { duration: 0.18, ease: "easeOut" });
    emit(clamped);
  };

  const move = (e: React.PointerEvent) => {
    if (!st.current.drag) return;
    const px = e.clientX - (box.current?.getBoundingClientRect().left || 0);
    const nx = rubber(px, lo, hi);
    cx.set(nx);
    off.set(nx < lo ? nx - lo : nx > hi ? nx - hi : 0);
    emit(nx);
    /* Отдача на краях: у нижнего слабее, у верхнего сильнее — как в
       оригинале. Флаги нужны, чтобы она случилась один раз, а не сорок. */
    const s = st.current;
    if (px <= lo + 2 && !s.minHit) { s.minHit = true; s.maxHit = false; haptic.tap(); }
    else if (px >= hi - 2 && !s.maxHit) { s.maxHit = true; s.minHit = false; haptic.press(); }
    else if (px > lo + 2 && px < hi - 2) { s.minHit = false; s.maxHit = false; }
  };

  const up = () => {
    if (!st.current.drag) return;
    st.current.drag = false;
    animate(sc, S_SC, SP_CONTRACT);
    animate(glass, 0, { duration: 0.28, ease: "easeOut" });
    animate(off, 0, SP_SLIDE);
    const v = toV(cx.get());
    animate(cx, toX(v), SP_SLIDE);
    onChange(v);
  };

  return (
    <div ref={box} data-t="slider" data-noswipe
         onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
         className="relative w-full select-none"
         style={{ height: SH, touchAction: "none", opacity: disabled ? 0.4 : 1 }}>
      <motion.div className="absolute left-0 right-0 rounded-full overflow-hidden lg-track"
                  style={{ height: TRACK, top: (SH - TRACK) / 2, background: "var(--label-3)",
                           x: trX, scaleX: trSx, scaleY: trSy }}>
        <motion.div className="absolute inset-0 origin-left"
                    style={{ background: "var(--tint-grad)", scaleX: fill }} />
      </motion.div>

      <motion.div className="absolute rounded-full"
                  style={{ width: S_EW, height: S_EH, top: (SH - S_EH) / 2, left: 0, x, scale: sc }}>
        <motion.div className="absolute inset-0 rounded-full"
                    style={{ opacity: solid, background: "#fff",
                             boxShadow: "0 2px 6px rgba(0,0,0,.3)" }} />
        <motion.div className="absolute inset-0 rounded-full lg" style={{ opacity: glass }} />
      </motion.div>
    </div>
  );
}

/* ── Галочка ───────────────────────────────────────────────────────────────
   Квадрат со скруглением: выключенный — пустое стекло, включённый —
   акцентная заливка. Сама галочка выезжает пружиной, а не появляется: иначе
   переключение из списка панелей читается как перерисовка, а не как ответ на
   нажатие. Нажатие обрабатывает родитель (строка целиком — цель побольше). */
export function Check3({ on, size = 20 }: { on: boolean; size?: number }) {
  return (
    <span className="relative shrink-0 rounded-[7px] overflow-hidden"
          style={{ width: size, height: size, border: "1px solid var(--label-3)" }}>
      <motion.span className="absolute inset-0"
                   style={{ background: "var(--tint-grad)" }}
                   initial={false} animate={{ opacity: on ? 1 : 0 }}
                   transition={{ duration: 0.18 }} />
      <motion.span className="absolute inset-0 flex items-center justify-center"
                   initial={false}
                   animate={{ scale: on ? 1 : 0.4, opacity: on ? 1 : 0 }}
                   transition={SP_EXPAND}>
        <Check size={Math.round(size * 0.66)} strokeWidth={3.2} color="#fff" />
      </motion.span>
    </span>
  );
}

/* ── Физика линзы ──────────────────────────────────────────────────────────
   Порт LiquidLensView: пузырь сжимается и растягивается по УСКОРЕНИЮ, а не по
   скорости. Разница видна сразу: по скорости пузырь растянут всю дорогу и
   возвращается рывком, по ускорению он растягивается на старте, отпускает
   середину и сжимается на торможении — то есть ведёт себя как капля.

   Окно усреднения 0.3с — из оригинала. А вот коэффициент пришлось пересчитать,
   и это не вкусовщина: у Apple линзу двигает ПАЛЕЦ, у нас — жёсткая пружина
   (380 при массе 0.8), и ускорения тут на порядок больше. С исходными 0.00005
   формула упиралась в ограничитель на первом же кадре и стояла в нём весь
   перелёт — замерено: sx=0.800 от старта до финиша. То есть эффект вырождался
   ровно в то, чего избегает оригинал: деформация «включена», а не живёт.
   Знаменатель 60000 px/с² — примерно пиковое ускорение нашей пружины, поэтому
   в ограничитель линза упирается только на самом резком переходе.

   Ограничение ужато с 0.3 до 0.2: у Apple линза размером с иконку, у нас — с
   половину ячейки, и те же 30% читаются как рывок. */
const ACC_WINDOW = 0.3;
const ACC_COEF = 1 / 60000;
const ACC_CLAMP = 0.2;

export function useLensSquash(v: MotionValue<number>, active: boolean) {
  const sx = useMotionValue(1);
  const sy = useMotionValue(1);

  useEffect(() => {
    if (!active) { animate(sx, 1, SP_CONTRACT); animate(sy, 1, SP_CONTRACT); return; }
    let raf = 0;
    const hist: { p: number; t: number }[] = [];
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = performance.now() / 1000;
      hist.push({ p: v.get(), t });
      while (hist.length && hist[0].t < t - ACC_WINDOW) hist.shift();
      if (hist.length < 3) return;

      const vel: { v: number; t: number }[] = [];
      for (let i = 1; i < hist.length; i++) {
        const dt = hist[i].t - hist[i - 1].t;
        if (dt > 0) vel.push({ v: (hist[i].p - hist[i - 1].p) / dt, t: (hist[i].t + hist[i - 1].t) / 2 });
      }
      if (vel.length < 2) return;
      let sum = 0, n = 0;
      for (let i = 1; i < vel.length; i++) {
        const dt = vel[i].t - vel[i - 1].t;
        if (dt > 0) { sum += (vel[i].v - vel[i - 1].v) / dt; n++; }
      }
      if (!n) return;
      const k = Math.max(-ACC_CLAMP, Math.min(ACC_CLAMP, (sum / n) * ACC_COEF));
      sx.set(1 + k);
      sy.set(1 - k);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return { sx, sy };
}
