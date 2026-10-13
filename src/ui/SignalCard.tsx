/**
 * Карточка сигнала — одна монета в ленте.
 *
 * Вынесена из ленты (бывший экран screens/Feed) в общий примитив: отдельной
 * вкладки «Сигналы» больше нет, вся лента живёт на Главной. Карточка остаётся
 * самостоятельным компонентом — её можно показать где угодно, не таща за собой
 * экран, — и обязана выглядеть одинаково везде.
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
import { eventLabel, eventTone } from "../lib/events";
import type { CoinRef } from "../screens/CoinDetail";

export function SignalCard({ s, onOpen }: {
  s: Signal;
  /** Клик по карточке открывает детальный экран монеты (карточка → график). */
  onOpen?: (ref: CoinRef) => void;
}) {
  const organic = s.is_organic;
  // Медиа оценено только тогда, когда есть сентимент: при выключенном фильтре
  // сервер отдаёт ноль, и это не оценка.
  const mediaChecked = s.sentiment > 0;
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

        {/* ПОЧЕМУ оно здесь: плашка фазы и отметка о медиа.
            Важно: пока фильтр по новостям выключен, сервер отдаёт sentiment 0 и
            is_organic=false — это ОТСУТСТВИЕ оценки, а не плохая оценка. Писать
            «не органика» по нулю значит обвинять монету в том, чего мы не
            проверяли; поэтому показываем отдельную нейтральную плашку. */}
        <div className="px-4 pb-1 flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] px-1.5 py-0.5 rounded-md font-semibold"
                style={{ background: "color-mix(in srgb, var(--green) 16%, transparent)", color: "var(--green)" }}>
            {s.status_label || "Фаза накопления подтверждена"}
          </span>
          {mediaChecked && !organic && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-md font-medium"
                  style={{ background: "color-mix(in srgb, var(--orange) 14%, transparent)", color: "var(--orange)" }}>
              не органика
            </span>
          )}
          {!mediaChecked && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-md font-medium"
                  style={{ background: "color-mix(in srgb, var(--label-3) 14%, transparent)", color: "var(--label-3)" }}>
              медиа не проверялось
            </span>
          )}
        </div>

        {/* ПОЧЕМУ монета в ленте: события-отборщики, если именно они её сюда
            привели (пусто — рядовой плановый скан, и тогда ряда нет вовсе).
            Отдельный ряд и НЕЙТРАЛЬНАЯ подложка (--bg-elev) с цветной точкой:
            он обязан отличаться от зелёной плашки фазы и от серой отметки о
            медиа — это другой ответ на другой вопрос. До трёх плашек: больше не
            влезает на 360px, а остальные причины видны в карточке монеты. */}
        {(s.events?.length ?? 0) > 0 && (
          <div className="px-4 pt-2 flex items-center gap-1.5 flex-wrap">
            {s.events!.slice(0, 3).map((code, i) => {
              const tint = eventTone(code);
              return (
                <span key={`${code}-${i}`}
                      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md font-semibold"
                      style={{ background: "var(--bg-elev)", color: tint }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tint }} />
                  {eventLabel(code)}
                </span>
              );
            })}
          </div>
        )}

        {/* Числа — строками, а не самодельной сеткой: тот же язык, что в кабинете. */}
        <div className="mt-2.5">
          <Row title="Скоринг"
               right={<span className="tabular-nums font-semibold" style={{ color: "var(--label)" }}>{s.score}</span>} />
          <Row title="Сентимент"
               right={<span className="tabular-nums"
                             style={{ color: !mediaChecked ? "var(--label-3)" : s.sentiment >= 6 ? "var(--green)" : "var(--orange)" }}>
                 {mediaChecked ? `${s.sentiment}/10` : "—"}
               </span>} />
          <Row last title="Таймфрейм" right={s.tf_accum} />
        </div>
      </Glass>
    </Press>
  );
}
