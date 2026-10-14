/**
 * db.ts — хранилище демо-контура на node:sqlite (DatabaseSync), схема из §3 плана.
 *
 * Здесь только «механическая» часть: схема, сид настроек, журнал, алерты,
 * виртуальные часы и хелперы настроек. Бизнес-логика (воронка, движок) живёт
 * в screener.ts и demo.ts и работает с БД через экспортированный getDb().
 *
 * Соединение открывается лениво: модуль импортируют при старте, но путь к БД
 * берётся из окружения в момент первого обращения — тесты успевают подставить
 * свой DB_PATH.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { REPO_ROOT, getEnv, getEnvNum, readDataMode, ApiError } from "./config.ts";
import type {
  Settings,
  SettingsPatch,
  AlertKind,
  ScanRun,
  FunnelDay,
  FunnelSummary,
} from "../shared/types.ts";

/* ─────────────── соединение ─────────────── */

let instance: DatabaseSync | null = null;
let openedPath = "";

export function dbPath(): string {
  return resolve(REPO_ROOT, getEnv("DB_PATH") || "./data/demo.db");
}

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });
  instance = new DatabaseSync(p);
  openedPath = p;
  migrate(instance);
  seedDefaults(instance);
  return instance;
}

/** Для тестов: закрыть соединение, чтобы следующий вызов открыл БД по новому пути. */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
    openedPath = "";
  }
}

