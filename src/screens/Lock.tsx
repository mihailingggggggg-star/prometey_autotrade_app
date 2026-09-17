import { useEffect, useState } from "react";
import { Fingerprint, ShieldCheck } from "lucide-react";
import { Press } from "../ui/kit";
import { bioEnabled, unlock } from "../lib/lock";
import { haptic, inTelegram } from "../lib/tg";

/**
 * Замок веб-версии. Внутри Telegram его нет: там вход уже проверен подписью,
 * и просить палец второй раз — заставлять человека доказывать доказанное.
 */
export function useLock() {
  const armed = !inTelegram && bioEnabled();
  const [open, setOpen] = useState(!armed);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true);
    const ok = await unlock();
    setBusy(false);
    if (ok) { haptic.ok(); setOpen(true); } else haptic.err();
  };

  // Спрашиваем сразу при запуске: лишний тап перед системным окном ничего не
  // добавляет к безопасности, а на каждом открытии приложения он заметен.
  useEffect(() => { if (armed) void ask(); /* eslint-disable-next-line */ }, []);

  return { locked: !open, busy, ask };
}

export function Lock({ busy, ask }: { busy: boolean; ask: () => void }) {
  return (
    <div className="relative z-10 h-full flex flex-col items-center justify-center px-8 text-center">
      <div className="w-[76px] h-[76px] rounded-[22px] flex items-center justify-center mb-6"
           style={{ background: "linear-gradient(145deg,var(--tint),#5e5ce6)",
                    boxShadow: "0 12px 32px -10px var(--tint)" }}>
        <Fingerprint size={38} color="#fff" strokeWidth={2} />
      </div>
      <h1 className="text-[26px] font-bold tracking-[-0.02em]">Приложение заблокировано</h1>
      <p className="text-[15px] mt-2 leading-snug" style={{ color: "var(--label-2)" }}>
        Подтвердите, что это вы — Face ID или отпечаток.
      </p>
      <Press feel="press" className="block w-full mt-7" onClick={ask} disabled={busy}>
        <div className="py-4 rounded-[18px] text-center text-[17px] font-semibold text-white"
             style={{ background: busy ? "var(--label-3)" : "var(--tint)" }}>
          {busy ? "Ждём подтверждения…" : "Разблокировать"}
        </div>
      </Press>
      <div className="flex items-center gap-1.5 mt-5 text-[12px]" style={{ color: "var(--label-3)" }}>
        <ShieldCheck size={13} /> проверку показывает сама система, не приложение
      </div>
    </div>
  );
}
