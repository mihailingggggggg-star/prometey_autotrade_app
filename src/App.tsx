import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TabBar, type Tab } from "./nav/TabBar";
import { useApp } from "./lib/store";
import { Auth } from "./screens/Auth";
import { Onboarding } from "./screens/Onboarding";
import { Home } from "./screens/Home";
import { Market } from "./screens/Market";
import { Trades } from "./screens/Trades";
import { Cabinet } from "./screens/Cabinet";
import { DebtGate } from "./screens/DebtGate";

export function App() {
  const { stage, setStage, positions, blocked, link } = useApp();
  const [tab, setTab] = useState<Tab>("home");

  /* Бот ответил «вы это вы» — значит авторизация уже состоялась, подписью
     Telegram. Показывать после этого экран регистрации с вводом кода было бы
     имитацией: код никуда не уходит и ничего не проверяет. */
  useEffect(() => {
    if (link === "ok" && stage === "auth") setStage("app");
  }, [link, stage, setStage]);

  return (
    /* h-full, а не min-h-full: прокручивается main, страница стоит на месте —
       иначе панель вкладок уезжала бы вместе с контентом. */
    <div className="relative h-full">
      <div className="mesh" />

      {stage === "auth" && <Auth />}

      {stage !== "auth" && (
        <>
          <main className="relative z-10 h-full scroll"
                style={{ paddingTop: "var(--safe-t)",
                         paddingBottom: "calc(var(--tabbar-h) + var(--safe-b) + 18px)" }}>
            <AnimatePresence mode="wait">
              <motion.div key={tab}
                initial={{ opacity: 0, y: 10, scale: 0.995 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.997 }}
                transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}>
                {tab === "home" && <Home onTab={setTab} />}
                {tab === "market" && <Market />}
                {tab === "trades" && <Trades />}
                {tab === "cabinet" && <Cabinet />}
              </motion.div>
            </AnimatePresence>
          </main>
          <TabBar tab={tab} onTab={setTab} badge={{ market: positions.length }} />
          {stage === "onboarding" && <Onboarding tab={tab} onTab={setTab} />}
          <DebtGate open={blocked && stage === "app"} />
        </>
      )}
    </div>
  );
}
