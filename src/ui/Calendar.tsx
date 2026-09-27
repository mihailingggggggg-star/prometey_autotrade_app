/**
 * Calendar.tsx — выбор ТОЧНОЙ ДАТЫ и ТОЧНОГО ПРОМЕЖУТКА в аналитике.
 *
 * ━━━ ЗАЧЕМ, ЕСЛИ ЕСТЬ КНОПКИ ПЕРИОДОВ ━━━
 *
 * «Сегодня / 7 дней / 30 дней / Всё» отвечают на вопрос «как дела в среднем».
 * Вопрос «что было во вторник» и «что было с 12 по 15» ими не задать вовсе, а
 * именно он возникает, когда день выбился из ряда: календарь нужен не вместо
 * кнопок, а рядом.
 *
 * ━━━ ДНИ С ДАННЫМИ ОТМЕЧЕНЫ, И ЭТО ГЛАВНОЕ ━━━
 *
 * Без отметки владелец ГАДАЕТ: тыкает даты, пока не попадёт в ту, где что-то
 * было, и пустой экран не отличается от неверно выбранного дня. Отметка
 * отвечает на этот вопрос ДО нажатия, а цвет — ещё и на «прибыльный он или
 * убыточный». Точка под числом не «украшение календаря»: это единственное, что
 * отличает «сделок в тот день не было» от «я промахнулся мимо дня».
 *
 * ━━━ СУТКИ СЧИТАЕТ СЕРВЕР, А НЕ УСТРОЙСТВО ━━━
 *
 * Разметка дней приходит готовой (`/api/days`, пояс отчётности — Бишкек), и
 * границы выбранного промежутка считаются ТЕМ ЖЕ смещением (`tzOffsetMin`),
 * которым сервер эти дни разметил. Возьми мы пояс телефона — подсветка
 * разошлась бы с выборкой ровно на границе суток, где это больнее всего:
 * сделка, закрытая в 02:00 по Бишкеку, у владельца в поездке уехала бы во
 * вчера, и «21 сентября» в приложении значило бы не то же, что в отчёте.
 *
 * Сетка месяца строится в UTC поверх сдвинутого времени — так календарные
 * сутки не зависят ни от часов устройства, ни от перехода на летнее время
 * (в Киргизии его нет с 2005 года, смещение постоянное).
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Glass, Press } from "./kit";
import type { ApiDay } from "../lib/api";

const DAY = 864e5;
const WD = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль",
                "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** Ключ дня (YYYY-MM-DD) в поясе отчётности — ровно в том виде, в каком его
 *  присылает сервер. Сверять день можно только одинаково посчитанными ключами. */
