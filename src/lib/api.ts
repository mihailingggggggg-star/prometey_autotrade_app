/**
 * Типизированный клиент HTTP-контракта демо-контура (§4 плана).
 *
 * Возвращаемые типы берутся из замороженного `shared/types.ts` — здесь НЕ
 * объявляется ни одной собственной копии домена: расхождение с сервером должно
 * ловиться компилятором, а не глазами.
 *
 * Адрес. В разработке Vite проксирует `/api` на локальный сервер (127.0.0.1:8790),
 * поэтому базовый адрес — пустая строка, то есть текущий origin. Единственное
 * исключение — ключ `solana.api` в localStorage: он появляется при запуске через
 * туннель, когда интерфейс и сервер живут на разных адресах. Хардкода адреса нет
 * нигде: сменный адрес — это ровно то место, где он ломается молча.
 */
import type {Health, Signal, SignalDetail, SignalStatus, ScanResult, Candle, ChartTf,
  Position, PositionStatus, Trade, AnalyticsSummary, Settings, SettingsPatch,
  KeysStatus, KeysUpdate, Alert, AuditEntry, OpenPositionRequest, Fill,
  ApiErrorBody, ScanStatus, ScanStart, TokenEvent, FunnelSummary } from "../../shared/types";

/** Базовый адрес API: ключ `solana.api` из localStorage либо тот же origin. */
export function apiBase(): string {
  try {
    return localStorage.getItem("solana.api") || "";
  } catch {
    // Приватный режим браузера может запрещать чтение localStorage — это не
    // повод не работать, просто остаёмся на своём origin.
    return "";
  }
}

/* ── ключ доступа к API ──────────────────────────────────────────────────────
 * Сервер при заданном API_TOKEN требует заголовок X-Api-Token. Ключ живёт
 * ТОЛЬКО в localStorage этого устройства и наружу (в интерфейс, ссылки, ответы)
 * не выводится — виден лишь признак «задан». */

export const TOKEN_KEY = "solana.token";

/** Ключ доступа из памяти браузера; пусто — не задан. */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Запомнить ключ. Пустая строка означает «стереть», а не «оставить мусор». */
export function setToken(value: string): void {
  try {
    const v = value.trim();
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Приватный режим: сохранить не выйдет — экран продолжит спрашивать ключ.
  }
}

/** Задан ли ключ. Сам ключ не показываем — только этот признак. */
export function hasToken(): boolean {
  return getToken().length > 0;
}

/**
 * Перенять ключ из адреса `?t=<ключ>` и сразу убрать его оттуда. Зовётся один
 * раз при старте: адрес остаётся в истории, закладках и на скриншотах, ключу там
 * не место. Для установленного на iOS приложения этот адрес приходит из
 * персонального манифеста ярлыка (см. lib/pwa.ts) — у него СВОЙ localStorage.
 */
export function captureTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  const t = params.get("t");
  if (!t) return;
  setToken(t);
  params.delete("t");
  const q = params.toString();
  const clean = window.location.pathname + (q ? `?${q}` : "") + window.location.hash;
  window.history.replaceState(null, "", clean);
}

/** Экран «нужен ключ доступа» подписывается здесь: ЛЮБОЙ ответ 401 поднимает его,
 *  а не только первый запрос. Так смена ключа проверяется в одном месте. */
type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

export function onUnauthorized(fn: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(fn);
  return () => { unauthorizedHandlers.delete(fn); };
}

/** Ошибка «сервер требует ключ»: экран обязан отличать её от прочих сбоев. */
export class UnauthorizedError extends Error {
  readonly code = "unauthorized";
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Единый текст для «сервер не отвечает»: экран обязан показать ПРИЧИНУ, а не
 *  пустоту, поэтому сетевой сбой превращается в понятное человеку предложение. */
export const NO_SERVER =
  "локальный сервер демо-контура не отвечает — запустите npm run server";

type JsonInit = {
  method?: string;
  body?: unknown;
  /** Ключ для этого запроса; по умолчанию — сохранённый в памяти браузера. */
  token?: string;
  /** false — ответ 401 не поднимает экран ввода ключа (проверка кандидата). */
  notifyUnauthorized?: boolean;
};

async function call<T>(path: string, init: JsonInit = {}): Promise<T> {
  const { method = "GET", body, token = getToken(), notifyUnauthorized = true } = init;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  // Ключ едет в ЗАГОЛОВКЕ, а не в строке запроса: строка живёт в логах и истории.
  if (token) headers["X-Api-Token"] = token;
  let res: Response;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Сюда попадает и «сервер не поднят», и «туннель умер» — для человека это
    // одно и то же: связи нет, причину читаем текстом ниже.
    throw new Error(NO_SERVER);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }

  if (!res.ok) {
    // Контракт ошибки: {"error":{"code","message"}}. Сообщение сервера уже
    // на русском — показываем его как есть, иначе подставляем статус.
    const err = (parsed as ApiErrorBody | null)?.error;
    const message = err?.message || `сервер вернул ошибку ${res.status}`;
    if (res.status === 401) {
      // Ключ не подошёл или не задан: приложение покажет экран ввода ключа.
      if (notifyUnauthorized) unauthorizedHandlers.forEach((fn) => fn());
      throw new UnauthorizedError(message);
    }
    throw new Error(message);
  }
  return parsed as T;
}

/* ── здоровье ── */
export const health = () => call<Health>("/api/health");

/* ── сигналы ── */
export const listSignals = (opts: { limit?: number; status?: SignalStatus } = {}) => {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.status) q.set("status", opts.status);
  const s = q.toString();
  return call<Signal[]>(`/api/signals${s ? `?${s}` : ""}`);
};

