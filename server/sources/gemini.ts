/**
 * sources/gemini.ts — LIVE-источник слоя 5: описание проекта и соцфильтр.
 *
 * Два промпта из §7 плана. Парсер соцфильтра обязан переживать «мусорный» ответ
 * (JSON внутри текста, пустая строка): при сбое возвращаем 0 / false / "" —
 * и screener тогда НЕ создаёт сигнал (не создаём «на веру»).
 */
import { httpJson, getEnv, ApiError } from "../config.ts";
import type { SourceRef, MarketData, SocialData } from "./mock.ts";

const MODEL = "gemini-1.5-flash";

/** Промпт 1 (описание проекта) — три пункта, без рекламного мусора. */
export const PROMPT_OVERVIEW = [
  "Ты венчурный крипто-аналитик экосистемы Solana.",
  "Опиши проект строго тремя пунктами: 1) что это за проект; 2) кто основатель и что с комьюнити;",
  "3) к какому нарративу он привязан. Без рекламных оборотов, только факты и трезвая оценка.",
  "Ответ — на русском, не длиннее 90 слов.",
].join(" ");

/** Промпт 2 (соцфильтр) — строгий JSON, без пояснений вокруг. */
export const PROMPT_SOCIAL = [
  "Ты фильтр накрученного ажиотажа. Оцени органичность интереса к токену.",
  'Верни СТРОГО JSON без пояснений: {"sentiment_score":0..10,"is_organic":true|false,"summary":"…"}.',
  "sentiment_score — тональность обсуждений, is_organic — нет ли признаков ботов и платного хайпа.",
].join(" ");

async function generate(prompt: string): Promise<string> {
  const key = getEnv("GEMINI_API_KEY");
  if (!key) throw new ApiError("missing_key", 400, "GEMINI_API_KEY не задан");
  // Ключ едет ЗАГОЛОВКОМ, а не в query: значение не должно попадать ни в URL,
  // ни в текст ошибки источника.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const j = await httpJson<{
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  }>(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

function context(ref: SourceRef, m: MarketData): string {
  return (
    `Токен ${ref.name} (${ref.symbol}), возраст пула ${Math.round(m.age_days)} дн., ` +
    `ликвидность ${Math.round(m.liq_usd)} USD, капитализация ${Math.round(m.mc_usd)} USD.`
  );
}

export async function geminiOverview(ref: SourceRef, m: MarketData): Promise<string> {
  try {
    return await generate(`${PROMPT_OVERVIEW}\n\nДанные: ${context(ref, m)}`);
  } catch {
    // Нет ключа или LLM недоступен — собираем осмысленное описание из ФАКТИЧЕСКИХ
    // данных (имя, возраст, ликвидность, объём). Никаких выдумок про основателя
    // и комьюнити: их мы не знаем.
    return factualOverview(ref, m);
  }
}

/** Описание проекта по фактическим данным, без LLM (когда ключа нет). */
export function factualOverview(ref: SourceRef, m: MarketData): string {
  const liq = Math.round(m.liq_usd).toLocaleString("ru-RU");
  const vol = Math.round(m.volume_24h_usd).toLocaleString("ru-RU");
  const mc = Math.round(m.mc_usd).toLocaleString("ru-RU");
  const age = Math.round(m.age_days);
  return (
    `${ref.name} (${ref.symbol}) — токен сети Solana. Пул торгуется примерно ${age} дн. ` +
    `при ликвидности ${liq} USD и капитализации ${mc} USD; объём за сутки — ${vol} USD. ` +
    `Данные взяты из DexScreener и GeckoTerminal. Автоматическое описание без LLM: ` +
    `сведения об основателе и комьюнити не проверены.`
  );
}

/** Разбор ответа соцфильтра: переживает JSON внутри текста и пустой ответ. */
export function parseSocial(text: string): SocialData {
  let sentiment = 0;
  let organic = false;
  let summary = "";
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      const s = Number(o.sentiment_score);
      sentiment = Number.isFinite(s) ? Math.min(10, Math.max(0, s)) : 0;
      organic = o.is_organic === true;
      summary = typeof o.summary === "string" ? o.summary : "";
    } catch {
      // Бит JSON — оставляем нули: сигнал не пройдёт слой 5.
    }
  }
  return { sentiment, is_organic: organic, summary, mentions: [] };
}

export async function geminiSocial(ref: SourceRef, m: MarketData): Promise<SocialData> {
  try {
    const text = await generate(`${PROMPT_SOCIAL}\n\nДанные: ${context(ref, m)}`);
    return parseSocial(text);
  } catch {
    // Нет ключа или LLM недоступен: помечаем слой как недоступный. Скринер по
    // этой проверке сигнал НЕ блокирует и НЕ создаёт «на веру».
    return { sentiment: 0, is_organic: false, summary: "", mentions: [], llm_unavailable: true };
  }
}

/** Оценка модели по собранным упоминаниям: тональность + органичность + резюме. */
export interface MentionsAssessment {
  sentiment: number;
  is_organic: boolean;
  summary: string;
}

/**
 * Оценка соцфильтра ПО РЕАЛЬНЫМ публикациям (медиаслой Apify, слой 5). Тот же
 * промпт, но данные — собранные упоминания. Бросает при отсутствии ключа/сбое:
 * вызывающий (apify.assessSocial) тогда падает на лексикон.
 */
export async function geminiMentionsAssessment(
  ref: SourceRef,
  mentions: { author: string; text: string }[],
): Promise<MentionsAssessment> {
  const sample = mentions
    .slice(0, 30)
    .map((m) => `@${m.author || "?"}: ${m.text.replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");
  const text = await generate(`${PROMPT_SOCIAL}\n\nТокен ${ref.symbol}. Публикации в X:\n${sample}`);
  const p = parseSocial(text);
  return { sentiment: p.sentiment, is_organic: p.is_organic, summary: p.summary };
}
