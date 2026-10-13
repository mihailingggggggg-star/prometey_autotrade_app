/**
 * Детальный экран монеты (§9.2) — сверху вниз:
 *   график → терминал → индикаторы → чек-лист фильтров → описание → соцсети.
 *
 * Здесь живут две вещи, которых нет больше нигде: перетаскиваемая линия ТП
 * (сохранение через /api/positions/:id/tp) и быстрый вход в Free Riding.
 *
 * Все действия (покупка, докупка, закрытие, перенос ТП) берут результат из
 * ОТВЕТА сервера и перечитывают позиции: своё представление о позиции здесь не
 * источник правды. Отказ показывается текстом с причиной.
 */
import { useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import {
  ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, ExternalLink,
  MessageCircle, ShieldCheck, ShieldAlert, XCircle,
} from "lucide-react";
import {
  getSignal, listEvents, listPositions, openPosition, addToPosition, closePosition,
  setTp as apiSetTp, getSettings,
} from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Check, DataMode, Indicators, Position, SignalDetail, TokenEvent } from "../../shared/types";
import { eventTone, eventTitle, formatMetrics } from "../lib/events";
import { Glass, Press, Segmented, Modal } from "../ui/kit";
import { PriceChart } from "../ui/PriceChart";
import { TokenLogo } from "../ui/TokenLogo";
import { ErrorBox, KV, Loading, Panel, DemoBanner } from "../ui/states";
import { dt, money, pct, price as fmtPrice } from "../lib/format";
import { ChartScreen } from "./ChartScreen";

/** Что за монета открыта. `signalId` может отсутствовать: позицию открывали
 *  без сигнала, и тогда чек-лист/описание недоступны — это не ошибка.
 *  `chart` — открыть сразу на графике (так карточка позиции ведёт в график). */
export interface CoinRef {
  signalId: number | null;
  tokenAddr: string;
  symbol: string;
  name: string;
  chart?: boolean;
}

const AMOUNTS = [10, 25, 50, 100];

