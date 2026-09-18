import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, KeyRound, MessageSquareLock, Phone, RefreshCw,
         Send, Server } from "lucide-react";
import { Glass, Press } from "../ui/kit";
import { API_BASE, authConfirm, authRequest, getHealth, hasApi, parseCode, applyCode,
         saveApi, saveSession } from "../lib/api";
import { refreshApi } from "../lib/boot";
import { wantBioAsk } from "../lib/lock";
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
 *
 * ЭКРАН ОДИН, и это важно. Раньше приложение, открытое без адреса бота,
 * начинало с вопроса «укажите адрес сервера» — то есть встречало человека
 * задачей, которую он не ставил и ответа на которую у него нет. Адрес теперь
 * ищется сам (ссылка → память → файл рядом с приложением, см. lib/boot.ts), а
 * если не нашёлся — спрашивается ЗДЕСЬ ЖЕ, на экране входа, рядом с полем
 * номера, а не вместо него.
 */
export function WebLogin() {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [left, setLeft] = useState(0);
  /* Адрес бота либо неизвестен, либо по нему не отвечают: и то и другое лечится
     одной и той же карточкой, поэтому состояние одно. */
  const [addr, setAddr] = useState(!hasApi);
  /* Имя бота спрашиваем у самого бота: без него некуда отправить
     регистрироваться, а регистрация — это как раз те, кто войти не может. */
  const [bot, setBot] = useState("");

  useEffect(() => {
    if (!hasApi) return;
    void getHealth().then((h) => setBot(h.bot || "")).catch(() => setBot(""));
  }, []);

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
      const msg = e instanceof Error ? e.message : String(e);
      /* Сеть не ответила вовсе — это не «неверный номер», а мёртвый адрес:
         тоннель перезапустился, и сохранённый адрес больше никуда не ведёт.
         Молчать об этом нельзя, иначе человек будет менять номер. */
      if (/Failed to fetch|NetworkError|timed out|aborted|Load failed/i.test(msg)) {
        setErr("Бот не отвечает по сохранённому адресу — он мог смениться.");
        setAddr(true);
      } else {
        setErr(msg);
      }
    } finally { setBusy(false); }
  };

  const confirm = async (value: string) => {
    setBusy(true); setErr("");
    try {
      const { token } = await authConfirm(phone, value);
      saveSession(token);
      // Замок предложим сразу после входа: ценность «больше не вводить код»
      // понятна именно сейчас, а в глубине кабинета его не найдут.
      wantBioAsk();
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
           style={{ background: "var(--tint-grad)",
                    boxShadow: "0 12px 32px -10px var(--tint)" }}>
        {step === "code" ? <KeyRound size={30} color="#fff" strokeWidth={2.2} />
          : <Phone size={28} color="#fff" strokeWidth={2.2} />}
      </div>

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
          <Press feel="press" className="block w-full mt-4"
                 disabled={busy || phone.length < 6 || !hasApi} onClick={ask}>
            <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white
                            flex items-center justify-center gap-2"
                 style={{ background: busy || phone.length < 6 || !hasApi
                          ? "var(--label-3)" : "var(--tint)" }}>
              {busy ? "Отправляем…" : <>Получить код <ArrowRight size={18} /></>}
            </div>
          </Press>
          {addr && <Addr />}
          <Reg bot={bot} />
          <div className="flex-1" />
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
              доставляет сообщения, пока чат не начат. Если этим номером вы ещё
              не регистрировались, кода не будет: сначала регистрация.
            </div>
          </Glass>
          <Reg bot={bot} />
          <Press className="mt-3 mx-auto" onClick={() => { setStep("phone"); setCode(""); setErr(""); }}>
            <span className="text-[13px]" style={{ color: "var(--label-3)" }}>Изменить номер</span>
          </Press>
        </>
      )}
    </div>
  );
}

/**
 * Регистрация — через Telegram, и только через него.
 *
 * Номер подтверждает сам Telegram: набранный в форме ничего не доказывает, а
 * по номеру выдаются права. Поэтому здесь не форма, а дорога в чат с ботом,
 * где Telegram покажет системную кнопку «Поделиться номером».
 *
 * Показывается ВСЕГДА, а не «когда номер не найден»: ручка входа отвечает
 * одинаково на известный и неизвестный номер — иначе она стала бы справочником
 * «кто у нас зарегистрирован». Значит подсказать путь можно только всем сразу.
 */
function Reg({ bot }: { bot: string }) {
  if (!bot) return null;
  return (
    <Press className="block w-full mt-3"
           onClick={() => window.open(`https://t.me/${bot}?start=reg`, "_blank", "noopener")}>
      <div className="py-3 rounded-[16px] text-center text-[14px] font-medium
                      flex items-center justify-center gap-2"
           style={{ background: "var(--label-3)", color: "var(--label)" }}>
        <Send size={15} /> Ещё нет счёта — регистрация в Telegram
      </div>
    </Press>
  );
}

/**
 * Адрес бота — вспомогательным блоком под полем номера.
 *
 * Показывается, только если адрес не нашёлся сам или по нему не отвечают: код
 * в Telegram просить некого, пока неизвестно, у кого спрашивать. Первая кнопка
 * — «поискать заново»: адрес публикуется рядом с приложением, и после его
 * смены достаточно перечитать файл, ничего не набирая руками.
 */
function Addr() {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const again = async () => {
    setBusy(true); setErr("");
    try {
      await refreshApi();
      location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Glass flat className="p-3.5 mt-4">
      <div className="flex items-start gap-2.5">
        <Server size={18} style={{ color: "var(--orange)" }} className="shrink-0 mt-0.5" />
        <div className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
          {hasApi
            ? <>Сохранён адрес <span className="break-all">{API_BASE}</span> — бот по нему
                не отвечает. Адрес тоннеля меняется при рестарте.</>
            : <>Приложение не знает, где искать бота. Возьмите адрес в боте командой
                <b> /web</b> — там же есть кнопка «Открыть в браузере» и код подключения.</>}
        </div>
      </div>
      <Press className="block w-full mt-3" disabled={busy} onClick={again}>
        <div className="py-2.5 rounded-[14px] text-center text-[14px] font-medium
                        flex items-center justify-center gap-2"
             style={{ background: "var(--label-3)", color: "var(--label)" }}>
          <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
          {busy ? "Ищем…" : "Поискать адрес заново"}
        </div>
      </Press>
      <div className="glass glass-flat flex items-center mt-2.5 px-3">
        <input value={url} onChange={(e) => { setUrl(e.target.value); setErr(""); }}
               placeholder="https://…trycloudflare.com" inputMode="url" spellCheck={false}
               className="flex-1 bg-transparent outline-none py-3 px-1.5 text-[14px]"
               style={{ color: "var(--label)" }} />
        <Press disabled={!url.trim()}
               onClick={() => {
                 try {
                   const v = url.trim();
                   if (v.startsWith("PR1-")) { applyCode(parseCode(v)); location.reload(); return; }
                   saveApi(v); haptic.ok(); location.reload();
                 } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
               }}>
          <span className="text-[14px] font-medium px-1"
                style={{ color: url.trim() ? "var(--tint)" : "var(--label-3)" }}>Задать</span>
        </Press>
      </div>
      <Err text={err} />
    </Glass>
  );
}

/** Запасной путь: целиком готовый код из бота. Внутри него и адрес, и ключ
 *  доступа — одна вставка вместо номера, кода и адреса. */
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
