/**
 * api.ts — связь с автотрейд-ботом.
 *
 * Бот отдаёт ТОЛЬКО ЧТЕНИЕ (см. autotrade_bot/webapi.py): состояние счёта,
 * открытые позиции, журнал закрытых сделок. Управление живёт в Telegram-панели
 * и сюда не вынесено намеренно — кнопка «закрыть всё» в вебвью, открытой по
 * публичной ссылке, это реальные деньги за один промах пальца.
 *
 * Адрес API приходит ПАРАМЕТРОМ `?api=`: бот подставляет в ссылку текущий адрес
 * cloudflared-тоннеля, который меняется при каждом рестарте. Хардкодить его
 * нельзя — ссылка протухала бы вместе с тоннелем. Нет параметра → адреса нет →
 * приложение работает на демо-данных (так его можно смотреть в браузере).
 *
 * Авторизация — подпись Telegram initData в заголовке. Заголовок, а не тело:
 * запросы тут GET, и initData в строке запроса осела бы в логах прокси.
 */
import { tg } from "./tg";

const qs = new URLSearchParams(location.search);

export const API_BASE = (qs.get("api") || import.meta.env.VITE_API_BASE || "")
  .replace(/\/+$/, "");
export const hasApi = Boolean(API_BASE);

/** Отладочный ключ — только чтобы смотреть настоящие данные из браузера, где
 *  Telegram initData взять негде. На сервере по умолчанию выключен. */
const devToken = qs.get("dev") || import.meta.env.VITE_DEV_TOKEN || "";

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
  constructor(public status: number) {
    super(`api ${status}`);
  }
}

export const getState = (s?: AbortSignal) => get<ApiState>("/api/state", s);
export const getPositions = (s?: AbortSignal) =>
  get<{ positions: ApiPosition[]; mode: string; ts: number }>("/api/positions", s);
export const getTrades = (days = 0, s?: AbortSignal) =>
  get<{ trades: ApiTrade[]; mode: string }>(`/api/trades?days=${days}&limit=500`, s);
