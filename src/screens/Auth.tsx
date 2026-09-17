import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Mail, MessageSquareLock, Phone, ShieldCheck, Zap } from "lucide-react";
import { Glass, Press, SPRING } from "../ui/kit";
import { useApp } from "../lib/store";
import { haptic, tgUser } from "../lib/tg";

type Step = "hello" | "contacts" | "code";

/** Незалогиненная зона. Пока человек здесь — ни вкладок, ни данных счёта. */
export function Auth() {
  const { setStage, setUser, saveProfile } = useApp();
  const [step, setStep] = useState<Step>("hello");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  return (
    <div className="relative z-10 h-full scroll flex flex-col px-5"
         style={{ paddingTop: "calc(var(--safe-t) + 56px)", paddingBottom: "calc(var(--safe-b) + 24px)" }}>
      <AnimatePresence mode="wait">
        {step === "hello" && (
          <Pane key="hello">
            <div className="flex-1 flex flex-col justify-center">
              <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                          transition={{ ...SPRING, delay: 0.05 }}
                          className="w-[72px] h-[72px] rounded-[20px] flex items-center justify-center mb-6"
                          style={{ background: "linear-gradient(145deg,var(--tint),#5e5ce6)",
                                   boxShadow: "0 12px 32px -10px var(--tint)" }}>
                <Zap size={36} color="#fff" strokeWidth={2.4} />
              </motion.div>
              <h1 className="text-[40px] font-bold leading-[1.05] tracking-[-0.035em]">
                Автотрейд<br />PROMETHEUS
              </h1>
              <p className="text-[17px] mt-3 leading-snug" style={{ color: "var(--label-2)" }}>
                Скринер находит сетап — бот исполняет его на вашем счёте Bybit.
                Без ручных входов и пропущенных движений.
              </p>
              <div className="mt-7 space-y-2.5">
                <Bullet icon={<ShieldCheck size={17} />} t="Ваши ключи, ваш счёт"
                        d="Торгуем по API без права на вывод средств" />
                <Bullet icon={<Zap size={17} />} t="Комиссия только с прибыли"
                        d="15% с прибыльной недели, 4% — по подписке" />
              </div>
            </div>
            <Press feel="press" className="block w-full" onClick={() => setStep("contacts")}>
              <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white flex items-center justify-center gap-2"
                   style={{ background: "var(--tint)" }}>
                Войти через Telegram <ArrowRight size={19} />
              </div>
            </Press>
            <p className="text-[12px] text-center mt-3 leading-snug" style={{ color: "var(--label-3)" }}>
              Продолжая, вы соглашаетесь с условиями использования
              и подтверждаете, что торговля сопряжена с риском убытка.
            </p>
          </Pane>
        )}

        {step === "contacts" && (
          <Pane key="contacts">
            <Head t="Ваши контакты"
                  d="Нужны, чтобы присылать чеки об оплате и восстановить доступ, если смените Telegram." />
            <div className="space-y-3 mt-6">
              <InputRow icon={<Phone size={17} />} value={phone} onChange={setPhone}
                        placeholder="+7 900 000-00-00" type="tel" label="Номер телефона" />
              <InputRow icon={<Mail size={17} />} value={email} onChange={setEmail}
                        placeholder="you@example.com" type="email" label="E-mail" />
            </div>
            <div className="flex-1" />
            <Press feel="press" className="block w-full" disabled={phone.length < 6 || !email.includes("@")}
                   onClick={() => {
                     setUser({ phone, email, name: tgUser?.first_name || "Трейдер" });
                     // Профиль уезжает боту сразу: регистрация — это и есть
                     // первое открытие приложения, отдельного шага «создать
                     // аккаунт» нет. Ряд там уже заведён по подписи Telegram,
                     // мы лишь дописываем контакты.
                     void saveProfile(email, phone);
                     setStep("code");
                   }}>
              <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white"
                   style={{ background: "var(--tint)" }}>Получить код</div>
            </Press>
          </Pane>
        )}

        {step === "code" && (
          <Pane key="code">
            <Head t="Код из бота"
                  d="Мы отправили шесть цифр в чат с ботом @prometheus_bot. Код действует 10 минут." />
            <div className="mt-7"><CodeInput onDone={() => { haptic.ok(); setStage("onboarding"); }} /></div>
            <Press className="mt-5 mx-auto" onClick={() => haptic.tap()}>
              <span className="text-[15px]" style={{ color: "var(--tint)" }}>Отправить код заново</span>
            </Press>
            <div className="flex-1" />
            <Glass flat className="p-3.5 flex items-start gap-2.5">
              <MessageSquareLock size={18} style={{ color: "var(--label-2)" }} className="shrink-0 mt-0.5" />
              <div className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
                Не приходит код? Откройте бота и нажмите «Старт» — Telegram не доставляет
                сообщения, пока чат не начат.
              </div>
            </Glass>
          </Pane>
        )}
      </AnimatePresence>
    </div>
  );
}

