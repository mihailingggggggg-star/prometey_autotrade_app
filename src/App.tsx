/**
 * Каркас демо-приложения: табы, экраны и глобальное состояние связи.
 *
 * Одна ошибка на всё приложение живёт здесь: если сервер не отвечает, человек
 * видит это сразу наверху, независимо от того, на какой вкладке находится.
 * Кнопка «Обновить» поднимает общий счётчик обновления — экраны перечитывают
 * данные немедленно, не дожидаясь своего интервала опроса.
 *
 * Детальный экран монеты — наложение ПОВЕРХ всего, а не пятая вкладка: он
 * открывается и из «Сигналов», и из «Позиций», и при возврате человек должен
 * попасть туда, откуда пришёл.
 */
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { health, listAlerts, onUnauthorized } from "./lib/api";
import { useApi } from "./lib/useApi";
import { haptic } from "./lib/haptics";
import { TabBar, type Tab } from "./nav/TabBar";
import { Press, SPRING } from "./ui/kit";
import { Feed } from "./screens/Feed";
import { Positions } from "./screens/Positions";
import { Analytics } from "./screens/Analytics";
import { Profile } from "./screens/Profile";
import { CoinDetail, type CoinRef } from "./screens/CoinDetail";
import { TokenGate } from "./screens/TokenGate";

export function App() {
  const [tab, setTab] = useState<Tab>("signals");
  const [coin, setCoin] = useState<CoinRef | null>(null);
  // Сервер ответил 401 — нужен ключ доступа. Показывается ВМЕСТО приложения,
  // чтобы человек видел понятный экран, а не пустоту с ошибками на каждой вкладке.
  const [needsToken, setNeedsToken] = useState(false);
  // Общий ключ обновления: действия на экранах меняют его, и все списки
  // перечитываются сразу, а не по своему таймеру.
  const [refreshKey, setRefreshKey] = useState(0);

  const h = useApi(health, 15000, [refreshKey]);
  const alerts = useApi(() => listAlerts(true), 15000, [refreshKey]);
  const unseen = alerts.data?.length ?? 0;

  const refresh = useCallback(() => {
    haptic.tap();
    setRefreshKey((k) => k + 1);
  }, []);

  // Любой ответ 401 (не только первый) поднимает экран ввода ключа.
  useEffect(() => onUnauthorized(() => setNeedsToken(true)), []);

  if (needsToken) {
    return (
      <TokenGate
        onUnlocked={() => {
          setNeedsToken(false);
          setRefreshKey((k) => k + 1);
        }}
      />
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      <div className="mesh" aria-hidden />

      {/* Верхняя полоса: марка, режим данных, кнопка обновления, ошибка связи */}
      <header className="relative z-20 shrink-0 chrome hairline" style={{ paddingTop: "var(--safe-t)" }}>
        <div className="flex items-center gap-2 px-4 h-[46px]">
          <span className="text-[13px] font-semibold tracking-[-0.01em]">SOLANA SWING BOT</span>
          {h.data && (
            <span className="text-[11px] px-2 py-0.5 rounded-full font-bold"
                  style={h.data.mode === "live"
                    ? { background: "color-mix(in srgb, var(--green) 18%, transparent)", color: "var(--green)" }
                    : { background: "var(--bg-elev)", color: "var(--label-2)" }}>
              {h.data.mode === "live" ? "LIVE" : "MOCK"}
            </span>
          )}
          <div className="flex-1" />
          <Press onClick={refresh} aria-label="Обновить" className="rounded-full p-1.5">
            <span className="flex items-center justify-center w-8 h-8 rounded-full"
                  style={{ background: "var(--bg-elev)" }}>
              <RefreshCw size={16} />
            </span>
          </Press>
        </div>
        {h.error && (
          <div className="px-4 pb-2 flex items-start gap-2">
            <span className="flex-1 text-[12px] leading-snug" style={{ color: "var(--orange)" }}>{h.error}</span>
            <Press onClick={refresh}>
              <span className="text-[12px] font-semibold shrink-0" style={{ color: "var(--tint-soft)" }}>повторить</span>
            </Press>
          </div>
        )}
      </header>

      {/* Прокручивается main, а не страница: панель вкладок должна оставаться
          приклеенной к низу. */}
      <main className="scroll relative z-10 flex-1 min-h-0"
            style={{ paddingBottom: "calc(var(--tabbar-h) + var(--safe-b) + 22px)", overscrollBehavior: "contain" }}>
        {tab === "signals" && <Feed refreshKey={refreshKey} onOpen={setCoin} />}
        {tab === "positions" && <Positions refreshKey={refreshKey} onOpen={setCoin} />}
        {tab === "analytics" && <Analytics refreshKey={refreshKey} />}
        {tab === "profile" && <Profile refreshKey={refreshKey} />}
      </main>

      <TabBar
        tab={tab}
        onTab={(t) => { setCoin(null); setTab(t); }}
        badge={{ positions: unseen }}
      />

      <AnimatePresence>
        {coin && (
          <motion.div key="coin-detail"
                      initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
                      transition={SPRING}
                      className="absolute inset-0 z-50">
            <CoinDetail coin={coin} onBack={() => setCoin(null)} onChanged={refresh} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
