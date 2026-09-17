import QRCode from "react-qr-code";
import { Check, Copy, Lock } from "lucide-react";
import { useState } from "react";
import { Glass, Modal, Press } from "../ui/kit";
import { useApp } from "../lib/store";
import * as M from "../lib/mock";
import { haptic } from "../lib/tg";

/**
 * Блокирующее окно: на балансе не хватает на недельную комиссию.
 * Закрыть его нельзя — сделки остановлены, и человек должен это увидеть,
 * а не обнаружить через сутки в логах.
 */
export function DebtGate({ open }: { open: boolean }) {
  const { owed, balance, payOwed, topUp } = useApp();
  const [copied, setCopied] = useState(false);
  const need = Math.max(0, owed - balance);

  return (
    <Modal open={open} onClose={() => {}} dismissable={false}>
      <div className="text-center">
        <div className="mx-auto mb-3 flex items-center justify-center w-14 h-14 rounded-full"
             style={{ background: "color-mix(in srgb, var(--red) 18%, transparent)" }}>
          <Lock size={26} style={{ color: "var(--red)" }} />
        </div>
        <h3 className="text-[21px] font-bold tracking-tight">Сделки приостановлены</h3>
        <p className="text-[14px] mt-2 leading-snug" style={{ color: "var(--label-2)" }}>
          К оплате <b style={{ color: "var(--label)" }}>${owed.toFixed(2)}</b> — комиссия за неделю.
          На балансе ${balance.toFixed(2)}, не хватает <b style={{ color: "var(--red)" }}>${need.toFixed(2)}</b>.
          Новые сигналы не берутся, пока долг не погашен. Открытые позиции продолжают вестись.
        </p>

        <div className="mt-4 flex justify-center">
          <div className="p-3 rounded-[18px] bg-white">
            <QRCode value={M.USDT_ADDRESS} size={180} bgColor="#ffffff" fgColor="#000000" />
          </div>
        </div>

        <div className="text-[12px] mt-3" style={{ color: "var(--label-2)" }}>
          USDT · сеть Polygon (PoS)
        </div>
        <Press className="block w-full mt-2" onClick={() => {
          navigator.clipboard?.writeText(M.USDT_ADDRESS); haptic.ok();
          setCopied(true); setTimeout(() => setCopied(false), 1600);
        }}>
          <Glass flat className="px-3 py-2.5 flex items-center gap-2">
            <span className="text-[12px] font-mono break-all flex-1 text-left">{M.USDT_ADDRESS}</span>
            {copied ? <Check size={16} style={{ color: "var(--green)" }} />
                    : <Copy size={16} style={{ color: "var(--label-2)" }} />}
          </Glass>
        </Press>

        <Press feel="press" className="block w-full mt-3"
               onClick={() => { topUp(need + 20); setTimeout(payOwed, 60); haptic.ok(); }}>
          <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
               style={{ background: "var(--green)" }}>Я оплатил — проверить</div>
        </Press>
      </div>
    </Modal>
  );
}
