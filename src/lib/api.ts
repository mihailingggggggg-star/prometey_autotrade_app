/**
 * api.ts — связь с автотрейд-ботом.
 *
 * Чтение и управление (см. autotrade_bot/webapi.py). Управление доступно
 * ТОЛЬКО владельцу счёта: у обычного пользователя нет счёта, которым он мог бы
 * тут распоряжаться. Права приходят с сервера полем `can` — фронт их не
 * угадывает и не выводит из роли.
 *
 * Адрес API приходит ПАРАМЕТРОМ `?api=`: бот подставляет в ссылку текущий адрес
 * cloudflared-тоннеля, который меняется при каждом рестарте. Хардкодить его
 * нельзя — ссылка протухала бы вместе с тоннелем. Нет параметра → адреса нет →
 * приложение работает на демо-данных (так его можно смотреть в браузере).
 *
 * Авторизация — подпись Telegram initData в заголовке. Заголовок, а не тело:
 * запросы тут GET, и initData в строке запроса осела бы в логах прокси.
 */
import { inTelegram, tg } from "./tg";
import { standalone } from "./pwa";

const qs = new URLSearchParams(location.search);

export const API_BASE = (qs.get("api") || import.meta.env.VITE_API_BASE || "")
  .replace(/\/+$/, "");
export const hasApi = Boolean(API_BASE);

/** Отладочный ключ — только чтобы смотреть настоящие данные из браузера, где
 *  Telegram initData взять негде. На сервере по умолчанию выключен. */
const devToken = qs.get("dev") || import.meta.env.VITE_DEV_TOKEN || "";

/**
 * Билет веб-версии. Вне Telegram подписи initData не существует, а ярлык с
 * рабочего стола открывается именно в браузере — без билета приложение
 * показывало бы демо-данные и выглядело бы сломанным.
 *
 * Билет приезжает параметром `?t=` и сохраняется в localStorage.
 *
 * Из адресной строки он вычищается НЕ ВСЕГДА, и это осознанный размен. В
 * обычной вкладке браузера адрес — это ровно то, что «Добавить на экран
 * Домой» запомнит в ярлыке: вычисти мы билет, ярлык открывался бы без
 * доступа к счёту, то есть на демо-данных. А у установленного приложения и
 * внутри Telegram адресной строки нет вовсе (там же и билет не нужен —
 * работает подпись), поэтому там чистим.
 *
 * Хранилище у установленного на iOS приложения СВОЁ, отдельное от Safari, —
 * поэтому полагаться на один localStorage нельзя, билет обязан быть в адресе.
 */
const SESSION_KEY = "prometey.session";

function readSession(): string {
  try {
    const fromUrl = qs.get("t");
    if (fromUrl) {
      localStorage.setItem(SESSION_KEY, fromUrl);
      if (standalone() || inTelegram) {
        const clean = new URL(location.href);
        clean.searchParams.delete("t");
        history.replaceState(null, "", clean.toString());
      }
      return fromUrl;
    }
    return localStorage.getItem(SESSION_KEY) || "";
  } catch {
    // Приватное окно, запрещённые куки, превью — билет просто не сохранится.
    return qs.get("t") || "";
  }
}

let session = readSession();
export const hasSession = () => Boolean(session);
export function dropSession() {
  session = "";
  try { localStorage.removeItem(SESSION_KEY); } catch { /* не критично */ }
}

export type ApiPosition = {
  id: string; symbol: string; side: "long" | "short"; lev: number;
  entry: number; mark: number; sl: number; slPlan: number;
  tp: number; tps: { price: number; weight: number }[];
  be: number | null; beMoved: boolean;
  size: number; risk: number; openedAt: number; scheme: string;
  status: "pending" | "open"; entryType: "market" | "limit";
  score: number; whale: boolean; upl?: number;
};

export type ApiTrade = {
  id: string; symbol: string; side: "long" | "short";
  entry: number; exit: number; pnl: number; r: number;
  reason: string; closedAt: number; heldMin: number; fee: number;
  mfe: number; mae: number; scheme: string; score: number; whale: boolean;
  entryType: "market" | "limit"; lev: number; risk: number; hits: number | null;
};

export type ApiMe = {
  id: number; name: string; username: string;
  role: "user" | "admin"; status: string;
  email: string; phone: string;
  balance: number; owed: number;
  subUntil: number | null; subPlan: string; createdAt: number;
  can: { topupFree: boolean; demo: boolean; control: boolean };
};

