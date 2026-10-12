/**
 * Лента сигналов — главный экран (§9.1).
 *
 * Карточка отвечает на три вопроса сразу: ЧТО нашли (тикер, имя, цена), ПОЧЕМУ
 * оно здесь (плашка фазы накопления + скоринг) и НАСКОЛЬКО живое (сентимент).
 * Клик открывает детальный экран.
 *
 * Пустая лента и лента, которую съел сбой, ВЫГЛЯДЯТ по-разному: у пустой есть
 * объяснение и кнопка «Сканировать», у сбоя — текст причины. Молчаливая пустота
 * неотличима от поломки, поэтому её здесь нет.
 */
import { useState } from "react";
import { Radar, Search } from "lucide-react";
import { listSignals, scan } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Signal } from "../../shared/types";
import { Glass, Press, Title } from "../ui/kit";
import { TokenLogo } from "../ui/TokenLogo";
import { Loading, ErrorBox } from "../ui/states";
import { price, ago } from "../lib/format";
import type { CoinRef } from "./CoinDetail";

export function Feed({ refreshKey, onOpen }: {
  refreshKey: number;
  onOpen: (ref: CoinRef) => void;
}) {
  // Опрос раз в 20 с: в mock-режиме сигналы появляются и уходят по виртуальным
  // часам, лента обязана это показывать без перезагрузки.
  const { data, error, loading, refresh } = useApi(() => listSignals({ limit: 60 }), 20000, [refreshKey]);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const runScan = async () => {
    setScanning(true);
    setNotice(null);
    try {
      const res = await scan();
      setNotice(res.found > 0
        ? `скан нашёл ${res.found} новых сигналов`
        : "скан не нашёл новых монет — попробуйте позже");
      refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="pb-3">
      <Title sub="Токены в фазе накопления">Сигналы</Title>

      {/* Кнопка скана и результат — на одной строке, чтобы не занимать экран. */}
      <div className="px-5 pb-3 flex items-center gap-2">
        <Press onClick={runScan} disabled={scanning} className="flex-1">
          <div className="flex items-center justify-center gap-2 py-3 rounded-[16px] text-[16px] font-semibold text-white"
               style={{ background: "var(--tint-grad)" }}>
            {scanning ? <Radar size={18} className="animate-spin" /> : <Search size={18} />}
            {scanning ? "Сканируем…" : "Сканировать"}
          </div>
        </Press>
      </div>
      {notice && (
        <div className="px-5 pb-2 text-[13px]" style={{ color: "var(--label-2)" }}>{notice}</div>
      )}

      {loading && !data && <Loading label="загружаем ленту сигналов…" />}
      {!loading && error && <ErrorBox text={error} onRetry={refresh} />}

      {data && data.length === 0 && !error && (
        <Empty onScan={runScan} scanning={scanning} />
      )}

      {data && data.length > 0 && (
        <div className="px-3 flex flex-col gap-2">
          {data.map((s) => (
            <Press key={s.id} onClick={() => onOpen({
              signalId: s.id, tokenAddr: s.token_addr, symbol: s.symbol, name: s.name,
            })}>
              <SignalCard s={s} />
            </Press>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalCard({ s }: { s: Signal }) {
  const organic = s.is_organic;
  return (
    <Glass flat className="rounded-[18px] p-3 flex gap-3 items-center">
      <TokenLogo symbol={s.symbol} size={44} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[16px] font-bold shrink-0">{s.symbol}</span>
          <span className="text-[13px] truncate" style={{ color: "var(--label-2)" }}>{s.name}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="tabular-nums text-[14px] font-medium">${price(s.price)}</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded-md"
                style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>
            ТФ {s.tf_accum}
          </span>
          <span className="text-[11px]" style={{ color: "var(--label-3)" }}>{ago(s.ts * 1000)}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] px-1.5 py-0.5 rounded-md font-semibold"
                style={{ background: "color-mix(in srgb, var(--green) 16%, transparent)", color: "var(--green)" }}>
            {s.status_label || "Фаза накопления подтверждена"}
          </span>
          <span className="text-[11px] px-1.5 py-0.5 rounded-md font-medium"
                style={{ background: "var(--bg-elev)",
                         color: s.sentiment >= 6 ? "var(--green)" : "var(--orange)" }}>
            сентимент {s.sentiment}/10
          </span>
          {!organic && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-md font-medium"
                  style={{ background: "color-mix(in srgb, var(--orange) 14%, transparent)", color: "var(--orange)" }}>
              не органика
            </span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0 pl-1">
        <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--label-3)" }}>скор</div>
        <div className="text-[16px] font-bold tabular-nums">{s.score}</div>
      </div>
    </Glass>
  );
}

function Empty({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  return (
    <div className="px-6 pt-10 text-center">
      <div className="mx-auto mb-4 flex items-center justify-center w-14 h-14 rounded-full"
           style={{ background: "color-mix(in srgb, var(--tint) 14%, transparent)" }}>
        <Radar size={26} style={{ color: "var(--tint)" }} />
      </div>
      <div className="text-[18px] font-bold">Сигналов пока нет</div>
      <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
        Скринер ищет монеты, которые долго стоят в узком коридоре, у которых
        ликвидность не слита, а холдеры растут. Нажмите «Сканировать» — в
        mock-режиме появится несколько сигналов.
      </p>
      <Press onClick={onScan} disabled={scanning} className="inline-block mt-5">
        <div className="px-6 py-3 rounded-[16px] text-[16px] font-semibold text-white"
             style={{ background: "var(--tint-grad)" }}>
          {scanning ? "Сканируем…" : "Сканировать"}
        </div>
      </Press>
    </div>
  );
}
