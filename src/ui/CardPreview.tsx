/**
 * Предпросмотр карточки для соцсетей — один на все карточки приложения.
 *
 * СНАЧАЛА ПОКАЗЫВАЕМ, что уйдёт в ленту, и только потом отдаём. Картинкой
 * делятся публично; отправить её вслепую — значит однажды опубликовать не то,
 * что человек имел в виду.
 *
 * Компонент общий намеренно: карточек стало три (сделка в процентах, сделка в
 * деньгах, кумулятивная прибыль), а работа с системным листом «Поделиться»,
 * запасной выгрузкой файла и предпросмотром у них одна и та же. Разведи их по
 * экранам — и однажды починишь долю в одном месте из трёх.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Press, Segmented, portal } from "./kit";
import { haptic } from "../lib/tg";

export type CardKind = string;

export function CardPreview<K extends CardKind>({
  kinds, initial, draw, blob, filename, text, onClose,
}: {
  /** Варианты карточки. Один вариант — переключатель не показываем. */
  kinds: { id: K; label: string }[];
  initial: K;
  draw: (cv: HTMLCanvasElement, kind: K) => void;
  blob: (kind: K) => Promise<Blob | null>;
  filename: (kind: K) => string;
  text: (kind: K) => string;
  onClose: () => void;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [kind, setKind] = useState<K>(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (cv.current) draw(cv.current, kind); }, [kind, draw]);

  const send = async () => {
    setBusy(true);
    haptic.tap();
    const b = await blob(kind);
    setBusy(false);
    if (!b) return;
    const file = new File([b], filename(kind), { type: "image/png" });
    /* Системный лист «Поделиться» есть не везде: в старом вебвью и на десктопе
       его нет вовсе. Тогда просто отдаём файл — человек сам решит, куда его
       деть. Молча ничего не делать в этом месте нельзя: кнопка нажата. */
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text: text(kind) }); haptic.ok(); return; }
      catch { /* закрыли лист — это не ошибка */ return; }
    }
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    haptic.ok();
  };

  return portal(
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center p-5"
         style={{ background: "rgba(0,0,0,.72)", backdropFilter: "blur(14px)",
                  WebkitBackdropFilter: "blur(14px)" }}>
      <motion.canvas ref={cv}
        initial={{ opacity: 0, scale: 0.94, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className="rounded-[22px] w-full"
        style={{ maxWidth: 320, aspectRatio: "1080 / 1350",
                 boxShadow: "0 30px 80px -20px rgba(255,40,70,.35)" }} />
      {kinds.length > 1 && (
        <div className="mt-4 w-full" style={{ maxWidth: 320 }}>
          <Segmented value={kind} onChange={setKind} options={kinds} size="sm" />
        </div>
      )}
      <div className="flex gap-2.5 mt-3 w-full" style={{ maxWidth: 320 }}>
        <Press onClick={onClose} className="flex-1">
          <div className="py-3 rounded-[14px] text-center text-[15px] font-semibold glass glass-flat">
            Отмена
          </div>
        </Press>
        <Press onClick={() => void send()} className="flex-1" disabled={busy}>
          <div className="py-3 rounded-[14px] text-center text-[15px] font-semibold text-white"
               style={{ background: "var(--tint-grad)" }}>
            {busy ? "Готовим…" : "Поделиться"}
          </div>
        </Press>
      </div>
    </div>,
  );
}