export function CoinDetail({ coin, onBack, onChanged, mode }: {
  coin: CoinRef;
  onBack: () => void;
  onChanged: () => void;
  /** Режим данных: в mock над карточкой стоит плашка «демо-данные». */
  mode?: DataMode | null;
}) {
  // Полноэкранный график: по умолчанию открыт, если карточку позвали из
  // позиции (там человек шёл именно за графиком).
  const [chartOpen, setChartOpen] = useState(Boolean(coin.chart));
  const sig = useApi<SignalDetail | null>(
    () => (coin.signalId != null ? getSignal(coin.signalId) : Promise.resolve(null)),
    15000,
    [coin.signalId],
  );
  const positions = useApi(() => listPositions(), 15000, []);
  const settings = useApi(getSettings, 0, []);
  // События-отборщики именно по этой монете — источник ответа «почему в ленте».
  // Опрашивается вместе с сигналом: событие может появиться и после открытия.
  const events = useApi(() => listEvents({ token: coin.tokenAddr }), 15000, [coin.tokenAddr]);

  // Позиция именно по этой монете и именно открытая — закрытые в терминале не
  // участвуют (их результат уже посчитан в аналитике).
  const pos: Position | null = useMemo(
    () => positions.data?.find((p) => p.token_addr === coin.tokenAddr && p.status !== "closed") ?? null,
    [positions.data, coin.tokenAddr],
  );

  /* ── терминал ── */
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState(25);
  const [custom, setCustom] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const slip = settings.data
    ? `проскальзывание ${settings.data.demo.slippage_min_pct}–${settings.data.demo.slippage_max_pct}% + комиссия пула ${settings.data.demo.pool_fee_pct}%`
    : "издержки удерживаются при входе и выходе";

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await fn());
      positions.refresh();
      onChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const buy = () => run(async () => {
    if (coin.signalId == null) throw new Error("у этой монеты нет сигнала — покупка недоступна");
    const p = await openPosition({
      signal_id: coin.signalId,
      usd: amount,
      order_type: orderType,
      limit_price: orderType === "limit" ? Number(limitPrice) || undefined : undefined,
      tp_mode: "free_ride",
    });
    return `Открыта позиция ${p.symbol}: ${money(p.usd_in)} по $${fmtPrice(p.entry_price)}`;
  });

  const add = () => run(async () => {
    if (!pos) throw new Error("нет открытой позиции");
    const p = await addToPosition(pos.id, amount);
    return `Докуплено ${money(amount)} — средняя цена $${fmtPrice(p.entry_price)}`;
  });

  const closeAll = () => run(async () => {
    if (!pos) throw new Error("нет открытой позиции");
    const r = await closePosition(pos.id, 1);
    return `Позиция закрыта по рынку: ${money(r.position.realized_usd, true)}`;
  });

  const saveTp = (p: number) => {
    if (!pos) return;
    void run(async () => {
      await apiSetTp(pos.id, p);
      return `ТП перенесён на $${fmtPrice(p)}`;
    });
  };

  const livePrice = pos?.current_price || sig.data?.signal.price || 0;

  return (
    <div className="absolute inset-0 z-50 flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Шапка: назад + монета + живая цена/PnL */}
      <div className="shrink-0 px-3 pt-2 pb-2 flex items-center gap-3 hairline"
           style={{ paddingTop: "calc(var(--safe-t) + 6px)" }}>
        <Press onClick={onBack} aria-label="Назад" className="rounded-full p-1.5 shrink-0">
          <span className="flex items-center justify-center w-9 h-9 rounded-full"
                style={{ background: "var(--bg-elev)" }}>
            <ArrowLeft size={18} />
          </span>
        </Press>
        <TokenLogo symbol={coin.symbol} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[17px] font-bold shrink-0">{coin.symbol}</span>
            <span className="text-[13px] truncate" style={{ color: "var(--label-2)" }}>{coin.name}</span>
          </div>
          <div className="text-[13px] tabular-nums" style={{ color: "var(--label-2)" }}>
            ${fmtPrice(livePrice)}
            {pos && (
              <span style={{ color: pos.pnl_pct >= 0 ? "var(--green)" : "var(--red)" }}>
                {"  "}{pct(pos.pnl_pct)}{" · "}{money(pos.pnl_usd, true)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* mock — придуманные числа нельзя принять за рынок. В live плашки нет. */}
      {mode === "mock" && <div className="pt-3"><DemoBanner /></div>}

      <div className="scroll flex-1 min-h-0" style={{ overscrollBehavior: "contain" }}>
        {/* ГРАФИК (встроенный) — тап по значку разворачивает его на весь экран. */}
        <div className="pt-3">
          <PriceChart
            token={coin.tokenAddr}
            symbol={coin.symbol}
            position={pos}
            tp2Percent={settings.data?.free_ride.tp2_percent}
            onTpChange={pos ? saveTp : undefined}
            onExpand={() => setChartOpen(true)}
          />
        </div>

        {notice && (
          <div className="mx-5 mt-3 text-[13px] leading-snug px-3 py-2 rounded-[12px]"
               style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>
            {notice}
          </div>
        )}

        {/* ТЕРМИНАЛ */}
        <div className="px-3 mt-3">
          <Panel title="Терминал">
            <Segmented
              value={orderType}
              onChange={setOrderType}
              options={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]}
            />

            {orderType === "limit" && (
              <div className="mt-3">
                <div className="text-[13px] mb-1" style={{ color: "var(--label-2)" }}>Цена лимитной заявки, USDT</div>
                <input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value.replace(/[^\d.]/g, ""))}
                       inputMode="decimal" placeholder={String(fmtPrice(livePrice))}
                       className="w-full px-3 py-2.5 rounded-[12px] text-[16px] tabular-nums outline-none"
                       style={{ background: "var(--bg-elev)", color: "var(--label)" }} />
              </div>
            )}

            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {AMOUNTS.map((a) => (
                <Press key={a} onClick={() => { setAmount(a); setCustom(""); }}>
                  <div className="px-3.5 py-2 rounded-[12px] text-[15px] font-semibold tabular-nums"
                       style={{ background: amount === a && !custom ? "var(--tint-grad)" : "var(--bg-elev)",
                                color: amount === a && !custom ? "#fff" : "var(--label)" }}>
                    ${a}
                  </div>
                </Press>
              ))}
              <input value={custom}
                     onChange={(e) => {
                       const v = e.target.value.replace(/[^\d.]/g, "");
                       setCustom(v);
                       const n = Number(v);
                       if (n > 0) setAmount(n);
                     }}
                     inputMode="decimal" placeholder="своя сумма"
                     className="flex-1 min-w-[92px] px-3 py-2 rounded-[12px] text-[15px] tabular-nums outline-none"
                     style={{ background: "var(--bg-elev)", color: "var(--label)" }} />
            </div>

            {/* Позиция уже есть — вторая покупка по той же монете запрещена сервером
                (409 position_exists), поэтому вместо «Купить» показываем «Докупить»:
                одна кнопка, а не две конкурирующие. */}
            {pos ? (
              <div className="mt-3 flex gap-2">
                <Press onClick={add} disabled={busy} className="flex-1">
                  <div className="py-3.5 rounded-[14px] text-center text-[16px] font-semibold text-white"
                       style={{ background: "var(--tint-grad)", opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Выполняем…" : `Докупить ${money(amount).replace("+", "")}`}
                  </div>
                </Press>
                <Press onClick={closeAll} disabled={busy} className="flex-1">
                  <div className="py-3.5 rounded-[14px] text-center text-[16px] font-semibold"
                       style={{ background: "color-mix(in srgb, var(--red) 16%, transparent)", color: "var(--red)" }}>
                    Закрыть всю позицию
                  </div>
                </Press>
              </div>
            ) : (
              <Press onClick={buy} disabled={busy || !amount} className="block w-full mt-3">
                <div className="py-3.5 rounded-[14px] text-center text-[16px] font-semibold text-white"
                     style={{ background: "var(--tint-grad)", opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Выполняем…" : `Купить токен (USDT) · ${money(amount).replace("+", "")}`}
                </div>
              </Press>
            )}

            {/* Обе цели явно: триггер фиксации половины (настройка) и остаток
                до цели 2 (tp_percent самой позиции — на графике одна линия ТП). */}
            {pos && settings.data && (
              <div className="mt-3 pt-2 flex flex-col gap-0.5 text-[13px]"
                   style={{ borderTop: "0.5px solid var(--separator)", color: "var(--label-2)" }}>
                <div>Фиксация {Math.round(settings.data.free_ride.tp1_fraction * 100)}% на +{settings.data.free_ride.tp1_percent}%</div>
                <div>Остаток до +{Math.round(pos.tp_percent)}%</div>
              </div>
            )}

            <div className="mt-2 text-[12px] leading-snug" style={{ color: "var(--label-3)" }}>
              Расчётное {slip}. Итог по позиции — net, после всех издержек.
            </div>
          </Panel>
        </div>

        {/* ПОЧЕМУ В ЛЕНТЕ: сработавшие события-отборщики именно по этой монете —
            подпись, конкретика, время и измеренные значения. Блок существует
            ТОЛЬКО при непустом списке: у рядового планового скана «причин» нет,
            и пустая рамка только занимала бы место на экране. */}
        {events.data && events.data.length > 0 && (
          <div className="px-3 mt-3">
            <Panel title="Почему в ленте">
              <div className="flex flex-col">
                {events.data.map((e, i) => (
                  <EventRow key={e.id} e={e} last={i === events.data!.length - 1} />
                ))}
              </div>
            </Panel>
          </div>
        )}

        {/* СОСТОЯНИЕ СИГНАЛА: индикаторы + чек-лист */}
        {coin.signalId == null ? (
          <div className="px-5 mt-4 text-[13px]" style={{ color: "var(--label-3)" }}>
            Монета открыта без сигнала скринера — чек-лист и описание недоступны.
          </div>
        ) : sig.loading && !sig.data ? (
          <Loading label="загружаем карточку сигнала…" />
        ) : sig.error ? (
          <ErrorBox text={sig.error} onRetry={sig.refresh} />
        ) : sig.data ? (
          <>
            <div className="px-3 mt-3">
              <Panel title="Индикаторы">
                <IndicatorsBlock ind={sig.data.indicators} />
              </Panel>
            </div>

            <div className="px-3 mt-3">
              <Panel title="Фильтры воронки"
                     right={<span className="text-[12px]" style={{ color: "var(--label-3)" }}>
                       {sig.data.checks.filter((c) => c.ok).length}/{sig.data.checks.length} пройдено
                     </span>}>
                <div className="flex flex-col divide-y" style={{ borderColor: "transparent" }}>
                  {sig.data.checks.map((c) => <CheckRow key={`${c.layer}-${c.code}`} c={c} />)}
                </div>
              </Panel>
            </div>

            <Overview text={sig.data.overview_ru} />
            <SocialTeaser social={sig.data.social} />
          </>
        ) : null}

        <div style={{ height: "calc(var(--safe-b) + 24px)" }} />
      </div>

      {/* ПОЛНОЭКРАННЫЙ ГРАФИК — поверх карточки, но под её шапкой не прячется:
          отдельное наложение своего уровня. */}
      <AnimatePresence>
        {chartOpen && (
          <ChartScreen
            key="chart"
            token={coin.tokenAddr}
            symbol={coin.symbol}
            name={coin.name}
            position={pos}
            tp2Percent={settings.data?.free_ride.tp2_percent}
            onTpChange={pos ? saveTp : undefined}
            onBack={() => setChartOpen(false)}
            mode={mode}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function fmtVal(v: Check["value"]): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (typeof v === "number") return v.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
  return v;
}

/** Строка события-отборщика: цветная точка и подпись по тону кода, справа —
 *  время (в поясе отчётности, как везде), ниже конкретика и измеренные значения
 *  монотипно, чтобы числа читались столбцом, а не как часть фразы. */
function EventRow({ e, last }: { e: TokenEvent; last?: boolean }) {
  const tint = eventTone(e.code);
  const metrics = formatMetrics(e.metrics);
  return (
    <div className={`flex items-start gap-2.5 py-2.5 ${last ? "" : "hairline"}`}>
      <span className="mt-1.5 shrink-0 w-2 h-2 rounded-full" style={{ background: tint }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-semibold leading-snug" style={{ color: tint }}>
            {eventTitle(e)}
          </span>
          <span className="text-[12px] tabular-nums shrink-0" style={{ color: "var(--label-3)" }}>
            {dt(e.ts * 1000)}
          </span>
        </div>
        {e.note && (
          <div className="text-[13px] mt-0.5 leading-snug" style={{ color: "var(--label-2)" }}>{e.note}</div>
        )}
        {metrics && (
          <div className="text-[12px] mt-0.5 tabular-nums" style={{ color: "var(--label-3)" }}>{metrics}</div>
        )}
      </div>
    </div>
  );
}

function CheckRow({ c }: { c: Check }) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      <span className="mt-0.5 shrink-0" style={{ color: c.ok ? "var(--green)" : "var(--red)" }}>
        {c.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] leading-snug">{c.label_ru}</div>
        <div className="text-[12px] tabular-nums mt-0.5" style={{ color: "var(--label-3)" }}>
          значение {fmtVal(c.value)} · порог {c.threshold}
        </div>
      </div>
      <span className="text-[11px] px-1.5 py-0.5 rounded-md shrink-0"
            style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>
        слой {c.layer}
      </span>
    </div>
  );
}

function IndicatorsBlock({ ind }: { ind: Indicators }) {
  const money0 = (v: number) => (v >= 0 ? "" : "−") + "$" + Math.abs(v).toLocaleString("ru-RU", { maximumFractionDigits: 0 });
  return (
    <div className="flex flex-col">
      <KV label="Сжатие диапазона (SVD)" value={`${Math.round(ind.svd)} / 100`} mono />
      <KV label="Он-чейн объём, 24ч" value={money0(ind.onchain_volume_usd)} mono />
      <KV label="Приток ликвидности, 24ч" value={money0(ind.liquidity_flow_usd)} mono
          tone={ind.liquidity_flow_usd >= 0 ? "var(--green)" : "var(--red)"} />
      <KV label="Рост холдеров, 7д" value={pct(ind.holders_growth_pct)} mono />
      <KV label="Уникальные мейкеры, 24ч" value={ind.makers_24h.toLocaleString("ru-RU")} mono />
      <KV label="Средняя сделка" value={money0(ind.avg_trade_usd)} mono />
      <KV label="Доля топ-10 холдеров" value={`${ind.top10_holders_pct}%`} mono />
      <KV label="Падение от ATH" value={`−${ind.drawdown_from_ath_pct}%`} mono />
      <KV label="Коридор накопления" value={`±${ind.range_pct}%`} mono />
    </div>
  );
}

function Overview({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="px-3 mt-3">
      <Panel>
        <Press onClick={() => setOpen((o) => !o)} className="block w-full">
          <div className="flex items-center justify-between">
            <div className="text-[13px] uppercase tracking-wide font-medium" style={{ color: "var(--label-2)" }}>
              О проекте
            </div>
            {open ? <ChevronUp size={18} style={{ color: "var(--label-2)" }} />
                  : <ChevronDown size={18} style={{ color: "var(--label-2)" }} />}
          </div>
        </Press>
        {open && (
          <p className="text-[14px] mt-2 leading-relaxed whitespace-pre-line" style={{ color: "var(--label)" }}>
            {text}
          </p>
        )}
      </Panel>
    </div>
  );
}

function SocialTeaser({ social }: { social: SignalDetail["social"] }) {
  const [open, setOpen] = useState(false);
  const organic = social.is_organic;
  return (
    <div className="px-3 mt-3">
      <Press onClick={() => setOpen(true)} className="block w-full">
        <Glass flat className="rounded-[18px] p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <MessageCircle size={16} style={{ color: "var(--label-2)" }} />
            <span className="text-[13px] uppercase tracking-wide font-medium" style={{ color: "var(--label-2)" }}>
              Соцсети
            </span>
            <span className="ml-auto flex items-center gap-1 text-[12px] font-semibold"
                  style={{ color: organic ? "var(--green)" : "var(--orange)" }}>
              {organic ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
              {organic ? "органика" : "накрутка"}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[22px] font-bold tabular-nums"
                  style={{ color: social.sentiment >= 6 ? "var(--green)" : "var(--orange)" }}>
              {social.sentiment}/10
            </span>
            <span className="text-[12px]" style={{ color: "var(--label-3)" }}>
              сентимент · {social.mentions.length} упоминаний
            </span>
          </div>
          {social.summary && (
            <p className="text-[13px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
              {social.summary}
            </p>
          )}
        </Glass>
      </Press>

      <Modal open={open} onClose={() => setOpen(false)}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[18px] font-bold">Упоминания</div>
          <span className="text-[13px] tabular-nums" style={{ color: "var(--label-2)" }}>
            сентимент {social.sentiment}/10
          </span>
        </div>
        {social.mentions.length === 0 && (
          <div className="text-[14px]" style={{ color: "var(--label-3)" }}>лента упоминаний пуста</div>
        )}
        <div className="flex flex-col divide-y" style={{ borderColor: "transparent" }}>
          {social.mentions.map((m, i) => (
            <a key={`${m.ts}-${i}`} href={m.url || "#"} target="_blank" rel="noreferrer noopener"
               className="py-2.5 flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0 text-[12px] font-bold tabular-nums w-8 text-center rounded-md py-0.5"
                    style={{ background: "var(--bg-elev)", color: m.score >= 6 ? "var(--green)" : "var(--orange)" }}>
                {m.score}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] leading-snug">{m.title}</div>
                <div className="text-[12px] mt-0.5" style={{ color: "var(--label-3)" }}>
                  {m.source} · {dt(m.ts * 1000)}
                </div>
              </div>
              <ExternalLink size={15} className="shrink-0 mt-0.5" style={{ color: "var(--label-3)" }} />
            </a>
          ))}
        </div>
      </Modal>
    </div>
  );
}
