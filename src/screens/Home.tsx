/**
 * Главная — экран, с которого начинается день.
 *
 * Сверху — тот же, что и раньше, финансовый результат: стеклянная карточка с
 * живым сиянием (`Aurora`), крупным числом `num-hero` и анимацией числа по
 * `key` (число «подпрыгивает», когда меняется). Под числом — доходность в R,
 * число сделок и винрейт; внизу — сколько позиций в рынке и их плавающий
 * результат.
 *
 * Период («День», «Неделя», «Всё») РЕАЛЬНО меняет агрегаты карточки: они
 * считаются по закрытым сделкам (`GET /api/trades`, поле `closed_ts`), а не
 * берутся готовыми с сервера. Сутки — календарные по Бишкеку (UTC+6), как в
 * отчётности бота; иначе «День» на главной спорил бы с днём в аналитике.
 *
 * Ниже — быстрые действия в стиле прежних `QuickAction` и короткая сводка по
 * открытым позициям. Всё собрано из готовых примитивов (`Title`, `Glass`,
 * `Press`, `Segmented`, `Row`, `Sheet`) — своего «панельного» языка у главной
 * нет.
 */
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ChevronRight, Plus, Radar, RefreshCw } from "lucide-react";
import {
  addDeposit, analyticsSummary, getSettings, listPositions, listTrades, scan,
} from "../lib/api";
import { useApi } from "../lib/useApi";
import type { DataMode, Position } from "../../shared/types";
import { Aurora, Glass, GroupLabel, Press, Row, Segmented, Sheet, Title, tone } from "../ui/kit";
import { TokenLogo } from "../ui/TokenLogo";
import { DemoBanner, ErrorBox, Loading } from "../ui/states";
import { money as fmtMoney, pct, plural, price as fmtPrice, rr } from "../lib/format";
import type { CoinRef } from "./CoinDetail";

type Period = "d" | "w" | "all";

const PERIODS: { id: Period; label: string }[] = [
  { id: "d", label: "День" },
  { id: "w", label: "Неделя" },
  { id: "all", label: "Всё" },
];

/** Начало периода в секундах UTC.
 *
 *  Сутки — КАЛЕНДАРНЫЕ по Бишкеку (UTC+6, без перехода на летнее время), как в
 *  аналитике бота: скользящее окно «последние 24 часа» показывало бы половину
 *  вчерашнего дня впридачу и не сходилось с той же строкой на вкладке
 *  «Аналитика». Неделя — семь таких суток. «Всё» — от начала истории.
 *
 *  Чистая функция от времени: её можно проверить на бумаге. */
function periodFrom(p: Period, nowSec: number): number {
  if (p === "all") return 0;
  const offset = 6 * 3600; // Бишкек
  const dayStart = Math.floor((nowSec + offset) / 86400) * 86400 - offset;
  return p === "d" ? dayStart : dayStart - 6 * 86400;
}