export function currentDbPath(): string {
  return openedPath;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      token_addr TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      pair_addr TEXT NOT NULL,
      price REAL NOT NULL,
      liq_usd REAL NOT NULL,
      mc_usd REAL NOT NULL,
      age_days REAL NOT NULL,
      tf_accum TEXT NOT NULL,
      score REAL NOT NULL,
      status TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      social_json TEXT NOT NULL,
      overview_ru TEXT NOT NULL,
      sentiment REAL NOT NULL,
      is_organic INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER,
      token_addr TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      entry_price REAL NOT NULL,
      qty REAL NOT NULL,
      usd_in REAL NOT NULL,
      fees_usd REAL NOT NULL,
      slippage_usd REAL NOT NULL,
      tp_price REAL NOT NULL,
      tp_percent REAL NOT NULL,
      status TEXT NOT NULL,
      free_ride_done INTEGER NOT NULL,
      realized_usd REAL NOT NULL,
      peak_price REAL NOT NULL,
      opened_ts INTEGER NOT NULL,
      closed_ts INTEGER,
      close_reason TEXT,
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      price REAL NOT NULL,
      qty REAL NOT NULL,
      usd REAL NOT NULL,
      fee_usd REAL NOT NULL,
      slippage_usd REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      usd REAL NOT NULL,
      kind TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      position_id INTEGER,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS keys_meta (
      key_name TEXT PRIMARY KEY,
      is_set INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      preview TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Медиаслой (Apify): нормализованные упоминания токена в X и статус сбора.
    -- Дедуп по (mint, url/идентификатор) — уникальный индекс; повторный сбор той
    -- же публикации не создаёт дубль (INSERT OR IGNORE).
    CREATE TABLE IF NOT EXISTS mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      url TEXT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0,
      retweets INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0,
      lang TEXT NOT NULL DEFAULT ''
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_dedup ON mentions(mint, url);
    CREATE INDEX IF NOT EXISTS idx_mentions_mint_ts ON mentions(mint, ts);

    -- Статус сбора по монете и источнику: когда обновляли и чем закончилось.
    -- items = -1 — сбор НЕ удался (нет ключа/ошибка/бюджет): такие данные «не
    -- свежие как результат», и слой 5 обязан видеть их как «нет данных».
    CREATE TABLE IF NOT EXISTS media_status (
      mint TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_ts INTEGER NOT NULL,
      items INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (mint, source)
    );

    -- История снимков вселенной Jupiter: копится БЕСПЛАТНО, из уже загруженного
    -- (кэш) списка токенов — по одному снимку на цикл. По ней считаются события-
    -- отборщики (медианы объёма, коридор, 6-часовое изменение цены), без единого
    -- лишнего запроса к внешним API. Пишутся только монеты в окне стратегии по
    -- возрасту. Ретеншен 30 дней; строки старше 48 ч свёртываются до одного
    -- значения в час.
    CREATE TABLE IF NOT EXISTS token_history (
      mint TEXT NOT NULL,
      ts INTEGER NOT NULL,
      price REAL NOT NULL,
      liq_usd REAL NOT NULL,
      volume_24h REAL NOT NULL,
      holders REAL NOT NULL,
      holder_change_24h REAL,
      liq_change_24h REAL,
      price_change_24h REAL,
      price_change_6h REAL,
      fdv REAL NOT NULL,
      organic REAL,
      PRIMARY KEY (mint, ts)
    );

    -- События-отборщики: сработал любой из семи независимых отборщиков — монета
    -- уходит в общую воронку. status: new (ждёт воронку) | checked (прошла, но не
    -- сигнал) | rejected (отбракована слоями) | signaled (стала сигналом). Дедуп по
    -- (token_addr, code) с TTL EVENT_TTL_MIN — на уровне кода (см. events.ts).
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      token_addr TEXT NOT NULL,
      symbol TEXT NOT NULL,
      code TEXT NOT NULL,
      label_ru TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'new',
      signal_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_events_status_ts ON events(status, ts);
    CREATE INDEX IF NOT EXISTS idx_events_token_code ON events(token_addr, code);
    CREATE INDEX IF NOT EXISTS idx_events_signal ON events(signal_id);

    -- ВНУТРЕННЯЯ таблица перехода для отборщика safety_cleared: запоминаем
    -- ПРЕДЫДУЩЕЕ состояние прав минта/заблокированной ликвидности, чтобы событие
    -- означало именно ПЕРЕХОД (стало отозвано/сожжено), а не «и так было».
    CREATE TABLE IF NOT EXISTS token_safety (
      mint TEXT PRIMARY KEY,
      mint_revoked INTEGER NOT NULL,
      lp_locked_pct REAL NOT NULL,
      ts INTEGER NOT NULL
    );

    -- История проходов воронки отбора: по строке на КАЖДЫЙ завершённый скан
    -- (плановый, ручной и mock). Нужна окну «Воронка отбора»: владелец видит, на
    -- каком слое/по какому чеку срезаются монеты, и сравнивает дни между собой.
    -- by_layer/by_check — снимок диагностики скана (JSON) рядом с сырыми числами
    -- (candidates/signals), чтобы периоды суммировались без разбора JSON. ts —
    -- время завершения скана, сек; индекс по ts держит запросы окна дешёвыми.
    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      candidates_total INTEGER NOT NULL,
      candidates_done INTEGER NOT NULL,
      signals_found INTEGER NOT NULL,
      elapsed_ms INTEGER NOT NULL,
      budget_used INTEGER NOT NULL,
      by_layer_json TEXT NOT NULL DEFAULT '{}',
      by_check_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_scan_runs_ts ON scan_runs(ts);

    CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_fills_position ON fills(position_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_seen ON alerts(seen);
  `);

  ensureUniqueOpenIndex(d);
}

/**
 * Частичный UNIQUE-индекс: одна НЕзакрытая позиция на монету.
 *
 * Делает антидубль входа АТОМАРНЫМ на уровне БД: проверка «нет открытой позиции»
 * в openPosition — быстрый путь для понятного 409, но между ней и вставкой есть
 * await маркет-данных, поэтому два параллельных открытия по одной монете могли
 * оба пройти проверку. Уникальный индекс закрывает эту гонку.
 *
 * Старые базы: если в данных уже есть две незакрытые позиции по одной монете
 * (гонка, допущенная до этой правки), CREATE UNIQUE INDEX упадёт. Мы НЕ трогаем
 * и не закрываем чужие сделки автоматически — это опаснее дубля. Вместо этого
 * предупреждаем в stderr и оставляем индекс несозданным: антидубль продолжает
 * работать проверкой в коде (как раньше), а оператор может разобрать дубли.
 */
function ensureUniqueOpenIndex(d: DatabaseSync): void {
  try {
    d.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_token_open " +
        "ON positions(token_addr) WHERE status <> 'closed'",
    );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(
      `[db] не удалось создать UNIQUE-индекс антидубля (idx_positions_token_open): ${why}. ` +
        "Проверьте незакрытые позиции на дубликаты по token_addr — индекс не создан, " +
        "антидубль остаётся только проверкой в коде.",
    );
  }
}

/* ─────────────── настройки ─────────────── */

/**
 * Порог сожжённой/заблокированной ликвидности — НАСТРОЙКА скринера (слой 1,
 * безопасность): поле объявлено в контракте (shared/types.ts, ScreenerSettings),
 * дефолт — ниже в DEFAULT_SETTINGS. Раньше это была константа в screener.ts,
 * теперь порог крутит владелец без правки кода.
 */
export const DEFAULT_SETTINGS: Settings = {
  screener: {
    age_min: 7,
    age_max: 180,
    liq_min: 20000,
    // 0 — без потолка ликвидности (решение владельца 13.10.2026).
    liq_max: 0,
    // Слой 2: концентрация топ-10 < 25%. Решение владельца от 12.10.2026:
    // порог 15% из исходного ТЗ недостижим на живых данных (честный замер без
    // счёта пула даёт 10–25%), при нём сигналов не было. Измеряется по RPC с
    // ИСКЛЮЧЕНИЕМ счетов пулов (опознание по программе AMM, см. sources/helius.ts).
    top10_max: 27,
    wash_filter: true,
    // Фильтр по новостям и упоминаниям. По умолчанию ВЫКЛЮЧЕН (решение владельца
    // 13.10.2026): включается тумблером в настройках, когда нужен медиаслой.
    // Пока выключен, слой 5 виден в чек-листе как «выключен» и не блокирует, а
    // кредит Apify не тратится вовсе — сбор не запускается.
    llm_filter: false,
    range_days: 14,
    // Слой 4, коридор накопления: полная ширина коридора (max-min)/mid ≤ 2*range_pct.
    // РЕШЕНИЕ ВЛАДЕЛЬЦА от 13.10.2026: ширина 40% → 45%. Поле хранит ПОЛУширину,
    // поэтому 22.5 — вся воронка и подписи в интерфейсе считают полную ширину как
    // 2*range_pct. Раньше (12.10.2026) ширина была ≤40% (range_pct = 20).
    range_pct: 22.5,
    // Слой 4, просадка от максимума. РЕШЕНИЕ ВЛАДЕЛЬЦА от 13.10.2026: 50 → 40.
    // Причина смягчения та же, что и прежде: наша история ограничена окном (~180 дней),
    // поэтому просадка измеряется от максимума ДОСТУПНОГО окна и систематически занижена.
    // Порог ≥40% сохраняет смысл стратегии («глубокая коррекция»), верхняя граница 95%
    // отсекает уже мёртвые монеты. Раньше (12.10.2026): 70–90 → 50–95.
    drawdown_min: 40,
    drawdown_max: 95,
    holders_growth_min: 1.5,
    maker_min: 120,
    // Слой 1: минимальная доля сожжённой/заблокированной ликвидности, %. Бывшая
    // константа screener.BURNED_LIQ_MIN_PCT. РЕШЕНИЕ ВЛАДЕЛЬЦА от 12.10.2026:
    // ослаблено с жёстких 100% («полностью сожжена») до 70% — на живом рынке 100%
    // отсекало почти все монеты и сигналов не было; 70% — компромисс между защитой
    // от rug-pull и живостью контура. Вынесено в настройки, чтобы порог можно было
    // менять без правки кода (раньше был зашит).
    burned_liq_min: 70,
  },
  demo: {
    start_balance: 500,
    monthly_deposit: 500,
    pool_fee_pct: 0.25,
    slippage_min_pct: 3,
    slippage_max_pct: 5,
    time_stop_days: 21,
    liq_drain_pct: 30,
    // По умолчанию шесть виртуальных часов за цикл (≈15 виртуальных суток за час
    // реального времени): на медленном тике демо-контур «стоит» и Free Riding не
    // наступает. Существующая база настройку не перезаписывает — правится только сид.
    tick_minutes: 360,
  },
  free_ride: {
    tp1_percent: 100,
    tp1_fraction: 0.5,
    // Цель 2 для «бесплатного полёта»: остаток держим до x5. Обязана быть выше
    // триггера tp1_percent, иначе остаток продавался бы сразу после фиксации
    // половины и Free Riding длился бы один тик.
    tp2_percent: 400,
  },
};

/** Допустимые диапазоны ключей настроек. Тип задаёт и валидацию, и дефолт. */
interface NumSpec {
  type: "number";
  min: number;
  max: number;
}
interface BoolSpec {
  type: "boolean";
}
type Spec = NumSpec | BoolSpec;

const SETTINGS_SPEC: Record<keyof Settings, Record<string, Spec>> = {
  screener: {
    age_min: { type: "number", min: 0, max: 3650 },
    age_max: { type: "number", min: 0, max: 3650 },
    liq_min: { type: "number", min: 0, max: 1e12 },
    liq_max: { type: "number", min: 0, max: 1e12 },
    top10_max: { type: "number", min: 0, max: 100 },
    wash_filter: { type: "boolean" },
    llm_filter: { type: "boolean" },
    range_days: { type: "number", min: 1, max: 365 },
    // range_pct хранит ПОЛУширину коридора: max 50 = полная ширина 100%.
    range_pct: { type: "number", min: 1, max: 50 },
    drawdown_min: { type: "number", min: 0, max: 100 },
    drawdown_max: { type: "number", min: 0, max: 100 },
    holders_growth_min: { type: "number", min: 0, max: 1000 },
    maker_min: { type: "number", min: 0, max: 1e7 },
    // Доля сожжённой ликвидности — это процент, поэтому 0..100.
    burned_liq_min: { type: "number", min: 0, max: 100 },
  },
  demo: {
    start_balance: { type: "number", min: 0, max: 1e9 },
    monthly_deposit: { type: "number", min: 0, max: 1e9 },
    pool_fee_pct: { type: "number", min: 0, max: 100 },
    slippage_min_pct: { type: "number", min: 0, max: 100 },
    slippage_max_pct: { type: "number", min: 0, max: 100 },
    // Слайдер в интерфейсе ходит 14..30, сервер держит широкий диапазон,
    // чтобы тесты могли проверить срабатывание стоп-тайма за разумное число тиков.
    time_stop_days: { type: "number", min: 1, max: 365 },
    liq_drain_pct: { type: "number", min: 0, max: 100 },
    tick_minutes: { type: "number", min: 1, max: 1440 },
  },
  free_ride: {
    tp1_percent: { type: "number", min: 1, max: 10000 },
    // Доля фиксации СТРОГО меньше 1: при 1 продавался бы весь объём, позиция
    // оставалась бы без остатка (зависала в 'free_ride'). Нижняя граница 0.1 —
    // фиксация меньше десятой доли не имеет смысла. Старое значение 1 из базы
    // readGroup теперь зажимает к 0.9 на чтении; страховка движка на нулевой
    // остаток (см. demo.ts) остаётся защитой от пылевого qty и прямых правок БД.
    tp1_fraction: { type: "number", min: 0.1, max: 0.9 },
    tp2_percent: { type: "number", min: 1, max: 10000 },
  },
};

/** Пары полей, для которых обязателен порядок min <= max. */
const ORDERED_PAIRS: Record<keyof Settings, [string, string][]> = {
  screener: [
    ["age_min", "age_max"],
    ["liq_min", "liq_max"],
    ["drawdown_min", "drawdown_max"],
  ],
  demo: [["slippage_min_pct", "slippage_max_pct"]],
  free_ride: [],
};

/** Пары полей со СТРОГИМ порядком min < max: равенство недопустимо. Цель 2
 *  (tp2_percent) обязана быть строго выше триггера (tp1_percent): на равенстве
 *  остаток продавался бы сразу после фиксации половины. */
const STRICT_ORDERED_PAIRS: Record<keyof Settings, [string, string][]> = {
  screener: [],
  demo: [],
  free_ride: [["tp1_percent", "tp2_percent"]],
};

/**
 * Привести прочитанное из БД значение к спеке: числовые зажать в [min, max],
 * нечисловые/битые — оставить дефолтом. Спасает СТАРЫЕ базы, где спека
 * ужесточилась: например, range_pct когда-то допускал до 100, а теперь max=50.
 * Без зажима сохранённое вне диапазона ломало бы следующий setSettings по ЛЮБОМУ
 * полю (валидация видит всю группу), и владелец не смог бы сохранить ничего, пока
 * не тронет именно этот ползунок. liq_max = 0 («без потолка») законен (спека min 0)
 * и остаётся нулём — зажим не превращает его в liq_min.
 */
function clampToSpec(group: keyof Settings, short: string, value: unknown): unknown {
  const sp = SETTINGS_SPEC[group][short];
  if (!sp) return value;
  const def = (DEFAULT_SETTINGS[group] as Record<string, unknown>)[short];
  if (sp.type === "boolean") return typeof value === "boolean" ? value : def;
  if (typeof value !== "number" || !Number.isFinite(value)) return def;
  return Math.min(sp.max, Math.max(sp.min, value));
}

function readGroup<K extends keyof Settings>(group: K): Settings[K] {
  const d = getDb();
  const rows = d.prepare("SELECT key, value_json FROM settings WHERE key LIKE ?").all(`${group}.%`);
  const out: Record<string, unknown> = { ...(DEFAULT_SETTINGS[group] as Record<string, unknown>) };
  for (const r of rows as { key: string; value_json: string }[]) {
    const short = r.key.slice(group.length + 1);
    try {
      out[short] = clampToSpec(group, short, JSON.parse(r.value_json));
    } catch {
      // Битый JSON — оставляем дефолт: лучше рабочая настройка, чем падение API.
    }
  }
  return out as Settings[K];
}

export function getSettings(): Settings {
  return {
    screener: readGroup("screener"),
    demo: readGroup("demo"),
    free_ride: readGroup("free_ride"),
  };
}

export function setSettings(patch: SettingsPatch, actor = "user"): Settings {
  const current = getSettings();
  const merged: Settings = {
    screener: { ...current.screener, ...(patch.screener ?? {}) },
    demo: { ...current.demo, ...(patch.demo ?? {}) },
    free_ride: { ...current.free_ride, ...(patch.free_ride ?? {}) },
  };
  validateSettings(merged);

  const changed: Record<string, unknown> = {};
  for (const group of ["screener", "demo", "free_ride"] as (keyof Settings)[]) {
    const spec = SETTINGS_SPEC[group];
    for (const [k, v] of Object.entries(merged[group])) {
      if (!(k in spec)) continue;
      const prev = (current[group] as Record<string, unknown>)[k];
      if (prev === v) continue;
      const prevJson = JSON.stringify(prev);
      getDb()
        .prepare(
          "INSERT INTO settings(key, value_json, updated_ts) VALUES(?,?,?) " +
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_ts=excluded.updated_ts",
        )
        .run(`${group}.${k}`, JSON.stringify(v), nowSec());
      changed[`${group}.${k}`] = { from: prev, to: v };
      void prevJson;
    }
  }
  if (Object.keys(changed).length) audit("settings.update", { changed }, actor);
  return getSettings();
}

function validateSettings(s: Settings): void {
  for (const group of ["screener", "demo", "free_ride"] as (keyof Settings)[]) {
    const spec = SETTINGS_SPEC[group];
    for (const [k, v] of Object.entries(s[group])) {
      const sp = spec[k];
      if (!sp) continue;
      if (sp.type === "boolean") {
        if (typeof v !== "boolean") throw badSetting(group, k, "должно быть true/false");
      } else {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw badSetting(group, k, "должно быть числом");
        }
        if (v < sp.min || v > sp.max) {
          throw badSetting(group, k, `вне диапазона ${sp.min}..${sp.max}`);
        }
      }
    }
    for (const [minKey, maxKey] of ORDERED_PAIRS[group]) {
      const a = (s[group] as Record<string, number>)[minKey];
      const b = (s[group] as Record<string, number>)[maxKey];
      // Потолок со значением 0 (или меньше) означает «без потолка» — тогда
      // сравнивать не с чем. Так снят потолок ликвидности (решение владельца
      // 13.10.2026): liq_max = 0 значит «верхней границы нет».
      if (b <= 0) continue;
      if (a > b) throw badSetting(group, minKey, `не может быть больше ${maxKey}`);
    }
    for (const [minKey, maxKey] of STRICT_ORDERED_PAIRS[group]) {
      const a = (s[group] as Record<string, number>)[minKey];
      const b = (s[group] as Record<string, number>)[maxKey];
      if (b <= a) {
        // Сообщение человеческим языком: пользователь крутит ползунки и должен
        // понять, что именно он сломал, а не читать имена полей движка.
        throw new ApiError(
          "invalid_settings",
          400,
          group === "free_ride"
            ? `цель 2 (+${b}%) должна быть выше триггера фиксации (+${a}%): остаток обязан лететь дальше половины`
            : `настройка ${group}.${maxKey}: должно быть строго больше ${minKey}`,
        );
      }
    }
  }
}

function badSetting(group: string, key: string, why: string): ApiError {
  return new ApiError("invalid_settings", 400, `настройка ${group}.${key}: ${why}`);
}

function seedDefaults(d: DatabaseSync): void {
  const have = d.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number };
  if (have.n === 0) {
    // Стартовый баланс/пополнение берём из .env (DEMO_START_BALANCE и т.п.),
    // чтобы «Профиль» и Аналитика сошлись с тем, что человек видит в окружении.
    const demo = { ...DEFAULT_SETTINGS.demo };
    demo.start_balance = getEnvNum("DEMO_START_BALANCE");
    demo.monthly_deposit = getEnvNum("DEMO_MONTHLY_DEPOSIT");
    const seed: Settings = { ...DEFAULT_SETTINGS, demo };
    const ins = d.prepare("INSERT INTO settings(key, value_json, updated_ts) VALUES(?,?,?)");
    for (const group of ["screener", "demo", "free_ride"] as (keyof Settings)[]) {
      for (const [k, v] of Object.entries(seed[group])) ins.run(`${group}.${k}`, JSON.stringify(v), nowSec());
    }
  }

  const dep = d.prepare("SELECT COUNT(*) AS n FROM deposits").get() as { n: number };
  if (dep.n === 0) {
    d.prepare("INSERT INTO deposits(ts, usd, kind) VALUES(?,?,?)").run(
      nowSec(),
      getEnvNum("DEMO_START_BALANCE"),
      "initial",
    );
  }
}

/* ─────────────── журнал, алерты, мета ─────────────── */

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function audit(action: string, payload: Record<string, unknown>, actor = "system"): void {
  getDb()
    .prepare("INSERT INTO audit(ts, actor, action, payload_json) VALUES(?,?,?,?)")
    .run(nowSec(), actor, action, JSON.stringify(payload ?? {}));
}

export function hasAlert(positionId: number | null, kind: AlertKind): boolean {
  const row = getDb()
    .prepare("SELECT id FROM alerts WHERE position_id IS ? AND kind = ? LIMIT 1")
    .get(positionId, kind);
  return Boolean(row);
}

/**
 * Добавить алерт. Идемпотентность: на одну позицию и один вид события — одна
 * запись. Вставка атомарна (INSERT ... WHERE NOT EXISTS): даже два параллельных
 * вызова не создадут дубль, а побочные эффекты навешивает только победитель.
 * Возвращает false, если такой алерт уже был (движок не должен «звенеть» тиком).
 */
export function addAlert(
  positionId: number | null,
  kind: AlertKind,
  message: string,
  severity: "info" | "warn" | "critical",
): boolean {
  const res = getDb()
    .prepare(
      "INSERT INTO alerts(ts, position_id, kind, message, severity, seen) " +
        "SELECT ?,?,?,?,?,0 WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE position_id IS ? AND kind=?)",
    )
    .run(nowSec(), positionId, kind, message, severity, positionId, kind);
  return Number(res.changes) === 1;
}

export function metaGet(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function metaSet(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, value);
}

/* ─────────────── виртуальные часы ─────────────── */

/**
 * Инициализация часов. world_start — момент, когда демо-мир «проснулся»:
 * от него отсчитываются разгоны токенов и старт виртуального времени.
 */
export function ensureClock(): void {
  if (metaGet("world_start") === null) metaSet("world_start", String(nowSec()));
  if (metaGet("virtual_ts") === null) metaSet("virtual_ts", metaGet("world_start") as string);
}

/**
 * Текущее «время мира». В mock берём из meta (мир ускорен), в live — реальные
 * секунды UTC. Всё, что пишется в ts/opened_ts и сравнивается с age, живёт в
 * этой шкале.
 */
export function virtualNow(): number {
  if (readDataMode() === "live") return nowSec();
  const v = metaGet("virtual_ts");
  return v ? Number(v) : nowSec();
}

export function worldStart(): number {
  const w = metaGet("world_start");
  return w ? Number(w) : nowSec();
}

/** Сдвинуть виртуальные часы вперёд (только mock). */
export function advanceVirtual(minutes: number): number {
  if (readDataMode() === "live") return nowSec();
  const next = virtualNow() + Math.round(minutes * 60);
  metaSet("virtual_ts", String(next));
  return next;
}

/* ─────────────── типизированные выборки ─────────────── */

export function signalById(id: number): SignalRow | null {
  const row = getDb().prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRow | undefined;
  return row ?? null;
}

export function positionById(id: number): PositionRow | null {
  const row = getDb().prepare("SELECT * FROM positions WHERE id = ?").get(id) as
    | PositionRow
    | undefined;
  return row ?? null;
}

export interface SignalRow {
  id: number;
  ts: number;
  token_addr: string;
  symbol: string;
  name: string;
  pair_addr: string;
  price: number;
  liq_usd: number;
  mc_usd: number;
  age_days: number;
  tf_accum: string;
  score: number;
  status: string;
  checks_json: string;
  metrics_json: string;
  social_json: string;
  overview_ru: string;
  sentiment: number;
  is_organic: number;
}

export interface PositionRow {
  id: number;
  signal_id: number | null;
  token_addr: string;
  symbol: string;
  name: string;
  entry_price: number;
  qty: number;
  usd_in: number;
  fees_usd: number;
  slippage_usd: number;
  tp_price: number;
  tp_percent: number;
  status: string;
  free_ride_done: number;
  realized_usd: number;
  peak_price: number;
  opened_ts: number;
  closed_ts: number | null;
  close_reason: string | null;
  note: string;
}

/* ─────────────── история воронки (scan_runs) ─────────────── */

/** Строка scan_runs как в БД: JSON-диагностика лежит текстом. */
interface ScanRunRow {
  id: number;
  ts: number;
  candidates_total: number;
  candidates_done: number;
  signals_found: number;
  elapsed_ms: number;
  budget_used: number;
  by_layer_json: string;
  by_check_json: string;
}

/**
 * Разобрать JSON-столбец с счётчиками. Битый JSON (старая/повреждённая строка)
 * не должен ронять чтение истории — отдаём пустой объект, как в соседних местах
 * (readGroup, safeParse в index.ts). Не-объект (массив/число/строка) — тоже «{}».
 */
function parseCounts(json: string): Record<string, number> {
  try {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, number>;
  } catch {
    // Битый JSON — оставляем пустой объект: одна плохая строка не ломает сводку.
  }
  return {};
}

/** Прибавить счётчики `add` к аккумулятору `into` (только конечные числа). */
function addCounts(into: Record<string, number>, add: Record<string, number>): void {
  for (const [k, v] of Object.entries(add)) {
    if (typeof v === "number" && Number.isFinite(v)) into[k] = (into[k] ?? 0) + v;
  }
}

/** Начало календарного дня в поясе Бишкек (UTC+6) для unix-секунд ts — РЕАЛЬНЫЕ
 *  unix-секунды этого начала. Тот же сдвиг пояса, что и на главной
 *  (src/screens/Home.tsx): сутки КАЛЕНДАРНЫЕ по Бишкеку, без перехода на летнее
 *  время. Сдвиг ВЫЧИТАЕТСЯ обратно, иначе результатом было бы «начало суток плюс
 *  шесть часов», а не настоящая полночь по Бишкеку. */
function bishkekDay(ts: number): number {
  const offset = 6 * 3600;
  return Math.floor((ts + offset) / 86400) * 86400 - offset;
}

/** Строка БД → ScanRun: разбираем JSON-диагностику в объекты. */
function scanRunFromRow(r: ScanRunRow): ScanRun {
  return {
    id: r.id,
    ts: r.ts,
    candidates_total: r.candidates_total,
    candidates_done: r.candidates_done,
    signals_found: r.signals_found,
    elapsed_ms: r.elapsed_ms,
    budget_used: r.budget_used,
    by_layer: parseCounts(r.by_layer_json),
    by_check: parseCounts(r.by_check_json),
  };
}

/** Сохранить один ПРОХОД воронки (вызывается по завершении скана — и в mock, и в live). */
export function insertScanRun(rec: Omit<ScanRun, "id">): void {
  getDb()
    .prepare(
      "INSERT INTO scan_runs(ts, candidates_total, candidates_done, signals_found, elapsed_ms, " +
        "budget_used, by_layer_json, by_check_json) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      rec.ts,
      rec.candidates_total,
      rec.candidates_done,
      rec.signals_found,
      rec.elapsed_ms,
      rec.budget_used,
      JSON.stringify(rec.by_layer ?? {}),
      JSON.stringify(rec.by_check ?? {}),
    );
}

/** Последние проходы воронки (свежие первыми), JSON-поля — объектами. */
export function listScanRuns(limit: number): ScanRun[] {
  const rows = getDb()
    .prepare("SELECT * FROM scan_runs ORDER BY ts DESC, id DESC LIMIT ?")
    .all(Math.max(0, Math.floor(limit))) as unknown as ScanRunRow[];
  return rows.map(scanRunFromRow);
}

/**
 * Сводка воронки за период [from, to] (unix-секунды, включительно).
 *
 * Складываем по всем проходам периода: число проходов, взятые в работу монеты и
 * найденные сигналы, а также отбраковку по слоям и по кодам проверок. Отдельно
 * даём разбивку по КАЛЕНДАРНЫМ дням Бишкера (UTC+6) — только дни, в которые
 * были проходы, свежие первыми — и последние `recentLimit` проходов для списка.
 * Битые JSON-строки в базе не роняют сводку (считаются за «{}»).
 */
export function funnelSummary(from: number, to: number, recentLimit = 20): FunnelSummary {
  const fromS = Math.floor(from);
  const toS = Math.floor(to);
  const rows = getDb()
    .prepare("SELECT * FROM scan_runs WHERE ts >= ? AND ts <= ? ORDER BY ts DESC, id DESC")
    .all(fromS, toS) as unknown as ScanRunRow[];

  let candidatesTotal = 0;
  let signalsFound = 0;
  const byLayer: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  const byDay = new Map<number, FunnelDay>();

  for (const r of rows) {
    candidatesTotal += r.candidates_total;
    signalsFound += r.signals_found;
    const layer = parseCounts(r.by_layer_json);
    const check = parseCounts(r.by_check_json);
    addCounts(byLayer, layer);
    addCounts(byCheck, check);

    const day = bishkekDay(r.ts);
    let d = byDay.get(day);
    if (!d) {
      d = { day, runs: 0, candidates: 0, signals: 0, by_layer: {}, by_check: {} };
      byDay.set(day, d);
    }
    d.runs += 1;
    d.candidates += r.candidates_total;
    d.signals += r.signals_found;
    addCounts(d.by_layer, layer);
    addCounts(d.by_check, check);
  }

  const days = [...byDay.values()].sort((a, b) => b.day - a.day);
  const recent = rows.slice(0, Math.max(0, Math.floor(recentLimit))).map(scanRunFromRow);
  return {
    from: fromS,
    to: toS,
    runs: rows.length,
    candidates_total: candidatesTotal,
    signals_found: signalsFound,
    by_layer: byLayer,
    by_check: byCheck,
    days,
    recent,
  };
}
