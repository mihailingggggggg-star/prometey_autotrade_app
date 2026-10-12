/**
 * Аналитика (§9.4): кривая капитала, винрейт, средний профит, распределение
 * исходов и таблица закрытых сделок.
 *
 * Деньги считаются ТОЛЬКО по закрытым сделкам (см. закон данных): у открытой
 * позиции результата ещё нет — есть состояние, и оно живёт на вкладке
 * «Позиции», а не здесь. Модель результата — net: издержки и проскальзывание
 * уже вычтены сервером и показаны отдельной колонкой, чтобы «прибыль» не
 * выглядела больше, чем она есть.
 */
import { useState } from "react";
import { LinePlot, BarPlot } from "../ui/Plot";
import { addDeposit, analyticsSummary, getSettings, listTrades } from "../lib/api";
import { useApi } from "../lib/useApi";
import { Glass, Press, Title } from "../ui/kit";
import { ErrorBox, KV, Loading, Panel } from "../ui/states";
import { dt, money, pct } from "../lib/format";

export function Analytics({ refreshKey }: { refreshKey: number }) {
  const summary = useApi(analyticsSummary, 15000, [refreshKey]);
  const trades = useApi(() => listTrades(50), 15000, [refreshKey]);
  const settings = useApi(getSettings, 0, []);

  const [amount, setAmount] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const monthly = settings.data?.demo.monthly_deposit ?? 500;
  const deposit = async (usd: number) => {
    if (!usd || usd <= 0) return;
    setBusy(true);
    setNotice(null);
    try {
      await addDeposit(usd);
      setNotice(`Демо-баланс пополнен на ${money(usd).replace("+", "")}`);
      setAmount("");
      summary.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const s = summary.data;

  return (
    <div className="pb-3">
      <Title sub="Демо-контур · net после издержек">Аналитика</Title>

      {summary.loading && !s && <Loading label="считаем результаты…" />}
      {!summary.loading && summary.error && (
        <ErrorBox text={summary.error} onRetry={summary.refresh} />
      )}

      {s && (
        <>
          {/* Ключевые числа */}
          <div className="px-3 grid grid-cols-2 gap-2.5">
            <BigStat label="Баланс" value={money(s.balance).replace("+", "")}
                     tone={s.balance >= s.deposited ? "var(--green)" : "var(--label)"} />
            <BigStat label="Внесено" value={money(s.deposited).replace("+", "")} />
            <BigStat label="Винрейт" value={`${(s.winrate * 100).toFixed(1)}%`}
                     tone={s.winrate >= 0.5 ? "var(--green)" : "var(--orange)"} />
            <BigStat label="Средний профит" value={pct(s.avg_profit_pct)}
                     tone={s.avg_profit_pct >= 0 ? "var(--green)" : "var(--red)"} />
          </div>

          <div className="px-3 mt-3">
            <Panel title="Кривая капитала"
                   right={<span className="text-[12px] tabular-nums" style={{ color: "var(--label-3)" }}>
                     {s.trades_count} сделок · {s.open_count} открыто
                   </span>}>
              {s.equity_curve.length >= 2 ? (
                <LinePlot
                  data={s.equity_curve.map(([ts, eq]) => ({ x: ts, y: eq }))}
                  height={150}
                  fmt={(v) => money(v).replace("+", "")}
                  xfmt={(v) => dt(v * 1000)}
                  zero={false}
                />
              ) : (
                <div className="text-[13px] py-6 text-center" style={{ color: "var(--label-3)" }}>
                  сделок пока не было — кривая появится после первой
                </div>
              )}
              <div className="mt-2">
                <KV label="Всего издержек и проскальзывания" value={money(s.costs_usd).replace("+", "")} mono />
              </div>
            </Panel>
          </div>

          {/* Распределение исходов */}
          <div className="px-3 mt-3">
            <Panel title="Распределение исходов">
              <BarPlot
                height={140}
                data={[
                  { label: "в ноль", y: s.by_outcome.closed_zero, good: false },
                  { label: "x2", y: s.by_outcome.reached_x2, good: true },
                  { label: "x5", y: s.by_outcome.reached_x5, good: true },
                  { label: "открыто", y: s.by_outcome.open },
                ]}
                fmt={(v) => String(v)}
              />
              <div className="grid grid-cols-3 gap-2 mt-2">
                <Mini label="в ноль" value={s.by_outcome.closed_zero} tone="var(--red)" />
                <Mini label="дошли до x2" value={s.by_outcome.reached_x2} tone="var(--green)" />
                <Mini label="дошли до x5" value={s.by_outcome.reached_x5} tone="var(--green)" />
              </div>
            </Panel>
          </div>

          {/* Пополнение демо-баланса */}
          <div className="px-3 mt-3">
            <Panel title="Пополнить демо-баланс">
              <div className="flex items-center gap-2">
                <Press onClick={() => deposit(monthly)} disabled={busy} className="flex-1">
                  <div className="py-2.5 rounded-[12px] text-center text-[14px] font-semibold text-white"
                       style={{ background: "var(--tint-grad)" }}>
                    + {money(monthly).replace("+", "")}
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
        </>
      )}

      {/* Таблица закрытых сделок */}
      <div className="px-3 mt-3">
        <Panel title="Закрытые сделки">
          {trades.loading && !trades.data && (
            <div className="text-[13px] py-3" style={{ color: "var(--label-3)" }}>загружаем сделки…</div>
          )}
          {trades.error && <div className="text-[13px]" style={{ color: "var(--orange)" }}>{trades.error}</div>}
          {trades.data && trades.data.length === 0 && (
            <div className="text-[13px] py-3" style={{ color: "var(--label-3)" }}>закрытых сделок пока нет</div>
          )}
          {trades.data && trades.data.length > 0 && (
            <div className="flex flex-col">
              <div className="flex text-[10px] uppercase tracking-wide pb-1.5"
                   style={{ color: "var(--label-3)" }}>
                <span className="flex-1">монета</span>
                <span className="w-[92px] text-right">вход → выход</span>
                <span className="w-[74px] text-right">PnL</span>
                <span className="w-[70px] text-right">издержки</span>
              </div>
              {trades.data.map((t) => (
                <div key={t.id} className="flex items-center py-2 hairline">
                  <span className="flex-1 min-w-0">
                    <span className="text-[14px] font-semibold">{t.symbol}</span>
                    {t.free_ride_done && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded"
                            style={{ background: "color-mix(in srgb, var(--green) 16%, transparent)", color: "var(--green)" }}>
                        FR
                      </span>
                    )}
                  </span>
                  <span className="w-[92px] text-right text-[11px] tabular-nums leading-tight"
                        style={{ color: "var(--label-2)" }}>
                    {dt(t.opened_ts * 1000)}<br />{dt(t.closed_ts * 1000)}
                  </span>
                  <span className="w-[74px] text-right text-[13px] font-semibold tabular-nums"
                        style={{ color: t.pnl_usd >= 0 ? "var(--green)" : "var(--red)" }}>
                    {pct(t.pnl_pct)}
                  </span>
                  <span className="w-[70px] text-right text-[12px] tabular-nums" style={{ color: "var(--label-2)" }}>
                    {money(t.costs_usd).replace("+", "")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
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

function Mini({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-[10px] px-2.5 py-2 text-center" style={{ background: "var(--bg-elev)" }}>
      <div className="text-[16px] font-bold tabular-nums" style={{ color: tone }}>{value}</div>
      <div className="text-[10px] mt-0.5" style={{ color: "var(--label-3)" }}>{label}</div>
    </div>
  );
}
