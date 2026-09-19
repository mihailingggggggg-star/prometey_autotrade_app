/**
 * Настройка уведомлений — строка в «Приложении» и шторка с тремя тумблерами.
 *
 * Виды разделены по ЦЕНЕ МОЛЧАНИЯ, а не по теме:
 *   • Позиции — сделка закрылась. Факт про ваши деньги.
 *   • Системные — бот перестал работать: биржа не принимает ордера, ключи
 *     отозваны, связь потеряна. Пропустить такое дороже всего.
 *   • Информационные — итоги дня, новости, предложения. Можно и не читать.
 *
 * Поэтому три тумблера, а не один: с одним пришлось бы выключать важное ради
 * тишины от новостей, и человек выключил бы всё.
 */

import { useEffect, useState } from "react";
import { BellRing, Info, ShieldAlert, TrendingUp } from "lucide-react";
import { Glass, Press, Row, Sheet, Toggle } from "../ui/kit";
import { haptic } from "../lib/tg";
import { available, probe, readPrefs, setKind,
         type PushKind, type PushPrefs, type PushStatus } from "../lib/push";

export function NotifyRow() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<PushPrefs>(readPrefs);
  const on = Object.values(prefs).filter(Boolean).length;

  return (
    <>
      <Glass flat className="overflow-hidden">
        <Row last icon={<BellRing size={16} />} title="Уведомления"
             note={!available() ? "доступны у ярлыка на рабочем столе"
                   : on ? `включено: ${on} из 3` : "выключены"}
             right={<span style={{ color: "var(--label-2)" }}>›</span>}
             onClick={() => { haptic.tap(); setOpen(true); }} />
      </Glass>
      <NotifySheet open={open} onClose={() => setOpen(false)} prefs={prefs} onPrefs={setPrefs} />
    </>
  );
}

function NotifySheet({ open, onClose, prefs, onPrefs }: {
  open: boolean; onClose: () => void; prefs: PushPrefs; onPrefs: (p: PushPrefs) => void;
}) {
  const [busy, setBusy] = useState<PushKind | null>(null);
  const [status, setStatus] = useState<PushStatus>("default");

  /* Состояние канала перечитываем при открытии И при возврате в приложение.
     Разрешение меняют в настройках системы, не закрывая приложение: застывший
     ответ показывал бы «запрещено» тому, кто только что всё разрешил — ровно
     на это и жаловались. */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const refresh = () => {
      onPrefs(readPrefs());
      void probe().then((s) => { if (alive) setStatus(s); });
    };
    refresh();
    const vis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", vis);
    return () => { alive = false; document.removeEventListener("visibilitychange", vis); };
  }, [open]);

  const flip = async (kind: PushKind, v: boolean) => {
    setBusy(kind);
    const { prefs: next, reason } = await setKind(kind, v);
    setBusy(null);
    onPrefs(next);
    setStatus(reason);
    /* Тумблер не «сделал вид»: если система отказала, он возвращается и рядом
       появляется объяснение — но именно то, которое годится. */
    if (v && !next[kind]) haptic.warn(); else haptic.select();
  };

  const can = status !== "unsupported" && status !== "denied";

  return (
    <Sheet open={open} onClose={onClose} title="Уведомления">
      <div className="pb-3 space-y-2.5">
        {status === "unsupported" && (
          <Glass flat className="p-3.5 text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
            В этом окне уведомления невозможны. Они работают у ярлыка на рабочем
            столе: добавьте приложение на экран — строка «Ярлык на экране
            смартфона» чуть выше — и включите их оттуда.
          </Glass>
        )}
        {status === "denied" && (
          <Glass flat className="p-3.5 text-[13px] leading-snug" style={{ color: "var(--orange)" }}>
            Уведомления запрещены в настройках телефона. Включить их отсюда уже
            нельзя — только в настройках системы для этого приложения. Разрешите
            там и вернитесь: экран обновится сам.
          </Glass>
        )}
        {/* Телефон готов, а отправлять некому. Винить в этом телефон — значит
            отправить человека чинить исправное. */}
        {status === "no-server" && (
          <Glass flat className="p-3.5 text-[13px] leading-snug" style={{ color: "var(--orange)" }}>
            Телефон разрешил уведомления, но бот пока не настроен на отправку —
            владельцу нужно прописать ключи на сервере. Ваш выбор сохранён:
            уведомления начнут приходить сами, как только канал заработает.
          </Glass>
        )}

        <Glass flat className="overflow-hidden">
          <Line icon={<TrendingUp size={16} />} title="Позиции"
                note="сделка закрылась: результат, R и время в рынке"
                on={prefs.positions} busy={busy === "positions"} can={can}
                onChange={(v) => void flip("positions", v)} />
          <Line icon={<ShieldAlert size={16} />} title="Системные"
                note="бот остановлен, биржа отказала, ключи не работают"
                on={prefs.system} busy={busy === "system"} can={can}
                onChange={(v) => void flip("system", v)} />
          <Line last icon={<Info size={16} />} title="Информационные"
                note="итоги дня, новости и предложения"
                on={prefs.news} busy={busy === "news"} can={can}
                onChange={(v) => void flip("news", v)} />
        </Glass>

        <p className="text-[12px] px-1 leading-snug" style={{ color: "var(--label-2)" }}>
          Уведомления приходят на это устройство. На другом телефоне их нужно
          включить отдельно — подписка принадлежит устройству, а не счёту.
        </p>
      </div>
    </Sheet>
  );
}

function Line({ icon, title, note, on, busy, can, onChange, last }: {
  icon: React.ReactNode; title: string; note: string; on: boolean;
  busy: boolean; can: boolean; onChange: (v: boolean) => void; last?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${last ? "" : "hairline"}`}
         style={{ opacity: can ? 1 : 0.45 }}>
      <span className="flex items-center justify-center w-[30px] h-[30px] rounded-[8px] shrink-0"
            style={{ background: "var(--label-3)" }}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px]">{title}</span>
        <span className="block text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>
          {busy ? "спрашиваем разрешение…" : note}
        </span>
      </span>
      <Toggle on={on} onChange={onChange} disabled={!can || busy} />
    </div>
  );
}

/** Кнопка «прислать пробное» — чтобы человек увидел, как это выглядит. */
export function TestPush() {
  return (
    <Press onClick={() => {
      haptic.tap();
      void navigator.serviceWorker?.getRegistration()?.then((r) =>
        r?.showNotification("TON +2.41% · цель взята", {
          body: "+$23,90 · +1.45R · 2 ч в рынке",
          icon: `${import.meta.env.BASE_URL || "/"}icon-192.png`,
        }));
    }} className="block w-full">
      <div className="py-2.5 text-center text-[14px]" style={{ color: "var(--tint-soft)" }}>
        Показать, как выглядит уведомление
      </div>
    </Press>
  );
}
