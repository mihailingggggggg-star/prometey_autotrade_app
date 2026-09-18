import { useState } from "react";
import { ClipboardPaste, Link2, TriangleAlert } from "lucide-react";
import { Glass, Press, Sheet } from "../ui/kit";
import { applyCode, parseCode } from "../lib/api";
import { haptic } from "../lib/tg";

/**
 * Подключение веб-версии кодом из бота.
 *
 * Почему кодом, а не ссылкой. Ссылка несёт адрес API и ключ доступа в
 * параметрах и переживает РОВНО ОДИН переход: встроенный браузер Telegram,
 * Safari и приложение с рабочего стола — три разных хранилища. Открыв ссылку в
 * одном, во втором человек снова оказывается ни с чем и видит демонстрацию
 * вместо своего счёта. Код переносится куда угодно.
 */
export function ConnectCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="px-4 mt-3">
        <Press onClick={() => { haptic.tap(); setOpen(true); }} className="block w-full" scale={0.98}>
          <Glass className="p-4 flex items-center gap-3.5">
            <span className="flex items-center justify-center w-11 h-11 rounded-[13px] shrink-0"
                  style={{ background: "var(--tint-grad)" }}>
              <Link2 size={22} color="#fff" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold leading-tight">Подключите свой счёт</div>
              <div className="text-[13px] mt-1 leading-snug" style={{ color: "var(--label-2)" }}>
                Сейчас показаны учебные данные. Вставьте код из бота — появятся ваши.
              </div>
            </div>
          </Glass>
        </Press>
      </div>
      <ConnectSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function ConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  const apply = (raw: string) => {
    try {
      applyCode(parseCode(raw));
      haptic.ok();
      // Перезагрузка обязательна: адрес API читается один раз при старте, и
      // половина приложения уже живёт с прежним (вернее, без него).
      location.reload();
    } catch (e) {
      haptic.err();
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const fromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setCode(t);
      apply(t);
    } catch {
      setErr("браузер не дал прочитать буфер — вставьте код в поле вручную");
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Подключить счёт" tall>
      <div className="pb-3 space-y-3">
        <Glass flat className="p-4">
          <div className="text-[14px] leading-snug">
            Откройте чат с ботом и отправьте <b>/web</b> — он пришлёт код. Либо
            в панели бота нажмите <b>«🌐 Код для веба»</b>.
          </div>
          <div className="text-[12px] mt-2 leading-snug" style={{ color: "var(--label-2)" }}>
            Код открывает доступ к вашему счёту — никому его не передавайте.
            Новый код отменяет предыдущий.
          </div>
        </Glass>

        <div>
          <div className="text-[13px] mb-1.5 px-1" style={{ color: "var(--label-2)" }}>Код</div>
          <div className="glass glass-flat p-3">
            <textarea value={code} onChange={(e) => { setCode(e.target.value); setErr(""); }}
                      placeholder="PR1-…" rows={3} spellCheck={false}
                      className="w-full bg-transparent outline-none resize-none text-[13px] font-mono"
                      style={{ color: "var(--label)" }} />
          </div>
        </div>

        {err && (
          <Glass flat className="p-3.5 flex items-start gap-2.5">
            <TriangleAlert size={18} style={{ color: "var(--orange)" }} className="shrink-0 mt-0.5" />
            <div className="text-[13px] leading-snug">Код не принят: {err}</div>
          </Glass>
        )}

        <Press onClick={fromClipboard} className="block w-full">
          <Glass flat className="p-3.5 flex items-center gap-2.5 text-[14px]">
            <ClipboardPaste size={17} style={{ color: "var(--tint)" }} />
            Вставить из буфера обмена
          </Glass>
        </Press>

        <Press feel="press" className="block w-full" disabled={!code.trim()}
               onClick={() => apply(code)}>
          <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
               style={{ background: code.trim() ? "var(--tint)" : "var(--label-3)" }}>
            Подключить
          </div>
        </Press>
      </div>
    </Sheet>
  );
}
