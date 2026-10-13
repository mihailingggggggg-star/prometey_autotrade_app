/**
 * events.ts — слой событий-отборщиков PROMETHEUS.
 *
 * Идея (решение владельца): вместо «слепого» перебора порции кандидатов семь
 * НЕЗАВИСИМЫХ отборщиков работают постоянно, и как только любой из них
 * срабатывает — монета уходит в общую воронку. Дорогие проверки (безопасность,
 * концентрация, свечи, накопление) выполняются только для тех, где событие уже
 * сработало.
 *
 * Ключ к экономике: список Jupiter (~4000 токенов с ценой, ликвидностью,
 * объёмом, холдерами и их изменениями) мы и так забираем ОДНИМ запросом. Значит
 * историю по всей вселенной можно копить БЕСПЛАТНО: каждый цикл складываем
 * снимок в свою таблицу token_history. Все события считаются по СВОЕЙ истории —
 * без единого лишнего запроса к внешним API.
 *
 * Снимок берётся из УЖЕ загруженной (кэш net.netJson) вселенной Jupiter: если
 * недавно её тянул отбор кандидатов, здесь не будет НИ ОДНОГО запроса. Отборщики
 * new_pool и large_buyer используют те же кэшированные данные GeckoTerminal, что и
 * воронка, поэтому тоже почти бесплатны.
 *
 * Единственные осознанные расходы за цикл: safety_cleared опрашивает RugCheck не
 * более SAFETY_CHECK_MAX_PER_CYCLE монет, large_buyer — не более
 * LARGE_BUYER_CHECK_MAX_PER_CYCLE сделок пулов (константы ниже).
 */
import { getDb, getSettings, metaGet, metaSet, nowSec } from "./db.ts";
import { getEnvNum, readDataMode } from "./config.ts";
import { jupiterUniverse, type JupiterToken } from "./sources/jupiter.ts";
import { newPools, poolTrades } from "./sources/geckoterminal.ts";
import { poolForToken } from "./sources/dexscreener.ts";
import { rugReport } from "./sources/rugcheck.ts";
import type { EventCode, TokenEvent } from "../shared/types.ts";
import type { SourceRef } from "./sources/mock.ts";

/* ─────────────── пороги отборщиков (константы с обоснованием) ─────────────── */

/**
 * dry_spike — «сухой всплеск: объём вырос, цена стоит». Признак набора позиции:
 * оборот раздулся, а цена не двинулась. Порог 2.5× медианы за 14 дней выбран как
 * «объём заметно выше обычного фона монеты», но не экстремум (3×+ почти всегда
 * одиночный выброс). Спокойная цена — |Δ24ч| ≤ 5%; набор холдеров — ≥ 1% за сутки.
 */
const DRY_SPIKE_VOL_MULT = 2.5;
const DRY_SPIKE_PRICE_MAX_ABS_PCT = 5;
const DRY_SPIKE_HOLDERS_MIN_PCT = 1;

/**
 * breakout — «старт пробоя коридора». Цена вышла ВВЕРХ из 14-дневного коридора,
 * набранного по нашим снимкам, и сделала это на объёме. Порог +8% за 6 часов —
 * «импульс, а не шум»; объём ≥ 2× медианы подтверждает, что выход настоящий.
 */
const BREAKOUT_PRICE_6H_MIN_PCT = 8;
const BREAKOUT_VOL_MULT = 2;
/**
 * Минимальная длина истории для коридора/6-часового изменения. Меньше — НЕ
 * выдумываем: отборщик молчит и пишет в лог причину «мало истории».
 */
const BREAKOUT_MIN_HISTORY_DAYS = 3;
/** Допуск при поиске снимка «~6 часов назад» (снимки идут не ровно по часам). */
const BREAKOUT_6H_TOLERANCE_H = 3;

/**
 * lp_inflow — «приток ликвидности» при плоской цене: в пул доливают деньги, но
 * цена ещё стоит. +15% ликвидности за сутки — заметное пополнение; |Δцены| ≤ 5%.
 */
const LP_INFLOW_LIQ_MIN_PCT = 15;
const LP_INFLOW_PRICE_MAX_ABS_PCT = 5;

/**
 * holders_accel — «ускорение холдеров» при плоской цене: +2% держателей за сутки
 * значит аудитория растёт быстрее фона, но цена это ещё не отыграла.
 */
const HOLDERS_ACCEL_MIN_PCT = 2;
const HOLDERS_ACCEL_PRICE_MAX_ABS_PCT = 5;

