/**
 * sources/rugcheck.ts — LIVE-источник слоя 1: права минта/фриза, риски пула.
 * Вызывается только при DATA_MODE=live.
 */
import { httpJson } from "../config.ts";
import type { SourceRef, RugData } from "./mock.ts";

const BASE = "https://api.rugcheck.xyz/v1";

interface RugReport {
  /** Список рисков; поле документировано, но набор кодов меняется. */
  risks?: { name?: string; level?: string }[];
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null };
  markets?: { lp?: { lpLockedPct?: number } }[];
}

export async function rugReport(tokenMint: string): Promise<RugReport> {
  return httpJson<RugReport>(`${BASE}/tokens/${tokenMint}/report`);
}

export async function rug(ref: SourceRef): Promise<RugData> {
  const rep = await rugReport(ref.token_addr);
  // mintAuthority/freezeAuthority === null означает, что право отозвано.
  const mintRevoked = !rep.token?.mintAuthority;
  const freezeRevoked = !rep.token?.freezeAuthority;
  // «Сожжённая ликвидность» процентом в отчёте отдельным полем не приходит —
  // возвращаем 0 (неизвестно), пока поле не подтверждено документацией.
  return {
    burned_liq: 0,
    mint_authority_revoked: mintRevoked,
    freeze_authority_revoked: freezeRevoked,
  };
}
