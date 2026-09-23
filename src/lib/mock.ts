/**
 * Демо-данные. Взяты с реального журнала автотрейда 11–17.09, чтобы прототип
 * показывал живые пропорции, а не круглые выдуманные числа: с ними сразу видно,
 * что делать с длинными тикерами, дешёвыми монетами и минусовым PnL.
 *
 * ЦЕНЫ ЗДЕСЬ БОЛЬШЕ НЕ ХРАНЯТСЯ. Открытые позиции собираются вокруг НАСТОЯЩЕЙ
 * цены монеты в момент запуска (`buildPosition`), а не вокруг цены входа из
 * сентябрьского журнала: DGAI с тех пор ушла с 0.69 на 0.94, и позиция с
 * зашитым входом показывала бы +36% «прибыли», которой нет. Задаётся не цена, а
 * ГЕОМЕТРИЯ сделки — расстояние до стопа в процентах и то, на сколько R цена
 * уже ушла от входа; всё остальное считается от живой котировки.
 */
export type Side = "long" | "short";

export type Position = {
  id: string; symbol: string; side: Side; lev: number;
  entry: number; mark: number; sl: number; tp: number; be?: number;
  size: number; risk: number; openedAt: number; scheme: string;
  /** По какому сценарию контур вошёл. Сторона и монета отвечают «что и куда»,
   *  а сценарий — «почему мы здесь». */
  scenario?: string;
  /** Размер в долларах и замороженная маржа. Монеты человеку ни о чём не
   *  говорят: вопрос всегда «сколько денег в позиции». */
  notional?: number; margin?: number; marginFrom?: string;
  /** Нереализованный результат с биржи — для значка PnL на линии входа. */
  upl?: number;
  entryType?: "market" | "limit";
  /** Ступени фиксации целиком. У шорта их три, у лонга одна — рисовать одну
   *  цель там, где в стакане стоит лесенка, значит показать треть плана.
   *  `r`/`usd` — ожидание от ступени, `done` — взята ли (null = неизвестно). */
  tps?: { price: number; weight: number; r?: number; usd?: number;
          done?: boolean | null }[];
  /** ДЕНЬГИ СЧИТАЕТ СЕРВЕР. Экран считал их сам и врал тремя способами сразу:
   *  делил на дистанцию до ТЕКУЩЕГО стопа (после переноса в безубыток она
   *  ноль — и удачная сделка показывала «0.00R»), считал ход по ЗАКАЗАННОМУ
   *  размеру, хотя часть позиции уже закрыта ступенью, и не показывал
   *  реализованные ступени вовсе. Поля необязательны: старый бот их не шлёт,
   *  и тогда остаётся прежний расчёт. */
  hits?: number | null; rDist?: number; doneShare?: number;
  rDone?: number; usdDone?: number; rOpen?: number; usdOpen?: number;
  rNow?: number; usdNow?: number;
  /** pending — лимитка выставлена, но ещё не налилась: позиции физически нет. */
  status?: "pending" | "open";
  /** Контур: скринер или «алгос» (чтение тиковой ленты). Отсутствует = скринер. */
  source?: "screener" | "algo" | "hunter";
};

export type Trade = {
  id: string; symbol: string; side: Side;
  entry: number; exit: number; pnl: number; r: number;
  /** Код причины закрытия из журнала бота. Строка, а не перечисление: у бота
   *  их больше (tp, flat, expired, canceled, venue), и новый код в журнале не
   *  должен ронять экран истории. */
  reason: string;
  /** Человеческое имя причины — считает СЕРВЕР. Причины выхода придумывает
   *  контур на стороне скринера, и второй их словарь здесь отставал бы ровно на
   *  один релиз мини-аппа, печатая владельцу «cmd:WHALE_AGAINST». */
  reasonRu?: string;
  closedAt: number; heldMin: number; fee: number; mfe: number; mae: number; scenario: string;
  /** Сколько ступеней фиксации отработало ЦЕЛИКОМ. `tp_be` не отличает одну
   *  взятую цель от двух, а разница между ними — половина результата сделки.
   *  null — биржа не ответила про ордера, то есть неизвестно. */
  hits?: number | null;
  source?: "screener" | "algo" | "hunter";
};

