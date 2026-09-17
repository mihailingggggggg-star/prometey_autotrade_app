import { useState } from "react";
import { Check, Copy, ExternalLink, Share, Smartphone, SquarePlus } from "lucide-react";
import { Glass, Press, Sheet } from "../ui/kit";
import { newSession, webLink } from "../lib/api";
import { useApp } from "../lib/store";
import { canAddToHome, haptic, isIOS, openExternal, tg } from "../lib/tg";

const DISMISS_KEY = "prometey.addhome.hidden";

export const homeCardHidden = () => {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
};
const hideCard = () => {
  try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* приватное окно */ }
};

/**
 * Приглашение вынести приложение на рабочий стол.
 *
 * Тонкость, без которой предложение было бы издевательством: «Добавить на
 * экран» умеет только БРАУЗЕР, а внутри Telegram такого пункта нет вовсе.
 * Значит сначала надо открыть приложение снаружи — и вот тут вылезает вторая
 * тонкость: снаружи нет подписи Telegram, то есть нет и доступа к счёту.
 * Поэтому по кнопке мы сперва берём у бота билет и уже с ним открываем
 * веб-версию. Без билета ярлык вёл бы на демо-данные.
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
                Открывается одним касанием, как обычное приложение — без поиска чата
              </div>
            </div>
            <SquarePlus size={20} style={{ color: "var(--label-3)" }} className="shrink-0" />
          </Glass>
        </Press>
      </div>

      <HowToSheet open={open} onClose={() => setOpen(false)}
                  onDone={() => { hideCard(); setOpen(false); onDone(); }} />
    </>
  );
}

function HowToSheet({ open, onClose, onDone }: {
  open: boolean; onClose: () => void; onDone: () => void;
}) {
  const { demo } = useApp();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const ios = isIOS();

  /* Билет берём ровно в момент нажатия, а не заранее: выданный впустую, он
     гасил бы предыдущий — билет на человека один. */
  const openOutside = async () => {
    setBusy(true);
    try {
      const url = demo ? location.href : webLink((await newSession()).token);
      setLink(url);
      openExternal(url);
      haptic.ok();
    } catch {
      // Билет не дали — открываем как есть. Приложение честно покажет, что
      // данные счёта недоступны, вместо того чтобы не открыться вовсе.
      const url = location.href;
      setLink(url);
      openExternal(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Ярлык на рабочем столе" tall>
      <div className="pb-3 space-y-3">
        {canAddToHome() && (
          <Press onClick={() => { tg?.addToHomeScreen?.(); haptic.ok(); onDone(); }}
                 className="block w-full">
            <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint)" }}>
              Добавить сразу
            </div>
          </Press>
        )}

        <Glass flat className="p-4">
          <div className="text-[15px] font-semibold mb-2.5">
            {ios ? "На iPhone" : "На Android"}
          </div>
          <Step n={1} icon={<ExternalLink size={15} />}
                text="Нажмите «Открыть в браузере» ниже — приложение откроется отдельной страницей." />
          <Step n={2} icon={<Share size={15} />}
                text={ios
                  ? "В браузере нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана."
                  : "В браузере откройте меню — три точки в правом верхнем углу."} />
          <Step n={3} icon={<SquarePlus size={15} />}
                text={ios
                  ? "Выберите «На экран «Домой»» и подтвердите «Добавить»."
                  : "Выберите «Добавить на главный экран» и подтвердите."} />
          <Step n={4} last icon={<Check size={15} />}
                text="Готово: значок появится рядом с обычными приложениями." />
        </Glass>

        {/* Честно про то, чего человек иначе не ждёт: снаружи Telegram нет
            подписи, и доступ к счёту держится на билете из ссылки. */}
        <p className="text-[12px] leading-snug px-1" style={{ color: "var(--label-2)" }}>
          Ссылка содержит ваш личный ключ доступа — не передавайте её. Открыв
          мини-апп в Telegram заново, вы сделаете старую ссылку недействительной.
        </p>

        <Press onClick={openOutside} disabled={busy} feel="press" className="block w-full">
          <div className="py-3.5 rounded-[16px] flex items-center justify-center gap-2
                          text-[16px] font-semibold text-white"
               style={{ background: busy ? "var(--label-3)" : "var(--tint)" }}>
            <ExternalLink size={17} /> {busy ? "Готовим ссылку…" : "Открыть в браузере"}
          </div>
        </Press>

        {link && (
          <Press onClick={() => {
                   navigator.clipboard?.writeText(link);
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
