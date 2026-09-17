import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Search, Trophy, Percent, TrendingDown, Scale } from "lucide-react";
import { Glass, GroupLabel, Press, Segmented, Title, tone } from "../ui/kit";
import { useApp } from "../lib/store";
import type { Trade } from "../lib/mock";
import * as M from "../lib/mock";
import { money, rr, dt, price, plural } from "../lib/format";

type P = "d" | "w" | "m" | "all";
const OPTS: { id: P; label: string; days: number }[] = [
  { id: "d", label: "Сегодня", days: 1 },
  { id: "w", label: "7 дней", days: 7 },
  { id: "m", label: "30 дней", days: 30 },
  { id: "all", label: "Всё", days: 3650 },
];

const REASON: Record<string, { t: string; c: string }> = {
  tp_all: { t: "цель взята", c: "var(--green)" },
  tp_be: { t: "часть целей → БУ", c: "var(--green)" },
  tp: { t: "цель взята", c: "var(--green)" },
  be: { t: "безубыток", c: "var(--label-2)" },
  sl: { t: "стоп", c: "var(--red)" },
  manual: { t: "закрыто вручную", c: "var(--label-2)" },
  expired: { t: "лимитка снята", c: "var(--label-2)" },
  canceled: { t: "ордер снят биржей", c: "var(--label-2)" },
  venue: { t: "счёт сменил биржу", c: "var(--label-2)" },
  flat: { t: "закрыто вне уровней", c: "var(--label-2)" },
};
/** Незнакомый код — не повод ломать строку: показываем как есть. */
const reasonOf = (code: string) => REASON[code] || { t: code, c: "var(--label-2)" };

export function Trades() {
  const { trades } = useApp();
  const [p, setP] = useState<P>("m");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const from = Date.now() - OPTS.find((o) => o.id === p)!.days * 864e5;
    return trades
      .filter((t) => t.closedAt >= from)
      .filter((t) => !q || t.symbol.toLowerCase().includes(q.toLowerCase()));
  }, [trades, p, q]);

  const k = useMemo(() => {
    const wins = rows.filter((r) => r.pnl > 0), loss = rows.filter((r) => r.pnl < 0);
    const be = rows.filter((r) => r.pnl === 0 || r.reason === "be");
    const gp = wins.reduce((s, r) => s + r.pnl, 0);
    const gl = Math.abs(loss.reduce((s, r) => s + r.pnl, 0));
    let eq = 0, peak = 0, dd = 0;
    [...rows].sort((a, b) => a.closedAt - b.closedAt).forEach((r) => {
      eq += r.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak);
    });
    return {
      net: gp - gl, wr: wins.length + loss.length ? Math.round((wins.length / (wins.length + loss.length)) * 100) : 0,
      pf: gl ? +(gp / gl).toFixed(2) : null, dd: +dd.toFixed(2),
      avgW: wins.length ? gp / wins.length : 0, avgL: loss.length ? gl / loss.length : 0,
      be: be.length, n: rows.length,
    };
  }, [rows]);

  return (
    <div className="pb-2">
      <Title sub="История и аналитика">Сделки</Title>

      <div className="px-4" data-coach="period">
        <Segmented value={p} onChange={setP} options={OPTS.map((o) => ({ id: o.id, label: o.label }))} />
      </div>

      {/* ── Кривая депозита ────────────────────────────────────────────────── */}
      <div className="px-4 mt-3">
        <Glass className="p-4 pb-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] uppercase tracking-wide" style={{ color: "var(--label-2)" }}>
              Кривая депозита
            </span>
            <span className="text-[17px] font-bold" style={{ color: tone(k.net) }}>{money(k.net, true)}</span>
          </div>
          <Equity trades={rows} />
        </Glass>
      </div>

      {/* ── Ключевые метрики ───────────────────────────────────────────────── */}
      <div className="px-4 mt-2.5 grid grid-cols-2 gap-2.5">
        <Metric icon={<Trophy size={15} />} label="Винрейт" value={`${k.wr}%`}
                note={`${k.be} ${plural(k.be, "безубыток", "безубытка", "безубытков")} не в счёте`} />
        <Metric icon={<Percent size={15} />} label="Профит-фактор" value={k.pf === null ? "—" : k.pf.toFixed(2)}
                note={k.pf && k.pf >= 1 ? "прибыль перекрывает убыток" : "убыток перекрывает прибыль"} />
        <Metric icon={<TrendingDown size={15} />} label="Макс. просадка" value={money(k.dd)} tint="var(--red)"
                note="от пика кривой" />
        <Metric icon={<Scale size={15} />} label="Средние" value={`${k.avgW.toFixed(1)} / ${k.avgL.toFixed(1)}`}
                note="прибыль / убыток, $" />
      </div>

      {/* ── История ────────────────────────────────────────────────────────── */}
      <GroupLabel>История · {rows.length} {plural(rows.length, "сделка", "сделки", "сделок")}</GroupLabel>
      <div className="px-4 mb-2.5">
        <div className="glass glass-flat flex items-center gap-2 px-3.5 py-2.5">
          <Search size={17} style={{ color: "var(--label-2)" }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по тикеру"
                 className="bg-transparent outline-none flex-1 text-[16px]"
                 style={{ color: "var(--label)" }} />
        </div>
      </div>

      <div className="px-4 space-y-2">
        {rows.map((t) => (
          <TradeRow key={t.id} t={t} open={openId === t.id}
                    onToggle={() => setOpenId(openId === t.id ? null : t.id)} />
        ))}
        {!rows.length && (
          <Glass className="p-7 text-center text-[15px]" style={{ color: "var(--label-2)" }}>
            За период сделок нет
          </Glass>
        )}
      </div>
    </div>
  );
}

