/**
 * Позиции (§9.3): карточки открытых позиций + лента алертов движка.
 *
 * Карточка отвечает за состояние позиции (размер, PnL net, вход/текущая цена,
 * метка Free Ride), а действия вынесены ОТДЕЛЬНЫМИ кнопками ниже: нажатие на
 * карточку открывает детальный экран, и смешивать это с «закрыть» нельзя.
 *
 * Алерты несут три события движка — free_ride, time_stop, liq_drain. Пока
 * алерт не отмечен, он виден и на вкладке (счётчик в TabBar), и здесь.
 */
import { useState } from "react";
import { AlertTriangle, Droplets, Timer, TrendingUp, Wallet } from "lucide-react";
import { closePosition, getSettings, listAlerts, listPositions, seenAlert } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Alert, AlertKind, Position } from "../../shared/types";
import { Glass, Press, Title } from "../ui/kit";
import { TokenLogo } from "../ui/TokenLogo";
import { ErrorBox, Loading } from "../ui/states";
import { ago, money, pct, price as fmtPrice } from "../lib/format";
import type { CoinRef } from "./CoinDetail";

export function Positions({ refreshKey, onOpen }: {
  refreshKey: number;
  onOpen: (ref: CoinRef) => void;
}) {
  const positions = useApi(() => listPositions(), 15000, [refreshKey]);
  const alerts = useApi(() => listAlerts(false), 15000, [refreshKey]);
  // Настройки Free Riding — чтобы показать обе цели явно: триггер фиксации
  // (из настроек) и цель 2 остатка (tp_percent самой позиции).
  const settings = useApi(getSettings, 0, [refreshKey]);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const close = async (p: Position, fraction: number) => {
    setBusy(p.id);
    setNotice(null);
    try {
      const r = await closePosition(p.id, fraction);
      setNotice(`Закрыто ${Math.round(fraction * 100)}% ${p.symbol} по рынку: ${money(r.position.realized_usd, true)}`);
      positions.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const markSeen = async (a: Alert) => {
    try {
      await seenAlert(a.id);
      alerts.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const list = positions.data ?? [];
  const unseen = (alerts.data ?? []).filter((a) => !a.seen);

  return (
    <div className="pb-3">
      <Title sub={list.length ? `открыто ${list.length}` : undefined}>Позиции</Title>

      {positions.loading && !positions.data && <Loading label="загружаем позиции…" />}
      {!positions.loading && positions.error && (
        <ErrorBox text={positions.error} onRetry={positions.refresh} />
      )}

      {notice && (
        <div className="mx-5 mb-2 text-[13px] leading-snug px-3 py-2 rounded-[12px]"
             style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>{notice}</div>
      )}

      {positions.data && list.length === 0 && !positions.error && (
        <div className="px-6 pt-10 text-center">
          <div className="mx-auto mb-4 flex items-center justify-center w-14 h-14 rounded-full"
               style={{ background: "var(--bg-elev)" }}>
            <Wallet size={26} style={{ color: "var(--label-2)" }} />
          </div>
          <div className="text-[18px] font-bold">Открытых позиций нет</div>
          <p className="text-[14px] mt-1.5" style={{ color: "var(--label-2)" }}>
            Откройте сделку из ленты сигналов на Главной — она появится здесь, и её
            можно будет вести: двигать ТП, докупать и закрывать.
          </p>
        </div>
      )}

      <div className="px-3 flex flex-col gap-2.5">
        {list.map((p) => (
          <Glass key={p.id} flat className="rounded-[18px] p-3.5">
            <Press onClick={() => onOpen({
              signalId: p.signal_id, tokenAddr: p.token_addr, symbol: p.symbol, name: p.name,
            })} className="block w-full">
              <div className="flex items-center gap-3">
                <TokenLogo symbol={p.symbol} size={42} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[16px] font-bold shrink-0">{p.symbol}</span>
                    <span className="text-[12px] truncate" style={{ color: "var(--label-2)" }}>{p.name}</span>
                  </div>
                  <div className="text-[12px] mt-0.5" style={{ color: "var(--label-3)" }}>
                    {ago(p.opened_ts * 1000)} · размер {money(p.usd_in)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[17px] font-bold tabular-nums"
                       style={{ color: p.pnl_pct >= 0 ? "var(--green)" : "var(--red)" }}>
                    {pct(p.pnl_pct)}
                  </div>
                  <div className="text-[12px] tabular-nums" style={{ color: "var(--label-2)" }}>
                    {money(p.pnl_usd, true)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3">
                <Cell label="Вход" value={`$${fmtPrice(p.entry_price)}`} />
                <Cell label="Текущая" value={`$${fmtPrice(p.current_price)}`} />
                <Cell label="Цель 2" value={`$${fmtPrice(p.tp_price)}`}
                      tone="var(--green)" />
              </div>

              {/* Обе цели явно: триггер фиксации половины и остаток до цели 2. */}
              {settings.data && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] leading-snug"
                     style={{ color: "var(--label-3)" }}>
                  <span>Фиксация {Math.round(settings.data.free_ride.tp1_fraction * 100)}% на +{settings.data.free_ride.tp1_percent}%</span>
                  <span>Остаток до +{Math.round(p.tp_percent)}%</span>
                </div>
              )}

              {(p.free_ride_done || p.status === "free_ride") && (
                <div className="mt-2.5 flex items-center gap-1.5">
                  <span className="text-[11px] px-2 py-0.5 rounded-md font-semibold inline-flex items-center gap-1"
                        style={{ background: "color-mix(in srgb, var(--green) 16%, transparent)", color: "var(--green)" }}>
                    <TrendingUp size={12} /> Free Ride
                  </span>
                  <span className="text-[11px] px-2 py-0.5 rounded-md font-semibold"
                        style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>
                    риск $0
                  </span>
                </div>
              )}
            </Press>

            {/* График — отдельным действием, а не через тап по карточке: за ним
                идут, чтобы вести цель, и открывать его надо сразу, без лишнего
                экрана посередине. */}
            <div className="flex gap-2 mt-3">
              <Press onClick={() => onOpen({
                signalId: p.signal_id, tokenAddr: p.token_addr, symbol: p.symbol, name: p.name, chart: true,
              })} className="flex-1">
                <div className="py-2.5 rounded-[12px] text-center text-[14px] font-semibold glass glass-flat">
                  График
                </div>
              </Press>
              <Press onClick={() => close(p, 0.5)} disabled={busy === p.id} className="flex-1">
                <div className="py-2.5 rounded-[12px] text-center text-[14px] font-semibold"
                     style={{ background: "var(--bg-elev)" }}>Закрыть 50%</div>
              </Press>
              <Press onClick={() => close(p, 1)} disabled={busy === p.id} className="flex-1">
                <div className="py-2.5 rounded-[12px] text-center text-[14px] font-semibold"
                     style={{ background: "color-mix(in srgb, var(--red) 16%, transparent)", color: "var(--red)" }}>
                  Всё
                </div>
              </Press>
            </div>
          </Glass>
        ))}
      </div>

      {/* Лента алертов — только когда есть что показывать. */}
      {unseen.length > 0 && (
        <div className="px-3 mt-5">
          <div className="px-2 pb-2 text-[13px] uppercase tracking-wide font-medium"
               style={{ color: "var(--label-2)" }}>
            События · {unseen.length}
          </div>
          <div className="flex flex-col gap-2">
            {unseen.map((a) => <AlertRow key={a.id} a={a} onSeen={() => markSeen(a)} />)}
          </div>
        </div>
      )}

      {alerts.error && unseen.length === 0 && (
        <div className="px-5 mt-4 text-[12px]" style={{ color: "var(--label-3)" }}>
          алерты недоступны: {alerts.error}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-[10px] px-2.5 py-2" style={{ background: "var(--bg-elev)" }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--label-3)" }}>{label}</div>
      <div className="text-[13px] font-medium tabular-nums mt-0.5" style={{ color: tone || "var(--label)" }}>
        {value}
      </div>
    </div>
  );
}

const ALERT_META: Record<AlertKind, { label: string; Icon: typeof Timer; tone: string }> = {
  free_ride: { label: "Free Ride", Icon: TrendingUp, tone: "var(--green)" },
  time_stop: { label: "Time-stop", Icon: Timer, tone: "var(--orange)" },
  liq_drain: { label: "Слив ликвидности", Icon: Droplets, tone: "var(--red)" },
  tp_reached: { label: "Достигнут ТП", Icon: AlertTriangle, tone: "var(--tint)" },
};

function AlertRow({ a, onSeen }: { a: Alert; onSeen: () => void }) {
  const meta = ALERT_META[a.kind] ?? ALERT_META.tp_reached;
  const critical = a.severity === "critical";
  return (
    <Glass flat className="rounded-[16px] p-3.5"
           style={critical ? { border: "1px solid color-mix(in srgb, var(--red) 45%, transparent)" } : undefined}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 flex items-center justify-center w-7 h-7 rounded-full"
              style={{ background: `color-mix(in srgb, ${meta.tone} 16%, transparent)`, color: meta.tone }}>
          <meta.Icon size={15} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold" style={{ color: meta.tone }}>{meta.label}</span>
            <span className="text-[12px] font-bold" style={{ color: "var(--label-2)" }}>{a.symbol}</span>
            {critical && (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase"
                    style={{ background: "var(--red)", color: "#fff" }}>важно</span>
            )}
          </div>
          <p className="text-[13px] mt-1 leading-snug" style={{ color: "var(--label-2)" }}>{a.message}</p>
          <div className="text-[11px] mt-1" style={{ color: "var(--label-3)" }}>{ago(a.ts * 1000)}</div>
        </div>
      </div>
      <Press onClick={onSeen} className="block w-full mt-2.5">
        <div className="py-2 rounded-[10px] text-center text-[13px] font-semibold"
             style={{ background: "var(--bg-elev)" }}>Отметить просмотренным</div>
      </Press>
    </Glass>
  );
}
