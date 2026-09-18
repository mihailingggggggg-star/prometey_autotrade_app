import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "motion/react";
import { LayoutGrid, CandlestickChart, ListChecks, UserRound } from "lucide-react";
import { haptic } from "../lib/tg";
import { SPRING } from "../ui/kit";

export type Tab = "home" | "market" | "trades" | "cabinet";

/** Порядок вкладок — ОДИН на панель и на свайп: если бы свайп листал в другом
 *  порядке, жест ощущался бы случайным. */
export const TABS_ORDER: Tab[] = ["home", "market", "trades", "cabinet"];

const TABS: { id: Tab; label: string; Icon: typeof LayoutGrid }[] = [
  { id: "home", label: "Главная", Icon: LayoutGrid },
  { id: "market", label: "Рынок", Icon: CandlestickChart },
  { id: "trades", label: "Сделки", Icon: ListChecks },
  { id: "cabinet", label: "Кабинет", Icon: UserRound },
];

/**
 * Панель вкладок — плавающая, со «жидким» пузырём под активной иконкой.
 *
 * Пузырь не переезжает, а ПЕРЕЛИВАЕТСЯ: на старте он растягивается по
 * направлению движения и худеет по вертикали, к финишу собирается обратно. За
 * ним с меньшей жёсткостью летит второй, и в контейнере с blur + contrast их
 * края слипаются — те самые метаболы (см. `.liquid` в theme.css). Всё на
 * композиторе: двигаются только transform и width, слой не перерисовывается.
 *
 * Хроматическая кромка живёт ТОЛЬКО во время перелёта. Постоянная бахрома
 * читается как дефект экрана, а в движении даёт стекло.
 *
 * Почему не готовая библиотека. Все зрелые реализации «жидкого стекла» для
 * веба (liquid-glass-react и родня) строят преломление на SVG-фильтре в
 * backdrop-filter, а Safari его не применяет вовсе — на iPhone, то есть на
 * нашем единственном настоящем устройстве, эффект просто не появился бы.
 * Поэтому здесь свои 60 строк на том, что Safari умеет.
 */
