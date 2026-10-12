/**
 * sources/rugcheck.ts — LIVE-источник слоя 1: права минта/фриза, ликвидность, риски.
 *
 * RugCheck публичный, ключ НЕ нужен (ключ владельца — от другого сервиса).
 * Полей mintAuthority/freezeAuthority/risks/lpLockedPct в /report/summary нет —
 * берём /report. Значения маппим в те же поля RugData, что и mock:
 *   burned_liq               — lpLockedPct (>=95% засчитываем как «сожжено» = 100);
 *   mint_authority_revoked   — mintAuthority === null;
 *   freeze_authority_revoked — freezeAuthority === null;
 *   danger                   — есть риск уровня danger в risks[].
 *
 * Побочно запоминаем адреса токен-аккаунтов пулов (по knownAccounts) и число
 * холдеров — их использует слой 2 (исключить пул из концентрации топ-10 и
 * показать число холдеров), чтобы не ходить за этим в сеть повторно.
 */
import { netJson } from "./net.ts";
import { jupiterToken } from "./jupiter.ts";
import type { SourceRef, RugData } from "./mock.ts";

const BASE = "https://api.rugcheck.xyz/v1";
const INTERVAL_MS = 150;
const TTL_REPORT = 300_000;

interface RugRisk {
  name?: string;
  level?: string;
}
interface RugHolder {
  address?: string;
  owner?: string;
}
export interface RugReport {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  risks?: RugRisk[];
  markets?: {
    lp?: { lpLockedPct?: number };
    /** Токен-аккаунты пула этой пары: база (A) и котировка (B). С их балансом —
     *  это ликвидность пула, а не кошелёк холдера. */
    liquidityA?: string;
    liquidityB?: string;
  }[];
  topHolders?: RugHolder[];
  knownAccounts?: Record<string, { name?: string; type?: string }>;
  totalHolders?: number;
  score?: number;
}

/** Кэш отчётов: тот же mint в скане и на деталях не должен бить API дважды. */
const reportCache = new Map<string, { exp: number; rep: RugReport }>();
/** Токен-аккаунты пулов на mint — исключаем из концентрации топ-10 (слой 2). */
const poolAccounts = new Map<string, Set<string>>();
/** Число холдеров по mint (из отчёта) для индикаторов. */
const holdersCount = new Map<string, number>();

export async function rugReport(mint: string): Promise<RugReport> {
  const hit = reportCache.get(mint);
  if (hit && hit.exp > Date.now()) return hit.rep;
  const rep = await netJson<RugReport>(`${BASE}/tokens/${mint}/report`, {
    ttlMs: TTL_REPORT,
    minIntervalMs: INTERVAL_MS,
    cacheKey: `rug:${mint}`,
  });
  reportCache.set(mint, { exp: Date.now() + TTL_REPORT, rep });
  return rep;
}

/** Типы knownAccounts, которые считаем пулом/локером (их баланс — не холдер). */
const POOL_TYPES = new Set(["AMM", "LOCKER", "VAULT", "POOL"]);

function rememberPoolContext(ref: SourceRef, rep: RugReport): void {
  const known = rep.knownAccounts ?? {};
  const set = new Set<string>();
  for (const h of rep.topHolders ?? []) {
    const addr = h.address ?? "";
    const owner = h.owner ?? "";
    // RugCheck размечает известные счета ДВУМЯ способами: ключ knownAccounts —
    // это и владелец счёта (owner), и сам токен-аккаунт (address). Матчим оба:
    // по-старому (owner) этого не хватало — у Meteora владелец vault'а обычный
    // System-кошелёк, а помечен именно счёт-адрес.
    const byOwner = owner ? POOL_TYPES.has(known[owner]?.type ?? "") : false;
    const byAddr = addr ? POOL_TYPES.has(known[addr]?.type ?? "") : false;
    if (addr && (byOwner || byAddr)) set.add(addr);
  }
  // Пары (markets) отдают ТОКЕН-АККАУНТЫ пула напрямую (liquidityA/B) — это самый
  // надёжный признак пула: даже если метка AMM промахнётся, баланс из пула не
  // должен попадать в «концентрацию холдеров».
  for (const m of rep.markets ?? []) {
    if (m.liquidityA) set.add(m.liquidityA);
    if (m.liquidityB) set.add(m.liquidityB);
  }
  poolAccounts.set(ref.token_addr, set);
  if (typeof rep.totalHolders === "number") holdersCount.set(ref.token_addr, rep.totalHolders);
}

/** Токен-аккаунты пулов для mint (пустой набор, если не опознали — верхняя оценка). */
export function poolAccountsFor(mint: string): Set<string> {
  return poolAccounts.get(mint) ?? new Set<string>();
}

/** Число холдеров из отчёта RugCheck, если оно было (иначе undefined). */
export function holdersCountFor(mint: string): number | undefined {
  return holdersCount.get(mint);
}

export async function rug(ref: SourceRef): Promise<RugData> {
  const rep = await rugReport(ref.token_addr);
  rememberPoolContext(ref, rep);
  // Право отозвано, когда поле равно null (или отсутствует — трактуем так же).
  const mintRevoked = rep.mintAuthority == null;
  const freezeRevoked = rep.freezeAuthority == null;
  let lockedPct = 0;
  for (const m of rep.markets ?? []) {
    const pct = m.lp?.lpLockedPct;
    if (typeof pct === "number" && pct > lockedPct) lockedPct = pct;
  }
  // Слой 1 по плану: lpLockedPct >= 95 ⇒ ликвидность заблокирована/сожжена.
  const burned = lockedPct >= 95 ? 100 : Math.floor(lockedPct);
  const danger = (rep.risks ?? []).some((r) => (r.level ?? "").toLowerCase() === "danger");
  // Перекрёстная проверка прав минта/фриза по данным Jupiter (audit.*). Нет
  // данных — null (проверка это честно покажет), Jupiter недоступен — тоже null.
  let jupFreeze: boolean | null = null;
  let jupMint: boolean | null = null;
  try {
    const jup = await jupiterToken(ref.token_addr);
    if (jup) {
      jupFreeze = jup.freeze_authority_disabled;
      jupMint = jup.mint_authority_disabled;
    }
  } catch {
    // Jupiter недоступен — перекрёстная проверка остаётся неизмеренной.
  }
  return {
    burned_liq: burned,
    mint_authority_revoked: mintRevoked,
    freeze_authority_revoked: freezeRevoked,
    danger,
    jupiter_freeze_disabled: jupFreeze,
    jupiter_mint_disabled: jupMint,
  };
}