export type Signal = {
  id: string; symbol: string; side: Side; score: number;
  /** Статус приходит из журнала бота строкой: открыта, лимитка,
   *  закрыта, снята. Перечислением его не запереть — в журнале
   *  появится новый код, и экран упадёт на ровном месте. */
  at: number; status: string;
  phase: string;
};

export type NewsItem = { id: string; src: string; title: string; at: number; kind: "market" | "system" | "macro" };

export type Payment = {
  id: string; at: number; kind: "комиссия" | "подписка" | "пополнение";
  amount: number; note: string; status: string;
};

const h = 3600e3, m = 60e3;
const now = Date.now();

/** Геометрия открытой позиции — то, что НЕ зависит от текущей цены. */
export type PosSpec = {
  id: string; symbol: string; side: Side; lev: number;
  rPct: number;      // расстояние вход→стоп, доля цены
  driftR: number;    // где цена сейчас относительно входа, в R (плюс — в нашу сторону)
  risk: number; openedAt: number; scheme: string; be: boolean;
  fallback: number;  // цена из журнала — только на случай, когда биржа недоступна
};

export const posSpecs: PosSpec[] = [
  { id: "p1", symbol: "MOODENGUSDT", side: "short", lev: 25, rPct: 0.0136, driftR: 0.61,
    risk: 10, openedAt: now - 42 * m, be: true, fallback: 0.041943,
    scheme: "1.5R → 100% · БУ с 1R" },
  { id: "p2", symbol: "DGAIUSDT", side: "long", lev: 20, rPct: 0.034, driftR: 1.18,
    risk: 10, openedAt: now - 3.2 * h, be: true, fallback: 0.6888,
    scheme: "1.5R → 100% · БУ с 1R" },
  { id: "p3", symbol: "GRIFFAINUSDT", side: "short", lev: 25, rPct: 0.0342, driftR: -0.34,
    risk: 10, openedAt: now - 8 * h, be: false, fallback: 0.014311,
    scheme: "1.5R → 100% · БУ с 1R" },
];

/**
 * Собрать позицию вокруг живой цены. Вход отматывается назад на `driftR`, стоп
 * и цель раскладываются от него по схеме 1.5R с безубытком на 1R — ровно так,
 * как их ставит бот. Размер выводится из риска: $10 на сделку при этом стопе.
 */
export function buildPosition(s: PosSpec, last: number): Position {
  const px = last > 0 ? last : s.fallback;
  const rDist = px * s.rPct;
  const dir = s.side === "long" ? 1 : -1;
  const entry = px - dir * s.driftR * rDist;
  return {
    id: s.id, symbol: s.symbol, side: s.side, lev: s.lev,
    entry, mark: px,
    sl: entry - dir * rDist,
    tp: entry + dir * 1.5 * rDist,
    // Уровень, на котором стоп уезжает в безубыток, — 1R (так же, как в боте).
    be: s.be ? entry + dir * rDist : undefined,
    size: Math.round(s.risk / rDist),
    risk: s.risk, openedAt: s.openedAt, scheme: s.scheme,
  };
}