/**
 * new_pool — «новый пул у зрелой монеты»: в списке новых пулов GeckoTerminal
 * появился пул токена возрастом 7–180 дней (миграция/новая площадка). Это окно
 * стратегии; младше 7 дней — ещё не сформировавшаяся монета, старше 180 — уже вне
 * нашего горизонта.
 */
const NEW_POOL_MIN_TOKEN_AGE_DAYS = 7;
const NEW_POOL_MAX_TOKEN_AGE_DAYS = 180;

/**
 * safety_cleared — «права отозваны / ликвидность сожжена»: событие-РАЗРЕШЕНИЕ
 * (до него монета блокировалась слоем 1). Чтобы не выжечь бюджет RugCheck, за цикл
 * проверяем не более N монет (ротация по курсору в meta). Порог запертой
 * ликвидности зеркалит слой 1 (70%), чтобы событие означало «слой 1 теперь пройдёт».
 */
const SAFETY_CHECK_MAX_PER_CYCLE = 3;
const SAFETY_LP_LOCKED_MIN_PCT = 70;

/**
 * large_buyer — «крупные покупки в пуле»: за последний час в сделках пула есть
 * покупка выше порога. Абсолютный порог — ≥ $2000. Относительный путь (≥ 3×
 * медианной сделки пула) подключаем только для ЖИВОГО пула, где типичная сделка
 * ≥ $50: если медиана сделки ниже, пул микроскопический и «×9 от $0.1» — шум,
 * а не крупный заход. За цикл проверяем не более N пулов, приоритет — монеты, у
 * которых уже сработало другое событие.
 */
const LARGE_BUYER_MIN_USD = 2000;
const LARGE_BUYER_MEDIAN_MULT = 3;
/**
 * Пол медианы сделки для относительного пути: сравнивать покупку с медианой
 * имеет смысл только в живом пуле, где типичная сделка ≥ $50. Ниже — медиана
 * микроскопическая, и любое «×9 от $0.1» это шум, а не крупный заход.
 */
const LARGE_BUYER_MEDIAN_FLOOR_USD = 50;
const LARGE_BUYER_CHECK_MAX_PER_CYCLE = 4;
/** Окно «крупных покупок» — последний час. */
const LARGE_BUYER_WINDOW_SEC = 3600;

/* ─────────────── история: окна хранения ─────────────── */

/** Окно истории для медиан/коридора — 14 дней (совпадает с «медиана за 14 дней»). */
const HISTORY_WINDOW_DAYS = 14;
/** Ретеншен: старше — удаляем. */
const HISTORY_RETENTION_DAYS = 30;
/** Строки старше 48 часов свёртываются до одного значения в час. */
const HISTORY_COLLAPSE_AFTER_HOURS = 48;
/** Минимум снимков, чтобы вообще считать медиану (иначе «мало истории»). */
const MIN_MEDIAN_SAMPLES = 8;
/** Предохранитель от патологического размера цикла (монет за проход). */
const MAX_MINTS_PER_CYCLE = 5000;

const LABELS: Record<EventCode, string> = {
  dry_spike: "сухой всплеск: объём вырос, цена стоит",
  breakout: "старт пробоя коридора",
  lp_inflow: "приток ликвидности",
  holders_accel: "ускорение холдеров",
  new_pool: "новый пул у зрелой монеты",
  safety_cleared: "права отозваны / ликвидность сожжена",
  large_buyer: "крупные покупки в пуле",
};

/* ─────────────── утилиты ─────────────── */

