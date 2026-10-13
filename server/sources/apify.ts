/**
 * sources/apify.ts — МЕДИАСЛОЙ (live): упоминания токена в X через Apify-актор.
 *
 * Почему Apify: готовый сборщик берёт на себя аккаунты и прокси, своих аккаунтов
 * X держать не нужно. Актор `apidojo~tweet-scraper` стоит ~$0.40 за 1000
 * публикаций, поэтому:
 *   • опрашиваем ТОЛЬКО монеты, дошедшие до сигналов (а не всю вселенную);
 *   • собранные упоминания считаются свежими MEDIA_TTL_MIN минут — за ними
 *     повторно не ходим;
 *   • держим СУТОЧНЫЙ бюджет публикаций (APIFY_DAILY_ITEMS): исчерпали — актор
 *     не запускаем, пишем понятную причину и НЕ ломаем скан.
 *
 * Приложение читает кэш из SQLite (таблицы mentions/media_status): падение Apify
 * или отсутствие ключа не ломают скринер — слой 5 просто честно «нет данных» и
 * сигнал НЕ блокирует.
 *
 * Оценка упоминаний:
 *   • тональность — лексикон (русский + английский), метод помечен;
 *   • органичность — эвристики по данным (уникальные авторы, доля повторов
 *     текста, разброс времени);
 *   • если задан GEMINI_API_KEY — модель даёт тональность + органичность + резюме
 *     (источник помечается), без ключа работает лексикон.
 */
import { getDb, metaGet, metaSet, nowSec, audit } from "../db.ts";
import { getEnv, getEnvNum, ApiError, redactUrl } from "../config.ts";
import { geminiMentionsAssessment } from "./gemini.ts";
import type { SourceRef, SocialData } from "./mock.ts";

/**
 * Порог упоминаний за 24ч для слоя 5 (константа, решение владельца от 12.10.2026):
 * если медиаслой доступен и упоминаний меньше — интереса нет, сигнал не создаём.
 * При отсутствии ключа/данных проверка не блокирует (см. screener, слой 5).
 */
export const MIN_MENTIONS_24H = 5;

/** Секунд в сутках — окно «свежести» упоминания. */
const DAY_S = 86_400;
/** Источник упоминания (пока только X). */
const SOURCE_X = "x";

/** Нормализованное упоминание — единый вид для БД, оценки и слоя 5. */
export interface Mention {
  ts: number;
  source: string;
  author: string;
  text: string;
  url: string;
  likes: number;
  retweets: number;
  replies: number;
  lang: string;
}

/** Результат сбора медиаслоя для монеты. */
export interface MediaResult {
  mentions: Mention[];
  /** true — данные реально получены (из свежего кэша или от актора). */
  available: boolean;
  /** Человекочитаемая причина/итог (для чека слоя 5 и лога). */
  note: string;
  source: "cache" | "apify" | "none";
}

/* ─────────────── служебное ─────────────── */

/** Настроен ли медиаслой (есть токен Apify). */
export function apifyConfigured(): boolean {
  return getEnv("APIFY_TOKEN").trim().length > 0;
}

/** Сутки UTC в виде YYYY-MM-DD — ключ суточного бюджета. */
function dayKey(atSec = nowSec()): string {
  return new Date(atSec * 1000).toISOString().slice(0, 10);
}

