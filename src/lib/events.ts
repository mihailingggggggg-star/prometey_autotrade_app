/**
 * Словарь событий-отборщиков: код → короткая подпись и цветовой тон.
 *
 * Зачем отдельный модуль. Сервер шлёт две подписи: короткий машинный код
 * (`EventCode`) и длинный человеческий `label_ru` («сухой всплеск: объём вырос,
 * цена стоит»). В компактных местах (плашка причины в ленте, строка на Главной)
 * длинная подпись не влезает и пестрит — там нужна короткая и одинаковая для
 * одного и того же кода. В просторном месте (карточка монеты) длинная подпись
 * наоборот полезна. Поэтому словарь живёт здесь, а длинный `label_ru` клиент не
 * выбрасывает: он показывается там, где ему есть место.
 *
 * Тона — из токенов темы (theme.css). Своих цветов не заводим: иначе палитра
 * расползлась бы по экранам и разошлась с единственной тёмной темой.
 */
import type { EventCode, TokenEvent } from "../../shared/types";

/** Короткая подпись: влезает в плашку и одинаково читается везде. */
export const EVENT_LABELS: Record<EventCode, string> = {
  dry_spike: "сухой всплеск",
  breakout: "пробой коридора",
  lp_inflow: "приток ликвидности",
  holders_accel: "рост холдеров",
  new_pool: "новый пул",
  safety_cleared: "права отозваны",
  large_buyer: "крупные покупки",
};

/** Цветовой тон текста и точки плашки — роль события, а не украшение. */
export const EVENT_TONES: Record<EventCode, string> = {
  dry_spike: "var(--orange)",
  breakout: "var(--green)",
  lp_inflow: "var(--green)",
  holders_accel: "var(--green)",
  new_pool: "var(--orange)",
  safety_cleared: "var(--green)",
  large_buyer: "var(--yellow)",
};

/** Короткая подпись кода; неизвестный код отдаётся как есть, а не пустотой. */
export function eventLabel(code: EventCode): string {
  return EVENT_LABELS[code] ?? code;
}

/** Тон кода; неизвестный — нейтральный серый, чтобы не выдумывать цвет. */
export function eventTone(code: EventCode): string {
  return EVENT_TONES[code] ?? "var(--label-2)";
}

/** Число метрики — монотипно и без хвоста нулей: крупные без копеек, мелкие с
 *  запасом. Округление здесь только для ПОКАЗА, расчёт не трогаем. */
function fmtMetric(v: number): string {
  const abs = Math.abs(v);
  const d = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return v.toLocaleString("ru-RU", { maximumFractionDigits: d });
}

/** Измеренные значения события одной строкой: «ключ значение · ключ значение».
 *  Пустые (null) пропускаем — это «не измерено», а не ноль. */
export function formatMetrics(metrics?: Record<string, number | null>): string {
  if (!metrics) return "";
  return Object.entries(metrics)
    .filter(([, v]) => v !== null && v !== undefined && Number.isFinite(v))
    .map(([k, v]) => `${k} ${fmtMetric(v as number)}`)
    .join(" · ");
}

/** Подпись события для просторного места: длинная, если сервер её дал. */
export function eventTitle(e: TokenEvent): string {
  return e.label_ru || eventLabel(e.code);
}
