/**
 * sources/net.ts — общий сетевой слой живого контура: кэш с TTL, ограничение
 * частоты по хосту, счётчик запросов на скан.
 *
 * Зачем отдельный модуль: публичные API (GeckoTerminal — около 30 запросов в
 * минуту) не терпят «шквала» запросов на каждый токен. Один кэш и один
 * планировщик частоты на всех источников — иначе каждый источник изобретал бы
 * свой, а лимит у них общий на IP.
 *
 * Сами запросы выполняет config.httpJson (таймаут 10 с, один повтор, маскировка
 * ключей в тексте ошибки). Здесь — только кэш, частота и бюджет.
 */
import { httpJson } from "../config.ts";

interface CacheEntry {
  exp: number;
  val: unknown;
}

const cache = new Map<string, CacheEntry>();
let requests = 0;

/** Полностью очистить кэш (тесты: изоляция прогонов). */
export function cacheClear(): void {
  cache.clear();
}

/** Сколько сетевых запросов реально ушло с последнего сброса. */
export function requestCount(): number {
  return requests;
}

/** Сбросить счётчик запросов (скан вызывает в начале). */
export function resetRequests(): void {
  requests = 0;
}

export interface NetOpts {
  /** TTL кэша в мс. 0 — без кэша (изменяемые данные, например доли холдеров). */
  ttlMs?: number;
  /** Минимальный интервал между запросами к одному хосту, мс. */
  minIntervalMs?: number;
  /** Ключ кэша; по умолчанию — URL. */
  cacheKey?: string;
  /** Дополнительные параметры запроса (method/headers/body). */
  init?: RequestInit;
}

const DEFAULT_MIN_INTERVAL = 150;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Очередь по хосту: запросы к одному хосту идут строго друг за другом с паузой. */
const lastAt = new Map<string, number>();
const chains = new Map<string, Promise<unknown>>();

async function rateLimit(host: string, minIntervalMs: number): Promise<void> {
  const prev = chains.get(host) ?? Promise.resolve();
  const run = prev.then(async () => {
    const wait = (lastAt.get(host) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(host, Date.now());
  });
  // Цепочка не должна «ломаться» ошибкой предыдущего запроса.
  chains.set(host, run.catch(() => undefined) as Promise<unknown>);
  await run;
}

/**
 * JSON-запрос с кэшем и ограничением частоты. Кэш отдаёт значение без обращения
 * к сети (в т.ч. повторный вызов в рамках TTL) — это и есть экономия запросов.
 */
export async function netJson<T>(url: string, opts: NetOpts = {}): Promise<T> {
  const ttl = opts.ttlMs ?? 0;
  const key = opts.cacheKey ?? url;
  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.val as T;
  }
  await rateLimit(hostOf(url), opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL);
  requests++;
  const val = await httpJson<T>(url, opts.init);
  if (ttl > 0) cache.set(key, { exp: Date.now() + ttl, val });
  return val;
}
