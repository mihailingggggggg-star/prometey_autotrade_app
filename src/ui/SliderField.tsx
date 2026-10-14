/**
 * SliderField — строка настройки кабинета: ползунок И компактное поле ввода,
 * синхронные между собой.
 *
 * Зачем оба. Ползунок хорош для «покрутить и почувствовать» — он даёт мгновенную
 * реакцию и живёт в пальце, а вот точное число (возраст 180 дней, ликвидность
 * $20 000) им не наберёшь: на длинной дорожке один пиксель — это сотни единиц.
 * Поле нужно там, где важно ЗНАЧЕНИЕ, а не ощущение. Держать их порознь нельзя:
 * два разных способа показать одно и то же число неизбежно разъедутся, поэтому
 * здесь одно `value` и два взгляда на него.
 *
 * Значение приходит в ЕДИНИЦАХ ОТОБРАЖЕНИЯ. Полуширину коридора (range_pct×2)
 * и долю фиксации (tp1_fraction×100) экран пересчитывает сам — компонент о
 * договорённостях сервера не знает и знать не должен.
 *
 * Ввод терпим к человеку: запятая принимается как десятичный разделитель
 * (русская раскладка), лишние пробелы (разряды «20 000») отбрасываются, число
 * зажимается в [min, max] и округляется по шагу. Пока поле в фокусе, текст НЕ
 * нормализуется — иначе «1,» превращалось бы в «1» прямо под пальцем и нельзя
 * было бы добрать «1,5». Нормализация — на потере фокуса; пустое или нечисловое
 * значение откатывается к последнему корректному, а не превращается в ноль.
 */
import { useEffect, useState } from "react";
import { Slider } from "./liquid";

/** Сколько знаков после запятой несёт шаг: 1 → 0, 0.05 → 2, 0.5 → 1. */
function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Число из текста: запятая — как десятичный разделитель, пробелы (разряды) — вон. */
function parseNum(raw: string): number | null {
  const cleaned = raw.replace(/\s|\u00a0/g, "").replace(",", ".");
  if (cleaned === "" || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

/** Зажать в диапазон и округлить по шагу. Округление — без «хвостов» двоичной дроби. */
function quantize(v: number, min: number, max: number, step: number): number {
  const clamped = Math.max(min, Math.min(max, v));
  const snapped = step > 0 ? Math.round(clamped / step) * step : clamped;
  return +Math.max(min, Math.min(max, snapped)).toFixed(decimalsOf(step));
}

export function SliderField(props: {
  label: string;
  /** Значение в единицах отображения (см. шапку файла). */
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Единица справа от числа: «%», «дн», «$», «мин». */
  suffix?: string;
  /** Мелкая подсказка под строкой. */
  hint?: string;
  onChange: (v: number) => void;
}): JSX.Element {
  const { label, value, min, max, step = 1, suffix, hint, onChange } = props;
  const dec = decimalsOf(step);

  // Живое значение во время перетяга — чтобы ползунок и поле показывали одно.
  const [live, setLive] = useState(value);
  // Текст поля держим отдельно от числа: в процессе набора «1,» — не ошибка.
  const [text, setText] = useState(String(+value.toFixed(dec)));
  const [focused, setFocused] = useState(false);

  useEffect(() => { setLive(value); }, [value]);
  // Вне фокуса поле следует за значением: ползунок, откат, приход с сервера.
  useEffect(() => { if (!focused) setText(String(+value.toFixed(dec))); }, [value, focused, dec]);

  const show = (v: number) => String(+v.toFixed(dec));

  const onSlide = (v: number) => {
    setLive(v);
    if (!focused) setText(show(v));
  };

  const onSlideCommit = (v: number) => {
    const q = quantize(v, min, max, step);
    setLive(q);
    setText(show(q));
    onChange(q);
  };

  const onType = (raw: string) => {
    setText(raw);
    const v = parseNum(raw);
    if (v == null) return;
    // Живое обновление без привязки к шагу: «12» при шаге 5 должно читаться как
    // двенадцать, а не прыгать на 10 прямо во время набора. Шаг дожмёт blur.
    const clamped = Math.max(min, Math.min(max, v));
    setLive(clamped);
    onChange(clamped);
  };

  const onBlur = () => {
    setFocused(false);
    const v = parseNum(text);
    // Пусто или мусор — возвращаем последнее корректное значение, не ноль.
    if (v == null) { setText(show(value)); setLive(value); return; }
    const q = quantize(v, min, max, step);
    setText(show(q));
    setLive(q);
    onChange(q);
  };

  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-[14px] min-w-0 leading-snug" style={{ color: "var(--label-2)" }}>{label}</span>
        <span className="flex items-center gap-1 shrink-0 h-[32px] px-2 rounded-[10px]"
              style={{ background: "var(--bg-elev)", width: 104 }}>
          <input
            inputMode="decimal"
            value={text}
            onChange={(e) => onType(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={onBlur}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="w-full bg-transparent outline-none text-right text-[15px] font-semibold tabular-nums min-w-0"
            style={{ color: "var(--label)" }}
            aria-label={label}
          />
          {suffix && (
            <span className="text-[13px] shrink-0" style={{ color: "var(--label-3)" }}>
              {suffix.trim()}
            </span>
          )}
        </span>
      </div>
      <Slider value={live} min={min} max={max} step={step}
              onInput={onSlide} onChange={onSlideCommit} />
      {hint && <div className="text-[12px] mt-1 leading-snug" style={{ color: "var(--label-3)" }}>{hint}</div>}
    </div>
  );
}
