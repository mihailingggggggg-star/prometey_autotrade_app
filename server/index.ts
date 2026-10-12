/**
 * index.ts — HTTP-роутер демо-контура (node:http), порт 8788, только 127.0.0.1.
 *
 * Формы ответов обязаны буквально совпадать с shared/types.ts: этот файл —
 * единственное место, где строки БД превращаются в DTO для клиента.
 * Ошибки — {"error":{"code","message"}} со статусом 4xx/5xx. Ожидаемые отказы
 * (ApiError, 4xx/5xx с понятным code) отдаются клиенту как есть и в лог не
 * пишутся; непредвиденные (внутренние 500) логируются в stderr только текстом
 * сообщения, без секретов (stdout занят приложением, логов туда не шлём).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { readDataMode, getEnv, getEnvNum, ApiError } from "./config.ts";
import {
  ensureClock,
  virtualNow,
  nowSec,
  getSettings,
  setSettings,
  signalById,
  getDb,
  type SignalRow,
} from "./db.ts";
import { runScan } from "./screener.ts";
import {
  openPosition,
  addToPosition,
  setTp,
  closePosition,
  listPositions,
  listTrades,
  analyticsSummary,
  listAlerts,
  markAlertSeen,
  addDeposit,
  advance,
  candlesFor,
} from "./demo.ts";
import { getKeysStatus, setKeys } from "./keys.ts";
import type {
  Health,
  Signal,
  SignalDetail,
  SignalStatus,
  Check,
  Indicators,
  Social,
  ChartTf,
  ScanResult,
  KeysUpdate,
  SettingsPatch,
  Settings,
  DepositResponse,
  AlertSeenResponse,
} from "../shared/types.ts";

const STATUS_LABELS: Record<SignalStatus, string> = {
  new: "Новый",
  taken: "В работе",
  skipped: "Пропущен",
  archived: "Архив",
};

const TFS = new Set<ChartTf>(["1m", "5m", "1h", "1d"]);

/* ─────────────── DTO ─────────────── */

function signalDTO(row: SignalRow): Signal {
  const status = row.status as SignalStatus;
  return {
    id: row.id,
    ts: row.ts,
    token_addr: row.token_addr,
    symbol: row.symbol,
    name: row.name,
    pair_addr: row.pair_addr,
    price: row.price,
    liq_usd: row.liq_usd,
    mc_usd: row.mc_usd,
    age_days: row.age_days,
    tf_accum: row.tf_accum,
    score: row.score,
    status,
    status_label: STATUS_LABELS[status] ?? status,
    sentiment: row.sentiment,
    is_organic: Boolean(row.is_organic),
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    // Битый JSON в БД не должен ломать карточку — отдаём пустое значение.
    return fallback;
  }
}

function signalDetail(row: SignalRow): SignalDetail {
  return {
    signal: signalDTO(row),
    checks: safeParse<Check[]>(row.checks_json, []),
    indicators: safeParse<Indicators>(row.metrics_json, {} as Indicators),
    overview_ru: row.overview_ru,
    social: safeParse<Social>(row.social_json, { sentiment: 0, is_organic: false, summary: "", mentions: [] }),
  };
}

