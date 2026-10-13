/**
 * index.ts — HTTP-роутер демо-контура (node:http), порт 8790, только 127.0.0.1.
 *
 * Здесь же, тем же процессом и на том же порту, отдаётся собранный интерфейс из
 * каталога STATIC_DIR (по умолчанию ./dist рядом с репозиторием). Это осознанное
 * решение: интерфейс и API живут по одному origin — нет CORS, нет второго
 * тоннеля. Доступ закрывает сам сервер: при заданном API_TOKEN все /api/* (кроме
 * GET /api/health) требуют заголовок X-Api-Token, а статика остаётся открытой —
 * её обязан получить ярлык PWA. Порт по умолчанию слушает только
 * 127.0.0.1. Если интерфейс не собран, сервер не падает: он работает как прежде
 * (только API) и пишет в stderr одну строку «интерфейс не собран, отдаю только API».
 *
 * /api/* всегда приоритетнее статики. Остальные пути отдаются файлами из
 * STATIC_DIR (GET/HEAD) с SPA-фолбэком: путь без расширения → index.html, с
 * расширением → 404. Путь разрешается через path.resolve и проверяется на
 * принадлежность корню статики (с учётом симлинков) ДО чтения файла — запрос не
 * может выйти за пределы STATIC_DIR.
 *
 * Формы ответов обязаны буквально совпадать с shared/types.ts: этот файл —
 * единственное место, где строки БД превращаются в DTO для клиента.
 * Ошибки — {"error":{"code","message"}} со статусом 4xx/5xx. Ожидаемые отказы
 * (ApiError, 4xx/5xx с понятным code) отдаются клиенту как есть и в лог не
 * пишутся; непредвиденные (внутренние 500) логируются в stderr только текстом
 * сообщения, без секретов (stdout занят приложением, логов туда не шлём).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readDataMode, getEnv, getEnvNum, ApiError, REPO_ROOT } from "./config.ts";
import {
  ensureClock,
  virtualNow,
  nowSec,
  getSettings,
  setSettings,
  signalById,
  getDb,
  audit,
  type SignalRow,
} from "./db.ts";
import { runScan, startScan, getScanStatus } from "./screener.ts";
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
import { assessSocial, cachedSocialMentions } from "./sources/apify.ts";
import type {
  Health,
  Signal,
  SignalDetail,
  SignalStatus,
  Check,
  Indicators,
  Social,
  ChartTf,
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
  const social = safeParse<Social>(row.social_json, { sentiment: 0, is_organic: false, summary: "", mentions: [] });
  // mentions[] отдаём из КЭША медиаслоя (свежие упоминания), если он есть; иначе
  // оставляем то, что записали при скане (mock/старые сигналы). Форма ответа та же.
  const cached = cachedSocialMentions(row.token_addr);
  if (cached.length > 0) social.mentions = cached;
  return {
    signal: signalDTO(row),
    checks: safeParse<Check[]>(row.checks_json, []),
    indicators: safeParse<Indicators>(row.metrics_json, {} as Indicators),
    overview_ru: row.overview_ru,
    social,
  };
}

/* ─────────────── HTTP-утилиты ─────────────── */

/**
 * Ответ со статусом, отличным от 200. Роутер по умолчанию отдаёт 200; этот
 * обёртка позволяет, например, POST /api/scan ответить 202 Accepted (скан ушёл
 * в фон), не меняя сигнатуру всех остальных обработчиков.
 */
class HttpReply {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

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

/* ─────────────── статика (собранный интерфейс) ─────────────── */

/** MIME только для того, что реально кладёт Vite-сборка. Остальное — octet-stream. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

interface StaticCtx {
  root: string;
  realRoot: string;
}

/** Корень статики из STATIC_DIR (по умолчанию ./dist). null — каталога нет. */
function resolveStaticCtx(): StaticCtx | null {
  const dir = resolve(REPO_ROOT, getEnv("STATIC_DIR") || "./dist");
  try {
    if (!statSync(dir).isDirectory()) return null;
    return { root: dir, realRoot: realpathSync(dir) };
  } catch {
    return null;
  }
}

/** Путь внутри корня? Сравнение с учётом разделителя, чтобы /dist-extra не проходил. */
function isInside(root: string, p: string): boolean {
  if (p === root) return true;
  const r = root.endsWith(sep) ? root : root + sep;
  return p.startsWith(r);
}

/**
 * Разрешить URL-путь в существующий файл внутри корня статики — или null.
 * Два барьера: path.resolve (ловит «..» после декодирования) и realpath
 * (ловит симлинк из корня наружу). Файл читается только после обеих проверок.
 */
function safeResolve(ctx: StaticCtx, decodedPath: string): string | null {
  const abs = resolve(ctx.root, decodedPath.replace(/^\/+/, ""));
  if (!isInside(ctx.root, abs)) return null;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null; // не существует
  }
  if (!isInside(ctx.realRoot, real)) return null; // симлинк наружу
  return real;
}

