import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionTemplate, useMotionValue, useTransform } from "motion/react";
import { LayoutGrid, CandlestickChart, ListChecks, UserRound } from "lucide-react";
import { haptic } from "../lib/tg";

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
 * Панель вкладок со СТЕКЛЯННОЙ ЛИНЗОЙ, как в Telegram на iOS.
 *
 * Как это устроено и почему именно так.
 *
 * Пузырь не подкрашивает фон — он УВЕЛИЧИВАЕТ то, что под ним. Внутри круга
 * лежит вторая, точная копия ряда иконок, увеличенная относительно центра
 * пузыря; круг едет по панели, копия едет ему навстречу, и получается
 * настоящее стекло, за которым иконка растягивается и смещается. Никакого
 * размытия движения и никакой заливки цветом.
 *
 * Радужная кромка — два цветных `drop-shadow` на копии, красный и голубой в
 * противоположные стороны. Это и есть хроматическая аберрация настоящей линзы;
 * живёт она только в полёте, потому что постоянная бахрома читается как
 * дефект экрана.
 *
 * SVG-фильтры (настоящее преломление) здесь невозможны: Safari не применяет их
 * ни к `backdrop-filter`, ни к содержимому под элементом, а телефон у нас
 * именно Safari. Поэтому линза сделана увеличением копии — Safari это умеет и
 * делает на композиторе.
 *
 * ПРОИЗВОДИТЕЛЬНОСТЬ. Ни одного повторного рендера React за время перелёта:
 * позиция живёт в MotionValue, встречное движение копии — производная от неё
 * (`useTransform`), центр увеличения — шаблон от неё же. Меняются только
 * transform и opacity, то есть работа композитора, а не пересборка дерева.
 */
