/**
 * Инструменты графика: линзы (что рисуем ПОВЕРХ цены) и конструктор панелей
 * (что показываем ПОД ней).
 *
 * Почему это два разных места, а не одно меню «индикаторы». Поверх цены живёт
 * то, что имеет цену: средние, крупные сделки. Под ценой — то, у чего своя
 * шкала: открытый интерес в долларах, СВД, ликвидации. Смешай их в один
 * список, и человек будет включать «ликвидации» в ожидании линий на свечах.
 *
 * Выбор запоминается: набор панелей — это рабочее место трейдера, собирать его
 * заново при каждом открытии сделки никто не станет.
 */

import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Eye, Plus, Sparkles } from "lucide-react";
import { Glass, Press, Sheet, Toggle } from "../ui/kit";
import { PANES, PANES_DEFAULT, type Lens, type PaneKind } from "../ui/TradeChart";
import { haptic } from "../lib/tg";

const LENS_KEY = "prometey.chart.lens";
const PANE_KEY = "prometey.chart.panes";

export function readLens(): Lens {
  try {
    const v = JSON.parse(localStorage.getItem(LENS_KEY) || "{}");
    return { ema50: !!v.ema50, ema200: !!v.ema200, whales: !!v.whales };
  } catch { return { ema50: false, ema200: false, whales: false }; }
}
export function saveLens(l: Lens) {
  try { localStorage.setItem(LENS_KEY, JSON.stringify(l)); } catch { /* приватное окно */ }
}
export function readPanes(): PaneKind[] {
  try {
    const v = JSON.parse(localStorage.getItem(PANE_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => PANES.some((p) => p.id === x)) : [];
  } catch { return []; }
}
export function savePanes(p: PaneKind[]) {
  try { localStorage.setItem(PANE_KEY, JSON.stringify(p)); } catch { /* приватное окно */ }
}

/* ── Линзы ──────────────────────────────────────────────────────────────── */

export function LensButton({ lens, onLens }: { lens: Lens; onLens: (l: Lens) => void }) {
  const [open, setOpen] = useState(false);
  const n = Number(lens.ema50) + Number(lens.ema200) + Number(lens.whales);
  return (
    <>
      <Press onClick={() => { haptic.tap(); setOpen(true); }} scale={0.9}>
        <span className="relative flex items-center justify-center w-8 h-8 rounded-[10px] chrome">
          <Eye size={15} style={{ color: n ? "var(--lime)" : "var(--label-2)" }} />
          {!!n && (
            <span className="absolute -top-1 -right-1 w-[15px] h-[15px] rounded-full text-[9px]
                             font-bold flex items-center justify-center"
                  style={{ background: "var(--tint-grad)", color: "#fff" }}>{n}</span>
          )}
        </span>
      </Press>
      <Sheet open={open} onClose={() => setOpen(false)} title="Поверх цены">
        <div className="pb-3 space-y-2">
          <Glass flat className="overflow-hidden">
            <LensRow label="EMA 50" note="быстрая средняя — где идёт краткосрочный тренд"
                     dot="var(--yellow)" on={lens.ema50}
                     onChange={(v) => onLens({ ...lens, ema50: v })} />
            <LensRow label="EMA 200" note="медленная — сторона рынка в целом"
                     dot="#0a84ff" on={lens.ema200}
                     onChange={(v) => onLens({ ...lens, ema200: v })} />
            <LensRow label="Входы китов" note="крупные сделки прямо сейчас, кружком с объёмом"
                     dot="var(--lime)" on={lens.whales}
                     onChange={(v) => onLens({ ...lens, whales: v })} last />
          </Glass>
          <p className="text-[12px] leading-snug px-1" style={{ color: "var(--label-2)" }}>
            «Крупная» считается не константой, а по самой монете: медиана её
            ленты, умноженная на 25. $50 000 на биткоине — рутина, а на мелкой
            монете — событие, и один порог на всех врал бы в обе стороны.
          </p>
        </div>
      </Sheet>
    </>
  );
}

function LensRow({ label, note, dot, on, onChange, last }: {
  label: string; note: string; dot: string; on: boolean;
  onChange: (v: boolean) => void; last?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${last ? "" : "hairline"}`}>
      <span className="w-3.5 h-[3px] rounded-full shrink-0" style={{ background: dot }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px]">{label}</span>
        <span className="block text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>{note}</span>
      </span>
      <Toggle on={on} onChange={(v) => { haptic.select(); onChange(v); }} />
    </div>
  );
}

/* ── Полоса «добавить панель» ───────────────────────────────────────────────
   Узкая зона под графиком с плюсом. Стоит там, где панели и появятся, — то
   есть кнопка находится на месте своего результата, а не в меню сверху. */

export function AddPaneStrip({ panes, onPanes }: {
  panes: PaneKind[]; onPanes: (p: PaneKind[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Press onClick={() => { haptic.tap(); setOpen(true); }} className="block w-full mt-2" scale={0.99}>
        <div className="h-[30px] rounded-[10px] flex items-center justify-center gap-1.5 text-[12px]"
             style={{ border: "1px dashed var(--label-3)", color: "var(--label-2)" }}>
          <Plus size={13} />
          {panes.length
            ? `Панели: ${panes.map((p) => PANES.find((x) => x.id === p)?.label).join(" · ")}`
            : "Добавить индикаторы под график"}
        </div>
      </Press>
      <PaneSheet open={open} onClose={() => setOpen(false)} panes={panes} onPanes={onPanes} />
    </>
  );
}

export function PaneSheet({ open, onClose, panes, onPanes }: {
  open: boolean; onClose: () => void; panes: PaneKind[]; onPanes: (p: PaneKind[]) => void;
}) {
  const toggle = (id: PaneKind) => {
    haptic.select();
    onPanes(panes.includes(id) ? panes.filter((p) => p !== id) : [...panes, id]);
  };
  const move = (id: PaneKind, d: number) => {
    const i = panes.indexOf(id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= panes.length) return;
    const next = [...panes];
    [next[i], next[j]] = [next[j], next[i]];
    haptic.tap();
    onPanes(next);
  };

  return (
    <Sheet open={open} onClose={onClose} title="Под графиком" tall>
      <div className="pb-3 space-y-2.5">
        <Press onClick={() => { haptic.ok(); onPanes(PANES_DEFAULT); }} className="block w-full">
          <div className="py-3 rounded-[16px] flex items-center justify-center gap-2 text-[15px]
                          font-semibold"
               style={{ background: "var(--tint-grad)", color: "#fff" }}>
            <Sparkles size={16} /> Рекомендованный набор
          </div>
        </Press>
        <p className="text-[12px] leading-snug px-1" style={{ color: "var(--label-2)" }}>
          Открытый интерес, новые лонги и шорты, СВД, ликвидации — в этом
          порядке. Сверху то, у чего есть история, снизу то, что идёт только
          потоком.
        </p>

        <Glass flat className="overflow-hidden">
          {PANES.map((p, i) => {
            const on = panes.includes(p.id);
            const pos = panes.indexOf(p.id);
            return (
              <div key={p.id} className={`flex items-center gap-3 px-4 py-3 ${i === PANES.length - 1 ? "" : "hairline"}`}>
                <Press onClick={() => toggle(p.id)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-2">
                    <span className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center shrink-0"
                          style={{ background: on ? "var(--lime)" : "transparent",
                                   border: on ? "none" : "1px solid var(--label-3)" }}>
                      {on && <Check size={13} strokeWidth={3} color="#fff" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px]">
                        {on && <b style={{ color: "var(--lime)" }}>{pos + 1}. </b>}{p.label}
                      </span>
                      <span className="block text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>
                        {p.note}{p.live ? " · только с момента открытия" : ""}
                      </span>
                    </span>
                  </span>
                </Press>
                {on && (
                  <span className="flex items-center gap-1 shrink-0">
                    <Press onClick={() => move(p.id, -1)} disabled={pos === 0} className="p-1.5 rounded-lg">
                      <ArrowUp size={14} style={{ color: pos === 0 ? "var(--label-3)" : "var(--label-2)" }} />
                    </Press>
                    <Press onClick={() => move(p.id, 1)} disabled={pos === panes.length - 1}
                           className="p-1.5 rounded-lg">
                      <ArrowDown size={14} style={{ color: pos === panes.length - 1 ? "var(--label-3)" : "var(--label-2)" }} />
                    </Press>
                  </span>
                )}
              </div>
            );
          })}
        </Glass>

        <p className="text-[12px] leading-snug px-1" style={{ color: "var(--label-2)" }}>
          У СВД и ликвидаций истории не существует ни у кого: биржа отдаёт их
          только потоком, поэтому ряд начинается в момент, когда вы открыли
          график. Дорисовать прошлое нечем, а выдумать — значит показать сделки,
          которых не было.
        </p>
        {panes.length > 0 && (
          <Press onClick={() => { haptic.tap(); onPanes([]); }} className="block w-full">
            <div className="py-2.5 text-center text-[14px]" style={{ color: "var(--red)" }}>
              Убрать все панели
            </div>
          </Press>
        )}
      </div>
    </Sheet>
  );
}
