/**
 * Полноэкранный график монеты — открывается из карточки монеты (кнопка
 * «развернуть» на встроенном графике) и из карточки позиции.
 *
 * Это тот же `PriceChart`, что и в карточке, только растянутый на весь экран и
 * с полной навигацией: свечи + гистограмма объёма, переключатель ТФ
 * (1m/5m/1ч/1D), линия входа, перетаскиваемая линия цели 2, значок PnL по
 * открытой позиции и кнопка «Цель 2». Своего графика здесь нет намеренно:
 * вторая копия машинерии уровней и перетаскивания разъехалась бы с первой.
 *
 * Разметка — те же примитивы, что и везде: `Press`, `TokenLogo`, готовые цвета
 * темы. Никаких новых зависимостей.
 */
import { ArrowLeft } from "lucide-react";
import { motion } from "motion/react";
import type { DataMode, Position } from "../../shared/types";
import { Press, SPRING } from "../ui/kit";
import { PriceChart } from "../ui/PriceChart";
import { TokenLogo } from "../ui/TokenLogo";
import { DemoBanner } from "../ui/states";
import { money, pct, price as fmtPrice } from "../lib/format";

export function ChartScreen({
  token, symbol, name, position, tp2Percent, onBack, onTpChange, mode,
}: {
  token: string;
  symbol: string;
  name?: string;
  position: Position | null;
  /** Цель 2 (остаток) из настроек — та же, что ждёт движок. */
  tp2Percent?: number;
  onBack: () => void;
  /** Сохранение перенесённой линии цели (запрос делает вызывающий). */
  onTpChange?: (price: number) => void;
  mode?: DataMode | null;
}) {
  const livePrice = position?.current_price || 0;
  return (
    <motion.div
      initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
      transition={SPRING}
      className="absolute inset-0 z-[60] flex flex-col"
      style={{ background: "var(--bg)" }}>
      <div className="mesh" aria-hidden />

      {/* Шапка: назад, монета, живая цена и PnL по открытой позиции. */}
      <header className="relative z-10 shrink-0 px-3 pb-2 flex items-center gap-3 hairline"
              style={{ paddingTop: "calc(var(--safe-t) + 6px)" }}>
        <Press onClick={onBack} aria-label="Назад" className="rounded-full p-1.5 shrink-0">
          <span className="flex items-center justify-center w-9 h-9 rounded-full"
                style={{ background: "var(--bg-elev)" }}>
            <ArrowLeft size={18} />
          </span>
        </Press>
        <TokenLogo symbol={symbol} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[17px] font-bold shrink-0">{symbol}</span>
            {name && <span className="text-[13px] truncate" style={{ color: "var(--label-2)" }}>{name}</span>}
          </div>
          {position && (
            <div className="text-[13px] tabular-nums" style={{ color: "var(--label-2)" }}>
              ${fmtPrice(livePrice)}
              <span style={{ color: position.pnl_pct >= 0 ? "var(--green)" : "var(--red)" }}>
                {"  "}{pct(position.pnl_pct)}{" · "}{money(position.pnl_usd, true)}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* mock — придуманные свечи нельзя принять за рынок. */}
      {mode === "mock" && <div className="relative z-10 pt-3"><DemoBanner /></div>}

      <div className="relative z-10 flex-1 min-h-0 pt-2">
        <PriceChart
          token={token} symbol={symbol} position={position} full
          tp2Percent={tp2Percent} onTpChange={onTpChange}
        />
      </div>
    </motion.div>
  );
}
