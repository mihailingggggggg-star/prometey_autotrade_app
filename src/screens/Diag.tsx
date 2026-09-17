import { useEffect, useState } from "react";
import { Copy, Check, Fingerprint, Stethoscope } from "lucide-react";
import { Glass, Press, Sheet, Toggle, Row } from "../ui/kit";
import { API_BASE, apiRemembered, hasApi, hasSession } from "../lib/api";
import { useApp } from "../lib/store";
import { bioEnabled, bioSupported, disableBio, enableBio } from "../lib/lock";
import { haptic, inTelegram } from "../lib/tg";

/**
 * Диагностика и замок — в одном месте.
 *
 * Диагностика здесь не «на всякий случай»: цепочка от кнопки в боте до данных
 * на экране состоит из пяти звеньев (адрес API, ключ доступа, ответ сервера,
 * права, режим счёта), и обрыв любого выглядит одинаково — пустой экран.
 * Без этой страницы вопрос «почему демо?» решался перепиской.
 */
export function DiagRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Glass flat className="overflow-hidden">
        <SecurityRow />
        <button type="button" onClick={() => { haptic.tap(); setOpen(true); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-left">
          <span className="flex items-center justify-center w-8 h-8 rounded-[9px] shrink-0"
                style={{ background: "var(--label-3)", color: "var(--label-2)" }}>
            <Stethoscope size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px]">Проверка связи</span>
            <span className="block text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>
              откуда приходят данные и что с доступом
            </span>
          </span>
        </button>
      </Glass>
      <DiagSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Замок по биометрии. Только для веб-версии: внутри Telegram вход уже
 *  проверен подписью, и просить палец второй раз — заставлять человека
 *  доказывать доказанное. */
function SecurityRow() {
  const { me } = useApp();
  const [can, setCan] = useState(false);
  const [on, setOn] = useState(bioEnabled());
  const [err, setErr] = useState("");

  useEffect(() => { void bioSupported().then(setCan); }, []);

  if (inTelegram) return null;

  const toggle = async (v: boolean) => {
    setErr("");
    if (!v) { disableBio(); setOn(false); haptic.tap(); return; }
    const fail = await enableBio(me?.id || 0, me?.name || "трейдер");
    if (fail) { setErr(fail); haptic.err(); return; }
    setOn(true); haptic.ok();
  };

  return (
    <div className={can ? "" : "opacity-60"}>
      <Row title="Вход по биометрии"
           note={!can ? "устройство не поддерживает"
                 : on ? "Face ID или отпечаток при каждом открытии"
                      : "спрашивать отпечаток или Face ID при открытии"}
           icon={<Fingerprint size={16} />}
           right={<Toggle on={on} onChange={(v) => { if (can) void toggle(v); }} />} />
      {err && (
        <div className="px-4 pb-2.5 text-[12px] leading-snug" style={{ color: "var(--orange)" }}>
          Не включилось: {err}
        </div>
      )}
      {on && (
        <div className="px-4 pb-2.5 text-[12px] leading-snug" style={{ color: "var(--label-2)" }}>
          Это замок на устройстве: он решает, отдать ли ключ доступа тому, кто
          держит телефон. Сам ключ хранится в этом браузере.
        </div>
      )}
    </div>
  );
}

function DiagSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, link, demo, mode, positions, trades } = useApp();
  const [health, setHealth] = useState("проверяем…");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setHealth("проверяем…");
    if (!hasApi) return setHealth("адреса API нет");
    fetch(API_BASE + "/api/health", { signal: AbortSignal.timeout(8000) })
      .then((r) => setHealth(r.ok ? "отвечает" : `ошибка ${r.status}`))
      .catch((e) => setHealth("не отвечает: " + (e?.message || "сеть")));
  }, [open]);

  const lines = [
    ["сборка", __BUILD__],
    ["открыто в", inTelegram ? "Telegram" : "браузере"],
    ["адрес API", hasApi ? API_BASE : "НЕ ПЕРЕДАН"],
    ["адрес взят", !hasApi ? "—" : apiRemembered ? "из памяти (мог протухнуть)" : "из ссылки"],
    ["сервер", health],
    ["ключ доступа", inTelegram ? "не нужен (подпись Telegram)"
                    : hasSession() ? "есть" : "НЕТ"],
    ["связь с ботом", link === "ok" ? "есть" : link === "off" ? "нет адреса"
                      : link === "denied" ? "доступ не выдан" : "бот не отвечает"],
    ["кто вы", me ? (me.role === "admin" ? "владелец счёта" : "пользователь") : "—"],
    ["номер подтверждён", me ? (me.phoneOk ? "да" : "НЕТ") : "—"],
    ["данные", demo ? "УЧЕБНЫЕ" : "настоящие"],
    ["счёт", mode === "live" ? "боевой" : "демо"],
    ["позиций / сделок", `${positions.length} / ${trades.length}`],
  ] as const;

  const text = lines.map(([k, v]) => `${k}: ${v}`).join("\n");

  return (
    <Sheet open={open} onClose={onClose} title="Проверка связи" tall>
      <div className="pb-3 space-y-3">
        <Glass flat className="overflow-hidden">
          {lines.map(([k, v], i) => (
            <div key={k} className={`flex items-start justify-between gap-3 px-4 py-2.5 ${
                   i === lines.length - 1 ? "" : "hairline"}`}>
              <span className="text-[14px] shrink-0" style={{ color: "var(--label-2)" }}>{k}</span>
              <span className="text-[13px] text-right break-all font-medium"
                    style={{ color: /НЕТ|НЕ ПЕРЕДАН|УЧЕБНЫЕ|не отвечает|не выдан/.test(String(v))
                             ? "var(--orange)" : "var(--label)" }}>{v}</span>
            </div>
          ))}
        </Glass>

        <p className="text-[12px] leading-snug px-1" style={{ color: "var(--label-2)" }}>
          Данные учебные, если нет адреса API, нет ключа доступа или бот не
          признал вас владельцем счёта. Строка выше показывает, что именно.
        </p>

        <Press onClick={() => { navigator.clipboard?.writeText(text); setCopied(true);
                                haptic.ok(); setTimeout(() => setCopied(false), 1600); }}
               className="block w-full">
          <Glass flat className="p-3.5 flex items-center gap-2.5 text-[14px]">
            {copied ? <Check size={17} style={{ color: "var(--green)" }} />
                    : <Copy size={17} style={{ color: "var(--tint)" }} />}
            {copied ? "Скопировано" : "Скопировать для поддержки"}
          </Glass>
        </Press>
      </div>
    </Sheet>
  );
}
