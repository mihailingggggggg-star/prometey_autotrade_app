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
  return generate(`${PROMPT_OVERVIEW}\n\nДанные: ${context(ref, m)}`);
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
  const text = await generate(`${PROMPT_SOCIAL}\n\nДанные: ${context(ref, m)}`);
  return parseSocial(text);
}