export function TabBar({ tab, onTab, badge }: {
  tab: Tab; onTab: (t: Tab) => void; badge?: Partial<Record<Tab, number>>;
}) {
  const row = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, TABS.findIndex((t) => t.id === tab));
  const prev = useRef(idx);
  const [cell, setCell] = useState(0);
  const main = useAnimationControls();
  const trail = useAnimationControls();
  const fringe = useAnimationControls();
  const goo = useAnimationControls();

  // Ширину ячейки меряем сами: пузырь ездит в пикселях, а панель тянется по
  // ширине экрана — от процентов он бы «дышал» на каждом повороте.
  useEffect(() => {
    const fit = () => setCell((row.current?.clientWidth || 0) / TABS.length);
    fit();
    const ro = new ResizeObserver(fit);
    if (row.current) ro.observe(row.current);
    return () => ro.disconnect();
  }, []);

  const D = 44;                                  // диаметр пузыря
  const x = (i: number) => i * cell + cell / 2 - D / 2;

  useEffect(() => {
    if (!cell) return;
    const from = prev.current, to = idx;
    prev.current = idx;
    const dist = Math.abs(to - from);
    if (!dist) {                                  // первая отрисовка — без анимации
      void main.set({ x: x(to), width: D, scaleY: 1 });
      void trail.set({ x: x(to), width: D, scaleY: 1 });
      return;
    }
    // Растяжение по направлению движения — это и есть «жидкость»: капля в
    // полёте вытягивается, а не едет шариком.
    const stretch = Math.min(1.9, 1 + dist * 0.32);
    void main.start({ x: x(to), width: [D, D * stretch, D], scaleY: [1, 0.72, 1] },
                    { type: "spring", stiffness: 420, damping: 30, mass: 0.7 });
    void trail.start({ x: x(to), width: [D * 0.8, D * stretch * 0.9, D * 0.8], scaleY: [1, 0.66, 1] },
                     { type: "spring", stiffness: 240, damping: 26, mass: 0.9 });
    void fringe.start({ opacity: [0, 0.75, 0] }, { duration: 0.42, ease: "easeOut" });
    void goo.start({ opacity: [0, 1, 1, 0] }, { duration: 0.5, ease: "easeOut" });
  }, [idx, cell]);

  return (
    <nav className="fixed left-0 right-0 z-40 px-4 pointer-events-none"
         style={{ bottom: "calc(var(--safe-b) + 10px)" }}>
      <div ref={row}
           className="relative mx-auto pointer-events-auto rounded-full overflow-hidden chrome"
           /* Фон плотнее обычного стекла: под панелью проезжает контент, и он
              не должен читаться сквозь неё — иначе вместо панели получается
              полоса с чужим текстом. */
           style={{ height: "var(--tabbar-h)", maxWidth: 420,
                    background: "color-mix(in srgb, var(--bg) 94%, transparent)",
                    border: "1px solid rgba(255,255,255,.10)",
                    boxShadow: "0 18px 40px -18px rgba(0,0,0,.9)" }}>

        {/* СЛОЙ КАПЕЛЬ работает только во время перелёта: пока вкладка не
            меняется, его не видно вовсе. Причина простая — в покое нужна
            чистая окружность, как в референсе, а blur+contrast даёт хоть и
            резкий, но всё же «оплавленный» край. Так что в покое рисует
            крепкая плашка ниже, а жидкость появляется ровно на время
            движения, когда край всё равно размазан скоростью. */}
        <motion.div className="liquid" animate={goo} style={{ opacity: 0 }}>
          <motion.div className="liquid-blob" animate={trail}
                      style={{ height: D * 0.82, marginTop: -(D * 0.82) / 2 }} />
          <motion.div className="liquid-blob" animate={main}
                      style={{ height: D, marginTop: -D / 2 }} />
        </motion.div>
        {/* Сама плашка активной вкладки — без фильтров, чтобы край был ровным. */}
        <motion.div animate={main} className="absolute rounded-full"
                    style={{ height: D, marginTop: -D / 2, top: "50%",
                             background: "var(--lime)",
                             boxShadow: "0 6px 18px -6px color-mix(in srgb, var(--lime) 60%, transparent)" }} />
        {/* Хроматическая кромка: та же капля в красном и синем, на пиксель в
            стороны, только в момент перелёта. */}
        <motion.div className="liquid" animate={fringe} style={{ opacity: 0 }}>
          <motion.div className="liquid-blob liquid-fringe" animate={main}
                      style={{ height: D, marginTop: -D / 2, background: "#ff3b30", marginLeft: -2 }} />
          <motion.div className="liquid-blob liquid-fringe" animate={main}
                      style={{ height: D, marginTop: -D / 2, background: "#0a84ff", marginLeft: 2 }} />
        </motion.div>

        <div className="relative flex h-full">
          {TABS.map(({ id, label, Icon }, i) => {
            const on = tab === id;
            const n = badge?.[id];
            return (
              <button key={id} onClick={() => { haptic.select(); onTab(id); }}
                      data-coach={`tab-${id}`} aria-label={label}
                      aria-current={on ? "page" : undefined}
                      className="relative flex-1 flex items-center justify-center">
                <motion.span animate={{ scale: on ? 1 : 0.92 }} transition={SPRING}
                             className="relative flex items-center justify-center">
                  <Icon size={22} strokeWidth={on ? 2.5 : 1.9}
                        /* На лаймовой капле иконка ТЁМНАЯ: белая по кислотному
                           фону не читается вовсе. */
                        style={{ color: on ? "#0b0f07" : "var(--label-2)" }} />
                  {!!n && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-[16px] px-1 rounded-full
                                     text-[10px] font-bold flex items-center justify-center text-white"
                          style={{ background: "var(--red)",
                                   boxShadow: "0 0 0 2px color-mix(in srgb, var(--bg) 80%, transparent)" }}>
                      {n}
                    </span>
                  )}
                </motion.span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