/** Сколько публикаций уже собрано за сутки (UTC). */
function spentToday(atSec = nowSec()): number {
  const n = Number(metaGet(`apify:spent:${dayKey(atSec)}`) ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function addSpent(items: number, atSec = nowSec()): void {
  if (items <= 0) return;
  const key = `apify:spent:${dayKey(atSec)}`;
  metaSet(key, String(spentToday(atSec) + items));
}

/** Небольшой стабильный хэш FNV-1a — для суррогатного идентификатора упоминания. */
function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/* ─────────────── доступ к БД ─────────────── */

interface StatusRow {
  updated_ts: number;
  items: number;
  note: string;
}

function statusRow(mint: string, source: string): StatusRow | null {
  const r = getDb()
    .prepare("SELECT updated_ts, items, note FROM media_status WHERE mint=? AND source=?")
    .get(mint, source) as StatusRow | undefined;
  return r ?? null;
}

function setStatus(mint: string, source: string, ts: number, items: number, note: string): void {
  getDb()
    .prepare(
      "INSERT INTO media_status(mint,source,updated_ts,items,note) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(mint,source) DO UPDATE SET updated_ts=excluded.updated_ts, items=excluded.items, note=excluded.note",
    )
    .run(mint, source, ts, items, note);
}

/** Сохранить упоминания с дедупом по (mint,url) — повторный сбор не даёт дубля. */
function storeMentions(mint: string, mentions: Mention[]): void {
  const ins = getDb().prepare(
    "INSERT OR IGNORE INTO mentions(mint,ts,source,author,text,url,likes,retweets,replies,lang) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  for (const m of mentions) {
    ins.run(mint, m.ts, m.source, m.author, m.text, m.url, m.likes, m.retweets, m.replies, m.lang);
  }
}

interface MentionRow {
  ts: number;
  source: string;
  author: string;
  text: string;
  url: string;
  likes: number;
  retweets: number;
  replies: number;
  lang: string;
}

/** Упоминания монеты из кэша (без сети), свежие первыми. */
export function cachedMentions(mint: string, limit = 50): Mention[] {
  const rows = getDb()
    .prepare(
      "SELECT ts,source,author,text,url,likes,retweets,replies,lang FROM mentions " +
        "WHERE mint=? ORDER BY ts DESC, id DESC LIMIT ?",
    )
    .all(mint, limit) as unknown as MentionRow[];
  return rows.map((r) => ({ ...r, source: r.source || SOURCE_X }));
}

/**
 * Упоминания из кэша в форме клиента (src ожидает {ts,source,title,url,score}).
 * Тональность одного упоминания считается лексиконом на месте — отдельной
 * колонки для неё нет.
 */
export function cachedSocialMentions(
  mint: string,
  limit = 20,
): { ts: number; source: string; title: string; url: string; score: number }[] {
  return cachedMentions(mint, limit).map((m) => ({
    ts: m.ts,
    source: m.source,
    title: m.text.slice(0, 160),
    url: m.url,
    score: lexiconScore(m.text),
  }));
}

/* ─────────────── разбор ответа актора ─────────────── */

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function numField(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** Время упоминания в секундах UTC. Числа в мс приводим к секундам. */
function toSec(v: unknown, fallbackSec: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return fallbackSec;
}

/** Автор упоминания — имя поля у разных акторов называется по-разному. */
function authorOf(o: Record<string, unknown>): string {
  const nested = (o.author ?? o.user ?? o.userInfo ?? o.legacy ?? {}) as Record<string, unknown>;
  const nestedUser = (nested.user ?? {}) as Record<string, unknown>;
  const cands = [
    nested.userName,
    nested.username,
    nested.screen_name,
    nested.handle,
    nested.name,
    nestedUser.screen_name,
    nestedUser.name,
    o.username,
    o.userName,
    o.screenName,
    o.authorName,
    o.handle,
  ];
  for (const c of cands) if (typeof c === "string" && c.trim()) return c.trim();
  return "";
}

/**
 * Разбор элементов датасета актора в нормализованные упоминания. Поля у разных
 * акторов называются по-разному — перебираем несколько вариантов имён. Мусор
 * (без текста) пропускаем, а не «дочиняем» выдумкой.
 */
export function parseItems(raw: unknown[], now = nowSec()): Mention[] {
  const out: Mention[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = String(pick(o, ["text", "full_text", "fullText", "tweetText", "content", "body"]) ?? "").trim();
    if (!text) continue; // мусор без текста не храним
    const id = pick(o, ["id", "id_str", "tweetId", "rest_id"]);
    let url = String(pick(o, ["url", "twitterUrl", "link", "permalink", "tweetUrl"]) ?? "").trim();
    const ts = toSec(pick(o, ["createdAt", "created_at", "time", "timestamp", "date", "tweetedAt"]), now);
    if (!url && id !== undefined) url = `https://x.com/i/web/status/${String(id)}`;
    if (!url) {
      // Устойчивый суррогат идентификатора: дедуп по (mint,url) должен работать
      // даже у актора, который не отдал ни ссылку, ни id.
      url = `x://${authorOf(o) || "?"}/${ts}/${hash(text)}`;
    }
    out.push({
      ts,
      source: SOURCE_X,
      author: authorOf(o),
      text,
      url,
      likes: numField(pick(o, ["likeCount", "favoriteCount", "likes", "likesCount", "favorite_count", "like_count"])),
      retweets: numField(pick(o, ["retweetCount", "retweets", "retweet_count", "reposts"])),
      replies: numField(pick(o, ["replyCount", "replies", "reply_count"])),
      lang: String(pick(o, ["lang", "language", "tweetLanguage"]) ?? ""),
    });
  }
  return out;
}

/* ─────────────── запуск актора ─────────────── */

/**
 * Синхронный запуск актора: POST .../run-sync-get-dataset-items. Таймаут —
 * APIFY_TIMEOUT_SEC (актор собирает публикации небыстро; config.httpJson с его
 * 10 с здесь не подходит). Один повтор при СЕТЕВОЙ ошибке/таймауте; HTTP-отказ
 * (401/402/…) не повторяем — ключ/кредит сам не «починится».
 */
async function runActor(searchTerms: string[], maxItems: number): Promise<unknown[]> {
  const token = getEnv("APIFY_TOKEN").trim();
  const actor = getEnv("APIFY_TWEET_ACTOR").trim() || "apidojo~tweet-scraper";
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const timeoutMs = Math.max(1, getEnvNum("APIFY_TIMEOUT_SEC") || 180) * 1000;
  const body = JSON.stringify({ searchTerms, maxItems, sort: "Latest" });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        signal: ctl.signal,
      });
      if (res.status === 401 || res.status === 403) throw new ApiError("apify_auth", 401, "Apify отклонил ключ (401/403)");
      if (res.status === 402) throw new ApiError("apify_credit", 402, "Apify: исчерпан кредит аккаунта");
      if (!res.ok) throw new ApiError("apify_http", 502, `Apify вернул HTTP ${res.status}`);
      const data: unknown = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      // HTTP-отказ не повторяем; повторяем только сетевой сбой/таймаут.
      if (e instanceof ApiError) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ApiError("source_unavailable", 502, `Apify не ответил: ${redactUrl(url)} — ${String(lastErr)}`);
}

/* ─────────────── сбор с бюджетом и кэшем ─────────────── */

function searchTerms(ref: SourceRef): string[] {
  const sym = (ref.symbol || "").trim();
  const terms = new Set<string>();
  if (sym) {
    terms.add(`$${sym}`);
    terms.add(sym);
  }
  if (terms.size === 0) terms.add(ref.token_addr);
  return [...terms];
}

/**
 * Данные медиаслоя для монеты. Порядок:
 *  1) свежий кэш (в пределах MEDIA_TTL_MIN) → отдаём без сети;
 *  2) нет ключа Apify → честное «нет ключа» (не блокирует слой 5);
 *  3) суточный бюджет исчерпан → актор не запускаем, понятная причина;
 *  4) запуск актора; успех и провал фиксируем в media_status (items=-1 — провал),
 *     чтобы не долбить API на каждом сигнале и видеть состояние.
 */
export async function getMedia(ref: SourceRef, now = nowSec()): Promise<MediaResult> {
  const mint = ref.token_addr;
  const ttlSec = Math.max(0, getEnvNum("MEDIA_TTL_MIN")) * 60;
  const st = statusRow(mint, SOURCE_X);

  if (st && ttlSec > 0 && now - st.updated_ts <= ttlSec) {
    const cached = cachedMentions(mint, now);
    if (st.items < 0) return { mentions: cached, available: false, note: st.note || "данных нет", source: "none" };
    return { mentions: cached, available: true, note: st.note || "из кэша", source: "cache" };
  }

  if (!apifyConfigured()) {
    return { mentions: cachedMentions(mint, now), available: false, note: "нет ключа Apify", source: "none" };
  }

  const daily = Math.max(0, getEnvNum("APIFY_DAILY_ITEMS"));
  const spent = spentToday(now);
  if (daily > 0 && spent >= daily) {
    const note = `бюджет Apify исчерпан (${spent}/${daily} публикаций за сутки)`;
    console.error(`[media] ${note} — актор не запускаю (${ref.symbol})`);
    return { mentions: cachedMentions(mint, now), available: false, note, source: "none" };
  }

  const perRun = Math.max(0, getEnvNum("APIFY_MAX_ITEMS")) || 50;
  const want = daily > 0 ? Math.max(1, Math.min(perRun, daily - spent)) : perRun;

  try {
    const items = await runActor(searchTerms(ref), want);
    const mentions = parseItems(items, now);
    // Актор умеет отвечать «нет результатов» массивом заглушек (по 10 строк вида
    // {noResults: …}) — и раньше мы считали их собранными публикациями: в журнал
    // попадало «собрано 10», бюджет списывался, а список упоминаний оставался
    // пустым. Из-за этого слой 5 судил об органичности по пустоте и отбраковывал
    // кандидатов ложно. Заглушки — это ОТСУТСТВИЕ данных, а не ноль упоминаний.
    const hasData = mentions.length > 0;
    storeMentions(mint, mentions);
    // Платим за реально собранные публикации (заглушки бесплатны и не считаются).
    addSpent(hasData ? Math.min(mentions.length, want) : 0, now);
    const note = hasData
      ? `собрано ${mentions.length} публикаций`
      : "источник ничего не вернул (нет результатов) — данных о соцсетях нет";
    setStatus(mint, SOURCE_X, now, hasData ? mentions.length : -1, note);
    audit("media.collect", { mint, symbol: ref.symbol, items: mentions.length, spent: spentToday(now) }, "media");
    return { mentions, available: hasData, note, source: hasData ? "apify" : "none" };
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    // Честное состояние: фиксируем причину (items=-1 → «не данные»), скан не падает.
    setStatus(mint, SOURCE_X, now, -1, note);
    console.error(`[media] Apify недоступен для ${ref.symbol}: ${note}`);
    return { mentions: cachedMentions(mint, now), available: false, note, source: "none" };
  }
}

/* ─────────────── оценка упоминаний ─────────────── */

/** Лексикон тональности (русский + английский). Метод — словарный, не модель. */
const POS_WORDS = [
  "рост",
  "бычий",
  "прорыв",
  "накоплен",
  "вверх",
  "луна",
  "потенциал",
  "сильн",
  "поддержк",
  "закуп",
  "bull",
  "moon",
  "pump",
  "breakout",
  "accumul",
  "gem",
  "strong",
  "buy",
  "upside",
  "rally",
  "surge",
  "gain",
  "hodl",
];
const NEG_WORDS = [
  "паден",
  "слив",
  "скам",
  "обман",
  "дамп",
  "вниз",
  "провал",
  "шорт",
  "риск",
  "потер",
  "bear",
  "dump",
  "scam",
  "rug",
  "sell",
  "short",
  "crash",
  "loss",
  "ponzi",
  "fud",
];

/** Тональность одного текста, 0..10 (5 — нейтрально). Метод — лексикон. */
export function lexiconScore(text: string): number {
  const t = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const w of POS_WORDS) if (t.includes(w)) pos++;
  for (const w of NEG_WORDS) if (t.includes(w)) neg++;
  return Math.round(Math.min(10, Math.max(0, 5 + (pos - neg))));
}

