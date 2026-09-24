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

/**
 * Адрес API ЗАПОМИНАЕТСЯ. Приходит он параметром `?api=` от бота, но
 * приложение, запущенное с ярлыка, открывается по своему start_url — и если
 * адреса в нём не окажется, обращаться будет некуда, и человек увидит
 * демонстрацию вместо своего счёта. Именно так это и выглядело.
 *
 * Поэтому: параметр (он главнее — адрес тоннеля меняется) → запомненный →
 * заданный при сборке.
 */
const API_KEY = "prometey.api";

function readApi(): string {
  const fromUrl = (qs.get("api") || "").replace(/\/+$/, "");
  try {
    if (fromUrl) {
      localStorage.setItem(API_KEY, fromUrl);
      return fromUrl;
    }
    return (localStorage.getItem(API_KEY) || import.meta.env.VITE_API_BASE || "")
      .replace(/\/+$/, "");
  } catch {
    return fromUrl || (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
  }
}

export const API_BASE = readApi();
export const hasApi = Boolean(API_BASE);
/** Адрес взят из памяти, а не из ссылки: он мог протухнуть вместе с тоннелем. */
export const apiRemembered = Boolean(!qs.get("api") && API_BASE);

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

/** Откуда сделка. Два контура живут по разным правилам: у скринера сигнал —
 *  это уровень, живущий часами и закрывающийся ценой; у алгоса — состояние
 *  ленты, живущее минуты и закрывающееся тем, что состояние кончилось.
 *  Смешивать их результаты в одну статистику значит не измерить ни один. */
export type Source = "screener" | "algo" | "hunter";

/** Что показывать: «обычный режим» (скринер + контур охоты) или «алгос».
 *
 *  Разделение НЕ по числу контуров, а по СРАВНИМОСТИ. Сделка контура охоты
 *  живёт часами и закрывается ценой — её можно класть в один винрейт со
 *  сделкой скринера. Алгос закрывает сделку за минуты и не по цене, а потому
 *  что подпись погасла, и делает их кратно больше: в общей куче он переписывает
 *  собой винрейт, среднюю длительность и число сделок, и цифры перестают
 *  описывать хоть что-нибудь одно. */
export type Contour = "normal" | "algo";

export type ApiPosition = {
  id: string; symbol: string; side: "long" | "short"; lev: number;
  entry: number; mark: number; sl: number; slPlan: number;
  /** Ступени фиксации С ОТМЕТКОЙ «взята» и с ожиданием в деньгах по каждой.
   *  Считает всё СЕРВЕР: цена ступени сама по себе не отвечает на вопрос, с
   *  которым на неё смотрят, а пересчёт в деньги требует замороженной цены R —
   *  той самой, которую экран раньше брал из текущего стопа и получал ноль.
   *  `done: null` — биржа не ответила, то есть НЕИЗВЕСТНО, а не «не взята». */
  tp: number; tps: { price: number; weight: number; r: number; usd: number;
                     done: boolean | null }[];
  /** Сколько ступеней уже взято (null — неизвестно). У открытой позиции это
   *  единственный способ узнать, что первая цель отработала: `tp_hits` в
   *  журнале появляется только при закрытии. */
  hits: number | null;
  /** ЦЕНА ОДНОГО R, замороженная в момент филла. Перенос стопа в безубыток
   *  затирает `sl`, и считать R из него — значит делить на ноль. */
  rDist: number;
  openSize: number; sizeLeft: number; doneShare: number;
  /** Реализованное ступенями и ход остатка — РАЗДЕЛЬНО. Их сумма (`r`/`usd`)
   *  помечена как состояние «сейчас»: сложив зафиксированную прибыль с
   *  нереализованным ходом молча, мы выдали бы состояние за итог. */
  rDone: number; usdDone: number; rOpen: number; usdOpen: number;
  r: number; usd: number;
  be: number | null; beMoved: boolean;
  size: number; risk: number; openedAt: number; scheme: string;
  /** Размер В ДОЛЛАРАХ по текущей цене и замороженная маржа. `marginFrom`
   *  говорит, маржа с биржи или посчитана нами: в биржевую входит комиссия
   *  закрытия, и наш расчёт её занижает — выдавать оценку за факт нельзя. */
  notional: number; margin: number; marginFrom: string;
  status: "pending" | "open"; entryType: "market" | "limit";
  score: number; whale: boolean; upl?: number;
  /** Контур сделки: `hunter` — собственный отбор монет автотрейда, `algo` —
   *  чтение тиковой ленты, `screener` — сигнал воронки скринера (таких сделок
   *  система больше не открывает). Поле может не прийти со старого бота —
   *  тогда это скринер, а не «неизвестно». */
  source?: Source;
  /** ПО КАКОМУ СЦЕНАРИЮ вошли. Сторона и монета отвечают «что и куда», а
   *  сценарий — «почему мы здесь»: пять сетапов контура ведутся по-разному и
   *  закрываются по разным причинам. */
  scenario?: string;
};

export type ApiTrade = {
  id: string; symbol: string; side: "long" | "short";
  entry: number; exit: number; pnl: number; r: number;
  reason: string; reasonRu?: string; closedAt: number; heldMin: number; fee: number;
  mfe: number; mae: number; scenario: string; score: number; whale: boolean;
  entryType: "market" | "limit"; lev: number; risk: number; hits: number | null;
  source?: Source;
};

export type ApiMe = {
  id: number; name: string; username: string;
  role: "user" | "admin"; status: string;
  email: string; phone: string;
  /** Номер подтверждён САМИМ Telegram. Введённый в форме не считается: по
   *  номеру выдаются права администратора. */
  phoneOk: boolean;
  /** С какого момента показывать историю сделок. */
  sinceAt: number | null;
  api: { connected: boolean; tail: string; linkedAt: number | null };
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
export const getTrades = (days = 0, contour: Contour = "normal", s?: AbortSignal) =>
  get<{ trades: ApiTrade[]; mode: string; source: Contour }>(
    `/api/trades?days=${days}&limit=500&source=${contour}`, s);

export type ApiSignal = {
  id: string; symbol: string; side: "long" | "short"; score: number; whale: boolean;
  at: number; status: string; entryType: "market" | "limit"; source?: Source;
  pnl: number | null; r: number | null;
};
export const getSignals = (contour: Contour = "normal", s?: AbortSignal) =>
  get<{ signals: ApiSignal[]; mode: string; source: Contour }>(
    `/api/signals?source=${contour}`, s);

/* ── Дашборд по сценариям ──────────────────────────────────────────────────
   СПИСОК СЦЕНАРИЕВ И ИХ ИМЕНА ПРИХОДЯТ С СЕРВЕРА, а не лежат здесь. Свой
   перечень s1..s7 во фронте отставал бы ровно на один релиз: s6 и s7 завелись
   24.09.2026, и экран молча не показывал бы их до следующей сборки. Тот же
   урок уже оплачен именем причины закрытия — его тоже считает сервер.

   `pct` — доходность в процентах от капитала НА НАЧАЛО ОКНА (`base`), а не от
   сегодняшнего: иначе один и тот же набор сделок показывал бы разный процент
   при каждом заходе. Базы нет — приходит `null`, и рисовать вместо него ноль
   нельзя: ноль означал бы «заработали ноль процентов».

   `winrate` НИКОГДА не показываем один. Рядом обязаны стоять средние и
   винрейт безубыточности: 35% при выигрыше +1.5R прибыльны, а при +0.42R
   против −1.01R для нуля нужно 70%. ── */
export type ApiScenario = {
  key: string; ru: string; on: boolean | null;
  n: number; wins: number; winrate: number | null;
  usd: number; pct: number | null; r: number;
  avgUsd: number | null; avgWinR: number | null; avgLossR: number | null;
  needWinrate: number | null; openN: number;
};
export type ApiScenarios = {
  scenarios: ApiScenario[];
  total: { n: number; wins: number; usd: number; r: number; openN: number;
           winrate: number | null; pct: number | null };
  mode: string; source: Contour; days: number; base: number; baseFrom: string;
};
/** `fromMs` — ТА ЖЕ отметка, по которой экран отобрал свои сделки. Период тут
 *  режется по локальной полуночи пояса отчётности, а не «минус N×24ч»; передай
 *  мы серверу число дней, он посчитал бы другое окно, и карточка описывала бы
 *  не тот период, что список под ней. 0 — «всё время». */
export const getScenarios = (fromMs = 0, contour: Contour = "normal", s?: AbortSignal) =>
  get<ApiScenarios>(`/api/scenarios?from=${Math.round(fromMs)}&source=${contour}`, s);

export type ApiPayment = {
  id: string; at: number; kind: string; amount: number; note: string; status: string;
};
export const getPayments = (s?: AbortSignal) =>
  get<{ payments: ApiPayment[] }>("/api/payments", s);

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

/** Перенести цену НЕИСПОЛНЕННОЙ лимитки. Размер на сервере пересчитывается:
 *  риск — якорь системы, и перенос входа ближе к стопу иначе молча уменьшил бы
 *  риск сделки при неизменной надписи. */
export const moveEntry = (id: string, entry: number) =>
  post<{ ok: boolean; message: string }>("/api/position/entry", { id, entry });

export const closeAll = () =>
  post<{ closed: number; failed: number }>("/api/positions/close_all", {});

export const putProfile = (email: string, phone: string) =>
  post<ApiMe>("/api/profile", { email, phone });

export const topUp = (amount: number) => post<ApiMe>("/api/billing/topup", { amount });

/** Выдать билет для веб-версии. Работает ТОЛЬКО изнутри Telegram: сервер
 *  требует свежую подпись, иначе утёкшая ссылка продлевала бы себя вечно. */
export const newSession = () => post<{ token: string; ttlDays: number }>("/api/session", {});

/**
 * Ссылка на это же приложение для браузера. Несёт ТОЛЬКО адрес бота.
 *
 * Ключ доступа в ссылку больше не кладётся: ссылка живёт в истории браузера,
 * в закладке, в ярлыке и на скриншотах, а вход человек и так подтвердит сам —
 * номером и кодом из Telegram. Подсмотренная ссылка после этого не даёт
 * ничего, кроме адреса.
 */
export function webLink(): string {
  const u = new URL(location.href);
  u.searchParams.delete("t");
  if (API_BASE) u.searchParams.set("api", API_BASE);
  u.hash = "";
  return u.toString();
}

/**
 * Живо ли API и как зовут бота.
 *
 * Без авторизации — и это единственно возможно: имя бота нужно РОВНО тем, кто
 * войти ещё не может, чтобы знать, где регистрироваться. Подтвердить номер
 * умеет только Telegram, значит без имени бота путь регистрации обрывается.
 */
export const getHealth = () =>
  fetch(API_BASE + "/api/health", { signal: AbortSignal.timeout(8000) })
    .then((r) => r.json() as Promise<{ ok: boolean; bot?: string }>);

/** Привязать ключи биржи в конце онбординга. Секрета мы не передаём и не
 *  получаем: бот торгует ключами из своего .env, а нам нужен только факт
 *  привязки и хвост ключа для показа. */
export const linkKeys = () => post<ApiMe>("/api/keys/link", {});

/* ── Вход в веб-версию по номеру и коду ─────────────────────────────────────
   Так же, как вход куда угодно ещё: номер → код в Telegram → готово. Ключ
   доступа при этом НЕ ездит в ссылке: ярлык несёт только адрес бота, а право
   на счёт человек подтверждает сам, уже в приложении. Подсмотренная ссылка
   больше ничего не даёт. */

export const authRequest = (phone: string) =>
  post<{ sent: boolean }>("/api/auth/request", { phone });

export const authConfirm = (phone: string, code: string) =>
  post<{ token: string; ttlDays: number }>("/api/auth/confirm", { phone, code });

/** Сохранить выданный билет. Дальше нужна перезагрузка: адрес и билет
 *  читаются один раз при старте. */
export function saveSession(token: string) {
  try { localStorage.setItem(SESSION_KEY, token); } catch { /* приватное окно */ }
}

/** Задать адрес бота вручную — на случай, когда ярлык открыт без него. */
export function saveApi(url: string) {
  const clean = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(clean)) throw new Error("адрес должен начинаться с https://");
  localStorage.setItem(API_KEY, clean);
}

/* ── Код подключения ─────────────────────────────────────────────────────────
   Ссылка с параметрами переживает ровно один переход: встроенный браузер
   Telegram, Safari и приложение с рабочего стола — это ТРИ РАЗНЫХ хранилища.
   Открыв ссылку в одном, во втором человек снова оказывается ни с чем. Код же
   переносится куда угодно — скопировал и вставил. Внутри тот же адрес API и
   тот же билет. */

export type Connected = { api: string; token: string };

/** Разобрать код. Бросает с человеческой причиной: «код неверный» без
 *  объяснения заставляет гадать, тот ли код вообще скопирован. */
export function parseCode(raw: string): Connected {
  const code = raw.trim().replace(/\s+/g, "");
  if (!code) throw new Error("пустая строка");
  if (!code.startsWith("PR1-")) throw new Error("это не код подключения — он начинается с PR1-");
  let json: string;
  try {
    const b = code.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    json = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  } catch {
    throw new Error("код повреждён — скопируйте его целиком");
  }
  let data: { a?: string; t?: string };
  try { data = JSON.parse(json); } catch { throw new Error("код повреждён"); }
  const api = (data.a || "").replace(/\/+$/, "");
  if (!api.startsWith("https://") && !api.startsWith("http://"))
    throw new Error("в коде нет адреса бота");
  if (!data.t) throw new Error("в коде нет ключа доступа");
  return { api, token: data.t };
}

/** Применить код: сохранить адрес и билет. Дальше нужна перезагрузка — адрес
 *  API читается один раз при старте, и половина приложения уже живёт с ним. */
export function applyCode(c: Connected) {
  localStorage.setItem(API_KEY, c.api);
  localStorage.setItem(SESSION_KEY, c.token);
}

/** Забыть подключение (выход из веб-версии). */
export function forgetConnection() {
  try {
    localStorage.removeItem(API_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch { /* приватное окно */ }
}

/* ── Уведомления ────────────────────────────────────────────────────────────
   Ключ отдаётся БЕЗ авторизации: это публичная половина пары VAPID, она и
   существует для того, чтобы её знал браузер. Сама подписка — уже под
   билетом: она привязывается к счёту, и чужое устройство подписывать на наши
   закрытия сделок нельзя. */
export const pushKey = () =>
  fetch(API_BASE + "/api/push/key", { signal: AbortSignal.timeout(8000) })
    .then((r) => r.json() as Promise<{ key?: string }>)
    .then((j) => j.key || "");

export const pushSubscribe = (sub: unknown, kinds: Record<string, boolean>) =>
  post<{ ok: boolean }>("/api/push/subscribe", { sub, kinds });
