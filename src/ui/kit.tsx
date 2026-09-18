import { AnimatePresence, motion, useDragControls } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { haptic } from "../lib/tg";

/* Пружина одна на всё приложение: разные кривые в соседних элементах читаются
   как разное качество сборки. Значения — «упругий отскок» без перелёта. */
export const SPRING = { type: "spring", stiffness: 520, damping: 30, mass: 0.7 } as const;
export const SPRING_SOFT = { type: "spring", stiffness: 260, damping: 26 } as const;

/** Всё нажимаемое оборачивается сюда: сжатие + хаптика + упругий возврат. */
export function Press({
  children, onClick, className = "", disabled, scale = 0.955, feel = "tap",
}: {
  children: ReactNode; onClick?: () => void; className?: string;
  disabled?: boolean; scale?: number; feel?: "tap" | "press" | "heavy";
}) {
  return (
    <motion.button
      type="button"
      disabled={disabled}
      whileTap={disabled ? undefined : { scale }}
      transition={SPRING}
      onClick={() => { if (disabled) return; haptic[feel](); onClick?.(); }}
      /* lg-press — режим кнопки из ybouane/liquidglass: нажатие сплющивает
         фаску стекла внутри и углубляет тень. На кнопке без стекла класс не
         делает ничего (правило в theme.css целится только в `.lg`). */
      className={`appearance-none text-left disabled:opacity-40 lg-press ${className}`}
    >
      {children}
    </motion.button>
  );
}

export function Glass({ children, className = "", flat, style }: {
  children: ReactNode; className?: string; flat?: boolean; style?: React.CSSProperties;
}) {
  return <div className={`glass ${flat ? "glass-flat" : ""} ${className}`} style={style}>{children}</div>;
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="px-5 pt-1 pb-3">
      <h1 className="text-[34px] font-bold tracking-[-0.03em] leading-tight">{children}</h1>
      {sub && <p className="text-[15px] mt-0.5" style={{ color: "var(--label-2)" }}>{sub}</p>}
    </div>
  );
}

export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 pt-5 pb-2 text-[13px] uppercase tracking-wide font-medium"
         style={{ color: "var(--label-2)" }}>{children}</div>
  );
}

/** Сегментный контрол iOS: подложка едет за выбором через layoutId. */
export function Segmented<T extends string>({
  value, onChange, options, size = "md",
}: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; size?: "sm" | "md" }) {
  return (
    <div className="glass glass-flat p-[3px] flex gap-[3px] rounded-[11px]">
      {options.map((o) => (
        <button key={o.id} onClick={() => { haptic.select(); onChange(o.id); }}
          className={`relative flex-1 rounded-[9px] ${size === "sm" ? "py-1 text-[13px]" : "py-1.5 text-[14px]"} font-medium`}
          style={{ color: value === o.id ? "var(--label)" : "var(--label-2)" }}>
          {value === o.id && (
            <motion.span layoutId="seg" transition={SPRING}
              className="absolute inset-0 rounded-[9px]"
              style={{ background: "var(--bg-elev)", boxShadow: "0 1px 3px rgba(0,0,0,.14)" }} />
          )}
          <span className="relative z-10">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Нижняя шторка: подъезжает пружиной, тянется вниз пальцем, фон размывается. */
export function Sheet({
  open, onClose, title, children, tall,
}: { open: boolean; onClose: () => void; title?: string; children: ReactNode; tall?: boolean }) {
  const grab = useDragControls();
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,.35)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }} />
          <motion.div
            /* Тянуть вниз можно ТОЛЬКО за шапку (dragListener выключен, жест
               запускает шапка через dragControls). Иначе жест закрытия спорит с
               прокруткой содержимого: лист уезжал вниз вместо того, чтобы
               прокрутить список, и до нижних строк было не добраться. */
            drag="y" dragListener={false} dragControls={grab}
            dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.45 }}
            onDragEnd={(_, i) => { if (i.offset.y > 110 || i.velocity.y > 700) { haptic.tap(); onClose(); } }}
            initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SPRING_SOFT}
            className="glass relative w-full flex flex-col"
            style={{
              borderRadius: "22px 22px 0 0",
              /* Высота листа — от экрана, а его содержимое тянется остатком
                 (flex-1 + min-h-0) и прокручивается. Раньше у прокрутки стоял
                 maxHeight в процентах ОТ РОДИТЕЛЯ, высота которого сама зависела
                 от содержимого: на длинном списке нижние строки просто не
                 доезжали. */
              maxHeight: tall ? "92svh" : "82svh",
              paddingBottom: "calc(20px + var(--safe-b))",
            }}>
            <div className="pt-2.5 pb-1 flex justify-center shrink-0 cursor-grab"
                 style={{ touchAction: "none" }}
                 onPointerDown={(e) => grab.start(e)}>
              <div className="w-9 h-[5px] rounded-full" style={{ background: "var(--label-3)" }} />
            </div>
            {title && (
              <div className="px-5 pb-2 flex items-center justify-between shrink-0"
                   style={{ touchAction: "none" }}
                   onPointerDown={(e) => grab.start(e)}>
                <h2 className="text-[20px] font-bold tracking-[-0.02em]">{title}</h2>
                <Press onClick={onClose} className="rounded-full p-1.5"
                       aria-label="Закрыть">
                  <span className="flex items-center justify-center w-7 h-7 rounded-full"
                        style={{ background: "var(--label-3)" }}>
                    <X size={15} strokeWidth={2.6} />
                  </span>
                </Press>
              </div>
            )}
            <div className="scroll px-5 flex-1 min-h-0" style={{ overscrollBehavior: "contain" }}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/** Модалка по центру — для блокирующих сообщений (долг, подтверждение закрытия). */
