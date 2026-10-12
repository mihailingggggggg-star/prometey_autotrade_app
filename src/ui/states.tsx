/**
 * Общие состояния экранов: загрузка, отказ связи, карточка-блок и строка
 * «подпись → значение».
 *
 * Вынесены из экранов, а не продублированы в каждом: одинаковая формулировка
 * ошибки в пяти местах — это пять разных формулировок через месяц. Требование
 * (§9): сначала состояние загрузки, потом данные; при сбое — понятный текст с
 * причиной, а не пустой экран.
 */
import type { ReactNode } from "react";
import { NO_SERVER } from "../lib/api";
import { Glass, Press } from "./kit";

export function Loading({ label }: { label: string }) {
  return (
    <div className="px-5 pt-16 text-center text-[14px]" style={{ color: "var(--label-3)" }}>
      {label}
    </div>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const offline = text === NO_SERVER;
  return (
    <div className="mx-3 mt-2 p-4 rounded-[16px] glass glass-flat">
      <div className="text-[15px] font-semibold" style={{ color: "var(--orange)" }}>
        {offline ? "Нет связи с сервером" : "Не удалось получить данные"}
      </div>
      <p className="text-[14px] mt-1 leading-snug" style={{ color: "var(--label-2)" }}>{text}</p>
      {onRetry && (
        <Press onClick={onRetry} className="inline-block mt-3">
          <div className="px-4 py-2 rounded-[12px] text-[14px] font-semibold"
               style={{ background: "var(--bg-elev)" }}>Повторить</div>
        </Press>
      )}
    </div>
  );
}

/** Карточка-раздел: заголовок и содержимое. Плотная сетка, без градиентов. */
export function Panel({ title, right, children }: {
  title?: ReactNode; right?: ReactNode; children: ReactNode;
}) {
  return (
    <Glass flat className="rounded-[18px] p-4">
      {(title || right) && (
        <div className="flex items-center justify-between mb-2.5">
          {typeof title === "string"
            ? <div className="text-[13px] uppercase tracking-wide font-medium"
                    style={{ color: "var(--label-2)" }}>{title}</div>
            : title}
          {right}
        </div>
      )}
      {children}
    </Glass>
  );
}

/** Строка «подпись → значение». `mono` — для цен и количеств. */
export function KV({ label, value, mono, tone }: {
  label: ReactNode; value: ReactNode; mono?: boolean; tone?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-[5px]">
      <span className="text-[14px]" style={{ color: "var(--label-2)" }}>{label}</span>
      <span className={"text-[14px] font-medium" + (mono ? " tabular-nums" : "")}
            style={{ color: tone || "var(--label)" }}>{value}</span>
    </div>
  );
}
