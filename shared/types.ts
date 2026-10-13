/**
 * shared/types.ts — ЗАМОРОЖЕННЫЙ контракт между сервером (server/) и клиентом (src/).
 *
 * Менять только по согласованию с оркестратором: файл читают обе стороны,
 * расхождение здесь — это молча сломанный экран, а не ошибка компиляции.
 *
 * Все суммы — в USDT, время — секунды UTC. Денежные значения ДЕМО-КОНТУРА
 * всегда net: комиссия пула и проскальзывание уже вычтены.
 */

/* ─────────────── здоровье и режим ─────────────── */

export type DataMode = "mock" | "live";

export interface KeysPresence {
  telegram: boolean;
  helius: boolean;
  gemini: boolean;
  wallet: boolean;
}

export interface Health {
  ok: boolean;
  mode: DataMode;
  keys: KeysPresence;
  ts: number;
  /** Виртуальное время mock-режима; в live равно ts. */
  virtual_ts: number;
}

/* ─────────────── сигналы ─────────────── */

export type SignalStatus = "new" | "taken" | "skipped" | "archived";

/** Один пункт чек-листа воронки (§5 плана). */
export interface Check {
  layer: 1 | 2 | 3 | 4 | 5;
  code: string;
  /** Подпись для интерфейса, по-русски. */
  label_ru: string;
  ok: boolean;
  /** Значение проверки; null — измерить не удалось. */
  value: number | string | boolean | null;
  /** Ограничение в человекочитаемом виде, например "=100%" или "30..180". */
  threshold: string;
}

/** Индикаторы блока «Данные» на детальном экране. */
export interface Indicators {
  /** Скрытая волатильность/сжатие диапазона, 0..100 (выше — плотнее боковик). */
  svd: number;
  /** Он-чейн объём за 24ч, USDT. */
  onchain_volume_usd: number;
  /** Приток/отток ликвидности пула за 24ч, USDT (знак = направление). */
  liquidity_flow_usd: number;
  /** Изменение числа уникальных холдеров за 7 дней, %. */
  holders_growth_pct: number;
  /** Уникальные мейкеры за 24ч. */
  makers_24h: number;
  /** Средний размер сделки, USDT (крупный = не боты). */
  avg_trade_usd: number;
  /** Доля объёма топ-10 холдеров, %. */
  top10_holders_pct: number;
  /** Падение от исторического максимума, % (положительное число). */
  drawdown_from_ath_pct: number;
  /** Ширина коридора за период накопления, %. */
  range_pct: number;
}

export interface SocialMention {
  ts: number;
  source: string;
  title: string;
  url: string;
  /** Тональность упоминания, 0..10. */
  score: number;
}

export interface Social {
  sentiment: number;
  is_organic: boolean;
  summary: string;
  mentions: SocialMention[];
}

export interface Signal {
  id: number;
  ts: number;
  token_addr: string;
  symbol: string;
  name: string;
  pair_addr: string;
  /** Цена в момент сигнала, USDT. */
  price: number;
  liq_usd: number;
  mc_usd: number;
  age_days: number;
  /** Таймфрейм, на котором найден боковик: "1D" | "4H" | "1H". */
  tf_accum: string;
  score: number;
  status: SignalStatus;
  /** Плашка статуса для ленты, по-русски. */
  status_label: string;
  sentiment: number;
  is_organic: boolean;
  /** События-отборщики, которые привели монету в ленту (пусто — плановый скан). */
  events?: EventCode[];
}

export interface SignalDetail {
  signal: Signal;
  checks: Check[];
  indicators: Indicators;
  overview_ru: string;
  social: Social;
}

/**
 * Состояние текущего скана — то, что показывает визуализатор поиска.
 * Живёт в общем контракте: сервер отдаёт, клиент рисует прогресс и фазы.
 */
export interface ScanStatus {
  running: boolean;
  started_ts: number;
  /** Человекочитаемая фаза: «собираю кандидатов», «проверяю накопление» и т. д. */
  stage: string;
  candidates_total: number;
  candidates_done: number;
  signals_found: number;
  /** Сколько отбраковано каждым слоем воронки. */
  by_layer: Record<string, number>;
  budget_used: number;
  budget_total: number;
  elapsed_ms: number;
  /** Последнее, что происходило: «MINI: проверяю накопление». */
  last_note: string;
  /** Секунда UTC завершения последнего скана; 0 — ещё ни один не завершался. */
  finished_ts: number;
  /** Итог последнего завершённого скана: ленте нужно знать, что искать нечего зря. */
  last_result: ScanResult | null;
}

