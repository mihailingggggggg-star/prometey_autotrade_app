/**
 * FunnelSheet — «окно воронки отбора»: на каких этапах и по каким причинам
 * скринер срезает монеты, с разбивкой по дням.
 *
 * Открывается из раздела настроек. За выбранный период показывает три итога
 * (проходы, монеты в работу, сигналы), этапы отбора по слоям с причинами
 * отбраковки из by_check, разбивку по дням и последние проходы.
 *
 * Цифры берём как есть: чего нет — прочерк, а не выдуманный ноль. Данные —
 * GET /api/funnel (см. lib/api). Период переключается Segmented как в аналитике:
 * День/Неделя/Месяц/Всё (1/7/30/3650 дней), по умолчанию — неделя (§4).
 */
import { useEffect, useState } from "react";
import { funnel } from "../lib/api";
import { Glass, GroupLabel, Row, Segmented, Sheet } from "./kit";
import { KV } from "./states";
import type { FunnelSummary } from "../../shared/types";

type P = "d" | "w" | "m" | "all";

const PERIODS: { id: P; label: string }[] = [
  { id: "d", label: "День" },
  { id: "w", label: "Неделя" },
  { id: "m", label: "Месяц" },
  { id: "all", label: "Всё" },
];
const DAYS: Record<P, number> = { d: 1, w: 7, m: 30, all: 3650 };

/** Слои воронки сверху вниз — те же подписи, что в словаре LAYER_LABELS из
 *  ScanProgress.tsx (он не экспортируется, поэтому локальная копия). */
const LAYERS: { key: string; name: string }[] = [
  { key: "1", name: "Безопасность контракта" },
  { key: "2", name: "Концентрация холдеров" },
  { key: "3", name: "Возраст и ликвидность" },
  { key: "4", name: "Накопление" },
  { key: "5", name: "Медиа и новости" },
];

/** Код чека (by_check) → слой и понятная причина. Коды — из server/screener.ts;
 *  слой нужен, чтобы разложить причины по этапам воронки. */
const REASONS: Record<string, { layer: string; label: string }> = {
  burned_liq: { layer: "1", label: "сожжённая ликвидность" },
  mint_revoked: { layer: "1", label: "права минта не сняты" },
  freeze_revoked: { layer: "1", label: "заморозка не снята" },
  danger_risk: { layer: "1", label: "риск контракта (RugCheck)" },
  mint_jupiter: { layer: "1", label: "права минта не сняты (Jupiter)" },
  freeze_jupiter: { layer: "1", label: "заморозка не снята (Jupiter)" },
  top10_holders: { layer: "2", label: "концентрация топ-10" },
  age: { layer: "3", label: "возраст" },
  liquidity: { layer: "3", label: "ликвидность" },
  tight_range: { layer: "4", label: "широкий коридор" },
  drawdown: { layer: "4", label: "просадка вне окна" },
  holders_growth: { layer: "4", label: "нет прироста холдеров" },
  wash_filter: { layer: "4", label: "накрутка объёма" },
  liq_change: { layer: "4", label: "слив ликвидности" },
  organic_jupiter: { layer: "4", label: "органичность" },
  mentions: { layer: "5", label: "мало упоминаний в X" },
  sentiment: { layer: "5", label: "тональность соцсетей" },
  organic: { layer: "5", label: "органичность интереса" },
};

/** Остановки, живущие в by_layer не слоем, а отдельным ключом. */
const STOP_LABELS: Record<string, string> = {
  budget: "бюджет исчерпан",
  error: "сбой замера",
};