export function Modal({
  open, onClose, children, dismissable = true,
}: { open: boolean; onClose: () => void; children: ReactNode; dismissable?: boolean }) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-5">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => dismissable && onClose()}
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,.45)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }} />
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 12 }} animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }} transition={SPRING}
            /* Прокрутка и здесь: длинное подтверждение (например, разбор
               отказа биржи) иначе упиралось в край экрана и обрезалось. */
            className="glass relative w-full max-w-[380px] p-5 scroll"
            style={{ maxHeight: "86svh", overscrollBehavior: "contain" }}>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function Row({
  icon, title, note, right, onClick, danger, last,
}: {
  icon?: ReactNode; title: ReactNode; note?: ReactNode; right?: ReactNode;
  onClick?: () => void; danger?: boolean; last?: boolean;
}) {
  const body = (
    <div className={`flex items-center gap-3 px-4 py-2.5 ${last ? "" : "hairline"}`}>
      {icon && (
        <span className="flex items-center justify-center w-[30px] h-[30px] rounded-[8px] shrink-0"
              style={{ background: "var(--label-3)", color: danger ? "var(--red)" : "var(--label)" }}>
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[16px] leading-tight truncate" style={{ color: danger ? "var(--red)" : "var(--label)" }}>
          {title}
        </div>
        {note && <div className="text-[13px] mt-0.5 leading-snug" style={{ color: "var(--label-2)" }}>{note}</div>}
      </div>
      {right && <div className="text-[15px] shrink-0" style={{ color: "var(--label-2)" }}>{right}</div>}
    </div>
  );
  return onClick ? <Press onClick={onClick} className="block w-full">{body}</Press> : body;
}

/* Переключатель переехал в ui/liquid.tsx — это порт LiquidGlassSwitch из iOS 26:
   бегунок раскрывается в стекло под пальцем, переключается по достижении края
   дорожки, сопротивляется за границей. Имя оставлено прежним НАМЕРЕННО: его
   зовут из восьми мест, и переименование ради переноса файла было бы правкой
   восьми экранов без единого изменения по существу. */
export { Toggle } from "./liquid";

export const money = (v: number) => (v >= 0 ? "+" : "−") + "$" + Math.abs(v).toFixed(2);
/** Тег контура «алгос».
 *
 *  Сделки двух контуров лежат в одном журнале и выглядят одинаково, а живут
 *  по-разному: сигнал скринера — это уровень, который держат часами, а сделка
 *  алгоса — реакция на работающий в ленте алгоритм, живущая минуты. Без метки
 *  строка «SUI −1.2% · 3 мин» в истории читалась бы как провал сигнала, хотя
 *  сигнала не было вовсе.
 *
 *  У скринерских сделок тега НЕТ намеренно: их большинство, и подписывать
 *  каждую «скринер» значит добавить шум ради симметрии. */
export function AlgoTag({ source, className = "" }: { source?: string; className?: string }) {
  if (source !== "algo") return null;
  return (
    /* Заливка акцентом, а не акцентный текст: красный — цвет убытка в числах,
       и красное слово рядом с красным минусом читалось бы как часть результата.
       Акцент в этой теме живёт на ПОВЕРХНОСТЯХ (см. theme.css), текст на нём
       белый — так тег остаётся меткой, а не оценкой. */
    <span className={"px-1.5 py-0.5 rounded-md text-[11px] font-semibold shrink-0 " + className}
          style={{ background: "var(--tint-grad)", color: "#fff" }}>
      алгос
    </span>
  );
}

export const tone = (v: number) => (v > 0 ? "var(--green)" : v < 0 ? "var(--red)" : "var(--label-2)");

/**
 * Живое сияние для стеклянной карточки. Разметка пустая — вся анимация в CSS
 * (`.aurora` в theme.css), поэтому React её не перерисовывает НИ РАЗУ: компонент
 * монтируется один раз и дальше существует только на композиторе.
 */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden>
      <i className="aurora__a" />
      <i className="aurora__b" />
      <i className="aurora__c" />
      <span className="aurora__grain" />
    </div>
  );
}

/** Значение CSS-переменной темы РЕАЛЬНЫМ цветом. Нужно всему, что рисуется не
 *  в CSS: canvas графика понимает «#30d158», но не «var(--green)». */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