/**
 * Ответ на запуск поиска. Запуск асинхронный: длинный HTTP-запрос обрывался
 * браузером на телефоне, и человек видел «сервер не отвечает» посреди работы.
 */
export interface ScanStart {
  /** true — скан начат этим вызовом; false — уже шёл. */
  started: boolean;
  running: boolean;
}

/**
 * Коды событий-отборщиков. Каждый работает независимо и постоянно; сработал —
 * монета уходит в общую воронку, не сработал — мы ничего не потратили.
 */
export type EventCode =
  /** Сухой всплеск: объём вырос, а цена стоит — признак набора позиции. */
  | "dry_spike"
  /** Старт пробоя: цена вышла из коридора накопления с объёмом. */
  | "breakout"
  /** Приток ликвидности в пул при плоской цене. */
  | "lp_inflow"
  /** Ускорение прироста холдеров при плоской цене. */
  | "holders_accel"
  /** Новый пул у зрелой монеты (миграция, новая площадка). */
  | "new_pool"
  /** Событие безопасности: права минта отозваны или ликвидность сожжена. */
  | "safety_cleared"
  /** Крупные покупки в пуле монеты, прошедшей дешёвые проверки. */
  | "large_buyer";

export interface TokenEvent {
  id: number;
  /** Секунда UTC, когда событие зафиксировано. */
  ts: number;
  token_addr: string;
  symbol: string;
  code: EventCode;
  /** Подпись по-русски: «сухой всплеск: объём вырос, цена стоит». */
  label_ru: string;
  /** Конкретика: «объём 3.2× медианы, цена +0.8%». */
  note: string;
  /** Измеренные значения, по которым сработал триггер. */
  metrics: Record<string, number | null>;
  status: "new" | "checked" | "rejected" | "signaled";
  /** Если событие дошло до сигнала — его id. */
  signal_id: number | null;
}

export interface ScanResult {
  found: number;
  ids: number[];
  /** Диагностика отбраковки за текущий скан: сколько монет срезал каждый слой. */
  rejected_by_layer: Record<string, number>;
}

/** Свеча: [ts, open, high, low, close, volume]. */
export type Candle = [number, number, number, number, number, number];

export type ChartTf = "1m" | "5m" | "1h" | "1d";

/* ─────────────── позиции и сделки ─────────────── */

export type PositionStatus = "open" | "free_ride" | "closed";

export type CloseReason =
  | "manual"
  | "tp_50"
  | "tp_full"
  | "time_stop"
  | "liq_drain";

export interface Position {
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
  status: PositionStatus;
  free_ride_done: boolean;
  realized_usd: number;
  peak_price: number;
  opened_ts: number;
  closed_ts: number | null;
  close_reason: CloseReason | null;
  note: string;
  /** Живые поля: считаются при чтении, в БД не хранятся. */
  current_price: number;
  pnl_usd: number;
  pnl_pct: number;
  /** Возраст позиции в днях виртуального времени. */
  age_days: number;
}

export interface Fill {
  id: number;
  position_id: number;
  ts: number;
  kind: "open" | "add" | "tp_50" | "close" | "partial";
  price: number;
  qty: number;
  usd: number;
  fee_usd: number;
  slippage_usd: number;
}

export interface Trade {
  id: number;
  position_id: number;
  symbol: string;
  token_addr: string;
  opened_ts: number;
  closed_ts: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  costs_usd: number;
  close_reason: CloseReason;
  free_ride_done: boolean;
}

/* ─────────────── аналитика ─────────────── */

export interface OutcomeBuckets {
  closed_zero: number;
  reached_x2: number;
  reached_x5: number;
  open: number;
}

/** Точка кривой капитала: [ts, equity_usd]. */
export type EquityPoint = [number, number];

export interface AnalyticsSummary {
  balance: number;
  deposited: number;
  equity: number;
  equity_curve: EquityPoint[];
  winrate: number;
  avg_profit_pct: number;
  by_outcome: OutcomeBuckets;
  trades_count: number;
  open_count: number;
  /** Сумма издержек и проскальзывания за всё время, USDT (положительное число). */
  costs_usd: number;
}

