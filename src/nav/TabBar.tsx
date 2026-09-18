import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionTemplate, useMotionValue, useTransform } from "motion/react";
import { LayoutGrid, CandlestickChart, ListChecks, UserRound } from "lucide-react";
import { haptic } from "../lib/tg";
import { useLensSquash } from "../ui/liquid";

export type Tab = "home" | "market" | "trades" | "cabinet";

/** Порядок вкладок — ОДИН на панель и на свайп: если бы свайп листал в другом
 *  порядке, жест ощущался бы случайным. */
export const TABS_ORDER: Tab[] = ["home", "market", "trades", "cabinet"];

const TABS: { id: Tab; label: string; Icon: typeof LayoutGrid }[] = [
  { id: "home", label: "Главная", Icon: LayoutGrid },
  { id: "market", label: "Позиции", Icon: CandlestickChart },
  { id: "trades", label: "Аналитика", Icon: ListChecks },
  { id: "cabinet", label: "Кабинет", Icon: UserRound },
];

/**
 * Панель вкладок — порт `_UILiquidLensView` из UITabBar iOS 26
 * (реализация DnV1eX/LiquidGlassKit, MIT).
 *
 * У линзы ДВА состояния, и это главное, что отличает её от «пузыря, который
 * прилетает и улетает»:
 *
 *   • ПОКОЙ — полупрозрачная белая пилюля под активной вкладкой. Она не
 *     исчезает: место, где вы находитесь, обозначено материалом, а не только
 *     цветом значка.
 *   • ПОДНЯТА — на время перелёта пилюля превращается в полноценное стекло:
 *     под ним лежит увеличенная копия ряда иконок, поэтому иконка за стеклом
 *     по-настоящему растягивается и смещается, а по её краю идёт радуга.
 *
 * Сжатие и растяжение линзы в полёте считаются по УСКОРЕНИЮ (`useLensSquash`,
 * ui/liquid.tsx), а не по скорости — формула и окно усреднения из оригинала.
 * Разница заметна сразу: по скорости пузырь растянут всю дорогу и встаёт
 * рывком; по ускорению он растягивается на старте, отпускает середину и
 * сжимается на торможении — то есть ведёт себя как капля, а не как резинка.
 *
 * Настоящего преломления фона тут нет и быть не может: SVG-фильтр в
 * `backdrop-filter` Safari не применяет, а телефон у нас именно Safari.
 * Но под линзой лежит ИЗВЕСТНОЕ содержимое — тот самый ряд иконок, — и его
 * копию можно увеличить честно. Поэтому искривление здесь настоящее, в
 * отличие от остальных стеклянных поверхностей приложения.
 *
 * ПРОИЗВОДИТЕЛЬНОСТЬ. Ни одного рендера React за перелёт: позиция, масштабы и
 * прозрачности живут в MotionValue, встречное движение копии — производная от
 * позиции. Меняются только transform и opacity, то есть работа композитора.
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
  /* Размеры линзы — тоже MotionValue, хотя меняются раз в жизнь (поворот,
     смена ширины окна). Причина техническая: `useTransform` запоминает
     функцию, и замыкание на обычное число после пересчёта ширины осталось бы
     со старым значением — центр увеличения уехал бы от центра стекла. */
  const lwMv = useMotionValue(0);
  const center = useTransform([x, lwMv], ([v, w]: number[]) => v + w / 2);
  const origin = useMotionTemplate`${center}px 50%`;
  /* ВСЁ на MotionValue, а не на `animate`-контролах, и это не стилистика.
     Контролы гоняют ключевые кадры через WAAPI, то есть на компоновщике: в
     стилях значение уже новое, а слой рисуется со СТАРЫМ базовым. На живом
     экране разница незаметна, но проверить такой эффект снимком невозможно —
     пузыря на снимке просто нет, и отличить «не работает» от «не снялось»
     нельзя. MotionValue пишет стиль сам, каждый кадр, на главном потоке —
     ререндеров React по-прежнему ноль. */
  const glassOp = useMotionValue(0);       // 0 — пилюля покоя, 1 — стекло
  const restOp = useTransform(glassOp, (v) => 1 - v);
  const fringeOp = useMotionValue(0);      // радуга только в полёте
  const barSx = useMotionValue(1);         // отскок самой панели
  const barSy = useMotionValue(1);

  /* «Поднята» — состояние оригинала: пока линза летит, она стеклянная и живёт
     по физике, в покое это просто пилюля. Держим его в state (а не в ref):
     от него зависит подписка на кадры, то есть монтирование эффекта. */
  const [lifted, setLifted] = useState(false);
  const { sx, sy } = useLensSquash(x, lifted);
  /* Подъём буквальный: в полёте линза ВЫРАСТАЕТ и выходит за края панели —
     стекло поднято над поверхностью, значит и выглядит крупнее. Для этого
     она вынесена из панели наружу (см. разметку): панель обрезает всё по
     своему скруглению, и изнутри линзе за край не выйти. */
  const lift = useMotionValue(1);
  const lensSx = useTransform([sx, lift], ([a, b]: number[]) => a * b);
  const lensSy = useTransform([sy, lift], ([a, b]: number[]) => a * b);

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

  /* Линза — КАПСУЛА по размеру ячейки, а не круг во всю высоту панели: круг
     высотой с панель накрывал бы вкладку целиком вместе с подписью, и вышла
     бы кнопка, а не отметка места. Полей оставлено по 3px с каждой стороны —
     столько, чтобы пилюля читалась как отдельный предмет, но занимала свою
     ячейку целиком. Полей ровно столько, чтобы у КРАЙНИХ вкладок выросшая
     линза не упиралась в край экрана: обрезанная экраном, она читается как
     дефект, а не как подъём. Потолок в 116px — чтобы на широком экране она
     не расползлась в плашку. */
  const lw = cell ? Math.min(Math.max(cell - 12, 48), 116) : 0;
  const lh = Math.max(h - 6, 34);
  const top = (h - lh) / 2;
  useEffect(() => { lwMv.set(lw); }, [lw]);

  const at = (i: number) => i * cell + cell / 2 - lw / 2;

  useEffect(() => {
    if (!cell) return;
    const from = prev.current, to = idx;
    prev.current = idx;
    if (from === to) { x.set(at(to)); return; }

    /* Подъём и посадка — пружины оригинала: 0.4с при затухании 0.7 вверх и
       0.5с при 0.8 вниз. Вверх короче и звонче, вниз дольше и мягче: линза
       поднимается рывком, а опускается, догоняя саму себя. */
    x.set(at(from));
    setLifted(true);
    animate(glassOp, 1, { type: "spring", duration: 0.4, bounce: 0.3 });
    animate(lift, 1.18, { type: "spring", duration: 0.4, bounce: 0.35 });
    animate(fringeOp, [0, 0.32, 0.32, 0], { duration: 0.58, times: [0, 0.18, 0.72, 1], ease: "easeOut" });
    const flight = animate(x, at(to), { type: "spring", stiffness: 380, damping: 26, mass: 0.8 });
    // Отскок панели: мягкий и короткий — она должна «дышать», а не прыгать.
    animate(barSx, [1, 1.015, 0.997, 1], { duration: 0.44, ease: "easeOut" });
    animate(barSy, [1, 0.965, 1.008, 1], { duration: 0.44, ease: "easeOut" });

    /* Посадка — по ОКОНЧАНИЮ перелёта, а не по таймеру «примерно столько же»:
       пружина доезжает за разное время в зависимости от длины пути (соседняя
       вкладка и вкладка через три — это не одно и то же), и линза, севшая
       раньше прибытия, оставила бы стекло посреди панели. */
    let alive = true;
    void flight.then(() => {
      if (!alive) return;
      setLifted(false);
      animate(glassOp, 0, { type: "spring", duration: 0.5, bounce: 0.2 });
      animate(lift, 1, { type: "spring", duration: 0.5, bounce: 0.25 });
    });
    return () => { alive = false; };
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

  /* Копия ряда под стеклом — одна и та же разметка для самого стекла и для
     радужной кромки, поэтому вынесена сюда. */
  const magnified = (
    <motion.div className="absolute top-0 left-0"
                style={{ x: inv, y: -top, height: h, width: cell * TABS.length,
                         scale: 1.14, transformOrigin: origin }}>
      {icons(tab)}
    </motion.div>
  );

  return (
    <nav className="fixed left-0 right-0 z-40 px-1.5 pointer-events-none"
         style={{ bottom: "calc(var(--safe-b) + 8px)" }}>
      {/* Обёртка НЕ обрезает содержимое: в ней лежат и панель, и линза.
          Панель обрезает себя сама (у неё скругление и фон), а линза —
          снаружи, поэтому в полёте ей есть куда вырасти. Пока она лежала
          внутри панели, «подъём» упирался в её же край. */}
      <div className="relative mx-auto" style={{ maxWidth: 560 }}>
        <motion.div ref={row}
                    className="relative rounded-[30px] overflow-hidden chrome"
                    /* Фон плотнее обычного стекла: под панелью проезжает контент,
                       и он не должен читаться сквозь неё. */
                    style={{ height: "var(--tabbar-h)",
                             scaleX: barSx, scaleY: barSy,
                             background: "color-mix(in srgb, var(--bg-elev) 88%, transparent)",
                             border: "1px solid rgba(255,255,255,.08)",
                             boxShadow: "0 20px 44px -20px rgba(0,0,0,.95)" }}>

          {/* Настоящий ряд: он и принимает нажатия. */}
          <div className="absolute inset-0">{icons(tab)}</div>

          {/* Кнопки поверх всего. */}
          <div className="relative flex h-full pointer-events-auto">
            {TABS.map(({ id, label }) => (
              <button key={id} onClick={() => { haptic.select(); onTab(id); }}
                      data-coach={`tab-${id}`} aria-label={label}
                      aria-current={tab === id ? "page" : undefined}
                      className="flex-1" />
            ))}
          </div>
        </motion.div>

        {/* ЛИНЗА. Один элемент на оба состояния — он и едет, и деформируется;
            меняется только материал внутри. Масштабы приходят из физики
            ускорения (сплющивается вдоль движения, вытягивается поперёк) и
            из подъёма (в полёте крупнее и выходит за панель). Нажатия она не
            перехватывает — они уходят кнопкам под ней. */}
        <motion.div className="absolute top-0 rounded-full pointer-events-none"
                    style={{ x, width: lw, height: lh, marginTop: top,
                             scaleX: lensSx, scaleY: lensSy }}>

          {/* ПОКОЙ: полупрозрачная белая пилюля. Она под активной вкладкой
              всегда — это и есть «вы здесь» из оригинала. */}
          <motion.div className="absolute inset-0 rounded-full"
                      style={{ opacity: restOp, background: "var(--lens-rest)",
                               boxShadow: "inset 0 1px 0 rgba(255,255,255,.22)" }} />

          {/* ПОДНЯТА: стекло с увеличенной копией ряда под ним. */}
          <motion.div className="absolute inset-0 rounded-full overflow-hidden lens-glass"
                      style={{ opacity: glassOp }}>
            {/* ВЫРЕЗ. В оригинале у линзы есть punchout-слой: настоящий ряд под
                ней не просвечивает, иначе увеличенная копия накладывается на
                него со смещением и вместо стекла получается двоение — на
                снимке подпись читалась дважды. Цвет — тот же, что у панели,
                поэтому вырез не виден как заплатка. */}
            <div className="absolute inset-0" style={{ background: "var(--bg-elev)" }} />
            {magnified}
            {/* Радужная кромка — та же копия, но со смещёнными цветными
                тенями. Отдельным слоем, чтобы гасить её независимо от стекла:
                постоянная бахрома читается как дефект экрана. */}
            <motion.div className="absolute inset-0 lens-fringe" style={{ opacity: fringeOp }}>
              {magnified}
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </nav>
  );
}

/** Нужен экранам, которые сами рисуют что-то поверх панели. */
export function TabBarSpacer(): ReactNode {
  return <div style={{ height: "calc(var(--tabbar-h) + var(--safe-b) + 18px)" }} />;
}