function Metric({ icon, label, value, note, tint }: {
  icon: React.ReactNode; label: string; value: string; note?: string; tint?: string;
}) {
  return (
    <Glass flat className="p-3.5">
      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--label-2)" }}>
        {icon}{label}
      </div>
      <div className="text-[22px] font-bold mt-1 tracking-tight" style={{ color: tint || "var(--label)" }}>{value}</div>
      {note && <div className="text-[11px] mt-0.5 leading-snug" style={{ color: "var(--label-3)" }}>{note}</div>}
    </Glass>
  );
}

function TradeRow({ t, open, onToggle }: { t: Trade; open: boolean; onToggle: () => void }) {
  const r = reasonOf(t.reason);
  return (
    <Glass flat className="overflow-hidden">
      <Press onClick={onToggle} className="block w-full" scale={0.985}>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[16px] font-semibold tracking-tight truncate">
                {t.symbol.replace("USDT", "")}
              </span>
              <span className="text-[11px] px-1.5 py-0.5 rounded-md font-semibold shrink-0"
                    style={{ background: "var(--label-3)", color: "var(--label-2)" }}>
                {t.side === "long" ? "LONG" : "SHORT"}
              </span>
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: r.c }}>{r.t} · {dt(t.closedAt)}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[16px] font-bold" style={{ color: tone(t.pnl) }}>{money(t.pnl, true)}</div>
            <div className="text-[12px]" style={{ color: tone(t.r) }}>{rr(t.r)}</div>
          </div>
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronDown size={17} style={{ color: "var(--label-2)" }} />
          </motion.span>
        </div>
      </Press>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}>
            <div className="px-4 pb-3 pt-1 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] hairline-t">
              <D k="Вход" v={price(t.entry)} />
              <D k="Выход" v={price(t.exit)} />
              <D k="Комиссия биржи" v={`уплачено $${t.fee.toFixed(2)}`} />
              <D k="В рынке" v={hold(t.heldMin)} />
              <D k="Был в плюсе" v={rr(t.mfe)} c={tone(1)} />
              <D k="Был в минусе" v={rr(t.mae)} c={tone(-1)} />
              <D k="Схема выхода" v={t.scheme} wide />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Glass>
  );
}

const hold = (m: number) =>
  m < 60 ? `${m} мин` : m < 1440 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} д`;

function D({ k, v, c, wide }: { k: string; v: string; c?: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <span style={{ color: "var(--label-2)" }}>{k}: </span>
      <span style={{ color: c || "var(--label)" }}>{v}</span>
    </div>
  );
}

/** Кривая депозита на чистом SVG с градиентной заливкой.
 *  Строится из ЗАКРЫТЫХ сделок нарастающим итогом — то же правило, что в
 *  отчётах бота: у открытой позиции результата ещё нет. */
function Equity({ trades }: { trades: Trade[] }) {
  const d = useMemo(() => {
    const rows = [...trades].sort((a, b) => a.closedAt - b.closedAt);
    if (rows.length < 2) return M.equity;
    let v = M.START_DEPOSIT;
    return [{ t: rows[0].closedAt, v }, ...rows.map((r) => ({ t: r.closedAt, v: +(v += r.pnl).toFixed(2) }))];
  }, [trades]);
  const w = 320, h = 108, pad = 4;
  const xs = d.map((_, i) => pad + (i * (w - pad * 2)) / (d.length - 1));
  const lo = Math.min(...d.map((p) => p.v)), hi = Math.max(...d.map((p) => p.v));
  const ys = d.map((p) => h - pad - ((p.v - lo) / (hi - lo || 1)) * (h - pad * 2));
  const line = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area = `${line} L${xs[xs.length - 1]},${h} L${xs[0]},${h} Z`;
  const up = d[d.length - 1].v >= d[0].v;
  const c = up ? "var(--green)" : "var(--red)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full mt-2" style={{ height: 108 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.32" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#eq)" />
      <motion.path d={line} fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                   initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
                   transition={{ duration: 0.9, ease: [0.32, 0.72, 0, 1] }} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3.5" fill={c} />
    </svg>
  );
}
