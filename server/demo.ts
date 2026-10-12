/**
 * demo.ts — демо-движок исполнения (§6 плана): издержки, Free Riding,
 * time-stop, liquidity drain, виртуальные часы и аналитика.
 *
 * Денежные правила: usd_in — сколько реально заплатил пользователь (gross),
 * qty — уже за вычетом издержек входа. Поэтому результат по позиции — всегда
 * net: pnl = realized + остаточная стоимость − usd_in.
 *
 * Почему режим ТП лежит в note: в схеме §3 у positions нет отдельной колонки
 * под tp_mode, а движку нужно знать, фиксировать ли 50% автоматически.
 */
import {
  getSettings,
  virtualNow,
  advanceVirtual,
  getDb,
  audit,
  addAlert,
  signalById,
  positionById,
  type PositionRow,
} from "./db.ts";
import { readDataMode, ApiError } from "./config.ts";
import { getSource, type SourceRef, type MarketData } from "./screener.ts";
import type {
  Position,
  Trade,
  Fill,
  Alert,
  AnalyticsSummary,
  OutcomeBuckets,
  EquityPoint,
  OpenPositionRequest,
  Settings,
  PositionStatus,
  CloseReason,
  ChartTf,
} from "../shared/types.ts";

const EPS = 1e-9;

/* ─────────────── детерминированное проскальзывание ─────────────── */

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Псевдослучайное [0,1) из строки-сида: проскальзывание воспроизводимо. */
function rand01(seed: string): number {
  let a = fnv1a(seed);
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function slipFraction(seed: string, minPct: number, maxPct: number): number {
  return (minPct + (maxPct - minPct) * rand01(seed)) / 100;
}

/* ─────────────── утилиты ─────────────── */

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function r6(v: number): number {
  return v > 0 ? Number(v.toPrecision(6)) : 0;
}

function refOf(row: PositionRow): SourceRef {
  return { token_addr: row.token_addr, pair_addr: row.token_addr, symbol: row.symbol, name: row.name };
}

/** Нарушение UNIQUE-индекса (SQLITE_CONSTRAINT_UNIQUE = 2067). */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { errcode?: number })?.errcode;
  const msg = e instanceof Error ? e.message : String(e);
  return code === 2067 || /UNIQUE constraint failed/i.test(msg);
}

/** Режим ТП хранится в note: "tp_mode=free_ride" | "tp_mode=manual". */
function tpModeOf(row: PositionRow): "free_ride" | "manual" {
  return row.note.includes("manual") ? "manual" : "free_ride";
}

