import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, Inbox, Layers, Maximize2, OctagonX, SlidersHorizontal,
         TrendingDown, TrendingUp, X } from "lucide-react";
import { Glass, Modal, Press, Sheet, Title, cssVar, portal, tone, SPRING, AlgoTag } from "../ui/kit";
import { useApp, posPnl } from "../lib/store";
import type { Position } from "../lib/mock";
import { money, price, pct, rr, ago } from "../lib/format";
import { haptic } from "../lib/tg";
import { useTickers } from "../lib/useMarket";
import { INTERVALS, type Interval } from "../lib/market";
import { TradeChart, type Lens, type Level, type PaneKind } from "../ui/TradeChart";
import { AddPaneStrip, LensButton, PaneSheet, readLens, readPanes, saveLens, savePanes }
  from "./ChartTools";
import { useSwipe } from "../lib/swipe";

export function Market() {
  const { positions, feed } = useApp();
  const [open, setOpen] = useState<Position | null>(null);
  const live = positions.find((p) => p.id === open?.id) || null;

  return (
    <div className="pb-2">
      <Title sub={feed === "live" ? "Цены Bybit · в реальном времени"
                : feed === "connecting" ? "подключаемся к бирже…"
                : "нет связи с биржей — цены могли устареть"}>Позиции</Title>

      {!positions.length && (
        <div className="px-4">
          <Glass className="p-8 text-center">
            <Inbox size={34} className="mx-auto mb-3" style={{ color: "var(--label-3)" }} />
            <div className="text-[17px] font-semibold">Открытых позиций нет</div>
            <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
              Бот ждёт сигнал от скринера. Как только он придёт — позиция появится здесь.
            </p>
          </Glass>
        </div>
      )}

      <div className="px-4 space-y-2.5" data-coach="positions">
        {positions.map((p) => <PositionCard key={p.id} p={p} onOpen={() => setOpen(p)} />)}
      </div>

      <AnimatePresence>
        {live && <Detail p={live} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </div>
  );
}

function PositionCard({ p, onOpen }: { p: Position; onOpen: () => void }) {
  const { usd, r, pct: ppct, pending } = posPnl(p);
  const up = p.side === "long";
  // У лимитки прогресс «от входа к цели» тоже бессмыслен: входа ещё не было.
  const progress = pending ? 0
    : Math.max(0, Math.min(1, Math.abs(p.mark - p.entry) / Math.abs(p.tp - p.entry)));
  return (
    <Press onClick={onOpen} className="block w-full" scale={0.975} feel="press">
      <Glass className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center justify-center w-7 h-7 rounded-full shrink-0"
                  style={{ background: `color-mix(in srgb, ${up ? "var(--green)" : "var(--red)"} 18%, transparent)` }}>
              {up ? <TrendingUp size={15} style={{ color: "var(--green)" }} />
                  : <TrendingDown size={15} style={{ color: "var(--red)" }} />}
            </span>
            <span className="text-[17px] font-semibold tracking-tight truncate">
              {p.symbol.replace("USDT", "")}
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[11px] font-semibold shrink-0"
                  style={{ background: "var(--label-3)", color: "var(--label-2)" }}>
              {up ? "LONG" : "SHORT"} {p.lev}×
            </span>
            <AlgoTag source={p.source} />
            {/* Лимитка ещё не налилась — позиции физически нет, и называть её
                позицией нельзя: PnL по ней не существует. */}
            {p.status === "pending" && (
              <span className="px-1.5 py-0.5 rounded-md text-[11px] font-semibold shrink-0"
                    style={{ background: "color-mix(in srgb, var(--orange) 20%, transparent)",
                             color: "var(--orange)" }}>лимитка</span>
            )}
          </div>
          {pending ? (
            /* Ордер, а не позиция: показывать по нему результат не из чего. */
            <div className="text-right shrink-0">
              <div className="text-[13px] font-semibold" style={{ color: "var(--orange)" }}>
                ждём налива
              </div>
              <div className="text-[11px]" style={{ color: "var(--label-2)" }}>позиции ещё нет</div>
            </div>
          ) : (
            <motion.div key={Math.round(usd * 100)} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }}
                        className="text-right shrink-0">
              <div className="text-[17px] font-bold" style={{ color: tone(usd) }}>{money(usd, true)}</div>
              <div className="text-[12px]" style={{ color: tone(usd) }}>{rr(r)} · {pct(ppct)}</div>
            </motion.div>
          )}
        </div>

        {/* Полоса «где цена между входом и целью» — быстрее любых цифр. */}
        <div className="mt-3 h-[5px] rounded-full overflow-hidden" style={{ background: "var(--label-3)" }}>
          <motion.div animate={{ width: `${progress * 100}%` }} transition={SPRING}
                      className="h-full rounded-full"
                      style={{ background: usd >= 0 ? "var(--green)" : "var(--red)" }} />
        </div>

        <div className="flex items-center justify-between mt-2.5 text-[12px]" style={{ color: "var(--label-2)" }}>
          <span>{pending ? "лимитка" : "вход"} {price(p.entry)}</span>
          <span>сейчас <b style={{ color: "var(--label)" }}>{price(p.mark)}</b></span>
          <span>цель {price(p.tp)}</span>
        </div>
      </Glass>
    </Press>
  );
}

