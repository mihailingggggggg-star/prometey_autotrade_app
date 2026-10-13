/**
 * config.ts — окружение демо-контура: чтение/запись .env и мелкие общие утилиты.
 *
 * Почему свой парсер .env, а не dotenv: сервер запускается на «голом» Node и
 * новых зависимостей мы не добавляем. Формат KEY=VALUE читается за несколько строк.
 *
 * Почему это общий модуль утилит, а не только про .env: файл импортируют все
 * слои сервера, поэтому сюда же вынесены ApiError и httpJson — иначе пришлось
 * бы завести ещё один файл, которого нет в плане (§1).
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { DataMode } from "../shared/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Корень репозитория (server/ лежит прямо в нём). */
export const REPO_ROOT = resolve(HERE, "..");

/** Каталог рабочих данных демо-контура (в .gitignore, создаётся в рантайме). */
export function dataDir(): string {
  return join(REPO_ROOT, "data");
}

/**
 * Путь к .env. Переменная ENV_PATH нужна тестам: они не должны трогать рабочий
 * файл с реальными ключами.
 */
export function envPath(): string {
  return process.env.ENV_PATH ? resolve(process.env.ENV_PATH) : join(REPO_ROOT, ".env");
}

/** Дефолты — ровно как в .env.example. */
export const ENV_DEFAULTS: Record<string, string> = {
  DATA_MODE: "mock",
  API_HOST: "127.0.0.1",
  API_PORT: "8790",
  // Как часто скринер ищет сигналы сам, минуты (0 — только по кнопке).
  SCAN_EVERY_MIN: "20",
  DB_PATH: "./data/demo.db",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  HELIUS_API_KEY: "",
  GEMINI_API_KEY: "",
  // Медиаслой (Apify): сбор упоминаний токена в X. Имена и дефолты — ровно как в
  // .env.example (файл не правим). Без APIFY_TOKEN медиаслой честно выключен.
  APIFY_TOKEN: "",
  APIFY_TWEET_ACTOR: "apidojo~tweet-scraper",
  APIFY_MAX_ITEMS: "50",
  APIFY_TIMEOUT_SEC: "180",
  APIFY_DAILY_ITEMS: "1000",
  MEDIA_TTL_MIN: "30",
  WALLET_SECRET: "",
  DEMO_START_BALANCE: "500",
  DEMO_MONTHLY_DEPOSIT: "500",
  // Ключ доступа к API. Пусто — контур открыт (локальная разработка). Задан —
  // все /api/* (кроме /api/health) требуют заголовок X-Api-Token.
  API_TOKEN: "",
};

/** Прочитать .env как словарь. Некуда деться — читаем каждый раз, файл крошечный. */
export function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = envPath();
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    // Снимаем обрамляющие кавычки: иначе они попали бы в значение ключа.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Значение ключа по приоритету: переменная окружения → файл .env → дефолт.
 * Окружение важнее файла: так тесты и dev-скрипты переопределяют пути,
 * не редактируя рабочий .env.
 */
export function getEnv(key: string): string {
  if (process.env[key] !== undefined) return process.env[key] as string;
  const file = readEnvFile();
  if (file[key] !== undefined) return file[key];
  return ENV_DEFAULTS[key] ?? "";
}

export function getEnvNum(key: string): number {
  const n = Number(getEnv(key));
  return Number.isFinite(n) ? n : Number(ENV_DEFAULTS[key] ?? 0);
}

/** DATA_MODE: всё, кроме явного "live", считаем mock — безопасный дефолт. */
export function readDataMode(): DataMode {
  return getEnv("DATA_MODE").trim().toLowerCase() === "live" ? "live" : "mock";
}

/**
 * Записать один или несколько ключей в .env, не потеряв остальные строки
 * (в том числе комментарии и порядок). Файл всегда получает chmod 600:
 * в нём лежат ключи внешних сервисов и зашифрованный секрет кошелька.
 */
