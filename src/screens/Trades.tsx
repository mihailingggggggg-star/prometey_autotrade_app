import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Maximize2, Search, Share2, X } from "lucide-react";
import { Glass, GroupLabel, Press, Segmented, Title, tone } from "../ui/kit";
import { Dash } from "./Dash";
import { useApp } from "../lib/store";
import type { Trade } from "../lib/mock";
import { money, rr, dt, price, plural } from "../lib/format";
import { TradeChart, type Mark } from "../ui/TradeChart";
import { fetchRange, INTERVALS, type Candle, type Interval } from "../lib/market";
import { stepOf } from "../lib/flow";
import { windowStart } from "../lib/stats";
import { cssVar } from "../ui/kit";
import { haptic } from "../lib/tg";
import { getHealth } from "../lib/api";
import { drawShareCard, shareCardBlob, type ShareTrade } from "../ui/ShareCard";

/** Вынести разметку из-под стекла (см. ClosedChart). */
const portal = (node: ReactNode) => {
  const host = typeof document === "undefined" ? null : document.getElementById("root");
  return host ? createPortal(node, host) : node;
};

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
    /* Границы периода — по КАЛЕНДАРНЫМ суткам Бишкека (см. lib/stats): было
       скользящее окно, и «Сегодня» показывало последние 24 часа, то есть
       половину вчерашнего дня в придачу. */
    const from = windowStart(OPTS.find((o) => o.id === p)!.days);
    return trades
      .filter((t) => t.closedAt >= from)
      .filter((t) => !q || t.symbol.toLowerCase().includes(q.toLowerCase()));
  }, [trades, p, q]);

  return (
    <div className="pb-2">
      <Title sub="История сделок и статистика">Аналитика</Title>

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
  const [full, setFull] = useState(false);
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
    /* Цвет выхода — по результату сделки: это единственное место, где он
       известен. Графику про прибыль ничего не рассказывают, он рисует цену. */
    const out = cssVar(t.pnl >= 0 ? "--green" : "--red", "#30d158");
    return [
      { time: snap(openAt), price: t.entry, kind: "in", side: t.side, text: "вход",
        color: cssVar("--label", "#fff") },
      { time: snap(t.closedAt), price: t.exit, kind: "out", side: t.side, text: "выход",
        color: out },
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
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px]" style={{ color: "var(--label-3)" }}>
          {INTERVALS.find((i) => i.id === iv)?.label} · окно сделки и 8 часов после закрытия
        </span>
        <Press onClick={() => { haptic.tap(); setFull(true); }} scale={0.92}>
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
                style={{ background: "var(--label-3)", color: "var(--label)" }}>
            <Maximize2 size={12} /> Развернуть
          </span>
        </Press>
      </div>
      {/* ПОРТАЛ, а не просто `fixed`. У стеклянной карточки есть
          `backdrop-filter`, а элемент с ним по спецификации становится
          контейнером для всех потомков с `position: fixed` — включая тех, кто
          просит «на весь экран». Полноэкранный график поэтому открывался
          ВНУТРИ строки истории: под шапкой, над панелью вкладок, шириной в
          карточку. Портал выносит его из-под стекла.

          Цель портала — `#root`, а не `body`: на десктопе приложение живёт в
          рамке телефона, и всё, что уехало бы в body, висело бы рядом с ней. */}
      {portal(
        <AnimatePresence>
          {full && <ClosedFull t={t} candles={candles} marks={marks} iv={iv}
                               onClose={() => setFull(false)} />}
        </AnimatePresence>)}
    </>
  );
}

/* ── Закрытая сделка на весь экран ──────────────────────────────────────────
   Тот же график, но с жестами: щипок, протяжка осей, прокрутка истории. В
   строке списка они не нужны и мешали бы прокрутке самого списка, а здесь —
   главное, ради чего разворачивают.

   Здесь же кнопка карточки для соцсетей: делятся результатом ровно в тот
   момент, когда на него смотрят, а не из отдельного меню. */
