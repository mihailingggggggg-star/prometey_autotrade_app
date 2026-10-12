/**
 * stats.ts — метрики по закрытым сделкам. Чистые функции над журналом сделок
 * демо-контура: ни сети, ни состояния, ни React — поэтому их можно посчитать в
 * любом месте и проверить глазами по одной цифре.
 *
 * Файл восстановлен из прежней аналитики (`git show 3253f44:src/lib/stats.ts`)
 * и адаптирован к контракту `shared/types.ts`: сделка теперь выглядит как
 * `Trade` (closed_ts в секундах, pnl_usd, usd_in, costs_usd, close_reason), а не
 * как прежняя модель бота. Формулы и правила сохранены.
 *
 * ГЛАВНОЕ ПРАВИЛО, общее с отчётами бота: деньги считаются ТОЛЬКО по закрытым
 * сделкам. У открытой позиции результата ещё нет — есть состояние, и, записав
 * его в статистику, мы обещали бы деньги, которых нет.
 *
 * Второе правило: безубыток — НЕ проигрыш и НЕ победа. Винрейт считается по
 * сделкам С РЕЗУЛЬТАТОМ (в плюс или в минус), иначе схема с переносом стопа в
 * безубыток выглядела бы тем хуже, чем лучше она защищает.
 */

import type { Trade, CloseReason } from "../../shared/types";

export const DAY = 864e5;

/* ── Сутки отчётности ───────────────────────────────────────────────────────
   День считается по БИШКЕКУ (UTC+6), а не по часам устройства. Причин две, и
   обе практические.

   Во-первых, тем же поясом живёт бот: его дневные отчёты и журнал уже
   считаются в UTC+6. Считай приложение по устройству — и «сегодня» в
   приложении расходилось бы с «сегодня» в Telegram, причём тем сильнее, чем
   дальше вы уехали. Две разные правды про один и тот же день — худшее, что
   может показывать торговый отчёт.

   Во-вторых, часы устройства — не то же самое, что место жизни: вебвью
   Telegram на чужом ноутбуке, поездка, выключенный автопояс. Перехода на
   летнее время в Киргизии нет с 2005 года, поэтому смещение постоянное и день
   ровно 24 часа — можно просто сдвигать метку времени. */
export const TZ_MIN = 6 * 60;
const toTz = (ms: number) => ms + TZ_MIN * 60000;
const fromTz = (ms: number) => ms - TZ_MIN * 60000;

/** Дата сделки в поясе отчётности, ключ вида YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(toTz(ms));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Полночь того дня отчётности, которому принадлежит момент. */
export function dayStart(ms: number): number {
  return fromTz(Math.floor(toTz(ms) / DAY) * DAY);
}

/** Начало дня отчётности, которому принадлежит `nowMs` (по умолчанию — сейчас). */
export const todayStart = (nowMs = Date.now()) => dayStart(nowMs);

/** Начало окна в N ПОЛНЫХ дней, считая сегодняшний. `days = 1` — «сегодня», то
 *  есть с полуночи, а не «последние 24 часа»: скользящее окно показывало бы в
 *  отчёте за сегодня половину вчерашнего дня. */
export const windowStart = (days: number, nowMs = Date.now()) =>
  todayStart(nowMs) - (Math.max(1, days) - 1) * DAY;

/** Подпись дня — тоже в поясе отчётности, иначе столбик «18 сент.» на устройстве
 *  западнее подписывался бы вчерашним числом. */
export const dayLabel = (ms: number) =>
  new Date(toTz(ms)).toLocaleDateString("ru-RU",
    { day: "numeric", month: "short", timeZone: "UTC" });

/** Результат сделки в R — доля от вложенного. `usd_in` — то, чем рискнули. */
export const rOf = (t: Trade) => (t.usd_in > 0 ? t.pnl_usd / t.usd_in : 0);

/** Сделки, ЗАКРЫТЫЕ в окне [fromMs, toMs) по своим `closed_ts`.
 *
 *  Обе границы — в миллисекундах, `closed_ts` приходит в секундах. Сравниваем в
 *  шкале отчётности уже на этапе ключей дней, поэтому здесь достаточно точного
 *  полуинтервала: сделка последней миллисекунды периода не должна «утечь» в
 *  следующий. */
export function inWindow(trades: Trade[], fromMs: number, toMs: number): Trade[] {
  return trades.filter((t) => {
    const ms = t.closed_ts * 1000;
    return ms >= fromMs && ms < toMs;
  });
}

/** Сделки по дням: сколько, сколько в плюс/минус и сколько денег. День без
 *  сделок — тоже факт, но в выбранном окне пустые дни не дорисовываем: здесь
 *  важен список дней С ДАННЫМИ для календаря. */
export type Day = { day: string; ts: number; n: number; wins: number; loss: number; pnl: number };