export const getSignal = (id: number) => call<SignalDetail>(`/api/signals/${id}`);

/* ── события-отборщики ──
 * Семь независимых детекторов пишут сюда КАЖДОЕ срабатывание, а не только те,
 * что дошли до сигнала: лента событий показывает, что отборщики работают, даже
 * когда сигналов нет. `token` сужает до одной монеты (блок «Почему в ленте» в
 * карточке), `status` — до состояния воронки. Порядок задаёт сервер (новые
 * сверху), клиент его не переворачивает. */
export const listEvents = (opts: { limit?: number; status?: TokenEvent["status"]; token?: string } = {}) => {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.status) q.set("status", opts.status);
  if (opts.token) q.set("token", opts.token);
  const s = q.toString();
  return call<TokenEvent[]>(`/api/events${s ? `?${s}` : ""}`);
};

/**
 * Ответ на запуск скана. POST /api/scan больше НЕ ждёт окончания: сервер уводит
 * скан в фон и отвечает сразу 202 — `started=true`, если скан стартовал этим
 * вызовом; `started=false, running=true`, если скан уже шёл (второй не
 * запускается). Итог забираем из GET /api/scan/status (поле `last_result`).
 */
export const scan = () => call<ScanStart>("/api/scan", { method: "POST" });

/* ── прогресс скана ── */

/**
 * Живое состояние скана (GET /api/scan/status). Отдельный эндпоинт: показывает
 * фазу, счётчики и отбраковку, чтобы по одному спиннеру не гадать, идёт работа
 * или всё зависло. В shared/types.ts его нет (файл заморожен) — тип живёт здесь.
 */
/* Тип живёт в общем контракте (shared/types.ts), здесь — только реэкспорт:
   экраны импортируют его из клиента и не знают про внутреннее расположение. */
export type { ScanStatus, ScanStart } from "../../shared/types";

export const scanStatus = () => call<ScanStatus>("/api/scan/status");

/* ── свечи ── */
export const candles = (token: string, tf: ChartTf, limit = 300) =>
  call<Candle[]>(
    `/api/candles?token=${encodeURIComponent(token)}&tf=${tf}&limit=${limit}`,
  );

/* ── позиции ── */
export const listPositions = (status?: PositionStatus) =>
  call<Position[]>(`/api/positions${status ? `?status=${status}` : ""}`);

export const openPosition = (req: OpenPositionRequest) =>
  call<Position>("/api/positions/open", { method: "POST", body: req });

export const addToPosition = (id: number, usd: number) =>
  call<Position>(`/api/positions/${id}/add`, { method: "POST", body: { usd } });

/** Перенос линии ТП на графике (§9): цена — единственное, что приходит сюда. */
export const setTp = (id: number, tpPrice: number) =>
  call<Position>(`/api/positions/${id}/tp`, { method: "POST", body: { tp_price: tpPrice } });

export const closePosition = (id: number, fraction: number) =>
  call<{ position: Position; fill: Fill }>(`/api/positions/${id}/close`, {
    method: "POST",
    body: { fraction },
  });

/* ── сделки и аналитика ── */
export const listTrades = (limit?: number) =>
  call<Trade[]>(`/api/trades${limit ? `?limit=${limit}` : ""}`);

export const analyticsSummary = () => call<AnalyticsSummary>("/api/analytics/summary");

export const addDeposit = (usd: number) =>
  call<AnalyticsSummary>("/api/deposits", { method: "POST", body: { usd } });

/* ── воронка отбора (история сканов) ──
 * GET /api/funnel отдаёт сводку воронки за период: этапы отбора с цифрами,
 * разбивку по дням и последние проходы — чтобы владелец видел, НА КАКОМ этапе
 * и по КАКОЙ причине скринер срезает монеты. Границы `from`/`to` — в секундах
 * (как и остальные метки времени контракта), `limit` ограничивает список
 * последних проходов. */
export const funnel = (opts: { from?: number; to?: number; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.from != null) q.set("from", String(opts.from));
  if (opts.to != null) q.set("to", String(opts.to));
  if (opts.limit != null) q.set("limit", String(opts.limit));
  const s = q.toString();
  return call<FunnelSummary>(`/api/funnel${s ? `?${s}` : ""}`);
};

/* ── настройки ── */
export const getSettings = () => call<Settings>("/api/settings");

export const updateSettings = (patch: SettingsPatch) =>
  call<Settings>("/api/settings", { method: "PUT", body: patch });

/* ── ключи ── */
export const keysStatus = () => call<KeysStatus>("/api/keys/status");

export const updateKeys = (patch: KeysUpdate) =>
  call<KeysStatus>("/api/keys", { method: "PUT", body: patch });

/* ── алерты ── */
export const listAlerts = (unseen = false) =>
  call<Alert[]>(`/api/alerts${unseen ? "?unseen=1" : ""}`);

export const seenAlert = (id: number) =>
  call<Alert>(`/api/alerts/${id}/seen`, { method: "POST" });

/* ── журнал ── */
export const listAudit = (limit?: number) =>
  call<AuditEntry[]>(`/api/audit${limit ? `?limit=${limit}` : ""}`);

/* ── проверка ключа ── */
/** Проверка КОНКРЕТНОГО ключа без его сохранения: ответ 200 — ключ принят.
 *  Отказ (401) не поднимает экран гейта: это проверка кандидата, а не отказ
 *  рабочему ключу. Минимальный аутентифицированный маршрут — настройки. */
export const probeAuth = (token: string) =>
  call<Settings>("/api/settings", { token, notifyUnauthorized: false });
