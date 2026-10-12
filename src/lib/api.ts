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
import type {
  Health, Signal, SignalDetail, SignalStatus, ScanResult, Candle, ChartTf,
  Position, PositionStatus, Trade, AnalyticsSummary, Settings, SettingsPatch,
  KeysStatus, KeysUpdate, Alert, AuditEntry, OpenPositionRequest, Fill,
  ApiErrorBody,
} from "../../shared/types";

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

/** Единый текст для «сервер не отвечает»: экран обязан показать ПРИЧИНУ, а не
 *  пустоту, поэтому сетевой сбой превращается в понятное человеку предложение. */
export const NO_SERVER =
  "локальный сервер демо-контура не отвечает — запустите npm run server";

type JsonInit = { method?: string; body?: unknown };

async function call<T>(path: string, init: JsonInit = {}): Promise<T> {
  const { method = "GET", body } = init;
  let res: Response;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
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
    throw new Error(err?.message || `сервер вернул ошибку ${res.status}`);
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

export const scan = () => call<ScanResult>("/api/scan", { method: "POST" });

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