function insertFill(
  positionId: number,
  ts: number,
  kind: Fill["kind"],
  price: number,
  qty: number,
  usd: number,
  fee: number,
  slip: number,
): number {
  const res = getDb()
    .prepare(
      "INSERT INTO fills(position_id, ts, kind, price, qty, usd, fee_usd, slippage_usd) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(positionId, ts, kind, price, qty, usd, fee, slip);
  return Number(res.lastInsertRowid);
}

function lastFillPrice(positionId: number): number | null {
  const row = getDb()
    .prepare("SELECT price FROM fills WHERE position_id = ? ORDER BY id DESC LIMIT 1")
    .get(positionId) as { price: number } | undefined;
  return row ? row.price : null;
}

/* ─────────────── открытие / докупка / ТП / закрытие ─────────────── */

export async function openPosition(req: OpenPositionRequest): Promise<Position> {
  const s = getSettings();
  const sig = signalById(Number(req.signal_id));
  if (!sig) throw new ApiError("signal_not_found", 404, `сигнал ${req.signal_id} не найден`);

  const usd = Number(req.usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new ApiError("invalid_amount", 400, "сумма должна быть > 0");

  // Антидубль: одна незакрытая позиция на монету. Иначе повторная покупка и
  // «Докупить» в интерфейсе создавали бы две позиции вместо одной усреднённой.
  // Это БЫСТРЫЙ путь (понятный 409 до запроса цены). Гонку двух параллельных
  // открытий закрывает частичный UNIQUE-индекс idx_positions_token_open — вставка
  // ниже превращает его нарушение в тот же 409.
  const existing = getDb()
    .prepare("SELECT id FROM positions WHERE token_addr=? AND status!='closed' LIMIT 1")
    .get(sig.token_addr) as { id: number } | undefined;
  if (existing) {
    throw new ApiError("position_exists", 409, `по ${sig.symbol} уже есть открытая позиция — используйте «Докупить»`);
  }

  const src = getSource();
  const now = virtualNow();
  const market = await src.market(
    { token_addr: sig.token_addr, pair_addr: sig.pair_addr, symbol: sig.symbol, name: sig.name },
    now,
  );

  // Limit исполняем по указанной цене (демо: считаем, что заявка налилась). Если
  // цена не задана — исполняем как market, чтобы позиция не осталась «висящей».
  const orderType = req.order_type === "limit" ? "limit" : "market";
  const entry = orderType === "limit" && req.limit_price ? Number(req.limit_price) : market.price;
  if (!(entry > 0)) throw new ApiError("no_price", 502, "не удалось получить цену входа");

  const tpMode = req.tp_mode === "manual" ? "manual" : "free_ride";
  // Цель 2 по умолчанию. Для Free Riding это tp2_percent (остаток летит до x5),
  // а НЕ триггер фиксации tp1_percent: иначе линия ТП совпала бы с триггером и
  // остаток закрывался бы сразу после фиксации половины. Для ручного режима —
  // прежнее поведение (tp1_percent).
  const defaultTpPercent = tpMode === "free_ride" ? s.free_ride.tp2_percent : s.free_ride.tp1_percent;
  // Явный tp_percent (ручная цель 2) уважаем. Проверка `!= null` (а не Number())
  // отсекает и undefined, и явный null: наивный Number(null)=0 дал бы tp_price =
  // цена входа и мгновенный Free Riding — это ошибка запроса, а не цель.
  const tpPercent = req.tp_percent != null ? Number(req.tp_percent) : defaultTpPercent;
  if (!Number.isFinite(tpPercent) || tpPercent <= 0) {
    throw new ApiError("invalid_tp_percent", 400, "tp_percent должен быть > 0");
  }
  const fee = usd * (s.demo.pool_fee_pct / 100);
  const slip = usd * slipFraction(`open:${sig.token_addr}:${now}`, s.demo.slippage_min_pct, s.demo.slippage_max_pct);
  const qty = (usd - fee - slip) / entry;
  const tpPrice = entry * (1 + tpPercent / 100);

  let id: number;
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO positions(signal_id, token_addr, symbol, name, entry_price, qty, usd_in, fees_usd,
          slippage_usd, tp_price, tp_percent, status, free_ride_done, realized_usd, peak_price, opened_ts, note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        sig.id,
        sig.token_addr,
        sig.symbol,
        sig.name,
        entry,
        qty,
        usd,
        fee,
        slip,
        tpPrice,
        tpPercent,
        "open",
        0,
        0,
        entry,
        now,
        `tp_mode=${tpMode}`,
      );
    id = Number(res.lastInsertRowid);
  } catch (e) {
    // Две параллельные заявки по одной монете прошли пред-проверку до вставки:
    // побеждает та, что вставила первой, вторая ловит UNIQUE-индекс и получает
    // тот же 409 position_exists, что и в быстром пути выше.
    if (isUniqueViolation(e)) {
      throw new ApiError("position_exists", 409, `по ${sig.symbol} уже есть открытая позиция — используйте «Докупить»`);
    }
    throw e;
  }
  insertFill(id, now, "open", entry, qty, usd, fee, slip);

  // Сигнал переходит в «в работе» — лента показывает, что им уже воспользовались.
  getDb().prepare("UPDATE signals SET status='taken' WHERE id=?").run(sig.id);
  audit("position.open", { id, signal_id: sig.id, usd, entry }, "user");

  return mapPosition(positionById(id) as PositionRow, market.price);
}

export async function addToPosition(id: number, usd: number): Promise<Position> {
  const s = getSettings();
  const row = positionById(id);
  if (!row) throw new ApiError("position_not_found", 404, `позиция ${id} не найдена`);
  if (row.status === "closed") throw new ApiError("position_closed", 400, "позиция уже закрыта");
  if (!Number.isFinite(usd) || usd <= 0) throw new ApiError("invalid_amount", 400, "сумма должна быть > 0");

  const src = getSource();
  const now = virtualNow();
  const market = await src.market(refOf(row), now);
  const price = market.price;
  const fee = usd * (s.demo.pool_fee_pct / 100);
  const slip = usd * slipFraction(`add:${id}:${now}`, s.demo.slippage_min_pct, s.demo.slippage_max_pct);
  const addQty = (usd - fee - slip) / price;
  const newQty = row.qty + addQty;
  // Средняя цена — по вкладу в токены, а не по деньгам: так учёт честнее.
  const newEntry = newQty > 0 ? (row.entry_price * row.qty + price * addQty) / newQty : row.entry_price;
  // Средняя цена входа изменилась — линия ТП (цель 2) едет за ней, иначе осталась
  // бы от старой средней и остаток закрылся бы не там, где планировалось.
  const newTp = newEntry * (1 + row.tp_percent / 100);

  getDb()
    .prepare(
      "UPDATE positions SET qty=?, usd_in=usd_in+?, fees_usd=fees_usd+?, slippage_usd=slippage_usd+?, entry_price=?, tp_price=? WHERE id=?",
    )
    .run(newQty, usd, fee, slip, newEntry, newTp, id);
  insertFill(id, now, "add", price, addQty, usd, fee, slip);
  audit("position.add", { id, usd, price }, "user");
  return mapPosition(positionById(id) as PositionRow, price);
}

export async function setTp(id: number, tpPrice: number): Promise<Position> {
  const row = positionById(id);
  if (!row) throw new ApiError("position_not_found", 404, `позиция ${id} не найдена`);
  if (!(tpPrice > 0)) throw new ApiError("invalid_tp", 400, "цена ТП должна быть > 0");
  const tpPercent = ((tpPrice / row.entry_price - 1) * 100);
  getDb().prepare("UPDATE positions SET tp_price=?, tp_percent=? WHERE id=?").run(tpPrice, tpPercent, id);
  audit("position.tp", { id, tp_price: tpPrice }, "user");
  // В ответе — РЕАЛЬНАЯ рыночная цена, а не перенесённая линия ТП: иначе
  // PositionResponse.current_price врал бы, показывая будущее значение.
  let current = row.entry_price;
  try {
    const p = await getSource().price(row.token_addr, virtualNow());
    if (p > 0) current = p;
  } catch {
    // цена недоступна — отдаём цену входа (не выдумываем значение)
  }
  return mapPosition(positionById(id) as PositionRow, current);
}

export async function closePosition(
  id: number,
  fraction: number,
  reason: CloseReason = "manual",
): Promise<{ position: Position; fill: Fill }> {
  const s = getSettings();
  const row = positionById(id);
  if (!row) throw new ApiError("position_not_found", 404, `позиция ${id} не найдена`);
  if (row.status === "closed") throw new ApiError("position_closed", 400, "позиция уже закрыта");

  const frac = Number(fraction);
  if (!Number.isFinite(frac) || frac <= 0 || frac > 1) {
    throw new ApiError("invalid_fraction", 400, "доля должна быть в диапазоне (0, 1]");
  }

  const src = getSource();
  const now = virtualNow();
  const price = await src.price(row.token_addr, now);
  if (!(price > 0)) throw new ApiError("no_price", 502, "не удалось получить цену закрытия");

  const full = frac >= 0.999;
  const kind: Fill["kind"] = full ? "close" : "partial";
  applySell(row, frac, price, kind, now, s);

  const after = positionById(id) as PositionRow;
  if (full || after.qty <= EPS) {
    getDb()
      .prepare("UPDATE positions SET qty=0, status='closed', closed_ts=?, close_reason=? WHERE id=?")
      .run(now, reason, id);
  }
  audit("position.close", { id, fraction: frac, price, reason }, "user");

  const fillRow = getDb()
    .prepare("SELECT * FROM fills WHERE position_id = ? ORDER BY id DESC LIMIT 1")
    .get(id) as Fill;
  return { position: mapPosition(positionById(id) as PositionRow, price), fill: fillRow };
}

/** Продать долю объёма: считаем издержки выхода и пишем fill. Возвращает net. */
function applySell(
  row: PositionRow,
  fraction: number,
  price: number,
  kind: Fill["kind"],
  now: number,
  s: Settings,
): number {
  const sellQty = row.qty * fraction;
  const gross = sellQty * price;
  const fee = gross * (s.demo.pool_fee_pct / 100);
  const slip = gross * slipFraction(`sell:${row.id}:${now}:${kind}`, s.demo.slippage_min_pct, s.demo.slippage_max_pct);
  const net = gross - fee - slip;
  getDb()
    .prepare(
      "UPDATE positions SET qty=qty-?, realized_usd=realized_usd+?, fees_usd=fees_usd+?, slippage_usd=slippage_usd+? WHERE id=?",
    )
    .run(sellQty, net, fee, slip, row.id);
  insertFill(row.id, now, kind, price, sellQty, gross, fee, slip);
  return net;
}

/* ─────────────── обслуживание и события движка ─────────────── */

/**
 * Очередь обслуживания: updatePositions вызывается и таймером, и на КАЖДОМ
 * чтении /api/positions, а тот опрашивают одновременно два экрана. Сериализуем
 * прогоны (следующий стартует только после завершения предыдущего), чтобы
 * наложения вообще не возникало: прогон читает строки ДО `await` маркет-данных,
 * и без сериализации второй прогон увидел бы устаревший снимок строки.
 *
 * От двойной продажи защищает ПРЕЖДЕ ВСЕГО атомарный захват free_ride_done
 * (UPDATE ... WHERE free_ride_done=0) в runUpdatePositions — он сработал бы и
 * при наложении. Очередь — дополнительная страховка: при ней параллельные
 * обращения к API не создают и лишних чтений устаревших строк.
 */
let updateQueue: Promise<void> = Promise.resolve();

/**
 * Пересчёт открытых позиций: peak, Free Riding, time-stop, liquidity drain.
 * События идемпотентны (addAlert не дублирует, захват Free Riding атомарен).
 */
export function updatePositions(now = virtualNow()): Promise<void> {
  const run = updateQueue.then(
    () => runUpdatePositions(now),
    () => runUpdatePositions(now), // предыдущий упал — очередь не должна застрять
  );
  updateQueue = run.catch(() => {});
  return run;
}

async function runUpdatePositions(now: number): Promise<void> {
  const s = getSettings();
  const src = getSource();
  const rows = getDb()
    .prepare("SELECT * FROM positions WHERE status IN ('open','free_ride') ORDER BY id")
    .all() as unknown as PositionRow[];

  for (const row of rows) {
    let market: MarketData;
    try {
      market = await src.market(refOf(row), now);
    } catch {
      continue; // источник недоступен — позицию не трогаем
    }
    const price = market.price;
    if (!(price > 0)) continue;

    const peak = Math.max(row.peak_price, price);
    if (peak > row.peak_price) getDb().prepare("UPDATE positions SET peak_price=? WHERE id=?").run(peak, row.id);

    const mode = tpModeOf(row);

    if (mode === "free_ride") {
      if (!row.free_ride_done) {
        // Free Riding: на +tp1_percent фиксируем tp1_fraction объёма — капитал
        // вернулся, риск 0. Захват АТОМАРЕН: продажу и алерт выполняет только
        // тот вызов, что перевёл free_ride_done 0→1.
        if (price >= row.entry_price * (1 + s.free_ride.tp1_percent / 100)) {
          const claim = getDb()
            .prepare("UPDATE positions SET free_ride_done=1 WHERE id=? AND free_ride_done=0")
            .run(row.id);
          if (Number(claim.changes) === 1) {
            const net = applySell(row, s.free_ride.tp1_fraction, price, "tp_50", now, s);
            // Страховка для уже сохранённых в базе настроек (валидация запрещает
            // лишь новые): если доля фиксации = 1, объём продан целиком и остаток
            // qty≈0. Без этой ветки позиция зависла бы в 'free_ride' с нулевым
            // остатком: цель 2 требует qty > EPS, история берёт только 'closed'.
            const after = positionById(row.id) as PositionRow;
            if (after.qty <= EPS) {
              getDb()
                .prepare("UPDATE positions SET qty=0, status='closed', close_reason='tp_full', closed_ts=? WHERE id=?")
                .run(now, row.id);
              addAlert(
                row.id,
                "free_ride",
                `Free Riding: зафиксировано 100% объёма ${row.symbol} на +${s.free_ride.tp1_percent}% ` +
                  `(вернулось ~${net.toFixed(2)} USDT, позиция закрыта)`,
                "info",
              );
            } else {
              getDb().prepare("UPDATE positions SET status='free_ride' WHERE id=? AND status!='closed'").run(row.id);
              addAlert(
                row.id,
                "free_ride",
                `Free Riding: зафиксировано ${Math.round(s.free_ride.tp1_fraction * 100)}% объёма на +${s.free_ride.tp1_percent}% ` +
                  `(вернулось ~${net.toFixed(2)} USDT, риск снят)`,
                "info",
              );
            }
          }
        }
      } else if (row.qty > EPS && row.tp_price > 0 && price >= row.tp_price) {
        // Цель 2 (остаток «летит» до линии ТП): достигли — закрываем целиком.
        // Сначала атомарный захват статуса, только потом продажа и алерт.
        const claim = getDb()
          .prepare("UPDATE positions SET status='closed', close_reason='tp_full', closed_ts=? WHERE id=? AND status='free_ride'")
          .run(now, row.id);
        if (Number(claim.changes) === 1) {
          applySell(row, 1, price, "close", now, s);
          getDb().prepare("UPDATE positions SET qty=0 WHERE id=?").run(row.id);
          addAlert(row.id, "tp_reached", `Цель 2 достигнута: ${row.symbol} закрыта по $${r6(price)}`, "info");
        }
      }
    } else if (mode === "manual" && price >= row.tp_price) {
      addAlert(row.id, "tp_reached", `Цена ${row.symbol} достигла линии ТП ${r6(row.tp_price)}`, "info");
    }

    // Time-stop: автозакрытия нет — только рекомендация.
    const ageDays = (now - row.opened_ts) / 86400;
    if (ageDays >= s.demo.time_stop_days) {
      addAlert(
        row.id,
        "time_stop",
        `Time-stop: ${row.symbol} — ${Math.round(ageDays)} дн без импульса, рекомендуется закрытие`,
        "warn",
      );
    }

    // Liquidity drain: пул просел сильнее порога с момента входа.
    const sig = row.signal_id ? signalById(row.signal_id) : null;
    const entryLiq = sig?.liq_usd ?? 0;
    if (entryLiq > 0) {
      const drop = ((entryLiq - market.liq_usd) / entryLiq) * 100;
      if (drop > s.demo.liq_drain_pct) {
        addAlert(
          row.id,
          "liq_drain",
          `Liquidity drain: ликвидность пула ${row.symbol} упала на ${drop.toFixed(0)}% с момента входа`,
          "critical",
        );
      }
    }
  }
}

/** Один цикл обслуживания: в mock двигает виртуальные часы и пересчитывает позиции. */
export async function advance(): Promise<number> {
  const s = getSettings();
  if (readDataMode() === "mock") advanceVirtual(s.demo.tick_minutes);
  const now = virtualNow();
  await updatePositions(now);
  return now;
}

/* ─────────────── чтение позиций / сделок / аналитики ─────────────── */

export async function listPositions(status?: string): Promise<Position[]> {
  await updatePositions();
  const rows = (status
    ? getDb().prepare("SELECT * FROM positions WHERE status=? ORDER BY id DESC").all(status)
    : getDb().prepare("SELECT * FROM positions ORDER BY id DESC").all()) as unknown as PositionRow[];
  const src = getSource();
  const now = virtualNow();
  const out: Position[] = [];
  for (const row of rows) {
    let current: number;
    if (row.status === "closed") {
      current = lastFillPrice(row.id) ?? row.entry_price;
    } else {
      try {
        current = await src.price(row.token_addr, now);
      } catch {
        current = row.entry_price;
      }
    }
    out.push(mapPosition(row, current));
  }
  return out;
}

export function listTrades(limit = 100): Trade[] {
  const rows = getDb()
    .prepare("SELECT * FROM positions WHERE status='closed' ORDER BY closed_ts DESC LIMIT ?")
    .all(limit) as unknown as PositionRow[];
  return rows.map((row) => {
    const pnlUsd = row.realized_usd - row.usd_in;
    return {
      id: row.id,
      position_id: row.id,
      symbol: row.symbol,
      token_addr: row.token_addr,
      opened_ts: row.opened_ts,
      closed_ts: row.closed_ts ?? row.opened_ts,
      usd_in: r2(row.usd_in),
      usd_out: r2(row.realized_usd),
      pnl_usd: r2(pnlUsd),
      pnl_pct: row.usd_in > 0 ? r2((pnlUsd / row.usd_in) * 100) : 0,
      costs_usd: r2(row.fees_usd + row.slippage_usd),
      close_reason: (row.close_reason as CloseReason) ?? "manual",
      free_ride_done: Boolean(row.free_ride_done),
    };
  });
}

export async function analyticsSummary(): Promise<AnalyticsSummary> {
  const s = getSettings();
  const db = getDb();
  const deposits = db.prepare("SELECT ts, usd FROM deposits ORDER BY ts").all() as unknown as {
    ts: number;
    usd: number;
  }[];
  const deposited = deposits.reduce((a, d) => a + d.usd, 0);

  const positions = db.prepare("SELECT * FROM positions").all() as unknown as PositionRow[];
  const fills = db.prepare("SELECT * FROM fills ORDER BY ts, id").all() as unknown as Fill[];

  const totalIn = positions.reduce((a, p) => a + p.usd_in, 0);
  const totalRealized = positions.reduce((a, p) => a + p.realized_usd, 0);
  const balance = deposited - totalIn + totalRealized;

  const openRows = positions.filter((p) => p.status !== "closed");
  const src = getSource();
  const now = virtualNow();
  const exitCostRate = (s.demo.pool_fee_pct + (s.demo.slippage_min_pct + s.demo.slippage_max_pct) / 2) / 100;
  let openValue = 0;
  for (const p of openRows) {
    let price = p.entry_price;
    try {
      price = await src.price(p.token_addr, now);
    } catch {
      // цена недоступна — оцениваем по входу
    }
    openValue += p.qty * price * (1 - exitCostRate);
  }
  const equity = balance + openValue;

  const closed = positions.filter((p) => p.status === "closed");
  const wins = closed.filter((p) => p.realized_usd - p.usd_in > 0).length;
  const winrate = closed.length ? wins / closed.length : 0;
  const avgProfit = closed.length
    ? closed.reduce((a, p) => a + (p.usd_in > 0 ? ((p.realized_usd - p.usd_in) / p.usd_in) * 100 : 0), 0) / closed.length
    : 0;

  const byOutcome: OutcomeBuckets = { closed_zero: 0, reached_x2: 0, reached_x5: 0, open: openRows.length };
  for (const p of closed) {
    const peakPct = p.entry_price > 0 ? (p.peak_price / p.entry_price - 1) * 100 : 0;
    if (peakPct >= 400) byOutcome.reached_x5++;
    else if (peakPct >= 100) byOutcome.reached_x2++;
    else byOutcome.closed_zero++;
  }

  const costs = fills.reduce((a, f) => a + f.fee_usd + f.slippage_usd, 0);

  // Кривая капитала: депозиты в плюс, входы в минус, продажи — net-поступления.
  const events: { ts: number; delta: number }[] = [];
  for (const d of deposits) events.push({ ts: d.ts, delta: d.usd });
  for (const f of fills) {
    if (f.kind === "open" || f.kind === "add") events.push({ ts: f.ts, delta: -f.usd });
    else events.push({ ts: f.ts, delta: f.usd - f.fee_usd - f.slippage_usd });
  }
  events.sort((a, b) => a.ts - b.ts);
  const equity_curve: EquityPoint[] = [];
  let run = 0;
  for (const e of events) {
    run += e.delta;
    equity_curve.push([e.ts, r2(run)]);
  }
  if (!equity_curve.length) equity_curve.push([now, r2(deposited)]);
  equity_curve.push([now, r2(equity)]);

  return {
    balance: r2(balance),
    deposited: r2(deposited),
    equity: r2(equity),
    equity_curve,
    winrate: r2(winrate * 100) / 100,
    avg_profit_pct: r2(avgProfit),
    by_outcome: byOutcome,
    trades_count: closed.length,
    open_count: openRows.length,
    costs_usd: r2(costs),
  };
}

/* ─────────────── алерты и депозиты ─────────────── */

export function listAlerts(unseenOnly = false): Alert[] {
  const sql =
    "SELECT a.*, COALESCE(p.symbol,'') AS symbol FROM alerts a LEFT JOIN positions p ON p.id=a.position_id" +
    (unseenOnly ? " WHERE a.seen=0" : "") +
    " ORDER BY a.id DESC";
  const rows = getDb().prepare(sql).all() as unknown as (Alert & { symbol: string })[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    position_id: r.position_id,
    symbol: r.symbol,
    kind: r.kind,
    message: r.message,
    severity: r.severity,
    seen: Boolean(r.seen),
  }));
}