export function Home({ refreshKey, onOpen, onChanged, mode }: {
  refreshKey: number;
  onOpen: (ref: CoinRef) => void;
  onChanged: () => void;
  /** Режим данных: в mock над карточкой стоит плашка «демо-данные». */
  mode?: DataMode | null;
}) {
  const summary = useApi(analyticsSummary, 15000, [refreshKey]);
  const positions = useApi(() => listPositions(), 15000, [refreshKey]);
  const trades = useApi(() => listTrades(500), 15000, [refreshKey]);
  const settings = useApi(getSettings, 0, [refreshKey]);

  const [period, setPeriod] = useState<Period>("d");
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* Агрегаты периода — из закрытых сделок. Поле `closed_ts` решает, в какой
     период попадает сделка; открытые в расчёт не входят — у них нет результата. */
  const stat = useMemo(() => {
    const from = periodFrom(period, Math.floor(Date.now() / 1000));
    const rows = (trades.data ?? []).filter((t) => t.closed_ts >= from);
    const wins = rows.filter((t) => t.pnl_usd > 0);
    const loss = rows.filter((t) => t.pnl_usd < 0);
    const gross = wins.reduce((s, t) => s + t.pnl_usd, 0);
    const lost = Math.abs(loss.reduce((s, t) => s + t.pnl_usd, 0));
    const net = rows.reduce((s, t) => s + t.pnl_usd, 0);
    /* R: на споте весь стейк и есть риск, поэтому 1R = вложенная сумма. Сумма
       R-множеств сделок периода — «во сколько рисков мы выиграли». */
    const r = rows.reduce((s, t) => s + (t.usd_in > 0 ? t.pnl_usd / t.usd_in : 0), 0);
    return {
      n: rows.length, wins: wins.length, loss: loss.length,
      net, gross, lost, r,
      wr: (wins.length + loss.length)
        ? Math.round((wins.length / (wins.length + loss.length)) * 100) : 0,
    };
  }, [trades.data, period]);

  // «В рынке» — только реально открытые: закрытая позиция результата уже не
  // меняет, а непролившаяся лимитка позицией не является.
  const opens: Position[] = (positions.data ?? []).filter((p) => p.status !== "closed");
  const floating = opens.reduce((s, p) => s + p.pnl_usd, 0);

  const s = summary.data;

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setNotice(null);
    try {
      setNotice(await fn());
      onChanged(); // все экраны перечитывают данные сразу
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const topUp = () => run("topup", async () => {
    const usd = settings.data?.demo.monthly_deposit ?? 500;
    await addDeposit(usd);
    return `Демо-баланс пополнен на ${fmtMoney(usd).replace("+", "")}`;
  });

  const runScan = () => run("scan", async () => {
    const res = await scan();
    return res.found > 0
      ? `скан нашёл ${res.found} новых сигналов`
      : "скан не нашёл новых монет — попробуйте позже";
  });

  return (
    <div className="pb-2">
      <Title sub="Solana · спотовый автотрейд">Главная</Title>

      {mode === "mock" && <DemoBanner />}

      {/* ── Финансовый результат ──────────────────────────────────────────── */}
      <div className="px-4">
        <Press onClick={() => setDetail(true)} className="block w-full" scale={0.975} feel="press">
          <Glass className="p-5 overflow-hidden">
            <Aurora />
            {/* Контент поднят над сиянием одним слоем, а не каждой строкой. */}
            <div className="relative z-10">
              <div className="flex items-start justify-between gap-3">
                <span className="text-[13px] font-medium uppercase tracking-wide"
                      style={{ color: "var(--label-2)" }}>Результат</span>
                <span className="flex items-center gap-1 text-[13px]" style={{ color: "var(--label-2)" }}>
                  подробнее <ChevronRight size={14} />
                </span>
              </div>

              {/* Число «подпрыгивает» при изменении: key = само число, поэтому
                  motion играет анимацию заново каждый раз, когда оно другое. */}
              <motion.div key={stat.net} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                          className="num-hero mt-2" style={{ color: tone(stat.net) }}>
                {fmtMoney(stat.net, true)}
              </motion.div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[14px]"
                   style={{ color: "var(--label-2)" }}>
                <span style={{ color: tone(stat.r) }}>{rr(stat.r)}</span>
                <span>·</span>
                <span>{stat.n} {plural(stat.n, "сделка", "сделки", "сделок")}</span>
                <span>·</span>
                <span>винрейт {stat.wr}%</span>
              </div>

              <div className="mt-3 pt-3 flex items-center justify-between hairline-t">
                <span className="text-[14px]" style={{ color: "var(--label-2)" }}>
                  В рынке сейчас: {opens.length}
                </span>
                <span className="text-[15px] font-semibold tabular-nums" style={{ color: tone(floating) }}>
                  {fmtMoney(floating, true)}
                </span>
              </div>
            </div>
          </Glass>
        </Press>

        <div className="mt-3">
          <Segmented value={period} onChange={setPeriod} layoutId="home-period"
                     options={PERIODS.map((p) => ({ id: p.id, label: p.label }))} />
        </div>

        {/* Карточка считает результат по сделкам: не смогли их прочитать —
            говорим причиной, а не показываем нули молча. */}
        {!trades.loading && trades.error && (
          <div className="mt-3"><ErrorBox text={trades.error} onRetry={trades.refresh} /></div>
        )}
      </div>

      {/* ── Быстрые действия ─────────────────────────────────────────────── */}
      <GroupLabel>Быстрые действия</GroupLabel>
      <div className="px-4 grid grid-cols-3 gap-2.5">
        <QuickAction icon={<Plus size={19} />} label="Пополнить" tint="var(--tint)"
                     busy={busy === "topup"} onClick={topUp} />
        <QuickAction icon={<Radar size={19} />} label="Сканировать" tint="var(--green)"
                     busy={busy === "scan"} onClick={runScan} />
        <QuickAction icon={<RefreshCw size={19} />} label="Обновить" tint="var(--label-2)"
                     onClick={() => { setNotice(null); onChanged(); }} />
      </div>
      {notice && (
        <div className="px-5 pt-2 text-[13px]" style={{ color: "var(--label-2)" }}>{notice}</div>
      )}

      {/* ── Открытые позиции ─────────────────────────────────────────────── */}
      <GroupLabel>Открытые позиции</GroupLabel>
      {positions.loading && !positions.data && <Loading label="загружаем позиции…" />}
      {!positions.loading && positions.error && (
        <ErrorBox text={positions.error} onRetry={positions.refresh} />
      )}
      {positions.data && opens.length === 0 && !positions.error && (
        <div className="px-4">
          <Glass flat className="p-4 text-center text-[14px]" style={{ color: "var(--label-2)" }}>
            Открытых позиций нет — откройте сделку на вкладке «Сигналы».
          </Glass>
        </div>
      )}
      {opens.length > 0 && (
        <div className="px-4">
          <Glass flat className="overflow-hidden">
            {opens.map((p, i) => (
              <Row
                key={p.id}
                last={i === opens.length - 1}
                icon={<TokenLogo symbol={p.symbol} size={30} />}
                title={p.symbol}
                note={`вход $${fmtPrice(p.entry_price)} · размер ${fmtMoney(p.usd_in).replace("+", "")}`}
                right={
                  <span className="tabular-nums font-semibold"
                        style={{ color: p.pnl_pct >= 0 ? "var(--green)" : "var(--red)" }}>
                    {pct(p.pnl_pct)}
                  </span>
                }
                onClick={() => onOpen({
                  signalId: p.signal_id, tokenAddr: p.token_addr, symbol: p.symbol, name: p.name, chart: true,
                })}
              />
            ))}
          </Glass>
        </div>
      )}

      {/* ── Шторка с разбивкой результата ────────────────────────────────── */}
      <Sheet open={detail} onClose={() => setDetail(false)} title="Разбивка результата">
        <div className="pb-2">
          <div className="num-hero mb-1 tabular-nums" style={{ color: tone(stat.net) }}>
            {fmtMoney(stat.net, true)}
          </div>
          <div className="text-[14px] mb-4" style={{ color: "var(--label-2)" }}>
            {PERIODS.find((x) => x.id === period)!.label.toLowerCase()} · {stat.n}{" "}
            {plural(stat.n, "сделка", "сделки", "сделок")}
          </div>
          <Glass flat className="overflow-hidden">
            <Row title="Прибыль по выигрышам"
                 right={<b className="tabular-nums" style={{ color: "var(--green)" }}>{fmtMoney(stat.gross, true)}</b>} />
            <Row title="Убыток по проигрышам"
                 right={<b className="tabular-nums" style={{ color: "var(--red)" }}>−{fmtMoney(stat.lost).replace("+", "")}</b>} />
            <Row title="Чистыми"
                 right={<b className="tabular-nums" style={{ color: tone(stat.net) }}>{fmtMoney(stat.net, true)}</b>} />
            <Row title="Успешных / убыточных"
                 right={<><span className="tabular-nums" style={{ color: "var(--green)" }}>{stat.wins}</span>
                        {" / "}
                        <span className="tabular-nums" style={{ color: "var(--red)" }}>{stat.loss}</span></>} />
            <Row title="Доходность в R"
                 right={<b className="tabular-nums" style={{ color: tone(stat.r) }}>{rr(stat.r)}</b>} />
            <Row last title="Свободно на счёте бота"
                 right={<>${(s?.balance ?? 0).toFixed(2)}</>} />
          </Glass>
          <p className="text-[13px] mt-3 leading-snug" style={{ color: "var(--label-2)" }}>
            В расчёт входят только закрытые сделки. Открытые позиции держат результат
            наверху карточки — у них ещё нет итога.
          </p>
        </div>
      </Sheet>

      <div style={{ height: "calc(var(--safe-b) + 8px)" }} />
    </div>
  );
}

/** Быстрое действие: стеклянная плитка со значком и подписью. Отдельная
 *  кнопка-плитка, а не строка меню: на главной важна скорость нажатия, а не
 *  описательность. */
function QuickAction({ icon, label, tint, onClick, busy }: {
  icon: React.ReactNode; label: string; tint: string; onClick: () => void; busy?: boolean;
}) {
  return (
    <Press onClick={onClick} disabled={busy} feel="press" className="block">
      <Glass flat className="py-3.5 flex flex-col items-center gap-1.5">
        <span style={{ color: tint }}>{icon}</span>
        <span className="text-[12px] font-medium leading-none">{label}</span>
      </Glass>
    </Press>
  );
}