export function writeEnvKeys(entries: Record<string, string>): void {
  // Значение .env — ровно одна строка. Перевод строки разорвал бы запись и
  // породил мусорную переменную, а обрамляющие пробелы попали бы в значение
  // ключа. Такие значения не «чиним» молча, а отвергаем с понятной ошибкой.
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    const s = String(v).trim();
    if (/[\r\n]/.test(s)) {
      throw new ApiError("invalid_env_value", 400, `значение ${k} содержит перевод строки`);
    }
    clean[k] = s;
  }

  const p = envPath();
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  const replaced = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith("#")) {
      const eq = t.indexOf("=");
      if (eq >= 0) {
        const key = t.slice(0, eq).trim();
        if (Object.prototype.hasOwnProperty.call(clean, key)) {
          out.push(`${key}=${clean[key]}`);
          replaced.add(key);
          continue;
        }
      }
    }
    out.push(line);
  }
  for (const [k, v] of Object.entries(clean)) {
    if (!replaced.has(k)) out.push(`${k}=${v}`);
  }
  while (out.length && out[out.length - 1] === "") out.pop();

  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, out.join("\n") + "\n", { mode: 0o600 });
  // mode у writeFileSync не меняет права уже существующего файла — доводим явно.
  chmodSync(p, 0o600);
}

/** Ошибка уровня HTTP: код и статус кладутся в тело ответа (§4 плана). */
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Убрать ЗНАЧЕНИЯ query-параметров из URL: ключи источников (Helius, Gemini)
 * едут в строке запроса, и в тексте ошибки их быть не должно. Имена параметров
 * оставляем — по ним видно, что за запрос упал.
 */
export function redactUrl(raw: string): string {
  const qi = raw.indexOf("?");
  if (qi < 0) return raw;
  const head = raw.slice(0, qi);
  const query = raw
    .slice(qi + 1)
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq < 0 ? part : `${part.slice(0, eq)}=***`;
    })
    .join("&");
  return `${head}?${query}`;
}

/** Базовая пауза перед повтором после HTTP 429: даём лимиту частоты (Gecko ~30/мин) остыть. */
export const RETRY_429_PAUSE_MS = 3000;
/**
 * Сколько раз повторяем запрос после HTTP 429 (сверх первой попытки). Пауза
 * НАРАСТАЁТ кратно номеру повтора (3 с, затем 6 с) — частый троттл-ответ
 * публичного API разъезжается во времени, и второй повтор успевает пройти.
 */
export const RETRY_429_MAX = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET/POST с JSON-ответом: таймаут 10 с (AbortController), один ретрай.
 * Живёт здесь, потому что все live-источники используют ровно эту обёртку.
 *
 * Особый случай — HTTP 429 (превышен лимит частоты публичного API): выжидаем
 * НАРАСТАЮЩУЮ паузу и пробуем ещё раз (до RETRY_429_MAX повторов), а не отдаём
 * ошибку сразу. Иначе один троттл-ответ «уронил» бы источник, а вместе с ним —
 * весь скан (в свечах это выглядело бы как «нет данных» на отдельном ТФ).
 */
export async function httpJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  let lastErr: unknown;
  let retries429 = 0; // повторы после HTTP 429 (нарастающая пауза)
  let retriedErr = false; // один повтор на прочие ошибки (таймаут/сеть)
  for (;;) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    let rateLimited = false;
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { accept: "application/json", ...(init.headers ?? {}) },
      });
      if (res.status === 429) {
        if (retries429 < RETRY_429_MAX) {
          // Лимит частоты: выжидаем с НАРАСТАЮЩЕЙ паузой (3 с, затем 6 с) и повторяем.
          await sleep(RETRY_429_PAUSE_MS * (retries429 + 1));
          retries429++;
          continue;
        }
        // Повторы исчерпаны — отдаём ошибку и НЕ делаем для неё «прочий» повтор.
        rateLimited = true;
        throw new Error(`HTTP 429 ${res.statusText}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      // Таймаут абортнулся — повторим один раз; прочие ошибки тоже ретраим,
      // но не более одного раза, чтобы скан не висел. Для 429 повтор уже свой.
      if (!rateLimited && !retriedErr) {
        retriedErr = true;
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  // redactUrl: секрет может ехать в query — в текст ошибки он не попадёт.
  throw new ApiError("source_unavailable", 502, `источник не ответил: ${redactUrl(url)} — ${String(lastErr)}`);
}
