/**
 * Карточка сигнала — одна монета в ленте.
 *
 * Вынесена из ленты (screens/Feed) в общий примитив, потому что лента теперь
 * живёт в ДВУХ местах: на Главной (ниже карточки результата и быстрых действий)
 * и на вкладке «Сигналы». Две копии одной разметки неизбежно разошлись бы, а
 * карточка обязана выглядеть ОДИНАКОВО в обоих местах — поэтому разметка
 * перенесена как есть, без перерисовки.
 *
 * Карточка отвечает на три вопроса сразу: ЧТО нашли (тикер, имя, цена), ПОЧЕМУ
 * оно здесь (плашка фазы накопления) и НАСКОЛЬКО это сильное (скоринг, сентимент)
 * — числовые строки показаны через `Row`, как во всём приложении. Клик открывает
 * детальный экран монеты.
 *
 * Разметка держится на общих примитивах (ui/kit): `Glass`, `Row`, `Press`.
 * Своего «панельного» языка у карточки нет — иначе она выбивалась бы из
 * остальных экранов.
 */
import type { Signal } from "../../shared/types";
import { Glass, Press, Row } from "./kit";
import { TokenLogo } from "./TokenLogo";
import { price, ago } from "../lib/format";
import type { CoinRef } from "../screens/CoinDetail";

export function SignalCard({ s, onOpen }: {
  s: Signal;
  /** Клик по карточке открывает детальный экран монеты, как на вкладке «Сигналы». */
  onOpen?: (ref: CoinRef) => void;
}) {
  const organic = s.is_organic;
  return (
    <Press
      onClick={() => onOpen?.({
        signalId: s.id, tokenAddr: s.token_addr, symbol: s.symbol, name: s.name,
      })}
      className="block w-full" scale={0.975} feel="press">
      <Glass flat className="overflow-hidden">
        {/* Шапка: ЧТО нашли — знак, тикер, имя, цена и давность. */}
        <div className="px-4 pt-3.5 pb-3 flex items-center gap-3">
          <TokenLogo symbol={s.symbol} size={44} />
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-semibold tracking-tight truncate">{s.symbol}</div>
            <div className="text-[13px] truncate" style={{ color: "var(--label-2)" }}>{s.name}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[16px] font-semibold tabular-nums">${price(s.price)}</div>
            <div className="text-[11px] tabular-nums" style={{ color: "var(--label-3)" }}>{ago(s.ts * 1000)}</div>
          </div>
        </div>

        {/* ПОЧЕМУ оно здесь: плашка фазы и, если нужно, отметка «не органика». */}
        <div className="px-4 pb-1 flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] px-1.5 py-0.5 rounded-md font-semibold"
                style={{ background: "color-mix(in srgb, var(--green) 16%, transparent)", color: "var(--green)" }}>
            {s.status_label || "Фаза накопления подтверждена"}
          </span>
          {!organic && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-md font-medium"
                  style={{ background: "color-mix(in srgb, var(--orange) 14%, transparent)", color: "var(--orange)" }}>
              не органика
            </span>
          )}
        </div>

        {/* Числа — строками, а не самодельной сеткой: тот же язык, что в кабинете. */}
        <div className="mt-2.5">
          <Row title="Скоринг"
               right={<span className="tabular-nums font-semibold" style={{ color: "var(--label)" }}>{s.score}</span>} />
          <Row title="Сентимент"
               right={<span className="tabular-nums"
                             style={{ color: s.sentiment >= 6 ? "var(--green)" : "var(--orange)" }}>
                 {s.sentiment}/10
               </span>} />
          <Row last title="Таймфрейм" right={s.tf_accum} />
        </div>
      </Glass>
    </Press>
  );
}