function snapEveryMin(): number {
  return getEnvNum("SNAP_EVERY_MIN") || 15;
}
/** TTL дедупа событий (мин). */
function eventTtlMin(): number {
  return getEnvNum("EVENT_TTL_MIN") || 360;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${round1(v)}%`;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

interface HistRow {
  ts: number;
  price: number;
  liq_usd: number;
  volume_24h: number;
  holders: number;
  holder_change_24h: number | null;
  liq_change_24h: number | null;
  price_change_24h: number | null;
  price_change_6h: number | null;
  fdv: number;
  organic: number | null;
}

interface EventRow {
  id: number;
  ts: number;
  token_addr: string;
  symbol: string;
  code: string;
  label_ru: string;
  note: string;
  metrics_json: string;
  status: string;
  signal_id: number | null;
}

/* ─────────────── 1. история снимков ─────────────── */

/**
 * Снимок вселенной Jupiter в token_history. Пишем ТОЛЬКО монеты в окне стратегии
 * по возрасту (иначе таблица распухнет впустую). Новых запросов не делаем: map уже
 * загружен (кэш). price_change_6h/24h считаем по СВОЕЙ истории, если уже накопили
 * (Jupiter отдаёт суточное изменение цены сразу — берём его, когда есть).
 *
 * Возвращает число записанных строк (для лога цикла).
 */
export function captureSnapshot(uni: Map<string, JupiterToken>, now: number): number {
  const db = getDb();
  const s = getSettings().screener;
  const ins = db.prepare(
    "INSERT OR REPLACE INTO token_history" +
      "(mint,ts,price,liq_usd,volume_24h,holders,holder_change_24h,liq_change_24h," +
      "price_change_24h,price_change_6h,fdv,organic) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const priceBefore = db.prepare(
    "SELECT price FROM token_history WHERE mint=? AND ts<=? ORDER BY ts DESC LIMIT 1",
  );
  const ch6Cut = now - 6 * 3600;
  const ch24Cut = now - 24 * 3600;
  let n = 0;
  for (const t of uni.values()) {
    if (t.age_days === null) continue;
    if (t.age_days < s.age_min || t.age_days > s.age_max) continue;
    const p6 = (priceBefore.get(t.mint, ch6Cut) as { price: number } | undefined)?.price ?? null;
    const p24 = (priceBefore.get(t.mint, ch24Cut) as { price: number } | undefined)?.price ?? null;
    const ch6 = p6 && p6 > 0 ? round2((t.usd_price / p6 - 1) * 100) : null;
    const ch24 =
      t.price_change_24h_pct != null
        ? t.price_change_24h_pct
        : p24 && p24 > 0
          ? round2((t.usd_price / p24 - 1) * 100)
          : null;
    ins.run(
      t.mint,
      now,
      t.usd_price,
      t.liq_usd,
      t.volume_24h_usd,
      t.holder_count,
      t.holders_change_24h_pct,
      t.liquidity_change_24h_pct,
      ch24,
      ch6,
      t.fdv_usd,
      t.organic_score,
    );
    n++;
  }
  return n;
}

/**
 * Уборка истории: ретеншен 30 дней + свёртка до одного значения в час для строк
 * старше 48 часов. Всё в ТОМ ЖЕ цикле, что и снимок, — отдельной службы нет.
 *
 * Свёртка идемпотентна: уже «часовые» строки (ts % 3600 == 0) пропускаются, так
 * что повторные циклы не перемалывают всю старую историю заново. В свёрнутом часе
 * цена/холдеры/тренды — ПОСЛЕДНИЕ измеренные значения (тренд честен), объём и
 * ликвидность — средние за час (одиночный всплеск не перевешивает и не исчезает).
 */
export function cleanupHistory(now: number): void {
  const db = getDb();
  db.prepare("DELETE FROM token_history WHERE ts < ?").run(now - HISTORY_RETENTION_DAYS * 86_400);
  const cutoff = now - HISTORY_COLLAPSE_AFTER_HOURS * 3600;
  db.prepare(
    "INSERT OR REPLACE INTO token_history" +
      "(mint,ts,price,liq_usd,volume_24h,holders,holder_change_24h,liq_change_24h," +
      "price_change_24h,price_change_6h,fdv,organic) " +
      "SELECT mint,bucket,price,avg_liq,avg_vol,holders,holder_change_24h,liq_change_24h," +
      "price_change_24h,price_change_6h,fdv,organic FROM (" +
      "  SELECT mint,(CAST(ts AS INTEGER)/3600)*3600 AS bucket," +
      "    price,holders,holder_change_24h,liq_change_24h,price_change_24h,price_change_6h,fdv,organic," +
      "    AVG(liq_usd) OVER (PARTITION BY mint,CAST(ts AS INTEGER)/3600) AS avg_liq," +
      "    AVG(volume_24h) OVER (PARTITION BY mint,CAST(ts AS INTEGER)/3600) AS avg_vol," +
      "    ROW_NUMBER() OVER (PARTITION BY mint,CAST(ts AS INTEGER)/3600 ORDER BY ts DESC) AS rn" +
      "  FROM token_history WHERE ts < ? AND ts % 3600 <> 0" +
      ") WHERE rn=1",
  ).run(cutoff);
  db.prepare("DELETE FROM token_history WHERE ts < ? AND ts % 3600 <> 0").run(cutoff);
}

/* ─────────────── дедуп и запись события ─────────────── */

/** Совсем недавно уже писали то же (монета, код)? Тогда не плодим записи. */
function eventIsFresh(tokenAddr: string, code: EventCode, now: number, ttlMin: number): boolean {
  const row = getDb()
    .prepare("SELECT ts FROM events WHERE token_addr=? AND code=? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(tokenAddr, code) as { ts: number } | undefined;
  return row !== undefined && now - row.ts < ttlMin * 60;
}

function insertEvent(
  now: number,
  tokenAddr: string,
  symbol: string,
  code: EventCode,
  note: string,
  metrics: Record<string, number | null>,
): boolean {
  getDb()
    .prepare(
      "INSERT INTO events(ts,token_addr,symbol,code,label_ru,note,metrics_json,status,signal_id)" +
        " VALUES(?,?,?,?,?,?,?,'new',NULL)",
    )
    .run(now, tokenAddr, symbol, code, LABELS[code], note, JSON.stringify(metrics));
  return true;
}

/**
 * Записать событие, если дедуп позволяет. Возвращает true, если записали.
 * Дедуп: одно и то же (монета, код) не чаще раза в EVENT_TTL_MIN минут — иначе
 * один всплеск породил бы сотни записей (снимок идёт каждые SNAP_EVERY_MIN минут).
 */
function maybeEmit(
  now: number,
  tokenAddr: string,
  symbol: string,
  code: EventCode,
  note: string,
  metrics: Record<string, number | null>,
  ttlMin: number,
): boolean {
  if (eventIsFresh(tokenAddr, code, now, ttlMin)) return false;
  return insertEvent(now, tokenAddr, symbol, code, note, metrics);
}

/* ─────────────── 2. семь отборщиков ─────────────── */

/**
 * Обойти историю всех «свежих» монет и применить к каждой независимые отборщики,
 * которые считаются по СВОЕЙ истории (dry_spike, breakout, lp_inflow,
 * holders_accel), затем события по внешним данным, которые мы и так забираем
 * (new_pool, safety_cleared, large_buyer). Возвращает число записанных событий.
 *
 * uni — карта вселенной Jupiter (уже загруженная). null — недоступна: события по
 * истории всё равно считаются, символ тогда «?».
 */
export async function detectEvents(
  now = nowSec(),
  uniIn?: Map<string, JupiterToken> | null,
): Promise<number> {
  const db = getDb();
  const ttl = eventTtlMin();
  let uni: Map<string, JupiterToken> | null;
  if (uniIn !== undefined) uni = uniIn;
  else {
    try {
      uni = await jupiterUniverse();
    } catch {
      uni = null;
    }
  }
  const symbolOf = (mint: string): string => uni?.get(mint)?.symbol?.toUpperCase() ?? "?";

  // Монеты, у которых есть снимок за последний час: их и разбираем. Так цикл не
  // зависит от того, удалось ли обновить вселенную именно в этот раз.
  const recent = now - Math.max(3600, snapEveryMin() * 60 * 2);
  const mintRows = db
    .prepare("SELECT DISTINCT mint FROM token_history WHERE ts >= ? LIMIT ?")
    .all(recent, MAX_MINTS_PER_CYCLE) as { mint: string }[];
  const mints = mintRows.map((r) => r.mint);

  const histStmt = db.prepare(
    "SELECT ts,price,liq_usd,volume_24h,holders,holder_change_24h,liq_change_24h," +
      "price_change_24h,price_change_6h,fdv,organic FROM token_history " +
      "WHERE mint=? AND ts>=? ORDER BY ts ASC",
  );
  const since = now - HISTORY_WINDOW_DAYS * 86_400;

  let count = 0;
  let littleHistory = 0;
  const touched = new Set<string>(); // монеты с событием за этот цикл (для large_buyer)

  for (const mint of mints) {
    const hist = histStmt.all(mint, since) as unknown as HistRow[];
    if (!hist.length) continue;
    const sym = symbolOf(mint);
    const emitted = runHistorySelectors(now, mint, sym, hist, ttl, touched);
    count += emitted;
    if (needsLittleHistoryLog(hist)) littleHistory++;
  }

  if (littleHistory > 0) {
    console.error(
      `[события] breakout: мало истории (<${BREAKOUT_MIN_HISTORY_DAYS} дн) у ${littleHistory} монет — коридор/6ч не считаю, не выдумываю`,
    );
  }

  // new_pool — новый пул у зрелой монеты (данные GeckoTerminal мы и так забираем).
  count += await detectNewPool(now, uni, ttl, touched);

  // safety_cleared — переход прав минта/ликвидности (ограниченный бюджет RugCheck).
  count += await detectSafetyCleared(now, mints, symbolOf, ttl, touched);

  // large_buyer — крупные покупки в пулах (сделки мы и так забираем). Только монеты
  // с уже сработавшим событием + ротация по дешёвому предфильтру (окно возраста).
  count += await detectLargeBuyer(now, mints, symbolOf, ttl, touched);

  return count;
}

/** Не хватает истории для breakout? (для одной сводной строки в лог) */
function needsLittleHistoryLog(hist: HistRow[]): boolean {
  const spanDays = (hist[hist.length - 1].ts - hist[0].ts) / 86_400;
  return spanDays < BREAKOUT_MIN_HISTORY_DAYS || hist.length < MIN_MEDIAN_SAMPLES;
}

/**
 * Четыре отборщика по СВОЕЙ истории. Возвращает число записей. Каждый — со своей
 * формулировкой и порогом-константой (см. блок констант выше).
 */
function runHistorySelectors(
  now: number,
  mint: string,
  sym: string,
  hist: HistRow[],
  ttl: number,
  touched: Set<string>,
): number {
  const cur = hist[hist.length - 1];
  let n = 0;

  // dry_spike — объём вспух, цена стоит, холдеры прибывают.
  const vols = hist.map((h) => h.volume_24h);
  if (hist.length >= MIN_MEDIAN_SAMPLES) {
    const med = median(vols);
    const pc = cur.price_change_24h;
    const hc = cur.holder_change_24h;
    if (
      med > 0 &&
      cur.volume_24h >= DRY_SPIKE_VOL_MULT * med &&
      pc !== null &&
      Math.abs(pc) <= DRY_SPIKE_PRICE_MAX_ABS_PCT &&
      hc !== null &&
      hc >= DRY_SPIKE_HOLDERS_MIN_PCT
    ) {
      const x = cur.volume_24h / med;
      if (
        maybeEmit(
          now,
          mint,
          sym,
          "dry_spike",
          `объём ${round1(x)}× медианы, цена ${fmtPct(pc)}, холдеры ${fmtPct(hc)}`,
          {
            volume_x: round1(x),
            volume_24h: Math.round(cur.volume_24h),
            median_volume: Math.round(med),
            price_change_24h: round1(pc),
            holder_change_24h: round1(hc),
          },
          ttl,
        )
      ) {
        n++;
        touched.add(mint);
      }
    }
  }

  // breakout — старт пробоя коридора (мало истории → молчим, см. лог выше).
  const spanDays = (cur.ts - hist[0].ts) / 86_400;
  if (spanDays >= BREAKOUT_MIN_HISTORY_DAYS && hist.length >= MIN_MEDIAN_SAMPLES) {
    const target = cur.ts - 6 * 3600;
    let p6: HistRow | null = null;
    for (const h of hist) if (h.ts <= target) p6 = h;
    const p6Fresh = p6 !== null && target - p6.ts <= BREAKOUT_6H_TOLERANCE_H * 3600;
    let upper = -Infinity;
    for (const h of hist) if (h.ts < cur.ts && h.price > upper) upper = h.price;
    const med = median(vols);
    const ch6 =
      p6Fresh && p6 && p6.price > 0 ? round2((cur.price / p6.price - 1) * 100) : null;
    if (
      ch6 !== null &&
      ch6 >= BREAKOUT_PRICE_6H_MIN_PCT &&
      upper > 0 &&
      cur.price > upper &&
      med > 0 &&
      cur.volume_24h >= BREAKOUT_VOL_MULT * med
    ) {
      const x = cur.volume_24h / med;
      if (
        maybeEmit(
          now,
          mint,
          sym,
          "breakout",
          `цена ${fmtPct(ch6)} за 6ч, выше коридора ${round2(upper)} (цена ${round2(cur.price)}), объём ${round1(x)}× медианы`,
          {
            price_change_6h: ch6,
            price: round2(cur.price),
            corridor_upper: round2(upper),
            volume_x: round1(x),
          },
          ttl,
        )
      ) {
        n++;
        touched.add(mint);
      }
    }
  }

  // lp_inflow — приток ликвидности при плоской цене.
  const lc = cur.liq_change_24h;
  const pc = cur.price_change_24h;
  if (
    lc !== null &&
    lc >= LP_INFLOW_LIQ_MIN_PCT &&
    pc !== null &&
    Math.abs(pc) <= LP_INFLOW_PRICE_MAX_ABS_PCT
  ) {
    if (
      maybeEmit(
        now,
        mint,
        sym,
        "lp_inflow",
        `ликвидность ${fmtPct(lc)} за сутки, цена ${fmtPct(pc)}`,
        {
          liq_change_24h: round1(lc),
          liq_usd: Math.round(cur.liq_usd),
          price_change_24h: round1(pc),
        },
        ttl,
      )
    ) {
      n++;
      touched.add(mint);
    }
  }

  // holders_accel — ускорение прироста холдеров при плоской цене.
  const hc = cur.holder_change_24h;
  if (
    hc !== null &&
    hc >= HOLDERS_ACCEL_MIN_PCT &&
    pc !== null &&
    Math.abs(pc) <= HOLDERS_ACCEL_PRICE_MAX_ABS_PCT
  ) {
    if (
      maybeEmit(
        now,
        mint,
        sym,
        "holders_accel",
        `холдеры ${fmtPct(hc)} за сутки, цена ${fmtPct(pc)}`,
        {
          holder_change_24h: round1(hc),
          holders: Math.round(cur.holders),
          price_change_24h: round1(pc),
        },
        ttl,
      )
    ) {
      n++;
      touched.add(mint);
    }
  }

  return n;
}

/** new_pool: в новых пулах GeckoTerminal — пул токена возрастом 7–180 дней. */
async function detectNewPool(
  now: number,
  uni: Map<string, JupiterToken> | null,
  ttl: number,
  touched: Set<string>,
): Promise<number> {
  let pools: Awaited<ReturnType<typeof newPools>>;
  try {
    pools = await newPools();
  } catch {
    return 0;
  }
  let n = 0;
  for (const p of pools) {
    const t = uni?.get(p.mint);
    const age = t?.age_days;
    const sym = t?.symbol?.toUpperCase() ?? p.symbol.toUpperCase();
    // Возраст токена — из вселенной. Нет данных — не выдумываем.
    if (age == null || age < NEW_POOL_MIN_TOKEN_AGE_DAYS || age > NEW_POOL_MAX_TOKEN_AGE_DAYS) continue;
    if (
      maybeEmit(
        now,
        p.mint,
        sym,
        "new_pool",
        `новый пул у монеты возрастом ${Math.round(age)} дн, ликвидность пула $${Math.round(p.liq_usd)}`,
        { token_age_days: round1(age), pool_liq_usd: Math.round(p.liq_usd) },
        ttl,
      )
    ) {
      n++;
      touched.add(p.mint);
    }
  }
  return n;
}

/**
 * safety_cleared: права минта СТАЛИ отозваны или запертая ликвидность ПЕРЕШЛА
 * порог. Понятие «стали/перешёл» требует предыдущего наблюдения — его хранит
 * внутренняя таблица token_safety. Первое наблюдение лишь ставит базу (событие не
 * пишем): иначе каждая и так отозванная монета «разрешалась» бы на первом заходе.
 * За цикл опрашиваем не более SAFETY_CHECK_MAX_PER_CYCLE монет (ротация).
 */
async function detectSafetyCleared(
  now: number,
  mints: string[],
  symbolOf: (m: string) => string,
  ttl: number,
  touched: Set<string>,
): Promise<number> {
  if (!mints.length) return 0;
  const db = getDb();
  const cursor = Number(metaGet("safety_cursor") ?? 0) || 0;
  const start = ((cursor % mints.length) + mints.length) % mints.length;
  const take = Math.min(SAFETY_CHECK_MAX_PER_CYCLE, mints.length);
  const prevStmt = db.prepare("SELECT mint_revoked, lp_locked_pct FROM token_safety WHERE mint=?");
  const upStmt = db.prepare(
    "INSERT INTO token_safety(mint,mint_revoked,lp_locked_pct,ts) VALUES(?,?,?,?) " +
      "ON CONFLICT(mint) DO UPDATE SET mint_revoked=excluded.mint_revoked," +
      "lp_locked_pct=excluded.lp_locked_pct, ts=excluded.ts",
  );
  let n = 0;
  for (let i = 0; i < take; i++) {
    const mint = mints[(start + i) % mints.length];
    let revoked = false;
    let lpPct = 0;
    try {
      const rep = await rugReport(mint);
      revoked = rep.mintAuthority == null;
      for (const m of rep.markets ?? []) {
        const pct = m.lp?.lpLockedPct;
        if (typeof pct === "number" && pct > lpPct) lpPct = pct;
      }
    } catch {
      continue; // источник недоступен — не выдумываем событие
    }
    const prev = prevStmt.get(mint) as { mint_revoked: number; lp_locked_pct: number } | undefined;
    if (prev) {
      const becameRevoked = prev.mint_revoked === 0 && revoked;
      const becameLocked =
        prev.lp_locked_pct < SAFETY_LP_LOCKED_MIN_PCT && lpPct >= SAFETY_LP_LOCKED_MIN_PCT;
      if (becameRevoked || becameLocked) {
        const note = becameRevoked
          ? `права минта отозваны (ликвидность заперта ${round1(lpPct)}%)`
          : `ликвидность заперта ${round1(lpPct)}% (порог ${SAFETY_LP_LOCKED_MIN_PCT}%)`;
        if (
          maybeEmit(
            now,
            mint,
            symbolOf(mint),
            "safety_cleared",
            note,
            { mint_revoked: revoked ? 1 : 0, lp_locked_pct: round1(lpPct) },
            ttl,
          )
        ) {
          n++;
          touched.add(mint);
        }
      }
    }
    upStmt.run(mint, revoked ? 1 : 0, lpPct, now);
  }
  metaSet("safety_cursor", String((start + take) % mints.length));
  return n;
}

/**
 * large_buyer: в сделках пула за последний час есть крупная покупка. Проверяем
 * только монеты с уже сработавшим событием (их немного) и, в добор, ротацию по
 * дешёвому предфильтру (монеты с историей = окно возраста). За цикл — не более
 * LARGE_BUYER_CHECK_MAX_PER_CYCLE пулов.
 */
async function detectLargeBuyer(
  now: number,
  mints: string[],
  symbolOf: (m: string) => string,
  ttl: number,
  touched: Set<string>,
): Promise<number> {
  const cap = LARGE_BUYER_CHECK_MAX_PER_CYCLE;
  const cursor = Number(metaGet("large_cursor") ?? 0) || 0;
  // Строгий потолок на цикл: сначала монеты с уже сработавшим событием, добор —
  // ротацией по дешёвому предфильтру (монеты окна возраста). Без этого один
  // «урожайный» цикл ушёл бы в десятки запросов к Gecko/DexScreener.
  const targets: string[] = [];
  for (const m of touched) {
    if (targets.length >= cap) break;
    if (!targets.includes(m)) targets.push(m);
  }
  let nextCursor = cursor;
  if (targets.length < cap && mints.length) {
    const start = ((cursor % mints.length) + mints.length) % mints.length;
    let i = 0;
    while (targets.length < cap && i < mints.length) {
      const m = mints[(start + i) % mints.length];
      if (!targets.includes(m)) targets.push(m);
      i++;
    }
    nextCursor = (start + i) % mints.length;
  }
  if (mints.length) metaSet("large_cursor", String(nextCursor));
  let n = 0;
  for (const mint of targets) {
    let pool: string | null = null;
    try {
      pool = await poolForToken(mint);
    } catch {
      continue;
    }
    if (!pool) continue;
    let trades: Awaited<ReturnType<typeof poolTrades>>;
    try {
      trades = await poolTrades(pool);
    } catch {
      continue;
    }
    if (!trades.length) continue;
    const buys = trades.filter((t) => t.kind === "buy");
    const inHour = buys.filter((t) => t.ts > 0 && now - t.ts <= LARGE_BUYER_WINDOW_SEC);
    if (!inHour.length) continue;
    const med = median(trades.map((t) => t.usd).filter((u) => u > 0));
    let maxBuy = 0;
    for (const b of inHour) if (b.usd > maxBuy) maxBuy = b.usd;
    // Абсолютный порог $2000 работает всегда; относительный (×3 к медиане) —
    // только при медиане сделки ≥ $50, иначе пул микроскопический и это шум.
    const big =
      maxBuy >= LARGE_BUYER_MIN_USD ||
      (med >= LARGE_BUYER_MEDIAN_FLOOR_USD && maxBuy >= LARGE_BUYER_MEDIAN_MULT * med);
    if (!big) continue;
    const x = med > 0 ? round1(maxBuy / med) : 0;
    if (
      maybeEmit(
        now,
        mint,
        symbolOf(mint),
        "large_buyer",
        `покупка $${Math.round(maxBuy)} за час (~${x}× медианы сделки)`,
        { max_buy_usd: Math.round(maxBuy), median_trade_usd: Math.round(med), buys_1h: inHour.length },
        ttl,
      )
    ) {
      n++;
      touched.add(mint);
    }
  }
  return n;
}

/* ─────────────── 3. цикл обслуживания событий ─────────────── */

/**
 * Полный цикл слоя событий: снимок истории (из кэша вселенной, без новых
 * запросов) → уборка (ретеншен + свёртка) → отбор событий. Вызывается служебным
 * циклом сервера не чаще, чем раз в SNAP_EVERY_MIN минут (гейт ниже). В mock —
 * всегда no-op: событийный слой живёт только в живом контуре.
 *
 * force=true снимает гейт частоты (смоук/тесты).
 */
export async function refreshEvents(force = false): Promise<{ snapshot: number; events: number }> {
  if (readDataMode() !== "live") return { snapshot: 0, events: 0 };
  const now = nowSec();
  const every = snapEveryMin();
  if (!force) {
    const last = Number(metaGet("last_snap_ts") ?? 0) || 0;
    if (last > 0 && now - last < every * 60) return { snapshot: 0, events: 0 };
  }
  metaSet("last_snap_ts", String(now));

  let snapshot = 0;
  let uni: Map<string, JupiterToken> | null = null;
  try {
    uni = await jupiterUniverse();
    snapshot = captureSnapshot(uni, now);
  } catch (e) {
    console.error(`[события] снимок истории не удался: ${e instanceof Error ? e.message : e}`);
  }
  try {
    cleanupHistory(now);
  } catch (e) {
    console.error(`[события] уборка истории не удалась: ${e instanceof Error ? e.message : e}`);
  }
  let events = 0;
  try {
    events = await detectEvents(now, uni);
  } catch (e) {
    console.error(`[события] отбор не удался: ${e instanceof Error ? e.message : e}`);
  }
  return { snapshot, events };
}

/* ─────────────── 4. связь с воронкой и API ─────────────── */

export type EventStatus = "new" | "checked" | "rejected" | "signaled";

/** Кандидат из событий: монета + id событий и их коды (для сигнала). */
export interface EventCandidate {
  ref: SourceRef;
  eventIds: number[];
  codes: EventCode[];
}

/**
 * Взять кандидатов из событий со статусом new (свежие вперёд, потолок за проход).
 * Монета попадает один раз; её коды (до трёх) уйдут в сигнал. Дешёвая выборка из
 * БД — без сети.
 */
export function takeEventCandidates(limit: number): EventCandidate[] {
  if (limit <= 0) return [];
  const rows = getDb()
    .prepare("SELECT id, token_addr, symbol, code FROM events WHERE status='new' ORDER BY ts DESC, id DESC LIMIT ?")
    .all(limit * 4) as { id: number; token_addr: string; symbol: string; code: string }[];
  const byToken = new Map<string, EventCandidate>();
  for (const r of rows) {
    let c = byToken.get(r.token_addr);
    if (!c) {
      c = {
        ref: { token_addr: r.token_addr, pair_addr: r.token_addr, symbol: r.symbol, name: r.symbol },
        eventIds: [],
        codes: [],
      };
      byToken.set(r.token_addr, c);
    }
    c.eventIds.push(r.id);
    const code = r.code as EventCode;
    if (c.codes.length < 3 && !c.codes.includes(code)) c.codes.push(code);
    if (byToken.size > limit && !byToken.has(r.token_addr)) break;
  }
  return [...byToken.values()].slice(0, limit);
}

/** Проставить исход событиям (rejected/signaled/checked) и ссылку на сигнал. */
export function markEvents(ids: number[], status: EventStatus, signalId: number | null = null): void {
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  getDb()
    .prepare(`UPDATE events SET status=?, signal_id=? WHERE id IN (${ph})`)
    .run(status, signalId, ...ids);
}

/** Коды, которыми были вызваны сигналы (до трёх на сигнал), одним запросом. */
export function codesForSignals(signalIds: number[]): Map<number, EventCode[]> {
  const out = new Map<number, EventCode[]>();
  if (!signalIds.length) return out;
  const ph = signalIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT signal_id, code FROM events WHERE signal_id IN (${ph}) ORDER BY id ASC`)
    .all(...signalIds) as { signal_id: number; code: string }[];
  for (const r of rows) {
    const arr = out.get(r.signal_id) ?? [];
    const code = r.code as EventCode;
    if (arr.length < 3 && !arr.includes(code)) arr.push(code);
    out.set(r.signal_id, arr);
  }
  return out;
}