const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** Дата дня в поясе Бишкек (UTC+6): «14 окт». День — в секундах контракта. */
function fmtDay(secs: number): string {
  const d = new Date((secs + 6 * 3600) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Время прохода в поясе Бишкек: «14:20». */
function fmtTime(secs: number): string {
  const d = new Date((secs + 6 * 3600) * 1000);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Число из ответа: нет поля — null (прочерк), а не выдуманный ноль. */
const num = (v: number | undefined): number | null => (typeof v === "number" ? v : null);
const cnt = (v: number | undefined): string => (typeof v === "number" ? String(v) : "—");

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Одно из трёх верхних чисел — крупная цифра и подпись под ней. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 min-w-0 text-center">
      <div className="text-[22px] font-bold tabular-nums leading-tight">{value}</div>
      <div className="text-[12px] mt-0.5 leading-tight" style={{ color: "var(--label-2)" }}>{label}</div>
    </div>
  );
}

export function FunnelSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [p, setP] = useState<P>("w");
  const [data, setData] = useState<FunnelSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Период меняется или окно открывают — перечитываем воронку. Границы считаем
  // в секундах: from = now − days·86400, to = now (как в контракте /api/funnel).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr(null);
    setData(null);
    const now = Math.floor(Date.now() / 1000);
    funnel({ from: now - DAYS[p] * 86400, to: now, limit: 20 })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(msg(e)); });
    return () => { cancelled = true; };
  }, [open, p]);

  // Причины по слоям из by_check. Незнакомый код показываем как есть — отдельно,
  // потому что к слою его отнести нечем.
  const byCheck = data?.by_check ?? {};
  const reasonsByLayer = new Map<string, { label: string; count: number }[]>();
  const unknown: { label: string; count: number }[] = [];
  for (const [code, count] of Object.entries(byCheck)) {
    const r = REASONS[code];
    if (!r) { unknown.push({ label: code, count }); continue; }
    const list = reasonsByLayer.get(r.layer) ?? [];
    list.push({ label: r.label, count });
    reasonsByLayer.set(r.layer, list);
  }
  reasonsByLayer.forEach((list) => list.sort((a, b) => b.count - a.count));
  unknown.sort((a, b) => b.count - a.count);

  // Остановки-не-слои (бюджет/сбои) показываем, только если они реально были.
  const stops: { key: string; label: string; count: number }[] = [];
  if (data) {
    for (const k of ["budget", "error"] as const) {
      const v = num(data.by_layer[k]);
      if (v != null && v > 0) stops.push({ key: k, label: STOP_LABELS[k], count: v });
    }
  }

  const days = data?.days ?? [];
  const recent = data?.recent ?? [];

  return (
    <Sheet open={open} onClose={onClose} title="Воронка отбора" tall>
      <div className="pb-4">
        {/* ── Период ────────────────────────────────────────────────────── */}
        <Segmented<P> value={p} onChange={setP} options={PERIODS} size="sm" layoutId="funnel-period" />

        {/* ── Состояния ─────────────────────────────────────────────────── */}
        {err && (
          <p className="text-[13px] mt-3 leading-snug" style={{ color: "var(--orange)" }}>{err}</p>
        )}
        {!data && !err && (
          <p className="text-[14px] mt-8 text-center" style={{ color: "var(--label-3)" }}>считаю воронку…</p>
        )}

        {data && (
          <>
            {/* ── Три числа за период ───────────────────────────────────── */}
            <Glass flat className="mt-3 px-3 py-3">
              <div className="flex items-stretch">
                <Stat label="проходов" value={cnt(data.runs)} />
                <Stat label="монет в работу" value={cnt(data.candidates_total)} />
                <Stat label="сигналов" value={cnt(data.signals_found)} />
              </div>
            </Glass>

            {/* ── Этапы отбора: воронкой сверху вниз ───────────────────── */}
            {/* GroupLabel несёт свой px-5, а шторка уже даёт px-5: -mx-5 гасит
                лишний отступ, чтобы подписи стояли вровень со слоями. */}
            <div className="-mx-5"><GroupLabel>Этапы отбора</GroupLabel></div>
            {LAYERS.map(({ key, name }) => {
              const rej = num(data.by_layer[key]);
              const reasons = reasonsByLayer.get(key) ?? [];
              return (
                <Glass key={key} flat className="mt-2 px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[15px] font-semibold leading-tight">Слой {key} · {name}</span>
                    <span className="text-[14px] tabular-nums shrink-0"
                          style={{ color: rej != null && rej > 0 ? "var(--orange)" : "var(--label-2)" }}>
                      {rej == null ? "—" : rej > 0 ? `отсеяно ${rej}` : "отсева не было"}
                    </span>
                  </div>
                  {reasons.length > 0 && (
                    <div className="mt-1">
                      {reasons.map((r) => (
                        <KV key={r.label} label={r.label} value={String(r.count)} mono />
                      ))}
                    </div>
                  )}
                </Glass>
              );
            })}
            {stops.map((s) => (
              <Glass key={s.key} flat className="mt-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[15px] font-semibold leading-tight">{s.label}</span>
                  <span className="text-[14px] tabular-nums shrink-0" style={{ color: "var(--label-2)" }}>{s.count}</span>
                </div>
              </Glass>
            ))}
            {unknown.length > 0 && (
              <Glass flat className="mt-2 px-4 py-3">
                <div className="text-[15px] font-semibold mb-0.5">Прочие причины</div>
                {unknown.map((r) => (
                  <KV key={r.label} label={r.label} value={String(r.count)} mono />
                ))}
              </Glass>
            )}

            {/* ── По дням ───────────────────────────────────────────────── */}
            <div className="-mx-5"><GroupLabel>По дням</GroupLabel></div>
            {days.length > 0 ? (
              <Glass flat className="overflow-hidden">
                {days.map((d, i) => (
                  <Row key={d.day}
                       title={fmtDay(d.day)}
                       note={`проходов ${d.runs} · монет ${d.candidates} · сигналов ${d.signals}`}
                       last={i === days.length - 1} />
                ))}
              </Glass>
            ) : (
              <p className="text-[14px] px-1" style={{ color: "var(--label-2)" }}>за период проходов не было</p>
            )}

            {/* ── Последние проходы ─────────────────────────────────────── */}
            <div className="-mx-5"><GroupLabel>Последние проходы</GroupLabel></div>
            {recent.length > 0 ? (
              <Glass flat className="scroll" style={{ maxHeight: 240, overscrollBehavior: "contain" }}>
                {recent.map((r, i) => (
                  <Row key={r.id}
                       title={fmtTime(r.ts)}
                       note={`монет ${r.candidates_total} · сигналов ${r.signals_found}`}
                       last={i === recent.length - 1} />
                ))}
              </Glass>
            ) : (
              <p className="text-[14px] px-1" style={{ color: "var(--label-2)" }}>проходов ещё не было</p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
