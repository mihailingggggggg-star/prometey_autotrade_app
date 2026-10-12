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
import type { Settings, SettingsPatch, AlertKind } from "../shared/types.ts";

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

export const DEFAULT_SETTINGS: Settings = {
  screener: {
    age_min: 30,
    age_max: 180,
    liq_min: 20000,
    liq_max: 150000,
    // Слой 2: концентрация топ-10 < 25%. Решение владельца от 12.10.2026:
    // порог 15% из исходного ТЗ недостижим на живых данных (честный замер без
    // счёта пула даёт 10–25%), при нём сигналов не было. Измеряется по RPC с
    // ИСКЛЮЧЕНИЕМ счетов пулов (опознание по программе AMM, см. sources/helius.ts).
    top10_max: 25,
    wash_filter: true,
    llm_filter: true,
    range_days: 14,
    range_pct: 18,
    drawdown_min: 70,
    drawdown_max: 90,
    holders_growth_min: 3,
    maker_min: 120,
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
    range_pct: { type: "number", min: 1, max: 100 },
    drawdown_min: { type: "number", min: 0, max: 100 },
    drawdown_max: { type: "number", min: 0, max: 100 },
    holders_growth_min: { type: "number", min: 0, max: 1000 },
    maker_min: { type: "number", min: 0, max: 1e7 },
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
    // фиксация меньше десятой доли не имеет смысла. Старые базы со значением 1
    // валидацию не проходят, но движок всё равно закрывает такую позицию (страховка).
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

function readGroup<K extends keyof Settings>(group: K): Settings[K] {
  const d = getDb();
  const rows = d.prepare("SELECT key, value_json FROM settings WHERE key LIKE ?").all(`${group}.%`);
  const out: Record<string, unknown> = { ...(DEFAULT_SETTINGS[group] as Record<string, unknown>) };
  for (const r of rows as { key: string; value_json: string }[]) {
    const short = r.key.slice(group.length + 1);
    try {
      out[short] = JSON.parse(r.value_json);
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
