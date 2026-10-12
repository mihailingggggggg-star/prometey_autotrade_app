/**
 * Аналитика — периоды, дашборды и прогноз по ЗАКРЫТЫМ сделкам демо-контура.
 *
 * Экран собран из прежнего приложения, а не нарисован заново: разбивки и
 * формулы взяты из `git show 3253f44:src/lib/stats.ts` (+ Dash.tsx), календарь —
 * из `src/ui/Calendar.tsx`, карточка для соцсетей — из `CardPreview.tsx` и
 * `ShareCard.ts`. Менялся слой представления: вместо модели бота (`lib/mock`)
 * источник — контракт `shared/types.ts` и `GET /api/trades`, а период теперь
 * фильтрует ВСЁ на экране.
 *
 * Деньги считаются ТОЛЬКО по закрытым сделкам (закон данных): у открытой
 * позиции результата ещё нет — есть состояние. Поэтому все числа периода идут
 * из журнала сделок, а капитал (баланс + оценка открытых) — отдельным снимком
 * из `/api/analytics/summary`, который нужен прогнозу, но не метрикам.
 *
 * Сервер не трогаем: агрегаты считаются на клиенте чистыми функциями lib/stats.
 */
import { useMemo, useState } from "react";
import { Share2 } from "lucide-react";
import { LinePlot } from "../ui/Plot";
import { addDeposit, analyticsSummary, getSettings, health, listTrades } from "../lib/api";
import { useApi } from "../lib/useApi";
import { Glass, Press, Row, Segmented, Sheet, Title } from "../ui/kit";
import { DemoBanner, ErrorBox, KV, Loading, Panel } from "../ui/states";
import { dt, money, pct, plural, rr } from "../lib/format";
import * as S from "../lib/stats";
import { Calendar, rangeLabel, rangeMs, type CalDay, type Range } from "../ui/Calendar";
import { CardPreview } from "../ui/CardPreview";
import { drawEquityCard, equityCardBlob, type ShareEquity, type ShareKind } from "../ui/ShareCard";
import type { Trade } from "../../shared/types";

/* ── период ────────────────────────────────────────────────────────────────── */

type P = "d" | "w" | "m" | "all" | "custom";
const OPTS: { id: P; label: string }[] = [
  { id: "d", label: "День" },
  { id: "w", label: "Неделя" },
  { id: "m", label: "Месяц" },
  { id: "all", label: "Всё" },
  { id: "custom", label: "Период…" },
];
const WINDOW_DAYS: Record<"d" | "w" | "m", number> = { d: 1, w: 7, m: 30 };

/** Причина закрытия — словом и тоном. Коды — из контракта (CloseReason);
 *  незнакомый не ломает строку, а показывается как есть. */
const REASON: Record<string, { t: string; tone: string }> = {
  tp_full: { t: "цель взята", tone: "var(--green)" },
  tp_50: { t: "взята половина", tone: "var(--green)" },
  manual: { t: "закрыто вручную", tone: "var(--label-2)" },
  time_stop: { t: "по времени", tone: "var(--label-2)" },
  liq_drain: { t: "слив ликвидности", tone: "var(--red)" },
};
const reasonOf = (r: string) => REASON[r] ?? { t: r, tone: "var(--label-2)" };

/** Метка бота для карточки. Без адреса карточка подписывается словесной маркой
 *  (см. ShareCard): придумывать username не станем. */
const BOT = "";
const SHARE_KINDS: { id: ShareKind; label: string }[] = [
  { id: "usd", label: "в долларах" },
  { id: "pct", label: "в R" },
];

/** Месяц отчётности, в котором пользователь уже пополнял баланс через панель.
 *  Нужен прогнозу: плановое пополнение месяца добавляем, только если оно ещё не
 *  внесено. Отдельного GET /api/deposits в контракте нет, поэтому опираемся на
 *  собственную отметку в памяти браузера (в приватном режиме — просто нет). */
const DEPOSIT_MONTH_KEY = "pmt.deposit.month";
const readDepositMonth = () => {
  try { return localStorage.getItem(DEPOSIT_MONTH_KEY); } catch { return null; }
};
const writeDepositMonth = (v: string) => {
  try { localStorage.setItem(DEPOSIT_MONTH_KEY, v); } catch { /* приватный режим */ }
};
const monthKeyOf = (ms: number) => S.dayKey(ms).slice(0, 7);

