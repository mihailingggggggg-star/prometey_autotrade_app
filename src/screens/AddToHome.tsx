import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Share, Smartphone, SquarePlus, TriangleAlert } from "lucide-react";
import { Glass, Press, Sheet } from "../ui/kit";
import { hasApi, hasSession, newSession, webLink } from "../lib/api";
import { useApp } from "../lib/store";
import { canInstall, install, personalizeManifest, standalone } from "../lib/pwa";
import { haptic, inTelegram, isIOS, openExternal } from "../lib/tg";

const DISMISS_KEY = "prometey.addhome.hidden";

export const homeCardHidden = () => {
  // Установленному приложению предлагать установку незачем.
  if (standalone()) return true;
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
};
const hideCard = () => {
  try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* приватное окно */ }
};

/**
 * Вынести приложение на рабочий стол — БЕЗ Telegram.
 *
 * Ярлык открывает самостоятельное веб-приложение: своё окно, свой значок, без
 * мессенджера вокруг. Тонкость в том, что снаружи Telegram нет подписи
 * initData, то есть нет и доступа к счёту, — поэтому перед выходом в браузер
 * приложение берёт у бота билет и уходит уже с ним. Без билета ярлык
 * открывался бы на демо-данных и выглядел бы сломанным.
 */
export function AddToHomeCard({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="px-4 mt-3">
        <Press onClick={() => { haptic.tap(); setOpen(true); }} className="block w-full" scale={0.98}>
          <Glass className="p-4 flex items-center gap-3.5">
            <span className="flex items-center justify-center w-11 h-11 rounded-[13px] shrink-0"
                  style={{ background: "linear-gradient(145deg,var(--tint),#5e5ce6)" }}>
              <Smartphone size={22} color="#fff" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold leading-tight">
                Добавьте приложение на экран смартфона
              </div>
              <div className="text-[13px] mt-1 leading-snug" style={{ color: "var(--label-2)" }}>
                Открывается одним касанием, как обычное приложение — без Telegram и поиска чата
              </div>
            </div>
            <SquarePlus size={20} style={{ color: "var(--label-3)" }} className="shrink-0" />
          </Glass>
        </Press>
      </div>

      <AddToHomeSheet open={open} onClose={() => setOpen(false)}
                  onDone={() => { hideCard(); setOpen(false); onDone(); }} />
    </>
  );
}

/** Инструкция и кнопки установки. Экспортируется отдельно: в кабинете есть
 *  постоянный вход сюда, не зависящий от того, скрыта ли карточка на главной. */