export function TabBar({ tab, onTab, badge }: {
  tab: Tab; onTab: (t: Tab) => void; badge?: Partial<Record<Tab, number>>;
}) {
  const row = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, TABS.findIndex((t) => t.id === tab));
  const prev = useRef(idx);
  const [cell, setCell] = useState(0);
  const [h, setH] = useState(56);

  /* Позиция линзы — MotionValue, а не состояние: состояние означало бы рендер
     дерева на каждом кадре полёта. */
  const x = useMotionValue(0);
  const inv = useTransform(x, (v) => -v);
  const center = useTransform(x, (v) => v + h / 2);
  const origin = useMotionTemplate`${center}px 50%`;
  /* ВСЁ на MotionValue, а не на `animate`-контролах, и это не стилистика.
     Контролы гоняют ключевые кадры через WAAPI, то есть на компоновщике: в
     стилях значение уже новое, а слой рисуется со СТАРЫМ базовым. На живом
     экране разница незаметна, но проверить такой эффект снимком невозможно —
     пузыря на снимке просто нет, и отличить «не работает» от «не снялось»
     нельзя. MotionValue пишет стиль сам, каждый кадр, на главном потоке —
     ререндеров React по-прежнему ноль. */
  const lensOp = useMotionValue(0);        // появление и угасание пузыря
  const lensSc = useMotionValue(0.8);
  const fringeOp = useMotionValue(0);      // радуга только в полёте
  const barSx = useMotionValue(1);         // отскок самой панели
  const barSy = useMotionValue(1);

  useEffect(() => {
    const fit = () => {
      const w = row.current?.clientWidth || 0;
      setCell(w / TABS.length);
      setH(row.current?.clientHeight || 56);
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (row.current) ro.observe(row.current);
    return () => ro.disconnect();
  }, []);

  const at = (i: number) => i * cell + cell / 2 - h / 2;

  useEffect(() => {
    if (!cell) return;
    const from = prev.current, to = idx;
    prev.current = idx;
    if (from === to) { x.set(at(to)); return; }

    /* Пузырь ПОЯВЛЯЕТСЯ у прежней вкладки, летит к новой и пропадает. Он не
       живёт на экране постоянно: в покое активную вкладку показывает цвет, а
       стекло — это про переход. */
    x.set(at(from));
    animate(lensOp, [0, 1, 1, 0], { duration: 0.58, times: [0, 0.14, 0.78, 1], ease: "easeOut" });
    animate(lensSc, [0.78, 1.04, 1, 0.86], { duration: 0.58, times: [0, 0.14, 0.78, 1], ease: "easeOut" });
    animate(fringeOp, [0, 0.32, 0.32, 0], { duration: 0.58, times: [0, 0.18, 0.72, 1], ease: "easeOut" });
    // Отскок: пружина с перелётом. Мягкая и короткая — панель должна
    // «дышать», а не прыгать.
    animate(x, at(to), { type: "spring", stiffness: 380, damping: 26, mass: 0.8 });
    animate(barSx, [1, 1.015, 0.997, 1], { duration: 0.44, ease: "easeOut" });
    animate(barSy, [1, 0.965, 1.008, 1], { duration: 0.44, ease: "easeOut" });
  }, [idx, cell, h]);

  const icons = (active: Tab) => (
    <div className="flex h-full">
      {TABS.map(({ id, label, Icon }) => {
        const on = id === active;
        const n = badge?.[id];
        return (
          <div key={id} className="relative flex-1 flex flex-col items-center justify-center gap-[3px]">
            {/* Отскок иконки: ключ меняется в момент, когда вкладка становится
                активной, поэтому анимация проигрывается заново — без ключа
                motion считал бы это тем же элементом и ничего бы не сыграл. */}
            <motion.span key={`${id}-${on}`} className="relative flex items-center justify-center"
                         initial={{ scale: on ? 0.84 : 1 }}
                         animate={{ scale: on ? [0.84, 1.16, 1] : 1 }}
                         transition={{ duration: 0.42, ease: "easeOut" }}>
              <Icon size={23} strokeWidth={on ? 2.5 : 1.9}
                    style={{ color: on ? "var(--tint-soft)" : "var(--label)" }} />
              {!!n && (
                <span className="absolute -top-1.5 -right-3 min-w-[17px] h-[17px] px-1 rounded-full
                                 text-[10px] font-bold flex items-center justify-center text-white"
                      style={{ background: "var(--tint-grad)" }}>{n > 999 ? "999+" : n}</span>
              )}
            </motion.span>
            <span className="text-[10px] font-medium tracking-tight"
                  style={{ color: on ? "var(--tint-soft)" : "var(--label-2)" }}>{label}</span>
          </div>
        );
      })}
    </div>
  );

  return (
    <nav className="fixed left-0 right-0 z-40 px-1.5 pointer-events-none"
         style={{ bottom: "calc(var(--safe-b) + 8px)" }}>
      <motion.div ref={row}
                  className="relative mx-auto pointer-events-auto rounded-[30px] overflow-hidden chrome"
                  /* Фон плотнее обычного стекла: под панелью проезжает контент,
                     и он не должен читаться сквозь неё. */
                  style={{ height: "var(--tabbar-h)", maxWidth: 560,
                           scaleX: barSx, scaleY: barSy,
                           background: "color-mix(in srgb, var(--bg-elev) 88%, transparent)",
                           border: "1px solid rgba(255,255,255,.08)",
                           boxShadow: "0 20px 44px -20px rgba(0,0,0,.95)" }}>

        {/* Настоящий ряд: он и принимает нажатия. */}
        <div className="absolute inset-0">{icons(tab)}</div>

        {/* ЛИНЗА. Круг с копией ряда внутри: копия увеличена относительно центра
            круга и едет навстречу, поэтому под стеклом иконка растягивается —
            ровно как в референсе. */}
        <motion.div className="absolute top-0 rounded-full overflow-hidden pointer-events-none lens-glass"
                    style={{ x, width: h, height: h, opacity: lensOp, scale: lensSc }}>
          <motion.div className="absolute top-0 left-0 h-full"
                      style={{ x: inv, width: "100vw", maxWidth: 560,
                               scale: 1.14, transformOrigin: origin }}>
            {icons(tab)}
          </motion.div>
          {/* Радужная кромка — та же копия, но со смещёнными цветными тенями.
              Отдельным слоем, чтобы гасить её независимо от самой линзы. */}
          <motion.div className="absolute inset-0 lens-fringe" style={{ opacity: fringeOp }}>
            <motion.div className="absolute top-0 left-0 h-full"
                        style={{ x: inv, width: "100vw", maxWidth: 560,
                                 scale: 1.14, transformOrigin: origin }}>
              {icons(tab)}
            </motion.div>
          </motion.div>
        </motion.div>

        {/* Кнопки поверх всего: линза ничего не перехватывает. */}
        <div className="relative flex h-full">
          {TABS.map(({ id, label }) => (
            <button key={id} onClick={() => { haptic.select(); onTab(id); }}
                    data-coach={`tab-${id}`} aria-label={label}
                    aria-current={tab === id ? "page" : undefined}
                    className="flex-1" />
          ))}
        </div>
      </motion.div>
    </nav>
  );
}

/** Нужен экранам, которые сами рисуют что-то поверх панели. */
export function TabBarSpacer(): ReactNode {
  return <div style={{ height: "calc(var(--tabbar-h) + var(--safe-b) + 18px)" }} />;
}
