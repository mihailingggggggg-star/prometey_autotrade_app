import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Search } from "lucide-react";
import { Glass, GroupLabel, Press, Segmented, Title, tone } from "../ui/kit";
import { Dash } from "./Dash";
import { useApp } from "../lib/store";
import type { Trade } from "../lib/mock";
import { money, rr, dt, price, plural } from "../lib/format";
import { TradeChart, type Mark } from "../ui/TradeChart";
import { fetchRange, INTERVALS, type Candle, type Interval } from "../lib/market";
import { stepOf } from "../lib/flow";
import { cssVar } from "../ui/kit";

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

  return (
    <div className="pb-2">
      <Title sub="История и аналитика">Сделки</Title>

      <div className="px-4" data-coach="period">
        <Segmented value={p} onChange={setP} options={OPTS.map((o) => ({ id: o.id, label: o.label }))} />
      </div>

      {/* ── Дашборды ───────────────────────────────────────────────────────
          Карточка отвечает на один вопрос одним числом, по тапу открывается
          тот же график в полный рост — с наведением и объяснением, что это
          число значит. Без объяснения «профит-фактор 1.4» остаётся цифрой. */}
      <div className="mt-3">
        <Dash trades={rows} />
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
            {/* График сделки — по тапу, а не сразу: рисовать его всем строкам
                списка значило бы тянуть свечи по каждой сделке за месяц. */}
            <div className="px-3 pb-3" data-noswipe>
              <ClosedChart t={t} />
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

/* ── График закрытой сделки ──────────────────────────────────────────────────
   Вход и выход — треугольниками по направлению сделки, между ними линейка с
   расстоянием в процентах: так это читается у Tiger Trade, и читается верно —
   первым делом видно, куда сделка пошла и насколько.

   Окно: от входа до ЗАКРЫТИЯ ПЛЮС ВОСЕМЬ ЧАСОВ (решение владельца). Дальше
   свечи ничего не добавляют к разбору сделки, а тянуть их — лишние запросы на
   каждую строку истории. */
const AFTER_MS = 8 * 3600e3;

/** Шаг свечей под длину окна: цель — около сотни бар. На пяти минутах
 *  двухдневная сделка дала бы 600 свечей волосками, на четырёх часах
 *  пятнадцатиминутная — три свечи. */
function intervalFor(ms: number): Interval {
  const want = ms / 110 / 1000;
  const ids = INTERVALS.map((i) => i.id);
  return (ids.find((id) => stepOf(id) >= want) || ids[ids.length - 1]) as Interval;
}

function ClosedChart({ t }: { t: Trade }) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [fail, setFail] = useState("");
  const openAt = t.closedAt - t.heldMin * 60000;
  const to = Math.min(t.closedAt + AFTER_MS, Date.now());
  const from = openAt - (to - openAt) * 0.15;
  const iv = intervalFor(to - from);

  useEffect(() => {
    let alive = true;
    setCandles(null); setFail("");
    fetchRange(t.symbol, iv, from, to)
      .then((c) => { if (alive) c.length ? setCandles(c) : setFail("свечей за это время у биржи нет"); })
      .catch(() => alive && setFail("биржа не ответила"));
    return () => { alive = false; };
  }, [t.id]);

  const marks = useMemo<Mark[]>(() => {
    const st = stepOf(iv);
    const snap = (ms: number) => Math.floor(ms / 1000 / st) * st;
    return [
      { time: snap(openAt), price: t.entry, kind: "in", side: t.side, text: "вход" },
      { time: snap(t.closedAt), price: t.exit, kind: "out", side: t.side, text: "выход" },
    ];
  }, [t.id, iv]);

  if (fail) {
    return (
      <div className="h-[60px] flex items-center justify-center text-[12px]"
           style={{ color: "var(--label-3)" }}>{fail}</div>
    );
  }
  if (!candles) {
    return (
      <div className="h-[60px] flex items-center justify-center text-[12px]"
           style={{ color: "var(--label-2)" }}>Загружаем свечи сделки…</div>
    );
  }
  return (
    <>
      <TradeChart symbol={t.symbol} interval={iv} candles={candles} marks={marks} height={200}
                  levels={[
                    { kind: "entry", price: t.entry, title: "вход", color: cssVar("--label-2", "#8e8e93") },
                    { kind: "sl", price: t.exit, title: "выход",
                      color: cssVar(t.pnl >= 0 ? "--green" : "--red", "#30d158") },
                  ]} />
      <div className="text-center text-[10px] mt-1" style={{ color: "var(--label-3)" }}>
        {INTERVALS.find((i) => i.id === iv)?.label} · окно сделки и 8 часов после закрытия
      </div>
    </>
  );
}