export function byDay(trades: Trade[]): Day[] {
  const map = new Map<string, Day>();
  trades.forEach((t) => {
    const ms = t.closed_ts * 1000;
    const key = dayKey(ms);
    const d = map.get(key) || { day: key, ts: dayStart(ms), n: 0, wins: 0, loss: 0, pnl: 0 };
    d.n += 1;
    if (t.pnl_usd > 0) d.wins += 1;
    else if (t.pnl_usd < 0) d.loss += 1;
    d.pnl += t.pnl_usd;
    map.set(key, d);
  });
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

/** Кумулятивный результат по закрытым сделкам: каждая точка — сделка, а не день,
 *  потому что просадку внутри дня иначе не увидеть вовсе. `x` — секунды
 *  (`closed_ts`), как их ждёт график. */
export function equity(trades: Trade[], start = 0): { x: number; y: number; label: string }[] {
  const rows = [...trades].sort((a, b) => a.closed_ts - b.closed_ts);
  let v = start;
  return rows.map((t) => {
    v += t.pnl_usd;
    return { x: t.closed_ts, y: +v.toFixed(2), label: t.symbol.replace("USDT", "") };
  });
}

/** То же, но в R (доля от вложенного) — вторая шкала того же результата. */
export function equityR(trades: Trade[], start = 0): { x: number; y: number; label: string }[] {
  const rows = [...trades].sort((a, b) => a.closed_ts - b.closed_ts);
  let v = start;
  return rows.map((t) => {
    v += rOf(t);
    return { x: t.closed_ts, y: +v.toFixed(3), label: t.symbol.replace("USDT", "") };
  });
}

/* ── Разбивки ─────────────────────────────────────────────────────────────── */

/** По монетам: сколько сделок, сколько денег, средний результат и винрейт.
 *  Отсортировано по СУММЕ (сколько монета принесла) — вопрос «на чём заработали»
 *  важнее вопроса «где больше сделок». */
export type SymbolRow = {
  symbol: string; n: number; pnl: number; avg: number; wins: number; winrate: number | null;
};

export function bySymbol(trades: Trade[], top = 10): SymbolRow[] {
  const m = new Map<string, { symbol: string; n: number; pnl: number; wins: number; decided: number }>();
  trades.forEach((t) => {
    const key = t.symbol.replace("USDT", "");
    const v = m.get(key) || { symbol: key, n: 0, pnl: 0, wins: 0, decided: 0 };
    v.n += 1;
    v.pnl += t.pnl_usd;
    if (t.pnl_usd > 0) v.wins += 1;
    if (t.pnl_usd !== 0) v.decided += 1;
    m.set(key, v);
  });
  return [...m.values()]
    .map((v) => ({
      symbol: v.symbol, n: v.n, pnl: +v.pnl.toFixed(2), avg: +(v.pnl / v.n).toFixed(2),
      wins: v.wins, winrate: v.decided ? Math.round((v.wins / v.decided) * 100) : null,
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, top);
}

/** Чем заканчивались сделки. Для этого контура метрика ключевая: доля взятых
 *  целей против ручных выходов и сливов ликвидности говорит о схеме выхода
 *  больше, чем винрейт. */
export type ReasonRow = { reason: CloseReason; n: number; pnl: number };

export function byReason(trades: Trade[]): ReasonRow[] {
  const m = new Map<CloseReason, { n: number; pnl: number }>();
  trades.forEach((t) => {
    const v = m.get(t.close_reason) || { n: 0, pnl: 0 };
    v.n += 1;
    v.pnl += t.pnl_usd;
    m.set(t.close_reason, v);
  });
  return [...m.entries()]
    .map(([reason, v]) => ({ reason, n: v.n, pnl: +v.pnl.toFixed(2) }))
    .sort((a, b) => b.n - a.n);
}

/** Суммарные издержки и проскальзывание за выборку, $. */
export function costs(trades: Trade[]): number {
  return +trades.reduce((s, t) => s + t.costs_usd, 0).toFixed(2);
}

/* ── Итоги и математическое ожидание ──────────────────────────────────────── */

export type Summary = {
  n: number; wins: number; loss: number; be: number;
  net: number; netR: number;
  winrate: number | null;          // %, по сделкам с результатом
  avgWin: number; avgLoss: number; // $, средний выигрыш и проигрыш
  avgWinPct: number; avgLossPct: number; // %, средний ход сделки
  avgInvested: number;             // $, средний размер входа
  expUsd: number | null;           // мат. ожидание на сделку, $
  expPct: number | null;           // мат. ожидание на сделку, % от вложенного
  expR: number | null;             // мат. ожидание на сделку, R
  sd: number;                      // стд. отклонение результата сделки, $ (выборочное)
  maxDd: number;                   // максимальная просадка кривой, $
  costs: number;                   // издержки за выборку, $
};

export function summary(trades: Trade[]): Summary {
  const wins = trades.filter((t) => t.pnl_usd > 0);
  const loss = trades.filter((t) => t.pnl_usd < 0);
  const be = trades.length - wins.length - loss.length;
  const gp = wins.reduce((s, t) => s + t.pnl_usd, 0);
  const gl = Math.abs(loss.reduce((s, t) => s + t.pnl_usd, 0));
  const decided = wins.length + loss.length;
  const n = trades.length;
  const net = gp - gl;

  const invested = trades.reduce((s, t) => s + t.usd_in, 0);
  const avgInvested = n ? invested / n : 0;

  /* Разброс — по сделкам С РЕЗУЛЬТАТОМ: безубыток не двигает результат, и
     включать его в дисперсию значило бы занижать риск на пустом месте.
     Выборочное отклонение (n−1): мы оцениваем разброс по выборке, а не по
     генеральной совокупности. */
  const bet = [...wins, ...loss].map((t) => t.pnl_usd);
  const mean = bet.length ? bet.reduce((s, v) => s + v, 0) / bet.length : 0;
  const sd = bet.length > 1
    ? Math.sqrt(bet.reduce((s, v) => s + (v - mean) ** 2, 0) / (bet.length - 1))
    : 0;

  let eq = 0, peak = 0, dd = 0;
  [...trades].sort((a, b) => a.closed_ts - b.closed_ts).forEach((t) => {
    eq += t.pnl_usd; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak);
  });

  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = loss.length ? gl / loss.length : 0;
  /* Математическое ожидание на сделку = средний результат. Его же можно собрать
     по частям: доля побед × средний выигрыш − доля убытков × средний убыток —
     что и подписывается на карточке, чтобы было видно, из чего число сложено. */
  return {
    n, wins: wins.length, loss: loss.length, be,
    net: +net.toFixed(2),
    netR: +trades.reduce((s, t) => s + rOf(t), 0).toFixed(4),
    winrate: decided ? Math.round((wins.length / decided) * 100) : null,
    avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
    avgWinPct: wins.length ? +(wins.reduce((s, t) => s + t.pnl_pct, 0) / wins.length).toFixed(2) : 0,
    avgLossPct: loss.length ? +(loss.reduce((s, t) => s + t.pnl_pct, 0) / loss.length).toFixed(2) : 0,
    avgInvested: +avgInvested.toFixed(2),
    expUsd: n ? +(net / n).toFixed(2) : null,
    expPct: n && invested ? +((net / invested) * 100).toFixed(2) : null,
    expR: n ? +(trades.reduce((s, t) => s + rOf(t), 0) / n).toFixed(4) : null,
    sd: +sd.toFixed(2),
    maxDd: +dd.toFixed(2),
    costs: costs(trades),
  };
}

/* ── Прогноз к концу месяца ───────────────────────────────────────────────── */

/**
 * Прогноз «докуда дойдёт к концу месяца» ПРИ ТЕКУЩЕМ ТЕМПЕ. Это оценка, а не
 * обещание: она честно говорит, на чём стоит и насколько шатко.
 *
 * Метод (весь виден на карточке):
 *   капитал   = equity из /api/analytics/summary (баланс + оценка открытых);
 *   темп      = закрытых сделок в этом месяце ÷ прошедших дней месяца;
 *   сделок    ≈ темп × оставшихся дней;
 *   прибыль   ≈ сделок × мат. ожидание на сделку (по сделкам ЭТОГО месяца);
 *   разброс   = стд. отклонение результата × √сделок (честнее одной цифры);
 *   пополн.   = плановое пополнение месяца, если ещё не внесено;
 *   итог      = капитал + прибыль + пополнение.
 *
 * Возвращает null, когда сделок в месяце нет: на пустом темпе любая цифра была
 * бы выдумкой, и экран обязан сказать «мало данных», а не нарисовать ноль.
 */
export type Forecast = {
  equity: number;
  done: number; elapsed: number; total: number; left: number;
  perDay: number; expectedDeals: number;
  expPerTrade: number; sd: number;
  baseProfit: number; spread: number; deposit: number;
  base: number; low: number; high: number;
};

export function forecastMonth(
  trades: Trade[], equityUsd: number, monthlyDeposit: number,
  depositPending: boolean, nowMs = Date.now(),
): Forecast | null {
  const d = new Date(toTz(nowMs));
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const monthStart = fromTz(Date.UTC(y, m, 1));
  const total = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const elapsed = d.getUTCDate();          // прошедших дней, включая сегодня
  const left = total - elapsed;

  const month = trades.filter((t) => {
    const ms = t.closed_ts * 1000;
    return ms >= monthStart && ms <= nowMs;
  });
  const done = month.length;
  if (done === 0) return null;

  const perDay = done / elapsed;
  const expectedDeals = perDay * left;
  const s = summary(month);
  const expPerTrade = s.expUsd ?? 0;
  const baseProfit = expectedDeals * expPerTrade;
  const spread = s.sd * Math.sqrt(expectedDeals);
  const deposit = depositPending ? monthlyDeposit : 0;
  const base = equityUsd + baseProfit + deposit;

  return {
    equity: equityUsd,
    done, elapsed, total, left,
    perDay: +perDay.toFixed(2),
    expectedDeals: +expectedDeals.toFixed(1),
    expPerTrade, sd: s.sd,
    baseProfit: +baseProfit.toFixed(2),
    spread: +spread.toFixed(2),
    deposit: +deposit.toFixed(2),
    base: +base.toFixed(2),
    low: +(base - spread).toFixed(2),
    high: +(base + spread).toFixed(2),
  };
}
