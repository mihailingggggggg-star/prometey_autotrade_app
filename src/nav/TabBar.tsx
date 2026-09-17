import { motion } from "motion/react";
import { LayoutGrid, CandlestickChart, ListChecks, UserRound } from "lucide-react";
import { haptic } from "../lib/tg";
import { SPRING } from "../ui/kit";

export type Tab = "home" | "market" | "trades" | "cabinet";

const TABS: { id: Tab; label: string; Icon: typeof LayoutGrid }[] = [
  { id: "home", label: "Главная", Icon: LayoutGrid },
  { id: "market", label: "Рынок", Icon: CandlestickChart },
  { id: "trades", label: "Сделки", Icon: ListChecks },
  { id: "cabinet", label: "Кабинет", Icon: UserRound },
];

export function TabBar({ tab, onTab, badge }: { tab: Tab; onTab: (t: Tab) => void; badge?: Partial<Record<Tab, number>> }) {
  return (
    <nav className="fixed left-0 right-0 bottom-0 z-40 chrome hairline-t"
         style={{ paddingBottom: "var(--safe-b)" }}>
      <div className="flex" style={{ height: "var(--tabbar-h)" }}>
        {TABS.map(({ id, label, Icon }) => {
          const on = tab === id;
          const n = badge?.[id];
          return (
            <button key={id} onClick={() => { haptic.select(); onTab(id); }}
              data-coach={`tab-${id}`}
              className="relative flex-1 flex flex-col items-center justify-center gap-[2px]">
              <motion.span animate={{ scale: on ? 1 : 0.94, y: on ? -1 : 0 }} transition={SPRING}
                className="relative">
                <Icon size={23} strokeWidth={on ? 2.4 : 1.9}
                      style={{ color: on ? "var(--tint)" : "var(--label-2)" }} />
                {!!n && (
                  <span className="absolute -top-1 -right-2 min-w-[16px] h-[16px] px-1 rounded-full
                                   text-[10px] font-bold flex items-center justify-center text-white"
                        style={{ background: "var(--red)" }}>{n}</span>
                )}
              </motion.span>
              <span className="text-[10px] font-medium tracking-tight"
                    style={{ color: on ? "var(--tint)" : "var(--label-2)" }}>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