export function AddToHomeSheet({ open, onClose, onDone }: {
  open: boolean; onClose: () => void; onDone: () => void;
}) {
  const { demo } = useApp();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fail, setFail] = useState("");
  const ios = isIOS();
  // В браузере мы уже там, куда надо попасть, — остаётся сам ярлык.
  const inBrowser = !inTelegram;

  /* Манифест персонализируем заранее: к моменту, когда человек нажмёт
     «Добавить на экран», в адресе уже должны быть и билет, и адрес API —
     именно их система запомнит в ярлыке. */
  useEffect(() => {
    if (open && inBrowser) personalizeManifest();
  }, [open, inBrowser]);

  /* Билет берём ровно в момент нажатия, а не заранее: выданный впустую, он
     погасил бы предыдущий — билет на человека один. */
  const openOutside = async () => {
    setBusy(true);
    setFail("");
    try {
      if (!hasApi) {
        // Без адреса API веб-версии неоткуда брать данные: она откроется
        // демонстрацией. Раньше мы так и делали молча — и человек получал
        // ярлык на демо вместо своего счёта.
        throw new Error("бот не передал адрес своего API — откройте мини-апп "
                        + "кнопкой из панели бота, а не по прямой ссылке");
      }
      const url = demo ? location.href : webLink((await newSession()).token);
      setLink(url);
      openExternal(url);
      haptic.ok();
    } catch (e) {
      // Ключ доступа не выдан — открывать НЕЛЬЗЯ: ярлык вёл бы на демо, и
      // человек считал бы, что видит свой счёт. Лучше отказ с причиной.
      haptic.err();
      setFail(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const systemInstall = async () => {
    if (await install()) { haptic.ok(); onDone(); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Приложение на рабочем столе" tall>
      <div className="pb-3 space-y-3">
        {/* Android и десктопный Chrome умеют ставить приложение системным
            окном — тогда никаких инструкций не нужно вовсе. */}
        {inBrowser && canInstall() && (
          <Press onClick={systemInstall} feel="press" className="block w-full">
            <div className="py-3.5 rounded-[16px] flex items-center justify-center gap-2
                            text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint)" }}>
              <SquarePlus size={17} /> Установить приложение
            </div>
          </Press>
        )}

        <Glass flat className="p-4">
          <div className="text-[15px] font-semibold mb-2.5">
            {inBrowser ? (ios ? "На iPhone" : "На Android") : "Три шага"}
          </div>
          {!inBrowser && (
            <Step n={1} icon={<ExternalLink size={15} />}
                  text="Нажмите «Открыть в браузере» — приложение откроется отдельной страницей, уже с доступом к вашему счёту." />
          )}
          <Step n={inBrowser ? 1 : 2} icon={<Share size={15} />}
                text={ios
                  ? "Нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана."
                  : "Откройте меню браузера — три точки в правом верхнем углу."} />
          <Step n={inBrowser ? 2 : 3} icon={<SquarePlus size={15} />}
                text={ios
                  ? "Выберите «На экран «Домой»» и подтвердите «Добавить»."
                  : "Выберите «Установить приложение» или «Добавить на главный экран»."} />
          <Step n={inBrowser ? 3 : 4} last icon={<Check size={15} />}
                text="Значок появится рядом с обычными приложениями и откроется на весь экран — без Telegram." />
        </Glass>

        {/* Честно про то, чего человек иначе не ждёт: снаружи Telegram доступ
            к счёту держится на ключе внутри ссылки. */}
        <p className="text-[12px] leading-snug px-1" style={{ color: "var(--label-2)" }}>
          Ссылка содержит ваш личный ключ доступа — не передавайте её и не
          публикуйте. Открыв мини-апп в Telegram заново, вы сделаете старую
          ссылку недействительной.
        </p>

        {fail && (
          <Glass flat className="p-3.5 flex items-start gap-2.5">
            <TriangleAlert size={18} style={{ color: "var(--orange)" }} className="shrink-0 mt-0.5" />
            <div className="text-[13px] leading-snug">
              <b>Ключ доступа не выдан.</b> {fail}
              <div className="mt-1" style={{ color: "var(--label-2)" }}>
                Чаще всего это значит, что бот на сервере старее приложения —
                обновите его и попробуйте снова.
              </div>
            </div>
          </Glass>
        )}

        {!inBrowser && (
          <Press onClick={openOutside} disabled={busy} feel="press" className="block w-full">
            <div className="py-3.5 rounded-[16px] flex items-center justify-center gap-2
                            text-[16px] font-semibold text-white"
                 style={{ background: busy ? "var(--label-3)" : "var(--tint)" }}>
              <ExternalLink size={17} /> {busy ? "Готовим ссылку…" : "Открыть в браузере"}
            </div>
          </Press>
        )}

        {(link || (inBrowser && hasSession())) && (
          <Press onClick={() => {
                   const url = link || location.href;
                   navigator.clipboard?.writeText(url);
                   setCopied(true); haptic.ok();
                   setTimeout(() => setCopied(false), 1600);
                 }} className="block w-full">
            <Glass flat className="p-3.5 flex items-center gap-2.5 text-[14px]">
              {copied ? <Check size={17} style={{ color: "var(--green)" }} />
                      : <Copy size={17} style={{ color: "var(--tint)" }} />}
              {copied ? "Ссылка скопирована" : "Скопировать ссылку"}
            </Glass>
          </Press>
        )}

        <Press onClick={onDone} className="block mx-auto">
          <span className="text-[13px]" style={{ color: "var(--label-3)" }}>
            Больше не показывать
          </span>
        </Press>
      </div>
    </Sheet>
  );
}

function Step({ n, icon, text, last }: {
  n: number; icon: React.ReactNode; text: string; last?: boolean;
}) {
  return (
    <div className={`flex gap-3 ${last ? "" : "pb-3"}`}>
      <span className="flex items-center justify-center w-6 h-6 rounded-full shrink-0 text-[11px] font-bold"
            style={{ background: "var(--label-3)", color: "var(--label)" }}>{n}</span>
      <div className="text-[14px] leading-snug flex-1" style={{ color: "var(--label)" }}>
        {text}
      </div>
      <span className="shrink-0 mt-0.5" style={{ color: "var(--label-3)" }}>{icon}</span>
    </div>
  );
}

/**
 * Постоянный вход в кабинете — строкой под кошельком бота.
 *
 * Карточку на главной можно скрыть насовсем, и тогда способа вернуться к
 * установке не осталось бы вовсе: человек, отмахнувшийся один раз, потерял бы
 * функцию навсегда. Здесь она живёт всегда.
 */
export function AddToHomeRow() {
  const [open, setOpen] = useState(false);
  const installed = standalone();
  return (
    <>
      <Glass flat className="overflow-hidden">
        <button type="button" disabled={installed}
                onClick={() => { haptic.tap(); setOpen(true); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-left">
          <span className="flex items-center justify-center w-8 h-8 rounded-[9px] shrink-0"
                style={{ background: "var(--label-3)",
                         color: installed ? "var(--green)" : "var(--tint)" }}>
            {installed ? <Check size={16} /> : <Smartphone size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px]">
              {installed ? "Приложение установлено" : "Ярлык на экране смартфона"}
            </span>
            <span className="block text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>
              {installed
                ? "открывается с рабочего стола, без Telegram"
                : "открывать одним касанием, без Telegram"}
            </span>
          </span>
          {!installed && <SquarePlus size={17} style={{ color: "var(--label-3)" }} />}
        </button>
      </Glass>

      <AddToHomeSheet open={open} onClose={() => setOpen(false)}
                      onDone={() => setOpen(false)} />
    </>
  );
}