/** Отметить алерт просмотренным и вернуть его же (DTO) — либо null, если id нет. */
export function markAlertSeen(id: number): Alert | null {
  const res = getDb().prepare("UPDATE alerts SET seen=1 WHERE id=?").run(id);
  if (Number(res.changes) === 0) return null;
  const row = getDb()
    .prepare(
      "SELECT a.*, COALESCE(p.symbol,'') AS symbol FROM alerts a LEFT JOIN positions p ON p.id=a.position_id WHERE a.id=?",
    )
    .get(id) as (Alert & { symbol: string }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    ts: row.ts,
    position_id: row.position_id,
    symbol: row.symbol,
    kind: row.kind,
    message: row.message,
    severity: row.severity,
    seen: Boolean(row.seen),
  };
}

export function addDeposit(usd: number, kind: "monthly" | "manual" = "manual"): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new ApiError("invalid_amount", 400, "сумма должна быть > 0");
  const now = virtualNow();
  const res = getDb().prepare("INSERT INTO deposits(ts, usd, kind) VALUES(?,?,?)").run(now, usd, kind);
  audit("deposit.add", { usd, kind }, "user");
  return Number(res.lastInsertRowid);
}

/* ─────────────── маппинг позиции ─────────────── */

export function mapPosition(row: PositionRow, currentPrice: number): Position {
  const now = virtualNow();
  const closed = row.status === "closed";
  const cur = currentPrice > 0 ? currentPrice : row.entry_price;
  const remainingValue = row.qty * cur;
  const pnlUsd = closed ? row.realized_usd - row.usd_in : row.realized_usd + remainingValue - row.usd_in;
  const pnlPct = row.usd_in > 0 ? (pnlUsd / row.usd_in) * 100 : 0;
  const ageDays = ((closed ? row.closed_ts ?? now : now) - row.opened_ts) / 86400;
  return {
    id: row.id,
    signal_id: row.signal_id,
    token_addr: row.token_addr,
    symbol: row.symbol,
    name: row.name,
    entry_price: r6(row.entry_price),
    qty: row.qty,
    usd_in: r2(row.usd_in),
    fees_usd: r2(row.fees_usd),
    slippage_usd: r2(row.slippage_usd),
    tp_price: r6(row.tp_price),
    tp_percent: r2(row.tp_percent),
    status: row.status as PositionStatus,
    free_ride_done: Boolean(row.free_ride_done),
    realized_usd: r2(row.realized_usd),
    peak_price: r6(row.peak_price),
    opened_ts: row.opened_ts,
    closed_ts: row.closed_ts,
    close_reason: (row.close_reason as CloseReason | null) ?? null,
    note: row.note,
    current_price: r6(cur),
    pnl_usd: r2(pnlUsd),
    pnl_pct: r2(pnlPct),
    age_days: r2(ageDays),
  };
}

/** Свечи для /api/candles через текущий источник. */
export async function candlesFor(token: string, tf: ChartTf, limit: number): Promise<number[][]> {
  const src = getSource();
  const ref: SourceRef = { token_addr: token, pair_addr: token, symbol: "", name: "" };
  return (await src.candles(ref, tf, limit, virtualNow())) as unknown as number[][];
}