/* ── Детальный экран тикера ─────────────────────────────────────────────────── */
function Detail({ p, onClose }: { p: Position; onClose: () => void }) {
  const { closePosition, updateLevels, moveEntry } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [edit, setEdit] = useState(false);
  const [tp, setTp] = useState(p.tp);
  const [sl, setSl] = useState(p.sl);
  const [tf, setTf] = useState<Interval>("15");
  const [fullChart, setFullChart] = useState(false);
  const tk = useTickers([p.symbol])[p.symbol];
  const { usd, r, pending } = posPnl(p);
  const [lens, setLensRaw] = useState(readLens());
  const [panes, setPanesRaw] = useState(readPanes());
  const setLens = (l: typeof lens) => { setLensRaw(l); saveLens(l); };
  const setPanes = (v: typeof panes) => { setPanesRaw(v); savePanes(v); };
  /* Перетащенный уровень СНАЧАЛА спрашивает. За этими линиями стоят настоящие
     заявки на бирже, и жест пальцем не имеет права отправлять ордер молча. */
  const [ask, setAsk] = useState<{ kind: Level["kind"]; price: number } | null>(null);
  /* Перенесённый уровень показываем СРАЗУ, не дожидаясь сервера.
     Между подтверждением и ответом лежат запрос к боту, его поход на биржу и
     следующий опрос — до нескольких секунд. Всё это время линия стояла на
     СТАРОМ месте, и перенос выглядел как несработавший: человек тянул её
     снова и снова. Показываем заявленное, а когда сервер догонит — снимаем
     накладку. Не догонит (биржа отказала) — линия возвращается сама. */
  const [moved, setMoved] = useState<Partial<Record<Level["kind"], number>>>({});
  const levels = useLevels(p, pending, moved);

  /* Накладку снимаем, как только сервер показал ровно то, что мы просили:
     держать её дольше значит скрывать расхождение с биржей. */
  useEffect(() => {
    const at = (k: Level["kind"]) => k === "entry" ? p.entry : k === "sl" ? p.sl : p.tp;
    setMoved((m) => {
      const next = { ...m };
      let hit = false;
      (Object.keys(next) as Level["kind"][]).forEach((k) => {
        const want = next[k];
        if (want && Math.abs(at(k) - want) <= want * 0.0002) { delete next[k]; hit = true; }
      });
      return hit ? next : m;
    });
  }, [p.entry, p.tp, p.sl]);
  const back = useSwipe({ onRight: onClose });

  return (
    <motion.div {...back}
      initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="fixed inset-0 z-50 scroll"
      style={{ background: "var(--bg)", paddingTop: "var(--safe-t)" }}>
      <div className="mesh" />
      <div className="relative z-10 pb-24">
        <div className="sticky top-0 z-20 chrome hairline px-2 py-2 flex items-center gap-1">
          <Press onClick={onClose} className="px-1.5 py-1.5 rounded-full">
            <span className="flex items-center gap-0.5 text-[17px]" style={{ color: "var(--tint)" }}>
              <ChevronLeft size={22} /> Назад
            </span>
          </Press>
          <span className="ml-auto mr-1 text-[16px] font-semibold">{p.symbol}</span>
          <AlgoTag source={p.source} className="mr-1" />
          {tk && (
            <span className="mr-2 text-[13px] font-semibold"
                  style={{ color: tk.pct24h >= 0 ? "var(--green)" : "var(--red)" }}>
              {pct(tk.pct24h)}
            </span>
          )}
        </div>

        <div className="px-4 pt-4">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[13px] uppercase tracking-wide" style={{ color: "var(--label-2)" }}>
                {p.side === "long" ? "Лонг" : "Шорт"} · {p.lev}× ·{" "}
                {pending ? `выставлена ${ago(p.openedAt)}` : `открыта ${ago(p.openedAt)}`}
              </div>
              {pending ? (
                <>
                  <div className="num-hero mt-1" style={{ color: "var(--orange)" }}>—</div>
                  <div className="text-[15px] mt-0.5" style={{ color: "var(--label-2)" }}>
                    лимитка выставлена, позиции ещё нет
                  </div>
                </>
              ) : (
                <>
                  <div className="num-hero mt-1" style={{ color: tone(usd) }}>{money(usd, true)}</div>
                  <div className="text-[15px] mt-0.5" style={{ color: tone(usd) }}>{rr(r)}</div>
                </>
              )}
            </div>
            {/* Цена и сутки — прямо с биржи: PnL считается от них, и человек
                должен видеть тот же источник, а не «примерно такое» число. */}
            <div className="text-right">
              <div className="text-[19px] font-bold tabular-nums">{price(p.mark)}</div>
              {tk && (
                <div className="text-[12px] mt-0.5" style={{ color: "var(--label-2)" }}>
                  сутки {price(tk.low24h)} — {price(tk.high24h)}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 mt-4">
          <Glass className="p-3 overflow-hidden">
            <div className="flex gap-1 mb-2">
              {INTERVALS.map((i) => (
                <Press key={i.id} onClick={() => { haptic.select(); setTf(i.id); }}
                       className="flex-1" scale={0.94}>
                  <div className="py-1.5 rounded-[10px] text-center text-[13px] font-medium"
                       style={tf === i.id
                         ? { background: "var(--tint-grad)", color: "#fff" }
                         : { color: "var(--label-2)" }}>{i.label}</div>
                </Press>
              ))}
            </div>
            {/* data-noswipe: горизонтальный жест здесь принадлежит графику —
                он тянет время. Без метки свайп по графику листал бы вкладки. */}
            <div className="relative" data-noswipe>
              <TradeChart symbol={p.symbol} interval={tf} levels={levels} lens={lens}
                          panes={panes}
                          pnl={pending ? null : { usd, r }}
                          onLevel={(kind, value) => setAsk({ kind, price: value })} />
              {/* Кнопки СЛЕВА: справа у графика ось цены и ручки уровней —
                  там они спорили бы за одно и то же место. */}
              <div className="absolute left-1 top-1 z-20 flex flex-col gap-1.5">
                <Press onClick={() => { haptic.tap(); setFullChart(true); }} scale={0.9}>
                  <span className="flex items-center justify-center w-8 h-8 rounded-[10px] chrome">
                    <Maximize2 size={15} style={{ color: "var(--label-2)" }} />
                  </span>
                </Press>
                <LensButton lens={lens} onLens={setLens} />
              </div>
            </div>
            <AddPaneStrip panes={panes} onPanes={setPanes} />
            {/* Цвета подписи обязаны совпадать с цветами линий на графике —
                иначе легенда объясняет не тот график, который нарисован. */}
            <div className="flex items-center justify-center flex-wrap gap-x-3.5 gap-y-1 mt-2 text-[11px]"
                 style={{ color: "var(--label-2)" }}>
              <Legend color="var(--label-2)" text={`вход ${price(p.entry)}`} />
              <Legend color="var(--green)" text={`цель ${price(p.tp)}`} />
              <Legend color="var(--red)" text={`стоп ${price(p.sl)}`} />
              {p.be && <Legend color="var(--orange)" text={`БУ ${price(p.be)}`} />}
            </div>
            {levels.some((l) => l.drag) && (
              <div className="text-center text-[10px] mt-1" style={{ color: "var(--label-3)" }}>
                коснитесь линии уровня — появится ручка, и линию можно тянуть
              </div>
            )}
          </Glass>
        </div>

        <div className="px-4 mt-3">
          <Glass flat className="overflow-hidden">
            {/* В ДОЛЛАРАХ: «300 монет» не отвечает на вопрос, с которым сюда
                смотрят, — сколько денег в позиции. Монеты остаются подписью:
                без них не сверить размер с биржей. */}
            <KV k="Размер позиции"
                v={`${money(p.notional ?? p.size * p.mark)} · ${p.size.toLocaleString("ru-RU")} монет`} />
            {/* Маржа — то, что реально заморожено на счёте. Расчётную помечаем
                «≈»: у биржи в начальную маржу входит комиссия закрытия, и наша
                оценка её занижает — выдавать оценку за факт нельзя. */}
            <KV k="Заморожено маржи"
                v={p.margin
                  ? `${p.marginFrom === "расчёт" ? "≈ " : ""}${money(p.margin)}`
                  : "—"} />
            <KV k="Риск на сделку" v={`$${p.risk.toFixed(2)}`} />
            <KV k="Схема выхода" v={p.scheme} />
            <KV k="Безубыток" v={p.be ? `при ${price(p.be)}` : "не переносим"} last />
          </Glass>
        </div>

        <div className="px-4 mt-3 grid grid-cols-2 gap-2.5">
          <Press onClick={() => { setTp(p.tp); setSl(p.sl); setEdit(true); }}
                 disabled={pending} className="block">
            <Glass flat className="py-3.5 flex items-center justify-center gap-2 text-[15px] font-medium">
              <SlidersHorizontal size={17} /> Уровни
            </Glass>
          </Press>
          <Press onClick={() => setConfirm(true)} feel="heavy" className="block">
            <div className="py-3.5 rounded-[16px] flex items-center justify-center gap-2 text-[15px] font-semibold text-white"
                 style={{ background: "var(--red)" }}>
              <OctagonX size={17} /> {pending ? "Снять лимитку" : "Закрыть"}
            </div>
          </Press>
        </div>
      </div>

      <AnimatePresence>
        {fullChart && (
          <FullChart p={p} interval={tf} onInterval={setTf} onClose={() => setFullChart(false)}
                     levels={levels} lens={lens} onLens={setLens}
                     panes={panes} onPanes={setPanes}
                     pnl={pending ? null : { usd, r }}
                     onLevel={(kind, value) => setAsk({ kind, price: value })} />
        )}
      </AnimatePresence>

      <Sheet open={edit} onClose={() => setEdit(false)} title="Уровни позиции">
        <div className="pb-3 space-y-4">
          <NumField label="Тейк-профит" value={tp} onChange={setTp} step={p.entry * 0.002} tint="var(--green)" />
          <NumField label="Стоп-лосс" value={sl} onChange={setSl} step={p.entry * 0.002} tint="var(--red)" />
          <p className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
            Новые уровни уедут на биржу сразу. Перенос стопа в безубыток после этого
            выполняться не будет — вы взяли управление на себя.
          </p>
          <Press feel="press" className="block w-full"
                 onClick={() => { updateLevels(p.id, tp, sl); haptic.ok(); setEdit(false); }}>
            <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint-grad)" }}>Сохранить</div>
          </Press>
        </div>
      </Sheet>

      {/* Подтверждение переноса уровня. Текст РАЗНЫЙ по смыслу действия: у
          лимитки пересчитается размер, у цели снимутся ступени лесенки. Одна
          формулировка на все три случая умалчивала бы о главном. */}
      <Modal open={!!ask} onClose={() => setAsk(null)}>
        {ask && (
          <div className="text-center">
            <h3 className="text-[19px] font-bold">
              {ask.kind === "entry" ? "Перенести вход" : ask.kind === "sl" ? "Перенести стоп" : "Перенести цель"}
              {" на "}{price(ask.price)}?
            </h3>
            <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
              {ask.kind === "entry"
                ? `Лимитка на бирже изменится, а размер пересчитается под прежний риск $${p.risk.toFixed(2)}: расстояние до стопа стало другим.`
                : ask.kind === "tp"
                ? "Цель уедет на биржу сразу. Ступени лесенки снимутся — они раскладывались по прежней цели."
                : "Стоп уедет на биржу сразу. Перенос в безубыток после этого выполняться не будет — вы взяли управление на себя."}
            </p>
            <div className="flex gap-2.5 mt-5">
              <Press onClick={() => setAsk(null)} className="flex-1">
                <div className="glass glass-flat py-3 text-center text-[16px] font-medium">Отмена</div>
              </Press>
              <Press feel="heavy" className="flex-1"
                     onClick={() => {
                       const { kind, price: want } = ask;
                       setMoved((m) => ({ ...m, [kind]: want }));
                       const run = kind === "entry" ? moveEntry(p.id, want)
                                 : kind === "tp" ? updateLevels(p.id, want, 0)
                                 : updateLevels(p.id, 0, want);
                       // Отказ биржи не имеет права остаться нарисованным: линия
                       // вернётся туда, где заявка стоит на самом деле.
                       void run.then((ok) => {
                         if (!ok) setMoved((m) => { const n = { ...m }; delete n[kind]; return n; });
                       });
                       haptic.ok(); setAsk(null);
                     }}>
                <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                     style={{ background: "var(--tint-grad)" }}>Перенести</div>
              </Press>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={confirm} onClose={() => setConfirm(false)}>
        <div className="text-center">
          <div className="mx-auto mb-3 flex items-center justify-center w-12 h-12 rounded-full"
               style={{ background: "color-mix(in srgb, var(--red) 18%, transparent)" }}>
            <OctagonX size={24} style={{ color: "var(--red)" }} />
          </div>
          <h3 className="text-[19px] font-bold">
            {pending ? "Снять лимитку" : "Закрыть"} {p.symbol.replace("USDT", "")}?
          </h3>
          <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
            {pending
              ? "Ордер будет снят с биржи. Позиции по этой монете нет, терять нечего."
              : `Позиция закроется по рыночной цене. Результат ${money(usd, true)} зафиксируется.`}
          </p>
          <div className="flex gap-2.5 mt-5">
            <Press onClick={() => setConfirm(false)} className="flex-1">
              <div className="glass glass-flat py-3 text-center text-[16px] font-medium">Отмена</div>
            </Press>
            <Press feel="heavy" className="flex-1"
                   onClick={() => { closePosition(p.id); haptic.ok(); setConfirm(false); onClose(); }}>
              <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--red)" }}>Закрыть</div>
            </Press>
          </div>
        </div>
      </Modal>
    </motion.div>
  );
}

/**
 * Уровни сделки для графика.
 *
 * Перетаскивать можно ровно то, за чем стоит ЖИВАЯ заявка: у неисполненной
 * лимитки — вход (сама заявка), у открытой позиции — стоп и первую цель.
 * Вход открытой позиции двигать нечего: он уже случился. Ступени 2 и 3
 * лесенки ручек не получают: переставить одну ступень значит пересобрать всю
 * лесенку, а это другая операция, и делается она схемой выхода.
 */
function useLevels(p: Position, pending: boolean,
                   moved: Partial<Record<Level["kind"], number>> = {}): Level[] {
  const key = JSON.stringify(moved);
  return useMemo(() => {
    const g = cssVar("--green", "#30d158"), r = cssVar("--red", "#ff453a");
    const gray = cssVar("--label-2", "#8e8e93"), o = cssVar("--orange", "#ff9f0a");
    const at = (kind: Level["kind"], v: number) => moved[kind] ?? v;
    const legs = p.tps?.length ? p.tps : [{ price: p.tp, weight: 1 }];
    const out: Level[] = [
      { kind: "entry", price: at("entry", p.entry), title: pending ? "лимитка" : "вход",
        color: gray, drag: pending },
    ];
    legs.filter((l) => l.price > 0).forEach((l, i) => out.push({
      kind: i === 0 ? "tp" : "leg", price: i === 0 ? at("tp", l.price) : l.price,
      title: legs.length > 1 ? `TP${i + 1} ${Math.round(l.weight * 100)}%` : "TP",
      color: g, drag: i === 0 && !pending,
    }));
    out.push({ kind: "sl", price: at("sl", p.sl), title: "SL", color: r, drag: !pending });
    if (p.be) out.push({ kind: "be", price: p.be, title: "БУ", color: o });
    return out;
  }, [p.entry, p.tp, p.sl, p.be, JSON.stringify(p.tps), pending, key]);
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-3 h-[2px] rounded-full" style={{ background: color }} />{text}
    </span>
  );
}

function KV({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-4 py-2.5 ${last ? "" : "hairline"}`}>
      <span className="text-[15px]" style={{ color: "var(--label-2)" }}>{k}</span>
      <span className="text-[15px] font-medium">{v}</span>
    </div>
  );
}

function NumField({ label, value, onChange, step, tint }: {
  label: string; value: number; onChange: (v: number) => void; step: number; tint: string;
}) {
  return (
    <div>
      <div className="text-[13px] mb-1.5" style={{ color: "var(--label-2)" }}>{label}</div>
      <div className="glass glass-flat flex items-center">
        <Press onClick={() => onChange(+(value - step).toFixed(10))} className="px-4 py-3 text-[20px] font-medium">−</Press>
        <div className="flex-1 text-center text-[19px] font-semibold" style={{ color: tint }}>{price(value)}</div>
        <Press onClick={() => onChange(+(value + step).toFixed(10))} className="px-4 py-3 text-[20px] font-medium">+</Press>
      </div>
    </div>
  );
}

/* ── График на весь экран ────────────────────────────────────────────────────
   Отдельный слой поверх всего, в портрете (альбомная ориентация в приложении не
   поддерживается). Здесь у графика полная навигация TradingView, а экрана под
   ним нет — значит ни один жест ни с чем не спорит.

   Панели индикаторов живут ИМЕННО ЗДЕСЬ, в полный рост: экран делится на цену
   сверху и узкие полосы под ней, все на одной оси времени. Смена таймфрейма
   меняет и панели — иначе столбики стояли бы не под своими свечами. */
function FullChart({ p, interval, onInterval, onClose, levels, lens, onLens,
                     panes, onPanes, pnl, onLevel }: {
  p: Position; interval: Interval; onInterval: (i: Interval) => void; onClose: () => void;
  levels: Level[]; lens: Lens; onLens: (l: Lens) => void;
  panes: PaneKind[]; onPanes: (v: PaneKind[]) => void;
  pnl: { usd: number; r: number } | null;
  onLevel: (kind: Level["kind"], price: number) => void;
}) {
  const tk = useTickers([p.symbol])[p.symbol];
  const [tools, setTools] = useState(false);
  /* ВЫНОСИМ В КОРЕНЬ. Карточка позиции живёт внутри <main>, у которого свой
     слой (z-10), и любой z-index внутри него этот потолок не пробивает: панель
     вкладок — сосед main, и она ложилась поверх «полноэкранного» графика,
     срезая ось времени. Полный экран обязан быть полным. */
  return portal(
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
      className="fixed inset-0 z-[80] flex flex-col"
      style={{ background: "var(--bg)", paddingTop: "var(--safe-t)", paddingBottom: "var(--safe-b)" }}>

      {/* Заголовок: слева — что за монета, справа — органы управления.
          Левая часть ОБЯЗАНА сжиматься (min-w-0 + truncate), а правая — нет.
          Без этого длинный тикер вместе с ценой и процентом раздували строку
          шире экрана, и кнопка закрытия уезжала за правый край: график
          открывался, а выйти из него было нечем. */}
      <div className="flex items-center gap-2 px-3 py-2 hairline">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[16px] font-semibold truncate">{p.symbol}</span>
          <AlgoTag source={p.source} />
          <span className="text-[15px] tabular-nums shrink-0" style={{ color: "var(--label)" }}>{price(p.mark)}</span>
          {tk && (
            <span className="text-[13px] font-semibold shrink-0"
                  style={{ color: tk.pct24h >= 0 ? "var(--green)" : "var(--red)" }}>{pct(tk.pct24h)}</span>
          )}
        </div>
        <span className="shrink-0 flex items-center gap-1.5">
          <LensButton lens={lens} onLens={onLens} />
          <Press onClick={() => { haptic.tap(); setTools(true); }} scale={0.9}>
            <span className="flex items-center justify-center w-9 h-9 rounded-full glass glass-flat">
              <Layers size={16} style={{ color: panes.length ? "var(--lime)" : "var(--label-2)" }} />
            </span>
          </Press>
          <Press onClick={() => { haptic.tap(); onClose(); }} scale={0.9}>
            <span className="flex items-center justify-center w-9 h-9 rounded-full glass glass-flat">
              <X size={18} />
            </span>
          </Press>
        </span>
      </div>

      <div className="flex gap-1 px-3 py-2">
        {INTERVALS.map((i) => (
          <Press key={i.id} onClick={() => { haptic.select(); onInterval(i.id); }} className="flex-1" scale={0.94}>
            <div className="py-1.5 rounded-[10px] text-center text-[13px] font-medium"
                 style={interval === i.id ? { background: "var(--tint-grad)", color: "#fff" } : { color: "var(--label-2)" }}>
              {i.label}
            </div>
          </Press>
        ))}
      </div>

      <div className="flex-1 min-h-0 px-1" data-noswipe>
        <TradeChart symbol={p.symbol} interval={interval} full levels={levels} lens={lens}
                    panes={panes} pnl={pnl} onLevel={onLevel} />
      </div>

      <div className="px-3 pt-1.5 pb-1 flex items-center justify-center flex-wrap gap-x-3.5 gap-y-1 text-[11px]"
           style={{ color: "var(--label-2)" }}>
        <Legend color="var(--label-2)" text={`вход ${price(p.entry)}`} />
        <Legend color="var(--green)" text={`цель ${price(p.tp)}`} />
        <Legend color="var(--red)" text={`стоп ${price(p.sl)}`} />
        {p.be && <Legend color="var(--orange)" text={`БУ ${price(p.be)}`} />}
      </div>
      {/* Жесты осей неочевидны — один раз сказать про них дешевле, чем надеяться,
          что их найдут наугад. */}
      <div className="px-3 pb-1 text-center text-[10px]" style={{ color: "var(--label-3)" }}>
        щипок — масштаб · тяните ось времени, чтобы сжать свечи · ось цены — растянуть · двойное касание оси — сброс
      </div>

      <PaneSheet open={tools} onClose={() => setTools(false)} panes={panes} onPanes={onPanes} />
    </motion.div>,
  );
}
