/**
 * Нижняя панель вкладок — четыре таба демо-контура (§9 плана):
 * Сигналы · Позиции · Аналитика · Профиль.
 *
 * Панель приклеена к низу (fixed) и потому требует, чтобы прокручивался
 * ВНУТРЕННИЙ контейнер экрана, а не страница: иначе она уезжала бы из-под
 * пальца вместе с прокруткой. На «Позициях» может стоять счётчик непрочитанных
 * алертов — это единственное число, которое обязано догнать человека, даже
 * когда он на другом экране.
 */
import { motion } from "motion/react";
import { LineChart, Radar, UserRound, Wallet, type LucideIcon } from "lucide-react";
import { SPRING } from "../ui/kit";
import { haptic } from "../lib/haptics";

export type Tab = "signals" | "positions" | "analytics" | "profile";

/** Порядок вкладок — один на панель и на логику приложения. */
export const TABS_ORDER: Tab[] = ["signals", "positions", "analytics", "profile"];

const TABS: { id: Tab; label: string; Icon: LucideIcon }[] = [
  { id: "signals", label: "Сигналы", Icon: Radar },
  { id: "positions", label: "Позиции", Icon: Wallet },
  { id: "analytics", label: "Аналитика", Icon: LineChart },
  { id: "profile", label: "Профиль", Icon: UserRound },
];

export function TabBar({ tab, onTab, badge }: {
  tab: Tab;
  onTab: (t: Tab) => void;
  /** Счётчики по вкладкам; сейчас используются только для «Позиций». */
  badge?: Partial<Record<Tab, number>>;
}) {
  return (
    <>
      {/* Градиентная подложка под панелью: контент уезжает под неё мягко, а не
          обрывается по краю. Жесты сквозь неё проходят (pointer-events: none). */}
      <div className="fixed left-0 right-0 bottom-0 z-30 pointer-events-none"
           style={{ height: "calc(var(--tabbar-h) + var(--safe-b) + 30px)",
                    background: "linear-gradient(to top, var(--bg) 8%, "
                              + "color-mix(in srgb, var(--bg) 74%, transparent) 48%, transparent 100%)" }} />
      <nav className="fixed left-0 right-0 z-40 px-2 pointer-events-none"
           style={{ bottom: "calc(var(--safe-b) * 0.45 + 2px)" }}>
        <div className="relative mx-auto rounded-[26px] overflow-hidden chrome pointer-events-auto"
             style={{ maxWidth: 560, height: "var(--tabbar-h)",
                      background: "color-mix(in srgb, var(--bg-elev) 88%, transparent)",
                      border: "1px solid rgba(255,255,255,.08)",
                      boxShadow: "0 20px 44px -20px rgba(0,0,0,.95)" }}>
          <div className="flex h-full">
            {TABS.map(({ id, label, Icon }) => {
              const active = id === tab;
              const n = badge?.[id] ?? 0;
              return (
                <button key={id} onClick={() => { haptic.select(); onTab(id); }}
                        aria-label={label} aria-current={active ? "page" : undefined}
                        className="relative flex-1 flex flex-col items-center justify-center gap-0.5"
                        style={{ color: active ? "var(--label)" : "var(--label-2)" }}>
                  {active && (
                    <motion.span layoutId="tab-pill" transition={SPRING}
                                 className="absolute inset-x-2 inset-y-1 rounded-[18px]"
                                 style={{ background: "var(--bg-elev)",
                                          boxShadow: "inset 0 1px 0 rgba(255,255,255,.08)" }} />
                  )}
                  <span className="relative z-10 flex items-center justify-center">
                    <Icon size={21} strokeWidth={active ? 2.4 : 2} />
                    {n > 0 && (
                      <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full
                                       text-[10px] font-bold flex items-center justify-center text-white"
                            style={{ background: "var(--tint-grad)" }}>
                        {n > 9 ? "9+" : n}
                      </span>
                    )}
                  </span>
                  <span className="relative z-10 text-[10px] font-medium leading-none">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}

/** Отступ под панель: экраны, рисующие контент до самого низа, вставляют его
 *  последним, чтобы содержимое не упиралось в панель. */
export function TabBarSpacer() {
  return <div style={{ height: "calc(var(--tabbar-h) + var(--safe-b) + 18px)" }} />;
}