function ClosedFull({ t, candles, marks, iv, onClose }: {
  t: Trade; candles: Candle[]; marks: Mark[]; iv: Interval; onClose: () => void;
}) {
  const [bot, setBot] = useState("");
  const [card, setCard] = useState(false);
  useEffect(() => { void getHealth().then((h) => setBot(h.bot || "")).catch(() => {}); }, []);

  const move = ((t.exit - t.entry) / t.entry) * 100 * (t.side === "long" ? 1 : -1);
  const share: ShareTrade = {
    symbol: t.symbol, side: t.side, entry: t.entry, exit: t.exit,
    pnlPct: move, r: t.r, closedAt: t.closedAt, heldMin: t.heldMin,
  };

  return (
    <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                className="fixed inset-0 z-[80] flex flex-col"
                style={{ background: "var(--bg)", paddingTop: "var(--safe-t)",
                         paddingBottom: "var(--safe-b)" }}>
      <div className="flex items-center gap-2 px-3 py-2 hairline">
        <span className="text-[16px] font-semibold">{t.symbol.replace("USDT", "")}</span>
        <span className="text-[13px] px-1.5 py-0.5 rounded-md font-semibold"
              style={{ background: "var(--label-3)", color: "var(--label-2)" }}>
          {t.side === "long" ? "LONG" : "SHORT"}
        </span>
        <span className="text-[15px] font-bold" style={{ color: tone(t.pnl) }}>
          {money(t.pnl, true)}
        </span>
        <span className="text-[13px]" style={{ color: tone(t.r) }}>{rr(t.r)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Press onClick={() => { haptic.tap(); setCard(true); }} scale={0.9}>
            <span className="flex items-center justify-center w-9 h-9 rounded-full glass glass-flat">
              <Share2 size={16} />
            </span>
          </Press>
          <Press onClick={() => { haptic.tap(); onClose(); }} scale={0.9}>
            <span className="flex items-center justify-center w-9 h-9 rounded-full glass glass-flat">
              <X size={18} />
            </span>
          </Press>
        </span>
      </div>

      <div className="flex-1 min-h-0 px-1" data-noswipe>
        <TradeChart symbol={t.symbol} interval={iv} candles={candles} marks={marks} full
                    levels={[
                      { kind: "entry", price: t.entry, title: "вход",
                        color: cssVar("--label-2", "#8e8e93") },
                      { kind: "sl", price: t.exit, title: "выход",
                        color: cssVar(t.pnl >= 0 ? "--green" : "--red", "#30d158") },
                    ]} />
      </div>
      <div className="px-3 pb-1 text-center text-[10px]" style={{ color: "var(--label-3)" }}>
        щипок — масштаб · тяните ось времени, чтобы сжать свечи · ось цены — растянуть
      </div>

      <AnimatePresence>
        {card && <CardSheet t={share} candles={candles} bot={bot} onClose={() => setCard(false)} />}
      </AnimatePresence>
    </motion.div>
  );
}

/* ── Карточка для соцсетей ─────────────────────────────────────────────────
   Сначала ПОКАЗЫВАЕМ, что уйдёт в ленту, и только потом отдаём. Картинкой
   делятся публично; отправить её вслепую — значит однажды опубликовать не то,
   что человек имел в виду. */
function CardSheet({ t, candles, bot, onClose }: {
  t: ShareTrade; candles: Candle[]; bot: string; onClose: () => void;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const line = useMemo(() => candles.map((c) => ({ time: c.time * 1000, close: c.close })), [candles]);

  useEffect(() => { if (cv.current) drawShareCard(cv.current, t, line, bot); }, [t.symbol, bot]);

  const send = async () => {
    setBusy(true);
    haptic.tap();
    const blob = await shareCardBlob(t, line, bot);
    setBusy(false);
    if (!blob) return;
    const file = new File([blob], `prometheus-${t.symbol}.png`, { type: "image/png" });
    const text = `${t.symbol.replace("USDT", "")} ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`
               + ` — сделку открыл и закрыл бот PROMETHEUS`;
    /* Системный лист «Поделиться» есть не везде: в старом вебвью и на десктопе
       его нет вовсе. Тогда просто отдаём файл — человек сам решит, куда его
       деть. Молча ничего не делать в этом месте нельзя: кнопка нажата. */
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); haptic.ok(); return; }
      catch { /* закрыли лист — это не ошибка */ return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    haptic.ok();
  };

  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center p-5"
         style={{ background: "rgba(0,0,0,.72)", backdropFilter: "blur(14px)",
                  WebkitBackdropFilter: "blur(14px)" }}>
      <motion.canvas ref={cv}
        initial={{ opacity: 0, scale: 0.94, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className="rounded-[22px] w-full"
        style={{ maxWidth: 320, aspectRatio: "1080 / 1350",
                 boxShadow: "0 30px 80px -20px rgba(255,40,70,.35)" }} />
      <div className="flex gap-2.5 mt-5 w-full" style={{ maxWidth: 320 }}>
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
    </div>
  );
}
