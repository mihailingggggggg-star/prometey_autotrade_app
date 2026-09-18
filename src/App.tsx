import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TabBar, TABS_ORDER, type Tab } from "./nav/TabBar";
import { useApp } from "./lib/store";
import { Auth } from "./screens/Auth";
import { Onboarding } from "./screens/Onboarding";
import { Home } from "./screens/Home";
import { Market } from "./screens/Market";
import { Trades } from "./screens/Trades";
import { Cabinet } from "./screens/Cabinet";
import { DebtGate } from "./screens/DebtGate";
import { Lock, useLock } from "./screens/Lock";
import { WebLogin } from "./screens/WebLogin";
import { BioOffer } from "./screens/BioOffer";
import { hasSession } from "./lib/api";
import { useSwipe } from "./lib/swipe";
import { inTelegram } from "./lib/tg";
import { Modal, Press } from "./ui/kit";
import { haptic } from "./lib/tg";
import { TriangleAlert } from "lucide-react";

export function App() {
  const { stage, setStage, positions, blocked, link, registered, error, clearError } = useApp();
  const [tab, setTab] = useState<Tab>("home");
  const lock = useLock();

  /* Свайп листает вкладки по тому же порядку, в котором они стоят в панели:
     жест и панель обязаны говорить одно и то же, иначе свайп ощущается
     случайным. Места, где горизонтальный жест принадлежит содержимому
     (график, ряды с прокруткой), помечены data-noswipe и жест не перехватывают. */
  const step = (d: number) => {
    const i = TABS_ORDER.indexOf(tab);
    const next = TABS_ORDER[Math.min(TABS_ORDER.length - 1, Math.max(0, i + d))];
    if (next !== tab) { haptic.select(); setTab(next); }
  };
  const swipe = useSwipe({ onLeft: () => step(1), onRight: () => step(-1) });

  /* Регистрация считается пройденной, когда ПОДТВЕРЖДЁН НОМЕР — а не когда
     бот узнал нас по подписи. Подпись говорит лишь «это тот же Telegram-
     аккаунт»; номер — то, по чему человека узнают и по чему выдаются права.
     Пропусти мы регистрацию по одной подписи, новый человек попадал бы сразу
     в кабинет, минуя единственный её шаг. */
  useEffect(() => {
    if (link === "ok" && registered && stage === "auth") setStage("app");
  }, [link, registered, stage, setStage]);

  return (
    /* h-full, а не min-h-full: прокручивается main, страница стоит на месте —
       иначе панель вкладок уезжала бы вместе с контентом. */
    <div className="relative h-full">
      <div className="mesh" />

      {/* Замок стоит ПЕРЕД всем: под ним лежит ключ доступа к счёту, и
          показывать что-либо до подтверждения незачем. */}
      {lock.locked && <Lock busy={lock.busy} ask={lock.ask} />}

      {/* Вне Telegram и без билета показывать демонстрацию бессмысленно:
          человек пришёл за своим счётом. Сразу вход — номер и код из
          Telegram. Telegram нужен ровно для доставки шести цифр. */}
      {!lock.locked && !inTelegram && !hasSession() && <WebLogin />}

      {!lock.locked && (inTelegram || hasSession()) && stage === "auth" && <Auth />}

      {!lock.locked && (inTelegram || hasSession()) && stage !== "auth" && (
        <>
          <main className="relative z-10 h-full scroll" {...swipe}
                style={{ paddingTop: "var(--safe-t)",
                         paddingBottom: "calc(var(--tabbar-h) + var(--safe-b) + 26px)" }}>
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
          {/* Замок предлагаем сразу после входа: в глубине кабинета его не
              найдут, а «больше не вводить код» понятно именно сейчас. */}
          <BioOffer />
          {/* Отказ сервера показываем ТЕКСТОМ, как он пришёл. «Не получилось»
              без причины заставляет гадать, а причина у бота всегда конкретная:
              значение вне диапазона, нет боевых ключей, биржа отбила ордер. */}
          <Modal open={!!error} onClose={clearError}>
            <div className="text-center">
              <div className="mx-auto mb-3 flex items-center justify-center w-12 h-12 rounded-full"
                   style={{ background: "color-mix(in srgb, var(--orange) 18%, transparent)" }}>
                <TriangleAlert size={22} style={{ color: "var(--orange)" }} />
              </div>
              <h3 className="text-[19px] font-bold">Не выполнено</h3>
              <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
                {error}
              </p>
              <Press onClick={clearError} className="block w-full mt-5">
                <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                     style={{ background: "var(--tint-grad)" }}>Понятно</div>
              </Press>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