/* ─────────────── HTTP-утилиты ─────────────── */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[server] внутренняя ошибка: ${message}`);
  sendJson(res, 500, { error: { code: "internal", message: "внутренняя ошибка сервера" } });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new ApiError("payload_too_large", 413, "тело запроса слишком большое");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    throw new Error("not an object");
  } catch {
    throw new ApiError("invalid_json", 400, "тело запроса — не JSON-объект");
  }
}

function numId(params: Record<string, string>): number {
  const n = Number(params.id);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("invalid_id", 400, "некорректный идентификатор");
  return n;
}

function numBody(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  // Number(null) === 0 и Number("") === 0 — это скрытый ноль вместо «не задано».
  // Возвращаем NaN, чтобы штатные проверки суммы/идентификатора отсекли поле.
  if (v === null || v === undefined || v === "") return Number.NaN;
  return Number(v);
}

/* ─────────────── маршруты ─────────────── */

interface Route {
  method: string;
  pattern: string;
  handler: (ctx: {
    params: Record<string, string>;
    url: URL;
    body: Record<string, unknown>;
  }) => Promise<unknown> | unknown;
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split("/").filter(Boolean);
  const xs = path.split("/").filter(Boolean);
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) {
      // Битый процент (`%zz`) роняет decodeURIComponent в URIError. Это ошибка
      // запроса (400), а не сбой сервера (500).
      try {
        params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
      } catch {
        throw new ApiError("invalid_path", 400, "некорректное кодирование в пути запроса");
      }
    } else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: "/api/health",
    handler: (): Health => {
      const ks = getKeysStatus();
      return {
        ok: true,
        mode: readDataMode(),
        keys: {
          telegram: ks.telegram_bot_token.set || ks.telegram_chat_id.set,
          helius: ks.helius_api_key.set,
          gemini: ks.gemini_api_key.set,
          wallet: ks.wallet.set,
        },
        ts: nowSec(),
        virtual_ts: virtualNow(),
      };
    },
  },
  {
    method: "GET",
    pattern: "/api/signals",
    handler: ({ url }) => {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const status = url.searchParams.get("status");
      const db = getDb();
      const rows = (status
        ? db.prepare("SELECT * FROM signals WHERE status=? ORDER BY ts DESC, id DESC LIMIT ?").all(status, limit)
        : db.prepare("SELECT * FROM signals ORDER BY ts DESC, id DESC LIMIT ?").all(limit)) as unknown as SignalRow[];
      return rows.map(signalDTO);
    },
  },
  {
    method: "GET",
    pattern: "/api/signals/:id",
    handler: ({ params }) => {
      const row = signalById(numId(params));
      if (!row) throw new ApiError("signal_not_found", 404, `сигнал ${params.id} не найден`);
      return signalDetail(row);
    },
  },
  {
    method: "POST",
    pattern: "/api/scan",
    handler: async (): Promise<ScanResult> => runScan(),
  },
  {
    method: "GET",
    pattern: "/api/candles",
    handler: async ({ url }) => {
      const token = url.searchParams.get("token");
      if (!token) throw new ApiError("missing_token", 400, "параметр token обязателен");
      const tf = (url.searchParams.get("tf") ?? "1h") as ChartTf;
      if (!TFS.has(tf)) throw new ApiError("invalid_tf", 400, "tf должен быть одним из 1m|5m|1h|1d");
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      return candlesFor(token, tf, limit);
    },
  },
  {
    method: "GET",
    pattern: "/api/positions",
    handler: ({ url }) => listPositions(url.searchParams.get("status") ?? undefined),
  },
  {
    method: "POST",
    pattern: "/api/positions/open",
    handler: ({ body }) =>
      openPosition({
        signal_id: numBody(body, "signal_id"),
        usd: numBody(body, "usd"),
        order_type: body.order_type === "limit" ? "limit" : "market",
        // null приравниваем к «не задано»: Number(null)=0 иначе давал бы ТП по цене входа.
        limit_price: body.limit_price == null ? undefined : Number(body.limit_price),
        tp_percent: body.tp_percent == null ? undefined : Number(body.tp_percent),
        tp_mode: body.tp_mode === "manual" ? "manual" : "free_ride",
      }),
  },
  {
    method: "POST",
    pattern: "/api/positions/:id/add",
    handler: ({ params, body }) => addToPosition(numId(params), numBody(body, "usd")),
  },
  {
    method: "POST",
    pattern: "/api/positions/:id/tp",
    handler: ({ params, body }) => setTp(numId(params), numBody(body, "tp_price")),
  },
  {
    method: "POST",
    pattern: "/api/positions/:id/close",
    handler: ({ params, body }) => closePosition(numId(params), body.fraction == null ? 1 : Number(body.fraction)),
  },
  {
    method: "GET",
    pattern: "/api/trades",
    handler: ({ url }) => listTrades(Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100))),
  },
  {
    method: "GET",
    pattern: "/api/analytics/summary",
    handler: () => analyticsSummary(),
  },
  {
    method: "GET",
    pattern: "/api/settings",
    handler: (): Settings => getSettings(),
  },
  {
    method: "PUT",
    pattern: "/api/settings",
    handler: ({ body }): Settings => setSettings(body as SettingsPatch, "user"),
  },
  {
    method: "GET",
    pattern: "/api/keys/status",
    handler: () => getKeysStatus(),
  },
  {
    method: "PUT",
    pattern: "/api/keys",
    handler: ({ body }) => setKeys(body as KeysUpdate),
  },
  {
    method: "GET",
    pattern: "/api/alerts",
    handler: ({ url }) => listAlerts(url.searchParams.get("unseen") === "1"),
  },
  {
    method: "POST",
    pattern: "/api/alerts/:id/seen",
    // Экран гадает, что стало с алертом, — отдаём его же (AlertSeenResponse = Alert).
    handler: ({ params }): AlertSeenResponse => {
      const alert = markAlertSeen(numId(params));
      if (!alert) throw new ApiError("alert_not_found", 404, "алерт не найден");
      return alert;
    },
  },
  {
    method: "POST",
    pattern: "/api/deposits",
    // Клиент ждёт AnalyticsSummary (DepositResponse): после пополнения экран
    // «Аналитика» обязан показать новый баланс и кривую. Считаем ПОСЛЕ записи.
    handler: async ({ body }): Promise<DepositResponse> => {
      addDeposit(numBody(body, "usd"), "manual");
      return analyticsSummary();
    },
  },
  {
    method: "GET",
    pattern: "/api/audit",
    handler: ({ url }) => {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const rows = getDb()
        .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
        .all(limit) as unknown as { id: number; ts: number; actor: string; action: string; payload_json: string }[];
      return rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        actor: r.actor,
        action: r.action,
        payload: safeParse<Record<string, unknown>>(r.payload_json, {}),
      }));
    },
  },
];

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = (req.method ?? "GET").toUpperCase();

  try {
    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "PUT" || method === "PATCH") body = await readBody(req);

    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.pattern, url.pathname);
      if (!params) continue;
      const result = await route.handler({ params, url, body });
      sendJson(res, 200, result ?? { ok: true });
      return;
    }
    throw new ApiError("not_found", 404, `маршрут ${method} ${url.pathname} не найден`);
  } catch (err) {
    sendError(res, err);
  }
}

/** Сервер без прослушивания — так его можно поднять в тестах на эфемерном порту. */
export function createServerApp() {
  return createServer((req, res) => {
    void handle(req, res);
  });
}

/* ─────────────── запуск ─────────────── */

function start(): void {
  ensureClock();
  const host = getEnv("API_HOST") || "127.0.0.1";
  const port = getEnvNum("API_PORT") || 8788;
  const server = createServerApp();

  // Служебный цикл раз в 60 с: в mock двигает виртуальные часы и пересчитывает
  // позиции (Free Riding, time-stop, liq-drain), в live — просто обновляет их.
  setInterval(() => {
    advance().catch((e) => console.error(`[server] цикл обслуживания: ${e instanceof Error ? e.message : e}`));
  }, 60_000).unref?.();

  server.listen(port, host, () => {
    console.error(`[server] демо-контур слушает http://${host}:${port} (режим ${readDataMode()})`);
  });
  server.on("error", (e) => {
    console.error(`[server] не удалось поднять сервер: ${e.message}`);
    process.exit(1);
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) start();
