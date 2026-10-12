/**
 * sources/jupiter.ts — LIVE-источник цены/котировки (Jupiter Price API v2).
 * Вызывается только при DATA_MODE=live.
 */
import { httpJson, getEnv } from "../config.ts";

interface PriceResp {
  data?: Record<string, { id?: string; price?: string } | null>;
}

/** Цена токена в USD. Ненайденный токен — 0 (не выдумываем значение). */
export async function jupiterPrice(mint: string): Promise<number> {
  const apiKey = getEnv("JUPITER_API_KEY");
  const headers: Record<string, string> = {};
  // Ключ опционален: без него Jupiter отвечает с более жёсткими лимитами.
  if (apiKey) headers["x-api-key"] = apiKey;
  const j = await httpJson<PriceResp>(`https://api.jup.ag/price/v2?ids=${mint}`, { headers });
  const entry = j.data?.[mint];
  return entry?.price ? Number(entry.price) : 0;
}