/* ─────────────── 5. чтение для API ─────────────── */

export interface EventsQuery {
  limit: number;
  status?: string;
  token?: string;
}

function eventDTO(row: EventRow): TokenEvent {
  let metrics: Record<string, number | null> = {};
  try {
    metrics = JSON.parse(row.metrics_json) as Record<string, number | null>;
  } catch {
    // Битый JSON не должен ломать ответ API.
  }
  return {
    id: row.id,
    ts: row.ts,
    token_addr: row.token_addr,
    symbol: row.symbol,
    code: row.code as EventCode,
    label_ru: row.label_ru,
    note: row.note,
    metrics,
    status: row.status as TokenEvent["status"],
    signal_id: row.signal_id,
  };
}

/** Список событий для GET /api/events (свежие вперёд). Дешёвый, без сети. */
export function listEvents(q: EventsQuery): TokenEvent[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.status) {
    where.push("status=?");
    args.push(q.status);
  }
  if (q.token) {
    where.push("token_addr=?");
    args.push(q.token);
  }
  const sql =
    "SELECT * FROM events" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY ts DESC, id DESC LIMIT ?";
  args.push(q.limit);
  const rows = getDb().prepare(sql).all(...args) as unknown as EventRow[];
  return rows.map(eventDTO);
}
