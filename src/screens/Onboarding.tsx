import { useEffect, useLayoutEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, BookOpen, PartyPopper, Sparkles } from "lucide-react";
import { Glass, Press, SPRING, Sheet } from "../ui/kit";
import { useApp } from "../lib/store";
import { haptic } from "../lib/tg";
import type { Tab } from "../nav/TabBar";
import { ApiGuide } from "./ApiGuide";

type Step = {
  target?: string;          // data-coach элемента, который подсвечиваем
  tab?: Tab;                // на какой вкладке живёт шаг
  title: string;
  text: string;
  cta?: string;
  final?: boolean;
};

const STEPS: Step[] = [
  { title: "Добро пожаловать", tab: "home",
    text: "Пройдём по интерфейсу за минуту — покажу, где что лежит, и в конце подключим биржу. Прервать можно в любой момент.",
    cta: "Показать" },
  { target: "pnl", tab: "home", title: "Ваш результат",
    text: "Главная карточка: заработок за выбранный период. Тап по ней открывает разбивку — прибыль, убытки, комиссии, оборот." },
  { target: "quick", tab: "home", title: "Быстрые действия",
    text: "Поставить бота на паузу, экстренно закрыть все позиции или пополнить баланс. Пауза не трогает уже открытые сделки." },
  { target: "signals", tab: "home", title: "Лента сигналов",
    text: "Что скринер нашёл последним и что с этим стало: открыта позиция, висит лимитка или сделка уже закрыта." },
  { target: "tab-market", tab: "market", title: "Рынок",
    text: "Здесь живут открытые позиции с PnL в реальном времени. Тап по карточке открывает график с уровнями входа, цели и стопа." },
  { target: "positions", tab: "market", title: "Карточка позиции",
    text: "Полоса показывает, насколько цена прошла путь от входа к цели. Внутри — кнопка закрытия и правка уровней." },
  { target: "tab-trades", tab: "trades", title: "Сделки",
    text: "История и аналитика: кривая депозита, винрейт, профит-фактор, просадка. Каждая строка раскрывается в детали." },
  { target: "tab-cabinet", tab: "cabinet", title: "Кабинет",
    text: "Баланс, подписка, комиссия, настройки бота и ключи биржи. Всё управление собрано здесь." },
  { target: "risk", tab: "cabinet", title: "Главная настройка",
    text: "Риск на сделку в долларах — ровно столько вы теряете при срабатывании стопа. Если поставите больше 5% депозита, приложение предупредит." },
  { target: "balance", tab: "cabinet", title: "Последний шаг", final: true,
    text: "Осталось подключить Bybit по API-ключу — без него бот не сможет торговать. Ключ выдаётся без права на вывод средств.",
    cta: "Подключить биржу" },
];

export function Onboarding({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const { setStage } = useApp();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [guide, setGuide] = useState(false);
  const step = STEPS[i];

  /* Шаг может жить на другой вкладке — переключаем ДО замера. */
  useEffect(() => {
    if (step.tab && step.tab !== tab) onTab(step.tab);
  }, [i]);

  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      if (!step.target) { setRect(null); return; }
      const el = document.querySelector(`[data-coach="${step.target}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const t = setTimeout(() => { measure(); raf = requestAnimationFrame(measure); }, 260);
    window.addEventListener("resize", measure);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); window.removeEventListener("resize", measure); };
  }, [i, tab]);

  const pad = 8;
  const hole = rect && {
    x: rect.left - pad, y: rect.top - pad,
    w: rect.width + pad * 2, h: rect.height + pad * 2,
  };
  const below = !hole || hole.y < window.innerHeight * 0.45;

  const next = () => {
    haptic.tap();
    if (i < STEPS.length - 1) setI(i + 1);
    else { haptic.ok(); setStage("app"); }
  };

  return (
    <div className="fixed inset-0 z-[70]">
      {/* Затемнение с «дыркой» под подсвеченным элементом. */}
      <svg className="absolute inset-0 w-full h-full" onClick={next}>
        <defs>
          <mask id="spot">
            <rect width="100%" height="100%" fill="#fff" />
            {hole && (
              <motion.rect
                initial={false}
                animate={{ x: hole.x, y: hole.y, width: hole.w, height: hole.h }}
                transition={SPRING} rx={18} fill="#000" />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,.62)" mask="url(#spot)" />
      </svg>

      {hole && (
        <motion.div initial={false}
          animate={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
          transition={SPRING}
          className="absolute rounded-[18px] pointer-events-none"
          style={{ boxShadow: "0 0 0 2px var(--tint), 0 0 40px -4px var(--tint)" }} />
      )}

      <AnimatePresence mode="wait">
        <motion.div key={i}
          initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={SPRING}
          className="absolute left-4 right-4"
          style={below
            ? { top: hole ? Math.min(hole.y + hole.h + 14, window.innerHeight - 250) : "42%" }
            : { bottom: window.innerHeight - (hole?.y ?? 0) + 14 }}>
          <Glass className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex items-center justify-center w-7 h-7 rounded-full"
                    style={{ background: "color-mix(in srgb, var(--tint) 18%, transparent)" }}>
                {step.final ? <PartyPopper size={15} style={{ color: "var(--tint)" }} />
                            : <Sparkles size={15} style={{ color: "var(--tint)" }} />}
              </span>
              <span className="text-[12px] font-medium" style={{ color: "var(--label-2)" }}>
                Шаг {i + 1} из {STEPS.length}
              </span>
            </div>

            <h3 className="text-[21px] font-bold tracking-[-0.02em]">{step.title}</h3>
            <p className="text-[15px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>{step.text}</p>

            {step.final && (
              <Press onClick={() => setGuide(true)} className="block w-full mt-3">
                <Glass flat className="py-3 flex items-center justify-center gap-2 text-[15px] font-medium"
                       style={{ color: "var(--tint)" }}>
                  <BookOpen size={16} /> Как создать API-ключ на Bybit
                </Glass>
              </Press>
            )}

            <div className="flex items-center gap-3 mt-4">
              <div className="flex gap-1.5 flex-1">
                {STEPS.map((_, n) => (
                  <motion.span key={n} animate={{ width: n === i ? 18 : 6, opacity: n <= i ? 1 : 0.3 }}
                    transition={SPRING} className="h-1.5 rounded-full block"
                    style={{ background: n <= i ? "var(--tint)" : "var(--label-3)" }} />
                ))}
              </div>
              <Press feel="press" onClick={next}>
                <div className="px-5 py-2.5 rounded-[14px] text-[15px] font-semibold text-white flex items-center gap-1.5"
                     style={{ background: "var(--tint)" }}>
                  {step.cta || (i === STEPS.length - 1 ? "Готово" : "Далее")}
                  {!step.final && <ArrowRight size={16} />}
                </div>
              </Press>
            </div>

            {i < STEPS.length - 1 && (
              <Press onClick={() => { haptic.tap(); setStage("app"); }} className="block mx-auto mt-3">
                <span className="text-[13px]" style={{ color: "var(--label-3)" }}>Пропустить обучение</span>
              </Press>
            )}
          </Glass>
        </motion.div>
      </AnimatePresence>

      <Sheet open={guide} onClose={() => setGuide(false)} title="API-ключ Bybit" tall><ApiGuide /></Sheet>
    </div>
  );
}
