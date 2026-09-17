import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, KeyRound, MessageSquareLock, Phone, Server } from "lucide-react";
import { Glass, Press } from "../ui/kit";
import { API_BASE, authConfirm, authRequest, hasApi, parseCode, applyCode,
         saveApi, saveSession } from "../lib/api";
import { haptic } from "../lib/tg";

/**
 * Вход в веб-версию: номер телефона → код из Telegram.
 *
 * Так же, как вход куда угодно ещё, и это главное достоинство: ключ доступа не
 * ездит в ссылке. Ярлык несёт только адрес бота, а право на счёт человек
 * подтверждает сам — значит подсмотренная ссылка, закладка или скриншот
 * больше ничего не дают.
 *
 * Telegram здесь нужен ровно для одного: доставить шесть цифр. Дальше
 * приложение живёт само.
 */
export function WebLogin() {
  const [step, setStep] = useState<"api" | "phone" | "code">(hasApi ? "phone" : "api");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!left) return;
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);

  const ask = async () => {
    setBusy(true); setErr("");
    try {
      await authRequest(phone);
      haptic.ok();
      setStep("code");
      setLeft(30);
    } catch (e) {
      haptic.err();
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const confirm = async (value: string) => {
    setBusy(true); setErr("");
    try {
      const { token } = await authConfirm(phone, value);
      saveSession(token);
      haptic.ok();
      // Перезагрузка обязательна: адрес и билет читаются один раз при старте.
      location.reload();
    } catch (e) {
      haptic.err();
      setErr(e instanceof Error ? e.message : String(e));
      setCode("");
    } finally { setBusy(false); }
  };

  return (
    <div className="relative z-10 h-full scroll flex flex-col px-5"
         style={{ paddingTop: "calc(var(--safe-t) + 44px)",
                  paddingBottom: "calc(var(--safe-b) + 24px)" }}>
      <div className="w-[64px] h-[64px] rounded-[18px] flex items-center justify-center mb-5"
           style={{ background: "linear-gradient(145deg,var(--tint),#5e5ce6)",
                    boxShadow: "0 12px 32px -10px var(--tint)" }}>
        {step === "code" ? <KeyRound size={30} color="#fff" strokeWidth={2.2} />
          : step === "api" ? <Server size={28} color="#fff" strokeWidth={2.2} />
          : <Phone size={28} color="#fff" strokeWidth={2.2} />}
      </div>

      {step === "api" && (
        <ApiStep onDone={() => setStep("phone")} />
      )}

      {step === "phone" && (
        <>
          <h1 className="text-[30px] font-bold tracking-[-0.03em] leading-tight">Вход</h1>
          <p className="text-[16px] mt-2 leading-snug" style={{ color: "var(--label-2)" }}>
            Введите номер, с которым регистрировались. Бот пришлёт код в Telegram.
          </p>
          <div className="glass glass-flat flex items-center mt-6 px-4">
            <Phone size={17} style={{ color: "var(--label-2)" }} />
            <input value={phone} onChange={(e) => { setPhone(e.target.value); setErr(""); }}
                   placeholder="+996 999 91-15-55" type="tel" inputMode="tel"
                   className="flex-1 bg-transparent outline-none py-3.5 px-3 text-[17px]"
                   style={{ color: "var(--label)" }} />
          </div>
          <Err text={err} />
          <div className="flex-1" />
          <Press feel="press" className="block w-full" disabled={busy || phone.length < 6}
                 onClick={ask}>
            <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white
                            flex items-center justify-center gap-2"
                 style={{ background: busy || phone.length < 6 ? "var(--label-3)" : "var(--tint)" }}>
              {busy ? "Отправляем…" : <>Получить код <ArrowRight size={18} /></>}
            </div>
          </Press>
          <CodeFallback />
        </>
      )}

      {step === "code" && (
        <>
          <h1 className="text-[30px] font-bold tracking-[-0.03em] leading-tight">Код из Telegram</h1>
          <p className="text-[16px] mt-2 leading-snug" style={{ color: "var(--label-2)" }}>
            Шесть цифр отправлены в чат с ботом. Код действует 5 минут.
          </p>
          <div className="mt-6">
            <Digits value={code} onChange={(v) => { setCode(v); setErr("");
                     if (v.length === 6) void confirm(v); }} busy={busy} />
          </div>
          <Err text={err} />
          <Press className="mt-5 mx-auto" disabled={left > 0 || busy}
                 onClick={() => { setCode(""); void ask(); }}>
            <span className="text-[15px]"
                  style={{ color: left > 0 ? "var(--label-3)" : "var(--tint)" }}>
              {left > 0 ? `Отправить заново через ${left} с` : "Отправить код заново"}
            </span>
          </Press>
          <div className="flex-1" />
          <Glass flat className="p-3.5 flex items-start gap-2.5">
            <MessageSquareLock size={18} style={{ color: "var(--label-2)" }} className="shrink-0 mt-0.5" />
            <div className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
              Код не приходит? Откройте чат с ботом и нажмите «Старт» — Telegram не
              доставляет сообщения, пока чат не начат.
            </div>
          </Glass>
          <Press className="mt-3 mx-auto" onClick={() => { setStep("phone"); setCode(""); setErr(""); }}>
            <span className="text-[13px]" style={{ color: "var(--label-3)" }}>Изменить номер</span>
          </Press>
        </>
      )}
    </div>
  );
}

/** Адреса бота нет — значит ярлык открыт без него. Просим адрес или код
 *  подключения: без адреса спросить код в Telegram попросту некого. */
function ApiStep({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  return (
    <>
      <h1 className="text-[30px] font-bold tracking-[-0.03em] leading-tight">Адрес бота</h1>
      <p className="text-[16px] mt-2 leading-snug" style={{ color: "var(--label-2)" }}>
        Приложение открыто без адреса сервера. Возьмите его в боте командой
        <b> /web</b> — там же есть готовый код подключения.
      </p>
      <div className="glass glass-flat flex items-center mt-6 px-4">
        <Server size={17} style={{ color: "var(--label-2)" }} />
        <input value={url} onChange={(e) => { setUrl(e.target.value); setErr(""); }}
               placeholder="https://…trycloudflare.com" inputMode="url" spellCheck={false}
               className="flex-1 bg-transparent outline-none py-3.5 px-3 text-[15px]"
               style={{ color: "var(--label)" }} />
      </div>
      <Err text={err} />
      <div className="flex-1" />
      <Press feel="press" className="block w-full" disabled={!url.trim()}
             onClick={() => {
               try {
                 if (url.trim().startsWith("PR1-")) { applyCode(parseCode(url)); location.reload(); return; }
                 saveApi(url); haptic.ok(); onDone(); location.reload();
               } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
             }}>
        <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white"
             style={{ background: url.trim() ? "var(--tint)" : "var(--label-3)" }}>Продолжить</div>
      </Press>
    </>
  );
}

/** Запасной путь: целиком готовый код из бота. Нужен, когда номер под рукой,
 *  а Telegram — нет (например, вошли с чужого устройства). */
function CodeFallback() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  if (!open) {
    return (
      <Press className="mt-4 mx-auto" onClick={() => setOpen(true)}>
        <span className="text-[13px]" style={{ color: "var(--label-3)" }}>
          У меня есть код подключения из бота
        </span>
      </Press>
    );
  }
  return (
    <div className="mt-4">
      <div className="glass glass-flat p-3">
        <textarea value={code} onChange={(e) => { setCode(e.target.value); setErr(""); }}
                  placeholder="PR1-…" rows={2} spellCheck={false}
                  className="w-full bg-transparent outline-none resize-none text-[13px] font-mono"
                  style={{ color: "var(--label)" }} />
      </div>
      <Err text={err} />
      <Press className="block w-full mt-2" disabled={!code.trim()}
             onClick={() => {
               try { applyCode(parseCode(code)); location.reload(); }
               catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
             }}>
        <Glass flat className="py-3 text-center text-[15px] font-medium">Войти по коду</Glass>
      </Press>
    </div>
  );
}

function Err({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="text-[13px] mt-2.5 px-1 leading-snug" style={{ color: "var(--orange)" }}>
      {text}
    </div>
  );
}

/** Шесть клеток. Одно скрытое поле под ними: свои input-ы на каждую цифру
 *  ломают автозаполнение и вставку кода целиком. */
function Digits({ value, onChange, busy }: {
  value: string; onChange: (v: string) => void; busy: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="relative" onClick={() => ref.current?.focus()}>
      <input ref={ref} value={value} inputMode="numeric" maxLength={6} autoFocus
             disabled={busy} autoComplete="one-time-code"
             onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
             className="absolute inset-0 w-full h-full opacity-0" />
      <div className="flex gap-2 justify-between">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex-1 aspect-[3/4] rounded-[14px] flex items-center justify-center
                                  text-[26px] font-semibold glass glass-flat"
               style={{ borderColor: i === value.length ? "var(--tint)" : undefined,
                        color: "var(--label)" }}>
            {value[i] === undefined ? "" : value[i]}
          </div>
        ))}
      </div>
      {busy && (
        <div className="text-[13px] mt-3 text-center" style={{ color: "var(--label-2)" }}>
          <Check size={14} className="inline mr-1" /> проверяем…
        </div>
      )}
    </div>
  );
}
