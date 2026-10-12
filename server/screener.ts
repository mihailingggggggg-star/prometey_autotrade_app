/**
 * screener.ts — воронка слоёв 1–5 (§5 плана) и фабрика источника данных.
 *
 * Скринер работает через единый интерфейс DataSource, поэтому не знает, mock
 * под ним или live. Сигнал создаётся только когда слои 1–4 пройдены, а слой 5
 * даёт sentiment >= 6 и is_organic === true. При сбое LLM сигнал НЕ создаётся.
 */
import { ensureClock, worldStart, virtualNow, getSettings, getDb, audit } from "./db.ts";
import { readDataMode } from "./config.ts";
import {
  createMockSource,
  type DataSource,
  type SourceRef,
  type MarketData,
  type HolderData,
  type SocialData,
} from "./sources/mock.ts";
import { dexMarket, dexCandles, dexSearch } from "./sources/dexscreener.ts";
import { rug as rugcheckRug } from "./sources/rugcheck.ts";
import { holders as heliusHolders } from "./sources/helius.ts";
import { jupiterPrice } from "./sources/jupiter.ts";
import { geminiOverview, geminiSocial } from "./sources/gemini.ts";
import type {
  Check,
  Indicators,
  ScanResult,
  ScreenerSettings,
  SignalStatus,
} from "../shared/types.ts";

const MAX_PER_SCAN = 5;

/** Фабрика источника: mock берёт эпоху мира, live собирает HTTP-источники. */
export function getSource(): DataSource {
  if (readDataMode() === "live") return createLiveSource();
  ensureClock();
  return createMockSource(worldStart());
}

function createLiveSource(): DataSource {
  return {
    mode: "live",
    async listCandidates() {
      // Публичный DexScreener не имеет «тренд-ленты»; собираем вселенную из
      // нескольких поисковых запросов — best-effort для Фазы 4.
      const queries = ["SOL/USDC", "USDC", "meme", "AI", "DeFi"];
      const seen = new Map<string, SourceRef>();
      for (const q of queries) {
        try {
          for (const r of await dexSearch(q)) if (!seen.has(r.token_addr)) seen.set(r.token_addr, r);
        } catch {
          // Один запрос упал — не рушим скан целиком.
        }
      }
      return [...seen.values()].slice(0, 40);
    },
    async market(ref) {
      return dexMarket(ref);
    },
    async price(addr) {
      return jupiterPrice(addr);
    },
    async rug(ref) {
      return rugcheckRug(ref);
    },
    async holders(ref) {
      return heliusHolders(ref);
    },
    async candles(ref, tf, limit) {
      return dexCandles(ref, tf, limit);
    },
    async overview(ref, market) {
      return geminiOverview(ref, market);
    },
    async social(ref, market) {
      return geminiSocial(ref, market);
    },
  };
}

/* ─────────────── воронка ─────────────── */

interface ScreenResult {
  checks: Check[];
  indicators: Indicators;
  social: SocialData;
  overview_ru: string;
  market: MarketData;
  open_signal: boolean;
  score: number;
}

function chk(
  layer: Check["layer"],
  code: string,
  label_ru: string,
  ok: boolean,
  value: Check["value"],
  threshold: string,
): Check {
  return { layer, code, label_ru, ok, value, threshold };
}