export const trades: Trade[] = [
  { id: "t1", symbol: "GRIFFAINUSDT", side: "short", entry: 0.01431, exit: 0.013578, pnl: 14.56, r: 1.45,
    reason: "tp_all", closedAt: now - 11 * h, heldMin: 833, fee: 0.27, mfe: 2.86, mae: -0.11, scenario: "s3 · нож" },
  { id: "t2", symbol: "BLURUSDT", side: "long", entry: 0.017677, exit: 0.017681, pnl: -0.31, r: -0.03,
    reason: "be", closedAt: now - 17 * h, heldMin: 833, fee: 0.31, mfe: 1.44, mae: -1.01, scenario: "s5 · шорт в памп" },
  { id: "t3", symbol: "DGAIUSDT", side: "long", entry: 0.6888, exit: 0.7238, pnl: 14.50, r: 1.45,
    reason: "tp_all", closedAt: now - 22 * h, heldMin: 166, fee: 0.29, mfe: 2.32, mae: -0.03, scenario: "s1 · старт пампа" },
  { id: "t4", symbol: "BTRUSDT", side: "short", entry: 0.05679, exit: 0.05803, pnl: -10.57, r: -1.05,
    reason: "sl", closedAt: now - 23 * h, heldMin: 61, fee: 0.26, mfe: 3.60, mae: -1.05, scenario: "s5 · шорт в памп" },
  { id: "t5", symbol: "SENTUSDT", side: "long", entry: 0.015638, exit: 0.014695, pnl: -9.25, r: -0.93,
    reason: "sl", closedAt: now - 36 * h, heldMin: 1185, fee: 0.3, mfe: 0.26, mae: -1.35, scenario: "s5 · шорт в памп" },
  { id: "t6", symbol: "ARBUSDT", side: "short", entry: 0.15114, exit: 0.15119, pnl: -0.28, r: -0.03,
    reason: "be", closedAt: now - 38 * h, heldMin: 166, fee: 0.28, mfe: 1.11, mae: -1.12, scenario: "s5 · шорт в памп" },
  { id: "t7", symbol: "TUSDT", side: "long", entry: 0.004941, exit: 0.005541, pnl: 14.47, r: 1.45,
    reason: "tp_all", closedAt: now - 52 * h, heldMin: 740, fee: 0.3, mfe: 1.58, mae: -0.42, scenario: "s5 · шорт в памп" },
  { id: "t8", symbol: "BIGTIMEUSDT", side: "long", entry: 0.007347, exit: 0.00715, pnl: -10.53, r: -1.06,
    reason: "sl", closedAt: now - 57 * h, heldMin: 300, fee: 0.25, mfe: 0.85, mae: -1.05, scenario: "s5 · шорт в памп" },
  { id: "t9", symbol: "ONDOUSDT", side: "short", entry: 0.3525, exit: 0.3558, pnl: -11.16, r: -1.10,
    reason: "sl", closedAt: now - 71 * h, heldMin: 440, fee: 0.32, mfe: 0.71, mae: -1.93, scenario: "s5 · шорт в памп" },
  { id: "t10", symbol: "REZUSDT", side: "short", entry: 0.005005, exit: 0.004599, pnl: 14.46, r: 1.45,
    reason: "tp_all", closedAt: now - 84 * h, heldMin: 155, fee: 0.29, mfe: 2.45, mae: -0.57, scenario: "s5 · шорт в памп" },
  { id: "t11", symbol: "PUFFERUSDT", side: "long", entry: 0.01912, exit: 0.02248, pnl: 14.50, r: 1.45,
    reason: "tp_all", closedAt: now - 96 * h, heldMin: 1745, fee: 0.31, mfe: 1.78, mae: -0.63, scenario: "s5 · шорт в памп" },
  { id: "t12", symbol: "RIVERUSDT", side: "short", entry: 1.266, exit: 1.2467, pnl: 15.08, r: 1.45,
    reason: "tp_all", closedAt: now - 130 * h, heldMin: 15, fee: 0.34, mfe: 8.57, mae: -0.62, scenario: "s5 · шорт в памп" },
  { id: "t13", symbol: "PLUMEUSDT", side: "long", entry: 0.01288, exit: 0.013475, pnl: 14.34, r: 1.45,
    reason: "tp_all", closedAt: now - 134 * h, heldMin: 360, fee: 0.28, mfe: 1.89, mae: -0.85, scenario: "s5 · шорт в памп" },
  { id: "t14", symbol: "ANIMEUSDT", side: "long", entry: 0.002953, exit: 0.002951, pnl: -0.26, r: -0.03,
    reason: "be", closedAt: now - 141 * h, heldMin: 9015, fee: 0.26, mfe: 1.34, mae: -1.07, scenario: "s5 · шорт в памп" },
  { id: "t15", symbol: "EIGENUSDT", side: "short", entry: 0.2223, exit: 0.2253, pnl: -10.82, r: -1.07,
    reason: "sl", closedAt: now - 151 * h, heldMin: 145, fee: 0.33, mfe: 3.08, mae: -1.43, scenario: "s5 · шорт в памп" },
];