export function Analytics({ refreshKey }: { refreshKey: number }) {
  const summary = useApi(analyticsSummary, 15000, [refreshKey]);
  const trades = useApi(() => listTrades(500), 15000, [refreshKey]);
  const settings = useApi(getSettings, 0, []);
  const healthApi = useApi(health, 0, []);

  const [p, setP] = useState<P>("d");
  const [range, setRange] = useState<Range>(null);
  const [unit, setUnit] = useState<"usd" | "r">("usd");
  const [share, setShare] = useState(false);
  const [openCoin, setOpenCoin] = useState<string | null>(null);
  const [depositMonth, setDepositMonth] = useState<string | null>(readDepositMonth);

  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /* Время мира: в mock оно ускорено и живёт на сервере. Сравнивать сделки с
     часами телефона здесь нельзя — сделки размечены виртуальным временем. */
  const nowMs = healthApi.data ? healthApi.data.virtual_ts * 1000 : Date.now();

  /* Границы выбранного периода. «Период…» главнее кнопок, пока в календаре
     стоит промежуток; сброс промежутка возвращает на «Всё». */
  const period = useMemo(() => {
    if (p === "custom" && range) {
      const ms = rangeMs(range, S.TZ_MIN);
      return { from: ms.from, to: ms.to, label: rangeLabel(range) };
    }
    if (p === "all") return { from: 0, to: Number.POSITIVE_INFINITY, label: "Всё время" };
    const days = WINDOW_DAYS[p === "custom" ? "m" : p];
    /* Верхняя граница — «сейчас» плюс секунда. Сделка, закрытая ровно в этот
       же момент (closed_ts в секундах), иначе выпадала бы из окна на самой
       границе: полуинтервал [from, to) её не пускал. */
    return {
      from: S.windowStart(days, nowMs),
      to: nowMs + 1000,
      label: days === 1 ? "Сегодня" : days === 7 ? "7 дней" : "30 дней",
    };
  }, [p, range, nowMs]);

  const all = trades.data ?? [];
  const list = useMemo(() => S.inWindow(all, period.from, period.to), [all, period]);
  const sum = useMemo(() => S.summary(list), [list]);
  const symRows = useMemo(() => S.bySymbol(list, 10), [list]);
  const reasonRows = useMemo(() => S.byReason(list), [list]);
  const eq = useMemo(() => S.equity(list), [list]);
  const eqR = useMemo(() => S.equityR(list), [list]);
  const latest = useMemo(
    () => [...list].sort((a, b) => b.closed_ts - a.closed_ts).slice(0, 50),
    [list],
  );
  const calDays: CalDay[] = useMemo(
    () => S.byDay(all).map((d) => ({ date: d.day, usd: d.pnl })),
    [all],
  );

  const monthly = settings.data?.demo.monthly_deposit ?? 500;
  const curMonth = monthKeyOf(nowMs);
  const depositPending = depositMonth !== curMonth;
  const fc = useMemo(
    () => S.forecastMonth(all, summary.data?.equity ?? 0, monthly, depositPending, nowMs),
    [all, summary.data, monthly, depositPending, nowMs],
  );

  const coinTrades = useMemo(
    () => (openCoin ? list.filter((t) => t.symbol.replace("USDT", "") === openCoin) : []),
    [openCoin, list],
  );
  const coinSum = useMemo(() => S.summary(coinTrades), [coinTrades]);

  const shareEquity: ShareEquity = {
    net: sum.net,
    netR: +sum.netR.toFixed(2),
    n: sum.n,
    wins: sum.wins,
    loss: sum.loss,
    periodLabel: period.label,
    to: nowMs,
  };
  const sharePoints = eq.map((pt) => ({ x: pt.x, y: pt.y }));

  const deposit = async (usd: number) => {
    if (!usd || usd <= 0) return;
    setBusy(true);
    setNotice(null);
    try {
      await addDeposit(usd);
      setNotice(`Демо-баланс пополнен на ${money(usd)}`);
      writeDepositMonth(curMonth);
      setDepositMonth(curMonth);
      setAmount("");
      summary.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const winShare = sum.n ? Math.round((sum.wins / sum.n) * 100) : 0;
  const lossShare = sum.n ? Math.round((sum.loss / sum.n) * 100) : 0;

  return (
    <div className="pb-3">
      <Title sub="Демо-контур · net после издержек">Аналитика</Title>

      {healthApi.data?.mode === "mock" && (
        <DemoBanner note="сделки, баланс и прогноз — придуманные движком демо-контура, а не результат реальной торговли." />
      )}

      {summary.loading && !summary.data && <Loading label="считаем результаты…" />}
      {!summary.loading && summary.error && (
        <ErrorBox text={summary.error} onRetry={summary.refresh} />
      )}

      {/* ── Период ─────────────────────────────────────────────────────────── */}
      <div className="px-3">
        <Segmented<P>
          value={p}
          onChange={(v) => {
            if (v === "custom") setP("custom");
            else { setP(v); setRange(null); }
          }}
          options={OPTS}
          size="sm"
          layoutId="an-period"
        />
        <div className="flex items-center justify-between mt-2 px-1">
          <span className="text-[12px]" style={{ color: "var(--label-3)" }}>{period.label}</span>
          <span className="text-[12px] tabular-nums" style={{ color: "var(--label-3)" }}>
            {sum.n} {plural(sum.n, "сделка", "сделки", "сделок")}
          </span>
        </div>
      </div>

      {p === "custom" && (
        <div className="px-3 mt-2">
          <Calendar
            days={calDays}
            tzMin={S.TZ_MIN}
            value={range}
            onChange={(r) => { setRange(r); if (!r) setP("all"); }}
          />
        </div>
      )}

      {/* ── Плитки периода ─────────────────────────────────────────────────── */}
      <div className="px-3 mt-3 grid grid-cols-2 gap-2.5">
        <BigStat label="Сделок" value={String(sum.n)} />
        <BigStat label="Винрейт"
                 value={sum.winrate == null ? "—" : `${sum.winrate}%`}
                 tone={sum.winrate != null && sum.winrate >= 50 ? "var(--green)" : "var(--orange)"} />
        <BigStat label="Чистыми" value={money(sum.net, true)}
                 tone={sum.net >= 0 ? "var(--green)" : "var(--red)"} />
        <BigStat label="Издержки" value={money(sum.costs)} />
      </div>

      {/* ── Кумулятивная прибыль ───────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel
          title="Кумулятивная прибыль"
          right={
            <span className="text-[12px] tabular-nums" style={{ color: "var(--label-3)" }}>
              итог {unit === "usd" ? money(sum.net, true) : rr(sum.netR)}
            </span>
          }
        >
          <div className="mb-2">
            <Segmented<"usd" | "r">
              value={unit}
              onChange={setUnit}
              options={[{ id: "usd", label: "в долларах" }, { id: "r", label: "в R" }]}
              size="sm"
              layoutId="an-unit"
            />
          </div>
          {list.length >= 2 ? (
            unit === "usd" ? (
              <LinePlot data={eq} height={160} fmt={(v) => money(v, true)}
                        xfmt={(v) => dt(v * 1000)} zero />
            ) : (
              <LinePlot data={eqR} height={160} color="var(--tint-soft)" fmt={(v) => rr(v)}
                        xfmt={(v) => dt(v * 1000)} zero />
            )
          ) : (
            <div className="text-[13px] py-6 text-center" style={{ color: "var(--label-3)" }}>
              за период сделок мало — кривая появится после пары закрытых сделок
            </div>
          )}
          <KV label="Чистыми за период" value={money(sum.net, true)} mono
              tone={sum.net >= 0 ? "var(--green)" : "var(--red)"} />
          <KV label="Всего в R" value={rr(sum.netR)} mono />
          <Press onClick={() => setShare(true)} disabled={list.length < 2} className="block mt-2">
            <div className="flex items-center justify-center gap-2 py-2.5 rounded-[12px] text-[14px] font-semibold"
                 style={{ background: "var(--bg-elev)" }}>
              <Share2 size={16} /> Поделиться карточкой
            </div>
          </Press>
        </Panel>
      </div>

      {/* ── По монетам ─────────────────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel
          title="По монетам"
          right={<span className="text-[12px]" style={{ color: "var(--label-3)" }}>топ {symRows.length}</span>}
        >
          {symRows.length === 0 ? <Empty /> : (
            <div className="flex flex-col">
              {symRows.map((r) => (
                <Row
                  key={r.symbol}
                  title={r.symbol}
                  note={`${r.n} ${plural(r.n, "сделка", "сделки", "сделок")} · винрейт ${r.winrate == null ? "—" : `${r.winrate}%`}`}
                  right={
                    <div className="text-right">
                      <div className="tabular-nums font-semibold"
                           style={{ color: r.pnl >= 0 ? "var(--green)" : "var(--red)" }}>
                        {money(r.pnl, true)}
                      </div>
                      <div className="tabular-nums text-[12px]" style={{ color: "var(--label-3)" }}>
                        сред. {money(r.avg, true)}
                      </div>
                    </div>
                  }
                  onClick={() => setOpenCoin(r.symbol)}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Причины закрытия ───────────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel title="Причины закрытия">
          {reasonRows.length === 0 ? <Empty /> : (
            <div className="flex flex-col">
              {reasonRows.map((r) => {
                const rr2 = reasonOf(r.reason);
                return (
                  <Row
                    key={r.reason}
                    title={<span style={{ color: rr2.tone }}>{rr2.t}</span>}
                    right={
                      <div className="text-right">
                        <div className="tabular-nums">{r.n}</div>
                        <div className="tabular-nums text-[12px]"
                             style={{ color: r.pnl >= 0 ? "var(--green)" : "var(--red)" }}>
                          {money(r.pnl, true)}
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Математическое ожидание ────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel
          title="Математическое ожидание"
          right={<span className="text-[12px]" style={{ color: "var(--label-3)" }}>на сделку</span>}
        >
          <div className="flex items-end gap-3">
            <div className="text-[30px] font-bold tabular-nums leading-none"
                 style={{ color: (sum.expUsd ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
              {sum.expUsd == null ? "—" : money(sum.expUsd, true)}
            </div>
            <div className="text-[13px] tabular-nums pb-1" style={{ color: "var(--label-2)" }}>
              {sum.expPct == null ? "" : `${pct(sum.expPct)} от вложенного`}
            </div>
          </div>
          <div className="mt-2">
            <KV label="Винрейт" value={sum.winrate == null ? "—" : `${sum.winrate}%`} />
            <KV label="Средний выигрыш"
                value={`${money(sum.avgWin)} · ${pct(sum.avgWinPct)}`} mono
                tone="var(--green)" />
            <KV label="Средний убыток"
                value={`−${money(sum.avgLoss)} · ${pct(sum.avgLossPct)}`} mono
                tone="var(--red)" />
            <KV label="Сделок с результатом" value={`${sum.wins + sum.loss} из ${sum.n}`} mono />
            <KV label="Средний размер входа" value={money(sum.avgInvested)} mono />
            <KV label="Макс. просадка кривой" value={money(sum.maxDd, true)} mono />
          </div>
          <p className="text-[12px] mt-2 leading-snug" style={{ color: "var(--label-3)" }}>
            Формула: доля побед × средний выигрыш − доля убытков × средний убыток
            (доли — от всех сделок периода).
            Здесь: {winShare}% × {money(sum.avgWin)} − {lossShare}% × {money(sum.avgLoss)}
            {" ≈ "}{sum.expUsd == null ? "—" : money(sum.expUsd, true)}.
          </p>
        </Panel>
      </div>

      {/* ── Издержки ───────────────────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel title="Издержки">
          <KV label="Комиссии и проскальзывание за период" value={money(sum.costs)} mono />
          <KV label="Сделок в периоде" value={String(sum.n)} mono />
          <KV label="Средние издержки на сделку"
              value={sum.n ? money(sum.costs / sum.n) : "—"} mono />
        </Panel>
      </div>

      {/* ── Прогноз на конец месяца ────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel
          title="Прогноз на конец месяца"
          right={<span className="text-[12px]" style={{ color: "var(--label-3)" }}>оценка по темпу</span>}
        >
          {!fc ? (
            <div className="text-[13px] py-3 leading-snug" style={{ color: "var(--label-3)" }}>
              мало данных — в этом месяце закрытых сделок ещё нет, прогноз не строим.
            </div>
          ) : (
            <>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--label-3)" }}>
                депозит к концу месяца
              </div>
              <div className="text-[30px] font-bold tabular-nums leading-none mt-1">
                {money(fc.base)}
              </div>
              <div className="text-[13px] mt-2 tabular-nums" style={{ color: "var(--label-2)" }}>
                разброс: {money(fc.low)} … {money(fc.high)}
                <span style={{ color: "var(--label-3)" }}> (±{money(fc.spread)})</span>
              </div>
              <div className="mt-2">
                <KV label="Капитал сейчас" value={money(fc.equity)} mono />
                <KV label="Сделок в месяце"
                    value={`${fc.done} за ${fc.elapsed} ${plural(fc.elapsed, "день", "дня", "дней")}`} mono />
                <KV label="Темп сделок" value={`${fc.perDay} в день`} mono />
                <KV label="Ожидается сделок"
                    value={`${fc.expectedDeals} за ${fc.left} ${plural(fc.left, "день", "дня", "дней")}`} mono />
                <KV label="Ожидание на сделку" value={money(fc.expPerTrade, true)} mono />
                <KV label="Ожидаемая прибыль" value={money(fc.baseProfit, true)} mono
                    tone={fc.baseProfit >= 0 ? "var(--green)" : "var(--red)"} />
                {fc.deposit > 0 && (
                  <KV label="Плановое пополнение месяца" value={money(fc.deposit)} mono />
                )}
              </div>
              <p className="text-[12px] mt-2 leading-snug" style={{ color: "var(--label-3)" }}>
                Метод: капитал + темп × оставшиеся дни × ожидание на сделку
                {fc.deposit > 0 ? " + плановое пополнение" : ""}.
                Границы — это ±одно стандартное отклонение результата сделки, умноженное
                на корень из ожидаемого числа сделок. Это оценка по текущему темпу,
                а не обещание: мало сделок — широкий разброс честнее одной цифры.
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* ── Пополнение демо-баланса ────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel title="Пополнить демо-баланс">
          <div className="flex items-center gap-2">
            <Press onClick={() => deposit(monthly)} disabled={busy} className="flex-1">
              <div className="py-2.5 rounded-[12px] text-center text-[14px] font-semibold text-white"
                   style={{ background: "var(--tint-grad)" }}>
                + {money(monthly)}
              </div>
            </Press>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                   inputMode="decimal" placeholder="своя сумма"
                   className="flex-1 min-w-[92px] px-3 py-2 rounded-[12px] text-[15px] tabular-nums outline-none"
                   style={{ background: "var(--bg-elev)", color: "var(--label)" }} />
            <Press onClick={() => deposit(Number(amount))} disabled={busy || !Number(amount)}>
              <div className="px-4 py-2.5 rounded-[12px] text-[14px] font-semibold"
                   style={{ background: "var(--bg-elev)" }}>Пополнить</div>
            </Press>
          </div>
          {notice && <div className="text-[13px] mt-2" style={{ color: "var(--label-2)" }}>{notice}</div>}
        </Panel>
      </div>

      {/* ── Сделки за период ───────────────────────────────────────────────── */}
      <div className="px-3 mt-3">
        <Panel
          title="Сделки за период"
          right={
            <span className="text-[12px] tabular-nums" style={{ color: "var(--label-3)" }}>
              {list.length > latest.length ? `последние ${latest.length} из ${list.length}` : `все ${list.length}`}
            </span>
          }
        >
          {trades.loading && !trades.data && (
            <div className="text-[13px] py-3" style={{ color: "var(--label-3)" }}>загружаем сделки…</div>
          )}
          {trades.error && (
            <div className="text-[13px]" style={{ color: "var(--orange)" }}>{trades.error}</div>
          )}
          {trades.data && list.length === 0 && (
            <div className="text-[13px] py-3" style={{ color: "var(--label-3)" }}>
              за период закрытых сделок нет
            </div>
          )}
          {latest.length > 0 && (
            <>
              <div className="flex text-[10px] uppercase tracking-wide pb-1.5"
                   style={{ color: "var(--label-3)" }}>
                <span className="flex-1">монета · причина</span>
                <span className="w-[96px] text-right">вход → выход</span>
                <span className="w-[108px] text-right">результат</span>
              </div>
              <div className="flex flex-col">
                {latest.map((t) => <TradeRow key={t.id} t={t} />)}
              </div>
            </>
          )}
        </Panel>
      </div>

      {/* ── Детали по монете (Sheet) ───────────────────────────────────────── */}
      <Sheet open={openCoin != null} onClose={() => setOpenCoin(null)} title={openCoin ?? ""}>
        {openCoin && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Mini label="сделок" value={String(coinSum.n)} tone="var(--label)" />
              <Mini label="чистыми" value={money(coinSum.net, true)}
                    tone={coinSum.net >= 0 ? "var(--green)" : "var(--red)"} />
              <Mini label="винрейт" value={coinSum.winrate == null ? "—" : `${coinSum.winrate}%`}
                    tone="var(--label)" />
            </div>
            <div className="flex flex-col mt-3">
              {[...coinTrades].sort((a, b) => b.closed_ts - a.closed_ts).map((t) => (
                <TradeRow key={t.id} t={t} />
              ))}
            </div>
          </>
        )}
      </Sheet>

      {/* ── Карточка для соцсетей ──────────────────────────────────────────── */}
      {share && (
        <CardPreview<ShareKind>
          kinds={SHARE_KINDS}
          initial="usd"
          draw={(cv, kind) => drawEquityCard(cv, shareEquity, sharePoints, BOT, kind)}
          blob={(kind) => equityCardBlob(shareEquity, sharePoints, BOT, kind)}
          filename={(kind) => `prometheus-${kind}.png`}
          text={() => `Кумулятивная прибыль · ${period.label} · ${money(sum.net, true)}`}
          onClose={() => setShare(false)}
        />
      )}
    </div>
  );
}

/* ── мелкие части ──────────────────────────────────────────────────────────── */

function TradeRow({ t }: { t: Trade }) {
  const r = reasonOf(t.close_reason);
  return (
    <div className="flex items-start py-2 hairline gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold flex items-center gap-1.5">
          <span className="truncate">{t.symbol.replace("USDT", "")}</span>
          {t.free_ride_done && (
            <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: "color-mix(in srgb, var(--green) 16%, transparent)", color: "var(--green)" }}>
              FR
            </span>
          )}
        </div>
        <div className="text-[11px] mt-0.5 truncate" style={{ color: r.tone }}>{r.t}</div>
      </div>
      <div className="w-[96px] text-right text-[11px] tabular-nums leading-tight shrink-0"
           style={{ color: "var(--label-2)" }}>
        {dt(t.opened_ts * 1000)}<br />{dt(t.closed_ts * 1000)}
      </div>
      <div className="w-[108px] text-right shrink-0">
        <div className="text-[13px] font-semibold tabular-nums"
             style={{ color: t.pnl_usd >= 0 ? "var(--green)" : "var(--red)" }}>
          {money(t.pnl_usd, true)}
        </div>
        <div className="text-[11px] tabular-nums leading-tight" style={{ color: "var(--label-3)" }}>
          {pct(t.pnl_pct)} · из. {money(t.costs_usd)}
        </div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="text-[13px] py-3" style={{ color: "var(--label-3)" }}>
      за период данных нет
    </div>
  );
}

function BigStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Glass flat className="rounded-[18px] p-3.5">
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--label-3)" }}>{label}</div>
      <div className="text-[24px] font-bold tabular-nums mt-1 leading-none"
           style={{ color: tone || "var(--label)" }}>{value}</div>
    </Glass>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-[10px] px-2.5 py-2 text-center" style={{ background: "var(--bg-elev)" }}>
      <div className="text-[15px] font-bold tabular-nums" style={{ color: tone }}>{value}</div>
      <div className="text-[10px] mt-0.5" style={{ color: "var(--label-3)" }}>{label}</div>
    </div>
  );
}