/** Средняя тональность по упоминаниям (0..10). Нет упоминаний — 0 (нет сигнала). */
export function lexiconSentiment(mentions: Mention[]): number {
  if (mentions.length === 0) return 0;
  const sum = mentions.reduce((a, m) => a + lexiconScore(m.text), 0);
  return Math.round((sum / mentions.length) * 10) / 10;
}

export interface OrganicHeuristics {
  is_organic: boolean;
  score: number;
  /** Число уникальных авторов. */
  authors: number;
  /** Доля повторяющихся текстов (в т.ч. репосты — нормализованное упоминание их
   *  не отличает: флага репоста у всех акторов нет). */
  dup_ratio: number;
  /** Разброс времени публикаций, часы. */
  span_hours: number;
}

/**
 * Органичность по данным: уникальные авторы, доля повторов текста, разброс
 * времени. Накрутка — один автор с пачкой одинаковых текстов. Эвристика
 * (помечается как таковая), не истина.
 */
export function heuristicsOrganic(mentions: Mention[]): OrganicHeuristics {
  const n = mentions.length;
  if (n === 0) return { is_organic: false, score: 0, authors: 0, dup_ratio: 0, span_hours: 0 };
  const authors = new Set(mentions.map((m) => m.author).filter(Boolean));
  const norm = mentions.map((m) => m.text.toLowerCase().replace(/\s+/g, " ").trim());
  const dupRatio = 1 - new Set(norm).size / n;
  const ts = mentions.map((m) => m.ts);
  const spanHours = (Math.max(...ts) - Math.min(...ts)) / 3600;
  const authorRatio = authors.size / n;
  const organic = !(authors.size <= 1 && n >= 5) && dupRatio < 0.5 && authorRatio >= 0.3;
  const raw = (authorRatio * 0.6 + (1 - dupRatio) * 0.4) * 100;
  return {
    is_organic: organic,
    score: Math.round(organic ? raw : Math.min(25, raw)),
    authors: authors.size,
    dup_ratio: Math.round(dupRatio * 100) / 100,
    span_hours: Math.round(spanHours * 10) / 10,
  };
}