async function screenCandidate(
  src: DataSource,
  ref: SourceRef,
  now: number,
  s: ScreenerSettings,
): Promise<ScreenResult> {
  const market = await src.market(ref, now);
  const rug = await src.rug(ref);
  const holders: HolderData = await src.holders(ref, now);

  const checks: Check[] = [];

  // Слой 1 — RugCheck.
  const okBurn = rug.burned_liq === 100;
  const okMint = rug.mint_authority_revoked;
  const okFreeze = rug.freeze_authority_revoked;
  checks.push(chk(1, "burned_liq", "Ликвидность сожжена", okBurn, rug.burned_liq, "=100%"));
  checks.push(chk(1, "mint_revoked", "Право минта отозвано", okMint, okMint, "true"));
  checks.push(chk(1, "freeze_revoked", "Право фриза отозвано", okFreeze, okFreeze, "true"));
  const ok1 = okBurn && okMint && okFreeze;

  // Слой 2 — Helius (концентрация холдеров).
  const ok2 = holders.top10_holders_pct < s.top10_max;
  checks.push(
    chk(2, "top10_holders", "Доля топ-10 холдеров", ok2, holders.top10_holders_pct, `<${s.top10_max}%`),
  );

  // Слой 3 — DexScreener (возраст и ликвидность).
  const okAge = market.age_days >= s.age_min && market.age_days <= s.age_max;
  const okLiq = market.liq_usd >= s.liq_min && market.liq_usd <= s.liq_max;
  checks.push(chk(3, "age", "Возраст пула", okAge, Math.round(market.age_days * 10) / 10, `${s.age_min}..${s.age_max} дн`));
  checks.push(chk(3, "liquidity", "Ликвидность пула", okLiq, Math.round(market.liq_usd), `${s.liq_min}..${s.liq_max}`));
  const ok3 = okAge && okLiq;

  // Слой 4 — накопление и защита от накрутки.
  // Коридор считаем полной шириной (max-min)/mid; порог «±range_pct» -> 2*range_pct.
  const tight = market.range_pct <= 2 * s.range_pct;
  const dd = market.drawdown_from_ath_pct;
  const okDd = dd >= s.drawdown_min && dd <= s.drawdown_max;
  const okGrowth = holders.holders_growth_pct >= s.holders_growth_min;
  const washOK = !s.wash_filter || holders.makers_24h >= s.maker_min;
  checks.push(chk(4, "tight_range", "Узкий коридор накопления", tight, Math.round(market.range_pct * 10) / 10, `≤${2 * s.range_pct}%`));
  checks.push(chk(4, "drawdown", "Падение от максимума", okDd, dd, `${s.drawdown_min}..${s.drawdown_max}%`));
  checks.push(chk(4, "holders_growth", "Прирост холдеров за 7 дней", okGrowth, holders.holders_growth_pct, `≥${s.holders_growth_min}%`));
  checks.push(
    chk(4, "wash_filter", "Защита от накрутки объёма", washOK, holders.makers_24h, s.wash_filter ? `≥${s.maker_min}` : "выключен"),
  );
  const ok4 = tight && okDd && okGrowth && washOK;

  // Слой 5 — Gemini. Выключенный тумблер не блокирует, но проверки остаются видимыми.
  let social: SocialData;
  let overview_ru = "";
  if (s.llm_filter) {
    social = await src.social(ref, market, now);
    overview_ru = await src.overview(ref, market);
  } else {
    social = { sentiment: 0, is_organic: false, summary: "", mentions: [] };
  }
  const okSent = !s.llm_filter || social.sentiment >= 6;
  const okOrganic = !s.llm_filter || social.is_organic === true;
  checks.push(chk(5, "sentiment", "Тональность соцсетей", okSent, s.llm_filter ? social.sentiment : null, s.llm_filter ? "≥6" : "выключен"));
  checks.push(chk(5, "organic", "Органичность интереса", okOrganic, s.llm_filter ? social.is_organic : null, s.llm_filter ? "true" : "выключен"));
  const ok5 = okSent && okOrganic;

  const indicators: Indicators = {
    svd: market.svd,
    onchain_volume_usd: market.onchain_volume_usd,
    liquidity_flow_usd: market.liquidity_flow_usd,
    holders_growth_pct: holders.holders_growth_pct,
    makers_24h: holders.makers_24h,
    avg_trade_usd: holders.avg_trade_usd,
    top10_holders_pct: holders.top10_holders_pct,
    drawdown_from_ath_pct: market.drawdown_from_ath_pct,
    range_pct: market.range_pct,
  };

  const okCount = [ok1, ok2, ok3, ok4, ok5].filter(Boolean).length;
  const score = Math.round((okCount / 5) * 50 + (Math.min(10, social.sentiment) / 10) * 50);

  return {
    checks,
    indicators,
    social,
    overview_ru: overview_ru || "(описание появится после прохождения соцфильтра)",
    market,
    open_signal: ok1 && ok2 && ok3 && ok4 && ok5,
    score,
  };
}

function firstFailLayer(checks: Check[]): number | null {
  for (const c of checks) if (!c.ok) return c.layer;
  return null;
}

/** Полный скан: оценивает всю вселенную, но добавляет не больше MAX_PER_SCAN сигналов. */
export async function runScan(): Promise<ScanResult> {
  const s = getSettings();
  const src = getSource();
  const now = virtualNow();
  const candidates = await src.listCandidates();
  const rejected: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  const passed: { ref: SourceRef; res: ScreenResult }[] = [];

  for (const ref of candidates) {
    const res = await screenCandidate(src, ref, now, s.screener);
    if (res.open_signal) {
      passed.push({ ref, res });
    } else {
      const layer = firstFailLayer(res.checks) ?? 5;
      rejected[String(layer)]++;
    }
  }

  const ids: number[] = [];
  for (const { ref, res } of passed.slice(0, MAX_PER_SCAN)) {
    ids.push(insertSignal(ref, res, now));
  }

  audit("scan", { found: ids.length, rejected }, "screener");
  return { found: ids.length, ids, rejected_by_layer: rejected };
}

function insertSignal(ref: SourceRef, res: ScreenResult, now: number): number {
  const m = res.market;
  const status: SignalStatus = "new";
  const result = getDb()
    .prepare(
      `INSERT INTO signals(ts, token_addr, symbol, name, pair_addr, price, liq_usd, mc_usd, age_days,
        tf_accum, score, status, checks_json, metrics_json, social_json, overview_ru, sentiment, is_organic)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      now,
      ref.token_addr,
      ref.symbol,
      ref.name,
      ref.pair_addr,
      m.price,
      m.liq_usd,
      m.mc_usd,
      m.age_days,
      m.tf_accum,
      res.score,
      status,
      JSON.stringify(res.checks),
      JSON.stringify(res.indicators),
      JSON.stringify(res.social),
      res.overview_ru,
      res.social.sentiment,
      res.social.is_organic ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}