/**
 * Есть ли «расширение» у последнего сегмента. Ведём по точке, а не по
 * path.extname: для /.env extname пуст, и такой запрос (файл, а не SPA-маршрут)
 * не должен получать index.html.
 */
function hasExtension(p: string): boolean {
  return p.slice(p.lastIndexOf("/") + 1).includes(".");
}

function contentType(abs: string): string {
  return MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
}

function sendFile(res: ServerResponse, abs: string, method: string): void {
  const info = statSync(abs);
  const noCache = basename(abs) === "index.html";
  res.writeHead(200, {
    "content-type": contentType(abs),
    "content-length": String(info.size),
    // index.html — точка входа: не кэшируем, иначе клиент застрянет на старой
    // версии. Остальное — файлы с хэшем в имени, их можно кэшировать навсегда.
    "cache-control": noCache ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(abs).pipe(res);
}

function serveStatic(
  res: ServerResponse,
  rawPath: string,
  ctx: StaticCtx,
  method: string,
): void {
  // URL.pathname приходит процент-кодированным; декодируем сами (URL нормализует
  // %2e, но %2f остаётся). Битый процент — 400, а не 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new ApiError("invalid_path", 400, "некорректное кодирование в пути запроса");
  }

  // 0. Попытка выйти за корень (после декодирования «..») — 404 сразу, без
  // SPA-фолбэка: даже index.html не должен маскировать обход пути.
  if (!isInside(ctx.root, resolve(ctx.root, decoded.replace(/^\/+/, "")))) {
    throw new ApiError("not_found", 404, `файл ${rawPath} не найден`);
  }

  // 1. Прямое совпадение файла.
  const direct = safeResolve(ctx, decoded);
  if (direct && statSync(direct).isFile()) {
    sendFile(res, direct, method);
    return;
  }

  // 2. SPA-фолбэк: путь без расширения (/, /positions) → index.html.
  if (!hasExtension(decoded)) {
    const index = safeResolve(ctx, "index.html");
    if (index && statSync(index).isFile()) {
      sendFile(res, index, method);
      return;
    }
  }

  // 3. Расширение есть, но файла нет — 404 (а не index.html).
  throw new ApiError("not_found", 404, `файл ${rawPath} не найден`);
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
    // По умолчанию — асинхронный запуск: скан уходит в фон, отвечаем сразу
    // 202 {"started","running"}. Долгой HTTP-связи нет, поэтому обрыв запроса
    // на телефоне (блокировка экрана) больше не выглядит как «сервер не
    // отвечает». Итог клиент забирает из GET /api/scan/status (last_result).
    // ?sync=1 — прежнее поведение для CLI/скриптов/мониторинга: ждём скан и
    // отдаём ScanResult (200).
    handler: ({ url }) => {
      if (url.searchParams.get("sync") === "1") return runScan();
      return new HttpReply(202, startScan());
    },
  },
  {
    method: "GET",
    pattern: "/api/scan/status",
    // Дешёвый статус текущего (или последнего) скана: без сети и побочных
    // эффектов. Нужен визуализатору поиска — по одному спиннеру не понять,
    // идёт работа или всё зависло.
    handler: () => getScanStatus(),
  },
  {
    method: "POST",
    pattern: "/api/media/refresh",
    // Ручная проверка медиаслоя по АДРЕСУ монеты: обновляет кэш упоминаний и
    // возвращает оценку. Побочных эффектов на сигналы и позиции НЕТ — только
    // чтение/запись медиакэша (Apify), торговая логика не затрагивается.
    handler: async ({ body }) => {
      const token = String(body.token ?? "").trim();
      if (!token) throw new ApiError("missing_token", 400, "параметр token обязателен (адрес монеты)");
      const row = getDb()
        .prepare("SELECT symbol, name FROM signals WHERE token_addr=? ORDER BY ts DESC, id DESC LIMIT 1")
        .get(token) as { symbol: string; name: string } | undefined;
      const ref = { token_addr: token, pair_addr: "", symbol: row?.symbol ?? "?", name: row?.name ?? "?" };
      const social = await assessSocial(ref);
      return {
        token,
        symbol: ref.symbol,
        source: social.media_source ?? "none",
        note: social.media_note ?? "",
        mentions_24h: social.media_mentions_24h ?? null,
        sentiment: social.sentiment,
        is_organic: social.is_organic,
        summary: social.summary,
        mentions: social.mentions,
      };
    },
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

/* ─────────────── ключ доступа к API ─────────────── */

/**
 * Ключ доступа к API из .env. Пусто — контур открыт (локальная разработка).
 * Значение НИКОГДА не логируем и не кладём в ответы: наружу уходит только факт.
 */
function apiToken(): string {
  return getEnv("API_TOKEN").trim();
}

/**
 * Совпал ли предъявленный ключ с ожидаемым. Сравниваем SHA-256-дайджесты через
 * crypto.timingSafeEqual: дайджесты всегда 32 байта, поэтому ни длина ключа, ни
 * позиция расхождения не утекают по времени ответа, а сравнение устойчиво к
 * подбору. Побайтовое равенство дайджестов равносильно равенству исходных строк.
 */
function tokenOk(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  staticCtx: StaticCtx | null,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = (req.method ?? "GET").toUpperCase();

  // /api/* всегда приоритетнее статики: иначе клиент получил бы index.html
  // вместо JSON-ошибки на неизвестный API-маршрут.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    try {
      // Ключ доступа. Закрываем ТОЛЬКО данные и действия, а не всё приложение:
      // статика (HTML, JS, CSS, манифест, иконки) остаётся открытой — в ней нет
      // секретов, но её обязан получить ярлык PWA, иначе он остаётся серым
      // квадратом. GET /api/health тоже открыт: он нужен мониторингу и секретов
      // не содержит. Пустой API_TOKEN — поведение прежнее (всё открыто).
      const token = apiToken();
      const healthProbe = method === "GET" && url.pathname === "/api/health";
      if (token && !healthProbe) {
        const raw = req.headers["x-api-token"];
        const provided = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
        if (!tokenOk(provided, token)) {
          // В журнал — только факт отказа, маршрут и метод. Ни значения ключа,
          // ни тела запроса там быть не должно.
          audit("api.unauthorized", { method, route: url.pathname });
          throw new ApiError("unauthorized", 401, "нужен ключ доступа к демо-контуру");
        }
      }

      let body: Record<string, unknown> = {};
      if (method === "POST" || method === "PUT" || method === "PATCH") body = await readBody(req);

      for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchPath(route.pattern, url.pathname);
        if (!params) continue;
        const result = await route.handler({ params, url, body });
        // Обработчик может попросить нестандартный статус (202 у фонового скана).
        if (result instanceof HttpReply) {
          sendJson(res, result.status, result.body);
          return;
        }
        sendJson(res, 200, result ?? { ok: true });
        return;
      }
      throw new ApiError("not_found", 404, `маршрут ${method} ${url.pathname} не найден`);
    } catch (err) {
      sendError(res, err);
    }
    return;
  }

  // Всё остальное — статика (только чтение). Без собранного интерфейса сервер
  // работает как прежде: отдаёт только API.
  if (method === "GET" || method === "HEAD") {
    if (!staticCtx) {
      sendError(res, new ApiError("not_found", 404, `маршрут ${method} ${url.pathname} не найден`));
      return;
    }
    try {
      serveStatic(res, url.pathname, staticCtx, method);
    } catch (err) {
      sendError(res, err);
    }
    return;
  }

  sendError(res, new ApiError("not_found", 404, `маршрут ${method} ${url.pathname} не найден`));
}