/* ─────────────── алерты и аудит ─────────────── */

export type AlertKind = "free_ride" | "time_stop" | "liq_drain" | "tp_reached";

export interface Alert {
  id: number;
  ts: number;
  position_id: number | null;
  symbol: string;
  kind: AlertKind;
  message: string;
  severity: "info" | "warn" | "critical";
  seen: boolean;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  payload: Record<string, unknown>;
}

/* ─────────────── настройки ─────────────── */

export interface ScreenerSettings {
  age_min: number;
  age_max: number;
  liq_min: number;
  liq_max: number;
  top10_max: number;
  wash_filter: boolean;
  llm_filter: boolean;
  range_days: number;
  range_pct: number;
  drawdown_min: number;
  drawdown_max: number;
  holders_growth_min: number;
  maker_min: number;
}

export interface DemoSettings {
  start_balance: number;
  monthly_deposit: number;
  pool_fee_pct: number;
  slippage_min_pct: number;
  slippage_max_pct: number;
  time_stop_days: number;
  liq_drain_pct: number;
  tick_minutes: number;
}

export interface FreeRideSettings {
  /** Триггер фиксации половины объёма: рост от входа, %. */
  tp1_percent: number;
  /** Доля объёма, фиксируемая на триггере (0..1). */
  tp1_fraction: number;
  /** Цель 2 для «бесплатного полёта», рост от входа, %. По умолчанию 400 (x5).
   *  Обязана быть заметно выше tp1_percent: иначе остаток продаётся сразу после
   *  фиксации половины и стратегия теряет смысл. */
  tp2_percent: number;
}

export interface Settings {
  screener: ScreenerSettings;
  demo: DemoSettings;
  free_ride: FreeRideSettings;
}

/** Частичное обновление: приходит только то, что изменил пользователь. */
export interface SettingsPatch {
  screener?: Partial<ScreenerSettings>;
  demo?: Partial<DemoSettings>;
  free_ride?: Partial<FreeRideSettings>;
}

/* ─────────────── ключи ─────────────── */

export interface KeyStatus {
  set: boolean;
  /** Маска вида "abcd…12"; у кошелька вместо неё публичный адрес. */
  preview: string;
  updated_ts: number;
}

export interface KeysStatus {
  telegram_bot_token: KeyStatus;
  telegram_chat_id: KeyStatus;
  helius_api_key: KeyStatus;
  gemini_api_key: KeyStatus;
  wallet: KeyStatus & { address: string };
}

export interface KeysUpdate {
  telegram_bot_token?: string;
  telegram_chat_id?: string;
  helius_api_key?: string;
  gemini_api_key?: string;
  wallet_secret?: string;
}

/* ─────────────── запросы действий ─────────────── */

export interface OpenPositionRequest {
  signal_id: number;
  usd: number;
  order_type: "market" | "limit";
  /** Цена лимитной заявки; для market игнорируется. */
  limit_price?: number;
  tp_percent?: number;
  tp_mode?: "free_ride" | "manual";
}

export interface ClosePositionRequest {
  /** Доля объёма: 0.5 — половина, 1 — вся позиция. */
  fraction: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/* ─────────────── формы ответов на действия ───────────────
 * Зафиксированы отдельными типами, потому что именно здесь части расходились:
 * клиент рисовал экран по одному предположению, сервер отвечал другим, и
 * расхождение не ловилось ни типами, ни сборкой. Менять только вместе с
 * реализацией на обеих сторонах.
 */

/** Открытие, докупка и перенос ТП отдают саму позицию. */
export type PositionResponse = Position;

/** Закрытие отдаёт и позицию, и исполнение — экрану нужны и итог, и цена выхода. */
export interface ClosePositionResponse {
  position: Position;
  fill: Fill;
}

/** Пополнение депозита отдаёт пересчитанную аналитику: баланс меняется сразу. */
export type DepositResponse = AnalyticsSummary;

/** Отметка алерта просмотренным отдаёт его же — экран не гадает, что стало. */
export type AlertSeenResponse = Alert;

/** Сохранение ключей отдаёт их статусы (значения не возвращаются никогда). */
export type KeysUpdateResponse = KeysStatus;
