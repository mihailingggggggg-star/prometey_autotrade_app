import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { Modal, Press } from "../ui/kit";
import { bioAsk, bioEnabled, bioSupported, clearBioAsk, enableBio } from "../lib/lock";
import { useApp } from "../lib/store";
import { haptic, inTelegram } from "../lib/tg";

/**
 * Предложение включить вход по биометрии — СРАЗУ после первого входа.
 *
 * Настройка, живущая только в глубине кабинета, не включается никогда: про неё
 * надо знать заранее. А ценность «больше не вводить код» очевидна ровно в тот
 * момент, когда человек его только что ввёл.
 *
 * Спрашиваем ОДИН раз. Отказ — это ответ, и переспрашивать его при каждом
 * запуске значит не услышать; включить можно в кабинете.
 *
 * Внутри Telegram замка нет вовсе: там вход проверен подписью, и просить палец
 * второй раз — заставлять человека доказывать доказанное.
 */
export function BioOffer() {
  const { me } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (inTelegram || !bioAsk() || bioEnabled()) return;
    /* Не поддерживает устройство — снимаем отметку молча: предлагать то, чего
       нет, значит обещать функцию, которой не будет. */
    void bioSupported().then((can) => (can ? setOpen(true) : clearBioAsk()));
  }, []);

  const close = () => { clearBioAsk(); setOpen(false); };

  const on = async () => {
    setBusy(true); setErr("");
    const fail = await enableBio(me?.id || 0, me?.name || "трейдер");
    setBusy(false);
    if (fail) { setErr(fail); haptic.err(); return; }
    haptic.ok();
    close();
  };

  return (
    <Modal open={open} onClose={close}>
      <div className="text-center">
        <div className="mx-auto mb-3 flex items-center justify-center w-12 h-12 rounded-full"
             style={{ background: "color-mix(in srgb, var(--tint) 18%, transparent)" }}>
          <Fingerprint size={22} style={{ color: "var(--tint)" }} />
        </div>
        <h3 className="text-[19px] font-bold">Входить по Face ID?</h3>
        <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
          Тогда код из Telegram больше не понадобится: приложение будет
          спрашивать отпечаток или лицо — так же, как сам телефон.
        </p>
        {err && (
          <p className="text-[13px] mt-2 leading-snug" style={{ color: "var(--orange)" }}>
            Не включилось: {err}
          </p>
        )}
        <Press onClick={on} disabled={busy} className="block w-full mt-5">
          <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
               style={{ background: busy ? "var(--label-3)" : "var(--tint)" }}>
            {busy ? "Ждём подтверждения…" : "Включить"}
          </div>
        </Press>
        <Press onClick={close} className="mt-3 mx-auto">
          <span className="text-[13px]" style={{ color: "var(--label-3)" }}>Не сейчас</span>
        </Press>
      </div>
    </Modal>
  );
}