export const signals: Signal[] = [
  { id: "s1", symbol: "MOODENGUSDT", side: "short", score: 55, at: now - 42 * m, status: "открыта", phase: "Развитие пампа" },
  { id: "s2", symbol: "APTUSDT", side: "short", score: 60, at: now - 1.4 * h, status: "лимитка", phase: "Лучшее на рынке" },
  { id: "s3", symbol: "DGAIUSDT", side: "long", score: 55, at: now - 3.2 * h, status: "открыта", phase: "Начало роста" },
  { id: "s4", symbol: "GRIFFAINUSDT", side: "short", score: 50, at: now - 8 * h, status: "открыта", phase: "Развитие пампа" },
  { id: "s5", symbol: "BTRUSDT", side: "short", score: 50, at: now - 23 * h, status: "закрыта", phase: "Развитие пампа" },
  { id: "s6", symbol: "WLDUSDT", side: "short", score: 76, at: now - 30 * h, status: "закрыта", phase: "Давление продаж" },
];

export const news: NewsItem[] = [
  { id: "n1", src: "Рынок", kind: "market", title: "BTC удерживает 112 400 — доминация 58.2%, альты в боковике", at: now - 25 * m },
  { id: "n2", src: "Бот", kind: "system", title: "Порог скоринга снижен до 40 — сигналов станет больше", at: now - 2 * h },
  { id: "n3", src: "Макро", kind: "macro", title: "Сегодня 21:30 МСК — данные по занятости в США", at: now - 5 * h },
];

export const payments: Payment[] = [
  { id: "y1", at: now - 2 * h, kind: "комиссия", amount: 4.31, note: "за 10–16 сентября · 4% от прибыли", status: "ожидает" },
  { id: "y2", at: now - 7 * 24 * h, kind: "комиссия", amount: 6.02, note: "за 3–9 сентября · 4% от прибыли", status: "оплачено" },
  { id: "y3", at: now - 12 * 24 * h, kind: "подписка", amount: 55, note: "Pro · 3 месяца", status: "оплачено" },
  { id: "y4", at: now - 14 * 24 * h, kind: "пополнение", amount: 100, note: "USDT · Polygon", status: "оплачено" },
];

/** Стартовый депозит демо-режима — точка отсчёта кривой. */
export const START_DEPOSIT = 1000;

/** Кривая депозита для графика доходности (демо-режим). */
export const equity = (() => {
  let v = 1000; const out: { t: number; v: number }[] = [];
  const steps = [0, -10.8, -0.3, 14.3, 15.1, 14.5, 14.5, -11.2, 14.5, -10.5, -0.3, -9.3, -10.6, 14.5, -0.3, 14.6];
  steps.forEach((s, i) => { v += s; out.push({ t: now - (steps.length - i) * 12 * h, v: Math.round(v * 100) / 100 }); });
  return out;
})();

export const PLANS = [
  { id: "m1", months: 1, price: 20, label: "1 месяц" },
  { id: "m3", months: 3, price: 55, label: "3 месяца", note: "−8%" },
  { id: "m6", months: 6, price: 95, label: "6 месяцев", note: "−21%", best: true },
  { id: "m12", months: 12, price: 150, label: "12 месяцев", note: "−38%" },
];

export const FEE_WITH_SUB = 0.04;
export const FEE_NO_SUB = 0.15;
export const USDT_ADDRESS = "0x7A9f4c2E1b8D0a35C6fE91bB47d2c8E0A5F3d19C";