export function keyOf(ms: number, tzMin: number): string {
  const d = new Date(ms + tzMin * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Полночь дня отчётности в epoch. Обратное к `keyOf`. */
export function startOf(key: string, tzMin: number): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - tzMin * 60000;
}

export type Range = { from: string; to: string } | null;

/** Границы выбранного промежутка в epoch: [начало первого дня, конец последнего).
 *
 *  Верхняя граница — НАЧАЛО СЛЕДУЮЩИХ суток, а не конец выбранных. Без неё
 *  «с 12 по 15» означало бы «с 12-го и до сегодня», причём выглядело бы
 *  правильным; а сравнение «≤ конец дня» промахивалось бы мимо сделок
 *  последней миллисекунды. */
export function rangeMs(r: Range, tzMin: number): { from: number; to: number } {
  if (!r) return { from: 0, to: 0 };
  return { from: startOf(r.from, tzMin), to: startOf(r.to, tzMin) + DAY };
}

export function rangeLabel(r: Range): string {
  if (!r) return "";
  const human = (k: string) => {
    const [, m, d] = k.split("-");
    return `${Number(d)} ${MONTHS[Number(m) - 1].slice(0, 3)}`;
  };
  return r.from === r.to ? human(r.from) : `${human(r.from)} — ${human(r.to)}`;
}

export function Calendar({ days, tzMin, value, onChange }: {
  days: ApiDay[];
  tzMin: number;
  value: Range;
  onChange: (r: Range) => void;
}) {
  const byKey = useMemo(() => {
    const m = new Map<string, ApiDay>();
    days.forEach((d) => m.set(d.date, d));
    return m;
  }, [days]);

  /* Открываемся на месяце ПОСЛЕДНЕГО дня с данными, а не на текущем: у счёта,
     который стоял неделю, текущий месяц пуст, и календарь встречал бы владельца
     пустой сеткой — то есть выглядел бы сломанным ровно тогда, когда он прав. */
  const initial = value?.to || days[days.length - 1]?.date || keyOf(Date.now(), tzMin);
  const [cursor, setCursor] = useState(() => {
    const [y, m] = initial.split("-").map(Number);
    return { y, m: m - 1 };
  });
  /* Первый тап задаёт начало промежутка, второй — конец. Между ними держим
     «якорь»: без него второй тап нельзя отличить от нового выбора, и выделить
     промежуток было бы физически нечем. */
  const [anchor, setAnchor] = useState<string | null>(null);

  const grid = useMemo(() => {
    const first = new Date(Date.UTC(cursor.y, cursor.m, 1));
    // Неделя начинается с ПОНЕДЕЛЬНИКА: у getUTCDay воскресенье это 0.
    const lead = (first.getUTCDay() + 6) % 7;
    const total = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
    const cells: (string | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= total; d++) {
      cells.push(`${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [cursor]);

  const tap = (key: string) => {
    if (!anchor) { setAnchor(key); onChange({ from: key, to: key }); return; }
    // Тапы в любом порядке: выбрав сначала 15-е, а потом 12-е, владелец имел в
    // виду промежуток, а не ошибку.
    const [from, to] = anchor <= key ? [anchor, key] : [key, anchor];
    setAnchor(null);
    onChange({ from, to });
  };

  const inRange = (key: string) =>
    !!value && key >= value.from && key <= value.to;

  const today = keyOf(Date.now(), tzMin);
  const shift = (n: number) => setCursor((c) => {
    const d = new Date(Date.UTC(c.y, c.m + n, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });

  return (
    <Glass flat className="px-3 py-3">
      <div className="flex items-center justify-between mb-2">
        <Press onClick={() => shift(-1)} className="p-1.5 -m-1.5 rounded-lg">
          <ChevronLeft size={18} style={{ color: "var(--label-2)" }} />
        </Press>
        <span className="text-[14px] font-semibold">
          {MONTHS[cursor.m]} {cursor.y}
        </span>
        <Press onClick={() => shift(1)} className="p-1.5 -m-1.5 rounded-lg">
          <ChevronRight size={18} style={{ color: "var(--label-2)" }} />
        </Press>
      </div>

      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {WD.map((w) => (
          <span key={w} className="text-[10px] text-center py-0.5"
                style={{ color: "var(--label-3)" }}>{w}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {grid.map((key, i) => {
          if (!key) return <span key={`e${i}`} />;
          const d = byKey.get(key);
          const sel = inRange(key);
          const edge = !!value && (key === value.from || key === value.to);
          return (
            /* Обычная кнопка, а не `Press`: ячеек в сетке 42, и пружинная
               анимация на каждой стоит дороже, чем добавляет. */
            <button key={key} type="button" onClick={() => tap(key)}
                    className="relative flex flex-col items-center justify-center py-1.5 rounded-lg active:opacity-60"
                    style={{
                      background: sel ? (edge ? "var(--tint)" : "rgba(255,255,255,.08)") : "transparent",
                    }}>
              <span className="text-[13px] tabular-nums"
                    style={{
                      color: edge ? "#fff"
                             : d ? "var(--label)" : "var(--label-3)",
                      fontWeight: key === today ? 700 : 400,
                    }}>
                {Number(key.split("-")[2])}
              </span>
              {/* ТОЧКА — ЕСТЬ ЛИ ДАННЫЕ, ЦВЕТ — КАКОЙ БЫЛ ДЕНЬ. Место под неё
                  занято всегда, иначе числа прыгали бы по вертикали между
                  днями с данными и без. */}
              <span className="block w-1 h-1 rounded-full mt-0.5"
                    style={{
                      background: !d ? "transparent"
                                  : edge ? "#fff"
                                  : d.usd > 0 ? "var(--green)"
                                  : d.usd < 0 ? "var(--red)" : "var(--label-3)",
                    }} />
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-2.5 pt-2.5 hairline-t">
        <span className="text-[11px]" style={{ color: "var(--label-3)" }}>
          {anchor ? "выберите второй день промежутка"
                  : value ? rangeLabel(value)
                  : "день — тап, промежуток — два тапа"}
        </span>
        {value && (
          <button type="button" onClick={() => { setAnchor(null); onChange(null); }}
                  className="text-[12px] px-2 py-1 -my-1 rounded-lg active:opacity-60"
                  style={{ color: "var(--tint-soft)" }}>
            Сбросить
          </button>
        )}
      </div>
    </Glass>
  );
}
