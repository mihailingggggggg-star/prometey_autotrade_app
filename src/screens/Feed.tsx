/**
 * Лента сигналов — главный экран (§9.1).
 *
 * Карточка отвечает на три вопроса сразу: ЧТО нашли (тикер, имя, цена), ПОЧЕМУ
 * оно здесь (плашка фазы накопления) и НАСКОЛЬКО это сильное (скоринг, сентимент)
 * — числовые строки показаны через `Row`, как во всём приложении. Клик открывает
 * детальный экран монеты.
 *
 * Пустая лента и лента, которую съел сбой, ВЫГЛЯДЯТ по-разному: у пустой есть
 * объяснение и кнопка «Сканировать», у сбоя — текст причины. Молчаливая пустота
 * неотличима от поломки, поэтому её здесь нет.
 *
 * Разметка держится на общих примитивах (ui/kit): `Title`, `Glass`, `Row`,
 * `Press`. Своего «панельного» языка у ленты нет — иначе она выбивалась бы из
 * остальных экранов.
 */
import { useState } from "react";
import { Radar, Search } from "lucide-react";
import { listSignals, scan } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { DataMode } from "../../shared/types";
import { Glass, Press, Title } from "../ui/kit";
import { SignalCard } from "../ui/SignalCard";
import { Loading, ErrorBox, DemoBanner } from "../ui/states";
import type { CoinRef } from "./CoinDetail";

export function Feed({ refreshKey, onOpen, mode }: {
  refreshKey: number;
  onOpen: (ref: CoinRef) => void;
  /** Режим данных: в mock над лентой стоит плашка «демо-данные». */
  mode?: DataMode | null;
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
    <div className="pb-2">
      <Title sub="Токены в фазе накопления">Сигналы</Title>

      {/* mock — числа придуманы движком: говорим об этом ПРЯМО на ленте, чтобы
          выдуманный скор не приняли за рыночный. В live плашки нет. */}
      {mode === "mock" && <DemoBanner />}

      {/* Кнопка скана — стеклянная кнопка на всю ширину (Press добавляет
          `lg-press`, стекло даёт `Glass`). Результат — текстом под ней, чтобы
          не занимать экран отдельной плашкой. */}
      <div className="px-4">
        <Press onClick={runScan} disabled={scanning} className="block w-full">
          <Glass flat className="py-3.5 flex items-center justify-center gap-2 text-[16px] font-semibold">
            {scanning ? <Radar size={18} className="animate-spin" /> : <Search size={18} />}
            {scanning ? "Сканируем…" : "Сканировать"}
          </Glass>
        </Press>
        {notice && (
          <div className="mt-2 text-[13px]" style={{ color: "var(--label-2)" }}>{notice}</div>
        )}
      </div>

      {loading && !data && <Loading label="загружаем ленту сигналов…" />}
      {!loading && error && <ErrorBox text={error} onRetry={refresh} />}

      {data && data.length === 0 && !error && (
        <Empty onScan={runScan} scanning={scanning} />
      )}

      {data && data.length > 0 && (
        <div className="px-4 mt-3 space-y-2.5">
          {data.map((s) => (
            <SignalCard key={s.id} s={s} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  return (
    <div className="px-4 mt-3">
      <Glass className="p-8 text-center">
        <Radar size={34} className="mx-auto mb-3" style={{ color: "var(--label-3)" }} />
        <div className="text-[17px] font-semibold">Сигналов пока нет</div>
        <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
          Скринер ищет монеты, которые долго стоят в узком коридоре, у которых
          ликвидность не слита, а холдеры растут. Нажмите «Сканировать» — в
          mock-режиме появится несколько сигналов.
        </p>
        <Press onClick={onScan} disabled={scanning} className="inline-block mt-5">
          <Glass flat className="px-6 py-3 text-[16px] font-semibold">
            {scanning ? "Сканируем…" : "Сканировать"}
          </Glass>
        </Press>
      </Glass>
    </div>
  );
}
