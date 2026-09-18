import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Mail, MessageSquareLock, Phone, ShieldCheck, Zap } from "lucide-react";
import { Glass, Press, SPRING } from "../ui/kit";
import { LogoMark, LogoWord } from "../ui/Logo";
import { useApp } from "../lib/store";
import { canRequestPhone, haptic, requestPhone, tgUser } from "../lib/tg";

type Step = "hello" | "phone" | "email";

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
                          style={{ background: "var(--tint-grad)",
                                   boxShadow: "0 12px 32px -10px var(--tint)" }}>
                {/* Знак логотипа, а не служебная иконка: это первый экран, и
                    именно здесь приложение представляется. Белым, потому что
                    плитка уже акцентная — градиент на градиенте не читается. */}
                <LogoMark size={40} grad={false} style={{ color: "#fff" }} />
              </motion.div>
              <h1 className="text-[40px] font-bold leading-[1.05] tracking-[-0.035em]">
                Автотрейд
              </h1>
              {/* Название — настоящей надписью логотипа, а не набранным словом:
                  шрифт у неё свой, и набор его не повторяет. */}
              <LogoWord height={34} className="mt-2" style={{ color: "var(--label)" }} />
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
            <Press feel="press" className="block w-full" onClick={() => setStep("phone")}>
              <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white flex items-center justify-center gap-2"
                   style={{ background: "var(--tint-grad)" }}>
                Войти через Telegram <ArrowRight size={19} />
              </div>
            </Press>
            <p className="text-[12px] text-center mt-3 leading-snug" style={{ color: "var(--label-3)" }}>
              Продолжая, вы соглашаетесь с условиями использования
              и подтверждаете, что торговля сопряжена с риском убытка.
            </p>
          </Pane>
        )}

        {step === "phone" && (
          <Pane key="phone">
            <PhoneStep onDone={() => setStep("email")} phone={phone} setPhone={setPhone} />
          </Pane>
        )}

        {step === "email" && (
          <Pane key="email">
            <Head t="Куда присылать чеки"
                  d="E-mail нужен для чеков об оплате и восстановления доступа. Можно пропустить." />
            <div className="space-y-3 mt-6">
              <InputRow icon={<Mail size={17} />} value={email} onChange={setEmail}
                        placeholder="you@example.com" type="email" label="E-mail" />
            </div>
            <div className="flex-1" />
            <Press feel="press" className="block w-full"
                   onClick={() => {
                     setUser({ email, name: tgUser?.first_name || "Трейдер" });
                     void saveProfile(email, phone);
                     haptic.ok();
                     setStage("onboarding");
                   }}>
              <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white"
                   style={{ background: "var(--tint-grad)" }}>
                {email.includes("@") ? "Продолжить" : "Пропустить"}
              </div>
            </Press>
          </Pane>
        )}

      </AnimatePresence>
    </div>
  );
}

/**
 * Подтверждение номера — настоящее, руками его не ввести.
 *
 * Telegram показывает системное окно и сам присылает боту контакт; бот
 * сверяет, что это СВОЙ контакт отправителя (переслать чужую карточку можно
 * из любой записной книжки), записывает номер и по нему же решает, открывать
 * ли админ-функции. Поэтому поля ввода здесь нет вовсе: набранный номер
 * ничего не доказывает, а права выдаются именно по нему.
 */
function PhoneStep({ onDone, phone, setPhone }: {
  onDone: () => void; phone: string; setPhone: (v: string) => void;
}) {
  const { me, demo, refresh } = useApp();
  const [waiting, setWaiting] = useState(false);
  const ok = demo ? phone.length > 5 : Boolean(me?.phoneOk);

  // Контакт уходит боту ОТДЕЛЬНЫМ сообщением, и когда он дойдёт — неизвестно.
  // Поэтому ждём появления отметки в профиле, а не верим ответу окна.
  useEffect(() => {
    if (!waiting || ok) return;
    const t = setInterval(refresh, 2000);
    const stop = setTimeout(() => setWaiting(false), 90000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [waiting, ok, refresh]);

  useEffect(() => {
    if (ok && waiting) { haptic.ok(); setWaiting(false); }
  }, [ok, waiting]);

  const ask = async () => {
    if (demo) { setPhone("+996999911555"); return; }
    setWaiting(true);
    const sent = await requestPhone();
    if (!sent) setWaiting(false);
  };

  return (
    <>
      <Head t="Подтвердите номер"
            d="Telegram подтвердит его сам — вводить ничего не нужно. По номеру мы узнаём вас и открываем доступ." />

      <div className="mt-6 space-y-2.5">
        <Glass flat className="p-4 flex items-center gap-3">
          <span className="flex items-center justify-center w-10 h-10 rounded-[12px] shrink-0"
                style={{ background: ok ? "color-mix(in srgb, var(--green) 20%, transparent)" : "var(--label-3)" }}>
            {ok ? <Check size={19} style={{ color: "var(--green)" }} />
                : <Phone size={18} style={{ color: "var(--label-2)" }} />}
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-medium">
              {ok ? (me?.phone || phone || "номер подтверждён") : "Номер не подтверждён"}
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>
              {ok ? "подтверждён через Telegram"
                  : waiting ? "ждём подтверждения…" : "нажмите кнопку ниже"}
            </div>
          </div>
        </Glass>

        {!canRequestPhone() && !demo && !ok && (
          /* Старый клиент Telegram: системного окна нет, но подтвердить номер
             всё равно можно — в чате с ботом. Тупика быть не должно. */
          <Glass flat className="p-3.5 flex items-start gap-2.5">
            <MessageSquareLock size={18} style={{ color: "var(--label-2)" }} className="shrink-0 mt-0.5" />
            <div className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
              Ваша версия Telegram не умеет показывать окно запроса. Откройте чат
              с ботом, отправьте <b style={{ color: "var(--label)" }}>/phone</b> и
              нажмите «Поделиться номером» — затем вернитесь сюда.
            </div>
          </Glass>
        )}
      </div>

      <div className="flex-1" />

      {!ok ? (
        <Press feel="press" className="block w-full" disabled={waiting} onClick={ask}>
          <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white"
               style={{ background: waiting ? "var(--label-3)" : "var(--tint)" }}>
            {waiting ? "Ждём подтверждения…" : "Подтвердить номер"}
          </div>
        </Press>
      ) : (
        <Press feel="press" className="block w-full" onClick={onDone}>
          <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white flex items-center justify-center gap-2"
               style={{ background: "var(--tint-grad)" }}>
            Дальше <ArrowRight size={19} />
          </div>
        </Press>
      )}
      <p className="text-[12px] text-center mt-3 leading-snug" style={{ color: "var(--label-3)" }}>
        Номер виден только нам и не публикуется. Он не используется для рассылок.
      </p>
    </>
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

