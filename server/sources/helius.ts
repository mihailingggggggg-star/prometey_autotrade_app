/**
 * sources/helius.ts — LIVE-источник слоя 2: концентрация холдеров через RPC.
 *
 * Стандартный JSON-RPC Helius даёт крупнейшие аккаунты и общее предложение —
 * из них считаем долю топ-10. Прирост холдеров и число уникальных мейкеров
 * доступны только в платном индексаторе Enhanced API, поэтому здесь возвращаем
 * 0 (неизвестно) с пояснением, а не выдуманные числа.
 */
import { httpJson, getEnv, ApiError } from "../config.ts";
import type { SourceRef, HolderData } from "./mock.ts";

interface RpcResp<T> {
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const key = getEnv("HELIUS_API_KEY");
  if (!key) throw new ApiError("missing_key", 400, "HELIUS_API_KEY не задан");
  const resp = await httpJson<RpcResp<T>>(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (resp.error) {
    // Сырое сообщение RPC наружу НЕ отдаём: провайдер может отразить в нём
    // детали запроса (в т.ч. ключ). Клиенту — понятная формулировка, без
    // содержания ответа. Ключ в query уже вырезается redactUrl в httpJson.
    throw new ApiError("rpc_error", 502, `Helius: RPC-запрос «${method}» отклонён провайдером`);
  }
  return resp.result as T;
}

export async function holders(ref: SourceRef): Promise<HolderData> {
  const [largest, supply] = await Promise.all([
    rpc<{ value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [ref.token_addr]),
    rpc<{ value: { amount: string; decimals: number; uiAmount: number | null } }>("getTokenSupply", [
      ref.token_addr,
    ]),
  ]);
  const total = supply.value.uiAmount ?? 0;
  const top10 = (largest.value ?? []).slice(0, 10).reduce((s, a) => s + Number(a.amount) / 10 ** supply.value.decimals, 0);
  const pct = total > 0 ? (top10 / total) * 100 : 0;
  return {
    top10_holders_pct: Number(pct.toFixed(2)),
    holders: 0, // общее число холдеров RPC не отдаёт
    holders_growth_pct: 0, // только Enhanced API Helius (индексатор)
    makers_24h: 0, // только Enhanced API Helius
    avg_trade_usd: 0,
  };
}