function Pane({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, x: 22 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -22 }}
                transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                className="flex-1 flex flex-col">{children}</motion.div>
  );
}

function Head({ t, d }: { t: string; d: string }) {
  return (
    <div className="pt-6">
      <h1 className="text-[32px] font-bold tracking-[-0.03em] leading-tight">{t}</h1>
      <p className="text-[16px] mt-2 leading-snug" style={{ color: "var(--label-2)" }}>{d}</p>
    </div>
  );
}

function Bullet({ icon, t, d }: { icon: React.ReactNode; t: string; d: string }) {
  return (
    <Glass flat className="p-3.5 flex items-start gap-3">
      <span className="flex items-center justify-center w-8 h-8 rounded-[9px] shrink-0"
            style={{ background: "var(--label-3)", color: "var(--tint)" }}>{icon}</span>
      <div>
        <div className="text-[15px] font-medium">{t}</div>
        <div className="text-[13px] mt-0.5 leading-snug" style={{ color: "var(--label-2)" }}>{d}</div>
      </div>
    </Glass>
  );
}

function InputRow({ icon, value, onChange, placeholder, type, label }: {
  icon: React.ReactNode; value: string; onChange: (v: string) => void;
  placeholder: string; type: string; label: string;
}) {
  return (
    <div>
      <div className="text-[13px] mb-1.5 px-1" style={{ color: "var(--label-2)" }}>{label}</div>
      <Glass flat className="px-3.5 py-3 flex items-center gap-2.5">
        <span style={{ color: "var(--label-2)" }}>{icon}</span>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
               type={type} autoCapitalize="off" autoCorrect="off"
               className="bg-transparent outline-none flex-1 text-[17px]" style={{ color: "var(--label)" }} />
        {value && <Check size={17} style={{ color: "var(--green)" }} />}
      </Glass>
    </div>
  );
}

function CodeInput({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { if (v.length === 6) setTimeout(onDone, 260); }, [v]);
  return (
    <div className="relative" onClick={() => ref.current?.focus()}>
      <input ref={ref} value={v} inputMode="numeric" maxLength={6}
             onChange={(e) => { const n = e.target.value.replace(/\D/g, "").slice(0, 6);
                                if (n.length > v.length) haptic.select(); setV(n); }}
             className="absolute opacity-0 inset-0 w-full" />
      <div className="flex gap-2 justify-between">
        {Array.from({ length: 6 }).map((_, i) => {
          const filled = i < v.length, active = i === v.length;
          return (
            <motion.div key={i} animate={{ scale: filled ? 1 : active ? 1.03 : 1 }} transition={SPRING}
              className="glass glass-flat flex-1 aspect-[3/4] flex items-center justify-center text-[26px] font-bold"
              style={{ outline: active ? "2px solid var(--tint)" : "none", outlineOffset: -2 }}>
              {v[i] || ""}
            </motion.div>
          );
        })}
      </div>
      <div className="text-center text-[13px] mt-3" style={{ color: "var(--label-3)" }}>
        для демонстрации подойдёт любой код
      </div>
    </div>
  );
}