function factualSummary(mentions24: Mention[], all: Mention[], heur: OrganicHeuristics): string {
  if (all.length === 0) return "";
  const span = heur.span_hours >= 1 ? `, разброс ~${Math.round(heur.span_hours)} ч` : "";
  return `${all.length} упоминаний в X (за 24ч — ${mentions24.length}); ${heur.authors} разных авторов${span}.`;
}

/**
 * Оценка соцсети для слоя 5: медиаслой (Apify) → тональность/органичность/резюме.
 * С GEMINI_API_KEY оценку даёт модель (источник помечается), иначе — лексикон и
 * эвристики. Нет данных медиаслоя — llm_unavailable (слой 5 не блокирует).
 */
export async function assessSocial(ref: SourceRef, now = nowSec()): Promise<SocialData> {
  const media = await getMedia(ref, now);
  const dataPresent = media.available;
  const mentions24 = media.mentions.filter((m) => now - m.ts <= DAY_S);
  const heur = heuristicsOrganic(media.mentions);
  const geminiKey = getEnv("GEMINI_API_KEY").trim();

  let sentiment: number;
  let isOrganic: boolean;
  let summary: string;
  let method: "gemini" | "lexicon";

  if (geminiKey && media.mentions.length > 0) {
    try {
      const a = await geminiMentionsAssessment(ref, mentions24.length ? mentions24 : media.mentions);
      sentiment = a.sentiment;
      isOrganic = a.is_organic;
      summary = a.summary || factualSummary(mentions24, media.mentions, heur);
      method = "gemini";
    } catch {
      sentiment = lexiconSentiment(media.mentions);
      isOrganic = heur.is_organic;
      summary = factualSummary(mentions24, media.mentions, heur);
      method = "lexicon";
    }
  } else {
    sentiment = lexiconSentiment(media.mentions);
    isOrganic = heur.is_organic;
    summary = factualSummary(mentions24, media.mentions, heur);
    method = "lexicon";
  }

  const mapped = media.mentions
    .slice(0, 20)
    .map((m) => ({ ts: m.ts, source: m.source, title: m.text.slice(0, 160), url: m.url, score: lexiconScore(m.text) }));

  return {
    sentiment,
    is_organic: isOrganic,
    summary,
    mentions: mapped,
    // Слой 5 блокирует по медиаслою ТОЛЬКО когда данные реально получены.
    media_mentions_24h: dataPresent ? mentions24.length : null,
    media_note: dataPresent
      ? `${media.note} · оценка: ${method === "gemini" ? "модель Gemini" : "лексикон"}`
      : media.note,
    media_source: media.source,
    media_method: method,
    // Нет данных медиаслоя — оценивать нечем: слой 5 НЕ блокирует сигнал.
    llm_unavailable: dataPresent ? undefined : true,
  };
}