export type ApiState = {
  mode: "demo" | "live";
  enabled: boolean;
  /** Биржа ответила. Отдельно от чисел: сбой сети не равен нулевому балансу. */
  exchange: boolean;
  equity: number; available: number; upl: number;
  settings: {
    riskUsd: number; maxOpen: number; maxPosition: number;
    leverage: number; leverageMode: "max" | "fixed"; limitTtlMin: number;
    marginMode: string; useSignalTp: boolean; liqBuffer: number;
  };
  scheme: { long: string; short: string };
  openN: number; ts: number;
};

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  const init = tg?.initData;
  if (init) headers["X-Init-Data"] = init;
  else if (session) headers["X-Session"] = session;
  if (devToken) headers["X-Dev-Token"] = devToken;
  const r = await fetch(API_BASE + path, {
    headers, signal: signal ?? AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new ApiError(r.status);
  return r.json() as Promise<T>;
}

/** Код ответа нужен наверху: 401/403 — это «вас не пустили», а не «сервер лёг»,
 *  и говорить об этом надо разными словами. */
export class ApiError extends Error {
  constructor(public status: number, public reason = "") {
    super(reason || `api ${status}`);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const init = tg?.initData;
  if (init) headers["X-Init-Data"] = init;
  else if (session) headers["X-Session"] = session;
  // Отладочный ключ в запись НЕ уходит: сервер её и не примет. Слать его
  // значило бы приучать себя к мысли, что он что-то решает.
  const r = await fetch(API_BASE + path, {
    method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (data as any)?.message || (data as any)?.error);
  return data as T;
}

export const getMe = (s?: AbortSignal) => get<ApiMe>("/api/me", s);
export const getState = (s?: AbortSignal) => get<ApiState>("/api/state", s);
export const getPositions = (s?: AbortSignal) =>
  get<{ positions: ApiPosition[]; mode: string; ts: number }>("/api/positions", s);
export const getTrades = (days = 0, s?: AbortSignal) =>
  get<{ trades: ApiTrade[]; mode: string }>(`/api/trades?days=${days}&limit=500`, s);

/* ── Управление. Каждая ручка возвращает то, что сервер реально применил:
      верить своему представлению о результате нельзя — значение могло быть
      отвергнуто проверкой, и экран обязан показать настоящее состояние. ── */

export type SettingsPatch = Partial<{
  risk_usd: number; max_position: number; max_open: number; leverage: number;
  limit_ttl_min: number; liq_buffer: number;
  leverage_mode: "max" | "fixed"; margin_mode: "isolated" | "cross";
  use_signal_tp: boolean;
}>;

export const putSettings = (patch: SettingsPatch) =>
  post<{ applied: Record<string, unknown>; rejected: string[]; state: ApiState }>(
    "/api/settings", patch);

export const putEnabled = (on: boolean) => post<{ enabled: boolean }>("/api/enabled", { on });

export const putMode = (mode: "demo" | "live") =>
  post<{ ok: boolean; message: string; mode: string }>("/api/mode", { mode });

export type SchemeLeg = { r: number; pct: number };
export const putScheme = (side: "long" | "short",
                          scheme: { legs: SchemeLeg[]; be_r: number | null } | null) =>
  post<{ ok: boolean; message: string; scheme: { long: string; short: string } }>(
    "/api/scheme", { side, scheme });

export const closePosition = (id: string) =>
  post<{ ok: boolean; message: string }>("/api/position/close", { id });

export const setLevels = (id: string, tp: number, sl: number) =>
  post<{ ok: boolean; message: string }>("/api/position/levels", { id, tp, sl });

export const closeAll = () =>
  post<{ closed: number; failed: number }>("/api/positions/close_all", {});

export const putProfile = (email: string, phone: string) =>
  post<ApiMe>("/api/profile", { email, phone });

export const topUp = (amount: number) => post<ApiMe>("/api/billing/topup", { amount });

/** Выдать билет для веб-версии. Работает ТОЛЬКО изнутри Telegram: сервер
 *  требует свежую подпись, иначе утёкшая ссылка продлевала бы себя вечно. */
export const newSession = () => post<{ token: string; ttlDays: number }>("/api/session", {});

/** Ссылка на это же приложение, открываемая вне Telegram. Адрес API тащим с
 *  собой: в браузере параметра `?api=` от бота уже никто не подставит. */
export function webLink(token: string): string {
  const u = new URL(location.href);
  u.searchParams.set("t", token);
  if (API_BASE) u.searchParams.set("api", API_BASE);
  u.hash = "";
  return u.toString();
}
