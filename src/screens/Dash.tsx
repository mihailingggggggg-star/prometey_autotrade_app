/**
 * Дашборды по сделкам: карточки, в каждую можно провалиться.
 *
 * Зачем именно так. Аналитика в одном экране превращается либо в стену цифр,
 * либо в один график, из которого ничего не следует. Карточка отвечает на один
 * вопрос одним числом, а по тапу открывается тот же график в полный рост — с
 * наведением, подписью и объяснением, что это число означает. Объяснение
 * обязательно: «профит-фактор 1.4» без него — просто цифра.
 *
 * Все метрики считаются в lib/stats.ts чистыми функциями: их можно проверить
 * по одной сделке на бумаге, и они не зависят ни от экрана, ни от сети.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Activity, BarChart3, Clock, Coins, Flame, Layers, Percent, PieChart,
         Scale, Target, Timer, TrendingUp } from "lucide-react";
import { Glass, Press, Sheet, tone } from "../ui/kit";
import { BarPlot, LinePlot } from "../ui/Plot";
import { byDay, byHour, byReason, bySide, bySymbol, equity, rHist, summary } from "../lib/stats";
import type { Trade } from "../lib/mock";
import { money, plural, rr } from "../lib/format";
import { haptic } from "../lib/tg";

const REASON_RU: Record<string, string> = {
  tp_all: "цели взяты", tp_be: "часть целей → БУ", tp: "цель взята", be: "безубыток",
  sl: "стоп", manual: "вручную", expired: "лимитка снята", canceled: "снят биржей",
  venue: "смена биржи", flat: "вне уровней",
};

const hold = (m: number) =>
  m < 60 ? `${Math.round(m)} мин` : m < 1440 ? `${(m / 60).toFixed(1)} ч` : `${(m / 1440).toFixed(1)} д`;

type Card = {
  id: string; title: string; icon: ReactNode; value: string; tint?: string;
  sub?: string; note: string; wide?: boolean;
  plot: (height: number) => ReactNode;
  extra?: ReactNode;
};

export function Dash({ trades }: { trades: Trade[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const s = useMemo(() => summary(trades), [trades]);
  const days = useMemo(() => byDay(trades), [trades]);
  const eq = useMemo(() => equity(trades), [trades]);

  const cards = useMemo<Card[]>(() => {
    const dayLabel = (ts: number) =>
      new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

    const list: Card[] = [
      {
        id: "eq", wide: true, title: "Кумулятивная прибыль", icon: <TrendingUp size={15} />,
        value: money(s.net, true), tint: tone(s.net),
        sub: `${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(2)}R за ${s.n} ${plural(s.n, "сделку", "сделки", "сделок")}`,
        note: "Каждая точка — закрытая сделка, а не день: просадку внутри дня иначе не увидеть. "
            + "Открытые позиции сюда не входят — у них ещё нет результата, только состояние.",
        plot: (h) => <LinePlot data={eq} height={h} fmt={(v) => money(v, true)} zero
                               xfmt={(x) => dayLabel(x)} />,
      },
      {
        id: "wr", title: "Винрейт по дням", icon: <Target size={15} />,
        value: s.winrate === null ? "—" : `${s.winrate}%`,
        sub: `${s.wins} / ${s.loss} · ${s.be} в безубытке`,
        note: "Безубыток не считается ни победой, ни проигрышем: иначе схема с переносом стопа "
            + "выглядела бы тем хуже, чем лучше она защищает. День без сделок — пустой столбик, "
            + "а не пропуск: это тоже факт.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => `${Math.round(v)}%`}
                   data={days.map((d) => ({
                     label: dayLabel(d.ts),
                     y: d.wins + d.loss ? Math.round((d.wins / (d.wins + d.loss)) * 100) : 0,
                     good: d.wins >= d.loss,
                   }))} />
        ),
      },
      {
        id: "n", title: "Сделок в день", icon: <BarChart3 size={15} />,
        value: String(s.n), sub: days.length ? `в среднем ${(s.n / days.length).toFixed(1)} в день` : "",
        note: "Сколько сделок бот открыл и закрыл. Это про поток сигналов скринера, а не про "
            + "качество: рост числа сделок сам по себе не хорош и не плох.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => `${v} ${plural(v, "сделка", "сделки", "сделок")}`}
                   good="var(--tint)"
                   data={days.map((d) => ({ label: dayLabel(d.ts), y: d.n, good: true }))} />
        ),
      },
      {
        id: "exp", title: "Мат. ожидание", icon: <Scale size={15} />,
        value: s.expR === null ? "—" : `${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}R`,
        tint: tone(s.expR || 0),
        sub: s.expUsd === null ? "" : `${money(s.expUsd, true)} на сделку`,
        note: "Сколько в среднем приносит ОДНА сделка. Это главное число системы: "
            + "положительное ожидание означает, что серию убытков переживёт сам счёт, "
            + "а не надежда. Считается по закрытым сделкам, в R — чтобы не зависеть от размера риска.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`}
                   data={days.map((d) => ({
                     label: dayLabel(d.ts), y: d.n ? +(d.r / d.n).toFixed(2) : 0,
                   }))} />
        ),
      },
      {
        id: "time", title: "Время в рынке", icon: <Timer size={15} />,
        value: hold(s.avgMin), sub: "в среднем на сделку",
        note: "Сколько сделка живёт от входа до закрытия. Полезно сверять со схемой выхода: "
            + "если сделки закрываются за минуты, дальние ступени лесенки не работают в принципе.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => hold(v)} good="var(--orange)"
                   data={days.map((d) => ({
                     label: dayLabel(d.ts), y: d.n ? Math.round(d.minutes / d.n) : 0, good: true,
                   }))} />
        ),
      },
      {
        id: "pnl", title: "Прибыль по дням", icon: <Activity size={15} />,
        value: money(s.net, true), tint: tone(s.net),
        sub: `${days.filter((d) => d.pnl > 0).length} дней в плюс`,
        note: "Тот же результат, но по дням: видно, сколько дней вытягивает счёт и нет ли "
            + "одного дня, на котором держится вся прибыль.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => money(v, true)}
                   data={days.map((d) => ({ label: dayLabel(d.ts), y: +d.pnl.toFixed(2) }))} />
        ),
      },
      {
        id: "pf", title: "Профит-фактор", icon: <Percent size={15} />,
        value: s.pf === null ? "—" : s.pf.toFixed(2),
        tint: s.pf !== null && s.pf >= 1 ? "var(--green)" : "var(--red)",
        sub: `средние ${s.avgWin.toFixed(1)} / ${s.avgLoss.toFixed(1)} $`,
        note: "Во сколько раз прибыль перекрывает убыток. Меньше единицы — система отдаёт "
            + "больше, чем берёт, каким бы ни был винрейт.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => money(v, true)}
                   data={[{ label: "прибыль", y: +(s.avgWin * s.wins).toFixed(2) },
                          { label: "убыток", y: -+(s.avgLoss * s.loss).toFixed(2) }]} />
        ),
      },
      {
        id: "hist", title: "Распределение R", icon: <Layers size={15} />,
        value: `${s.streakWin} / ${s.streakLoss}`,
        sub: "лучшая и худшая серии",
        note: "Сколько сделок попало в каждый диапазон результата. Корзины фиксированные, "
            + "поэтому разные периоды сравнимы между собой. Здесь же серии — сколько раз "
            + "подряд бот выигрывал и проигрывал: именно серию убытков и должен выдержать счёт.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => `${v} ${plural(v, "сделка", "сделки", "сделок")}`}
                   data={rHist(trades).map((b) => ({ label: b.label, y: b.n, good: b.good }))} />
        ),
      },
      {
        id: "capture", title: "Взяли от хода", icon: <Flame size={15} />,
        value: s.capture === null ? "—" : `${Math.round(s.capture * 100)}%`,
        sub: "от лучшего движения",
        note: "Сделка сходила в +3R, а забрали 1R — значит дело не в сигналах, а в том, где "
            + "стоят цели. Считается только по сделкам, которые вообще были в плюсе: "
            + "у не сходившей в прибыль забирать было нечего.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => `${v.toFixed(2)}R`}
                   data={trades.filter((t) => t.mfe > 0.05).slice(-24).map((t) => ({
                     label: t.symbol.replace("USDT", ""),
                     y: +t.r.toFixed(2), good: t.r >= 0,
                   }))} />
        ),
      },
      {
        id: "hour", title: "По часам суток", icon: <Clock size={15} />,
        value: bestHour(trades), sub: "лучший час по деньгам",
        note: "Час ВХОДА, по вашему времени. Сигналы приходят неравномерно, и знать свои часы "
            + "полезнее, чем ещё один средний показатель.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => money(v, true)}
                   data={byHour(trades).map((x) => ({ label: `${x.hour}:00`, y: +x.pnl.toFixed(2) }))} />
        ),
      },
      {
        id: "sym", title: "По монетам", icon: <Coins size={15} />,
        value: String(new Set(trades.map((t) => t.symbol)).size),
        sub: "монет в истории",
        note: "Вклад каждой монеты в результат. Если весь плюс делает одна монета, "
            + "система пока не доказана — доказан один инструмент.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => money(v, true)}
                   data={bySymbol(trades).map((x) => ({ label: x.symbol, y: +x.pnl.toFixed(2) }))} />
        ),
        extra: (
          <Rows rows={bySymbol(trades, 12).map((x) => ({
            k: x.symbol, v: money(x.pnl, true), c: tone(x.pnl),
            note: `${x.n} ${plural(x.n, "сделка", "сделки", "сделок")} · ${rr(x.r)}`,
          }))} />
        ),
      },
      {
        id: "why", title: "Чем заканчивались", icon: <PieChart size={15} />,
        value: String(byReason(trades)[0] ? (REASON_RU[byReason(trades)[0].reason] || byReason(trades)[0].reason) : "—"),
        sub: "чаще всего",
        note: "Для этого бота метрика ключевая: доля стопов против взятых целей говорит о схеме "
            + "выхода больше, чем винрейт. «Часть целей → БУ» — это взятые ступени и остаток "
            + "в безубытке, то есть сделка отработала, а не провалилась.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => `${v} ${plural(v, "сделка", "сделки", "сделок")}`}
                   data={byReason(trades).map((x) => ({
                     label: REASON_RU[x.reason] || x.reason, y: x.n,
                     good: !["sl", "flat"].includes(x.reason),
                   }))} />
        ),
        extra: (
          <Rows rows={byReason(trades).map((x) => ({
            k: REASON_RU[x.reason] || x.reason, v: money(x.pnl, true), c: tone(x.pnl),
            note: `${x.n} ${plural(x.n, "сделка", "сделки", "сделок")}`,
          }))} />
        ),
      },
    ];

    const sides = bySide(trades);
    if (sides.length > 1) {
      list.push({
        id: "side", title: "Лонги против шортов", icon: <Scale size={15} />,
        value: sides.map((x) => `${x.s.winrate ?? 0}%`).join(" / "),
        sub: sides.map((x) => (x.side === "long" ? "лонг" : "шорт")).join(" / "),
        note: "У бота лонг и шорт торгуются по РАЗНЫМ схемам выхода: у шорта лесенка из трёх "
            + "ступеней, у лонга одна цель на всю позицию. Один винрейт на двоих мерил бы "
            + "две системы одним числом.",
        plot: (h) => (
          <BarPlot height={h} fmt={(v) => money(v, true)}
                   data={sides.map((x) => ({ label: x.side === "long" ? "лонг" : "шорт",
                                             y: +x.s.net.toFixed(2) }))} />
        ),
        extra: (
          <Rows rows={sides.flatMap((x) => [
            { k: x.side === "long" ? "Лонг" : "Шорт", v: money(x.s.net, true), c: tone(x.s.net),
              note: `${x.s.n} ${plural(x.s.n, "сделка", "сделки", "сделок")} · винрейт ${x.s.winrate ?? 0}%` },
            { k: "  ожидание", v: x.s.expR === null ? "—" : `${x.s.expR.toFixed(2)}R`,
              c: tone(x.s.expR || 0), note: `профит-фактор ${x.s.pf ?? "—"}` },
          ])} />
        ),
      });
    }
    return list;
  }, [trades, s, days, eq]);

  if (!trades.length) return null;
  const cur = cards.find((c) => c.id === open) || null;

  return (
    <>
      <div className="px-4 grid grid-cols-2 gap-2.5">
        {cards.map((c) => (
          <Press key={c.id} onClick={() => { haptic.tap(); setOpen(c.id); }}
                 className={`block ${c.wide ? "col-span-2" : ""}`} scale={0.98}>
            <Glass flat className="p-3.5 overflow-hidden h-full">
              <div className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--label-2)" }}>
                {c.icon}{c.title}
              </div>
              <div className="text-[22px] font-bold mt-1 tracking-tight"
                   style={{ color: c.tint || "var(--label)" }}>{c.value}</div>
              {c.sub && (
                <div className="text-[11px] mt-0.5 leading-snug" style={{ color: "var(--label-3)" }}>
                  {c.sub}
                </div>
              )}
              {/* Мини-график в карточке без наведения: палец по нему всё равно
                  открывает карточку, и подпись под ним только мешала бы. */}
              <div className="mt-1.5 pointer-events-none">{c.plot(c.wide ? 96 : 70)}</div>
            </Glass>
          </Press>
        ))}
      </div>

      <Sheet open={!!cur} onClose={() => setOpen(null)} title={cur?.title} tall>
        {cur && (
          <div className="pb-3 space-y-3" data-noswipe>
            <div className="flex items-baseline gap-2">
              <span className="text-[30px] font-bold tracking-[-0.03em]"
                    style={{ color: cur.tint || "var(--label)" }}>{cur.value}</span>
              {cur.sub && <span className="text-[13px]" style={{ color: "var(--label-2)" }}>{cur.sub}</span>}
            </div>
            <Glass flat className="p-3 pt-2">
              {cur.plot(210)}
              <div className="text-center text-[10px] mt-1" style={{ color: "var(--label-3)" }}>
                ведите пальцем по графику — покажет цифры
              </div>
            </Glass>
            {cur.extra}
            <p className="text-[13px] leading-snug px-1" style={{ color: "var(--label-2)" }}>
              {cur.note}
            </p>
          </div>
        )}
      </Sheet>
    </>
  );
}

function Rows({ rows }: { rows: { k: string; v: string; c?: string; note?: string }[] }) {
  return (
    <Glass flat className="overflow-hidden">
      {rows.map((r, i) => (
        <div key={r.k + i} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${
               i === rows.length - 1 ? "" : "hairline"}`}>
          <span className="min-w-0">
            <span className="block text-[14px] truncate">{r.k}</span>
            {r.note && (
              <span className="block text-[11px] mt-0.5" style={{ color: "var(--label-3)" }}>{r.note}</span>
            )}
          </span>
          <span className="text-[14px] font-semibold tabular-nums shrink-0"
                style={{ color: r.c || "var(--label)" }}>{r.v}</span>
        </div>
      ))}
    </Glass>
  );
}

function bestHour(trades: Trade[]): string {
  const h = byHour(trades).filter((x) => x.n > 0).sort((a, b) => b.pnl - a.pnl)[0];
  return h ? `${h.hour}:00` : "—";
}