/**
 * Сервер без прослушивания — так его можно поднять в тестах на эфемерном порту.
 * Корень статики берётся из STATIC_DIR на момент вызова (тесты задают его сами);
 * null означает «интерфейс не собран, только API».
 */
export function createServerApp(staticCtx: StaticCtx | null = resolveStaticCtx()) {
  return createServer((req, res) => {
    void handle(req, res, staticCtx);
  });
}

/* ─────────────── запуск ─────────────── */

function start(): void {
  ensureClock();
  const host = getEnv("API_HOST") || "127.0.0.1";
  const port = getEnvNum("API_PORT") || 8790;
  const staticCtx = resolveStaticCtx();
  // Одна понятная строка, чтобы деплой видел причину «нет интерфейса», а не молчал.
  if (!staticCtx) console.error("[server] интерфейс не собран, отдаю только API");
  const server = createServerApp(staticCtx);

  // Служебный цикл раз в 60 с: в mock двигает виртуальные часы и пересчитывает
  // позиции (Free Riding, time-stop, liq-drain), в live — просто обновляет их.
  setInterval(() => {
    advance().catch((e) => console.error(`[server] цикл обслуживания: ${e instanceof Error ? e.message : e}`));
  }, 60_000).unref?.();

  // Периодический скан: скринер обязан искать сам, а не ждать, пока человек
  // откроет приложение и нажмёт кнопку — иначе за сутки не наберётся ни одной
  // находки, и будет казаться, что воронка не работает. Интервал из
  // SCAN_EVERY_MIN (минуты), 0 — выключить. Один скан одновременно гарантирует
  // runScan, поэтому наложение с кнопкой в приложении безопасно.
  const scanEveryMin = getEnvNum("SCAN_EVERY_MIN") ?? 20;
  if (scanEveryMin > 0) {
    setInterval(() => {
      runScan()
        .then((r) => console.error(`[server] плановый скан: найдено ${r.found}, отбраковка ${JSON.stringify(r.rejected_by_layer)}`))
        .catch((e) => console.error(`[server] плановый скан: ${e instanceof Error ? e.message : e}`));
    }, scanEveryMin * 60_000).unref?.();
  }

  server.listen(port, host, () => {
    const what = staticCtx ? "API и интерфейс" : "только API";
    console.error(`[server] демо-контур слушает http://${host}:${port} (${what}, режим ${readDataMode()})`);
  });
  server.on("error", (e) => {
    console.error(`[server] не удалось поднять сервер: ${e.message}`);
    process.exit(1);
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) start();
