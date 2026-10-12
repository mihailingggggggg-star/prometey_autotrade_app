/**
 * screener.ts — воронка слоёв 1–5 (§5 плана) и фабрика источника данных.
 *
 * Скринер работает через единый интерфейс DataSource, поэтому не знает, mock
 * под ним или live. Сигнал создаётся только когда слои 1–4 пройдены, а слой 5
 * даёт sentiment >= 6 и is_organic === true. При сбое LLM сигнал НЕ создаётся.
 */
import { ensureClock, worldStart, virtualNow, getSettings, getDb, audit } from "./db.ts";
import { readDataMode, getEnvNum } from "./config.ts";
import {
  createMockSource,
  type DataSource,
  type SourceRef,
  type MarketData,
  type HolderData,
  type SocialData,
} from "./sources/mock.ts";
import {
  dexMarket,
  dexMarketMeta,
  dexDailyCandles,
  accumulationFromDaily,
  dexCandles,
  dexPrice,
  listCandidates as dexListCandidates,
  setRangeDays,
  setCandidateFilter,
} from "./sources/dexscreener.ts";
import { rug as rugcheckRug } from "./sources/rugcheck.ts";
import { holders as fluxHolders } from "./sources/helius.ts";
import { jupiterPrice } from "./sources/jupiter.ts";
import { geminiOverview } from "./sources/gemini.ts";
import { assessSocial, MIN_MENTIONS_24H } from "./sources/apify.ts";
import { requestCount, resetRequests } from "./sources/net.ts";
import type {
  Check,
  Indicators,
  ScanResult,
  ScreenerSettings,
  SignalStatus,
} from "../shared/types.ts";

const MAX_PER_SCAN = 5;

/**
 * Слой 1: минимальная доля сожжённой/заблокированной ликвидности, %.
 * РЕШЕНИЕ ВЛАДЕЛЬЦА от 12.10.2026: ослаблено с жёстких 100% («полностью
 * сожжена») до 70%. На живом рынке 100% отсекало почти все монеты — сигналов
 * не было; 70% оставлено как компромисс между защитой от rug-pull и живостью
 * контура. Это НЕ случайное число, а осознанное решение владельца.
 */
const BURNED_LIQ_MIN_PCT = 70;
/**
 * Ориентир для верхней оценки доли топ-10 из Jupiter (audit.topHoldersPercentage,
 * ВКЛЮЧАЕТ счёт пула): показываем, но НЕ блокируем — без RPC точной меры нет.
 */
const TOP10_UPPER_REF_PCT = 30;
/**
 * Потолок сетевых запросов на один скан (live): не даём скану «залить» API.
 * Предфильтр кандидатов по возрасту/ликвидности держит этот бюджет: в дорогую
 * воронку (RugCheck/RPC/свечи) идут только прошедшие, а не все подряд.
 * РЕШЕНИЕ ВЛАДЕЛЬЦА от 12.10.2026: 70 → 140. На 70 бюджет исчерпывался за ~11
 * кандидатов, и 26 из 38 вообще не оценивались (уходили в rejected_by_layer
 * ["budget"]); 140 даёт воронке дойти до большей части списка.
 */
export const MAX_SCAN_REQUESTS = 220;
/**
 * Потолок ВРЕМЕНИ скана, мс (переопределяется SCAN_MAX_MS в тестах). GeckoTerminal
 * троттлится ~30/мин, поэтому бюджет 140 запросов сам по себе может идти дольше
 * трёх минут. Что наступит раньше — бюджет запросов или этот дедлайн — то и
 * остановит скан; остаток кандидатов честно уходит в rejected_by_layer["budget"].
 */
export const MAX_SCAN_MS = 480_000;

/**
 * Порог органичности Jupiter (organicScore 0..100) для ИНФОРМАЦИОННОЙ пометки
 * «низкая органичность» в checks слоя 4 (сам порог больше НЕ блокирует сигнал).
 * Ярлык «low» = ровно 0; score < 30 показываем как «низкая органичность».
 */
const ORGANIC_MIN_SCORE = 30;
/**
 * Слив ликвидности за сутки: падение более 30% (Jupiter stats24h.liquidityChange,
 * %) — повод отбраковать кандидата. Порог зеркалит demo.liq_drain_pct.
 */
const LIQ_DRAIN_MIN_PCT = -30;

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
      // Кандидаты: DexScreener (профили/бусты) + GeckoTerminal (trending/new),
      // затем ОДИН батч-запрос DexScreener по адресам за всю пачку (≤60).
      return dexListCandidates();
    },
    async market(ref) {
      return dexMarket(ref);
    },
    async price(addr) {
      // Основной путь — Jupiter; при сбое/нуле берём цену из DexScreener.
      try {
        const p = await jupiterPrice(addr);
        if (p > 0) return p;
      } catch {
        /* падаем на DexScreener */
      }
      return dexPrice(addr);
    },
    async rug(ref) {
      return rugcheckRug(ref);
    },
    async holders(ref) {
      return fluxHolders(ref);
    },
    async candles(ref, tf, limit) {
      return dexCandles(ref, tf, limit);
    },
    async overview(ref, market) {
      return geminiOverview(ref, market);
    },
    async social(ref, market, now) {
      // Медиаслой (Apify) + оценка тональности/органичности; см. sources/apify.ts.
      return assessSocial(ref, now);
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
  const isLive = src.mode === "live";
  const checks: Check[] = [];

  // Слой 1 — RugCheck + перекрёстная проверка прав минта/фриза по Jupiter.
  const rug = await src.rug(ref);
  // Порог 70% — решение владельца (см. BURNED_LIQ_MIN_PCT выше).
  const okBurn = rug.burned_liq >= BURNED_LIQ_MIN_PCT;
  const okMint = rug.mint_authority_revoked;
  const okFreeze = rug.freeze_authority_revoked;
  checks.push(chk(1, "burned_liq", "Ликвидность сожжена", okBurn, rug.burned_liq, `≥${BURNED_LIQ_MIN_PCT}%`));
  checks.push(chk(1, "mint_revoked", "Право минта отозвано", okMint, okMint, "true"));
  checks.push(chk(1, "freeze_revoked", "Право фриза отозвано", okFreeze, okFreeze, "true"));
  // danger-риск из отчёта RugCheck (только live) блокирует сигнал.
  const okDanger = !rug.danger;
  checks.push(chk(1, "danger_risk", "Опасные риски контракта", okDanger, rug.danger ? "danger" : null, "нет danger"));
  // Перекрёстная сверка с Jupiter (audit.*): если значение есть, оно обязано
  // согласовываться. Нет данных — проверка не блокирует (value=null).
  const jupFreeze = rug.jupiter_freeze_disabled ?? null;
  const okJupFreeze = jupFreeze === null ? true : jupFreeze === true;
  checks.push(
    chk(1, "freeze_jupiter", "Право фриза отозвано (Jupiter)", okJupFreeze, jupFreeze, jupFreeze === null ? "нет данных" : "true"),
  );
  const jupMint = rug.jupiter_mint_disabled ?? null;
  const okJupMint = jupMint === null ? true : jupMint === true;
  checks.push(
    chk(1, "mint_jupiter", "Право минта отозвано (Jupiter)", okJupMint, jupMint, jupMint === null ? "нет данных" : "true"),
  );
  const ok1 = okBurn && okMint && okFreeze && okDanger && okJupFreeze && okJupMint;

  // Слой 3 — возраст и ликвидность ТОКЕНА. Оба признака — из Jupiter (источник
  // вселенной, даёт их одним запросом): это РОВНО те значения, по которым
  // предфильтр отобрал кандидата, поэтому слой 3 не может «добить» уже
  // прошедшего по тому же признаку. В checks видно источник, если признак мог
  // прийти не от Jupiter (свежий добор). Нет данных о создании — value=null
  // (честно «не измерено»), а не выдуманные 0 дней.
  // Живой контур берёт ТОЛЬКО метаданные (dexMarketMeta): свечи — дорогой запрос
  // GeckoTerminal, и качать их раньше слоёв 1 и 3 нельзя (бюджет, время скана).
  const market: MarketData = isLive ? await dexMarketMeta(ref) : await src.market(ref, now);
  const ageKnown = market.age_na !== true;
  const okAge = ageKnown && market.age_days >= s.age_min && market.age_days <= s.age_max;
  const okLiq = market.liq_usd >= s.liq_min && market.liq_usd <= s.liq_max;
  const ageSrcSuffix = market.age_source ? ` · ${market.age_source}` : "";
  const liqSrcSuffix = market.liq_source ? ` · ${market.liq_source}` : "";
  checks.push(
    chk(3, "age", "Возраст токена", okAge, ageKnown ? Math.round(market.age_days * 10) / 10 : null, ageKnown ? `${s.age_min}..${s.age_max} дн${ageSrcSuffix}` : "нет данных о создании пула"),
  );
  checks.push(
    chk(3, "liquidity", "Ликвидность токена", okLiq, Math.round(market.liq_usd), `${s.liq_min}..${s.liq_max}${liqSrcSuffix}`),
  );
  const ok3 = okAge && okLiq;

  // ГЕЙТ ДОРОГИХ ПРОВЕРОК (бюджет и время скана): владельцы по RPC и дневные
  // свечи запрашиваются ТОЛЬКО для кандидатов, прошедших слои 1 и 3. Остальные
  // получают «не измерено» и отбраковываются первым же непройденным слоем.
  const gateOpen = ok1 && ok3;
  let holders: HolderData;
  if (gateOpen) {
    holders = await src.holders(ref, now);
    if (isLive) {
      // Свечи — и дневные, и добор часовых при коротком дневном ряде (см. dexDailyCandles).
      const acc = accumulationFromDaily(await dexDailyCandles(ref));
      market.range_pct = acc.range_pct;
      market.drawdown_from_ath_pct = acc.drawdown_pct;
      market.candles_na = acc.candles_na;
    }
  } else {
    // Слои 1/3 уже не пройдены — дорогие проверки не выполняем, честно «не измерено».
    holders = {
      top10_holders_pct: 0,
      holders: 0,
      holders_growth_pct: 0,
      makers_24h: 0,
      avg_trade_usd: 0,
      top10_na: true,
      holders_growth_na: true,
      makers_na: true,
      makers_note: "не оценивалось (слои 1–3 не пройдены)",
    };
  }

  // Слой 2 — концентрация холдеров. ТРИ исхода измерения, РАЗНЫЕ подписи:
  //  • RPC (FluxRPC), если задан — счета пулов ИСКЛЮЧЕНЫ (RugCheck knownAccounts +
  //    опознание по ПРОГРАММЕ AMM: authority счёта принадлежит программе-маркет-
  //    мейкеру). Сравниваем со СТРОГИМ top10_max из настроек; им и блокируем.
  //  • без RPC — audit.topHoldersPercentage из Jupiter, но он ВКЛЮЧАЕТ счёт пула:
  //    это ВЕРХНЯЯ оценка. Показываем с ориентиром TOP10_UPPER_REF_PCT и
  //    источником, сигнал по ней НЕ блокируем — иначе без RPC-ключа контур мёртв.
  //  • измерить не удалось (нет ни RPC, ни данных Jupiter) — value=null,
  //    «не измерено», сигнал НЕ блокируем (нет данных — не выдумываем).
  const top10NA = holders.top10_na === true;
  const top10Src = holders.top10_source ?? "mock";
  const top10Upper = top10Src === "jupiter";
  const ok2 = top10NA || top10Upper ? true : holders.top10_holders_pct < s.top10_max;
  const top10Note = (holders as { top10_excluded_note?: string }).top10_excluded_note;
  const top10Threshold = top10NA
    ? "не измерено (нет данных)"
    : top10Upper
      ? `верхняя оценка, включая пул · Jupiter (ориентир ≤${TOP10_UPPER_REF_PCT}%)`
      : top10Src === "rpc"
        ? `<${s.top10_max}% · RPC, ${top10Note ?? "счета пулов исключены"}`
        : `<${s.top10_max}%`;
  checks.push(
    chk(2, "top10_holders", "Доля топ-10 холдеров", ok2, top10NA ? null : holders.top10_holders_pct, top10Threshold),
  );

  // Слой 4 — накопление и защита от накрутки.
  // Коридор считаем полной шириной (max-min)/mid; порог «±range_pct» -> 2*range_pct.
  // Нет дневных свечей → коридор/просадку измерить нельзя: value=null и причина.
  const candlesNA = market.candles_na === true;
  // ПРИНЦИП: «не измерено» ≠ «не прошло». Раньше при троттлинге GeckoTerminal свечи
  // не приходили, и оба чека падали как провал — кандидат отбраковывался за то,
  // что замер не состоялся (та же ошибка, что была у мейкеров). Теперь отсутствие
  // свечей — честное value=null в checks и НЕ блокирует; блокирует только
  // измеренное нарушение. Иначе на 38 кандидатах мы теряем половину воронки из-за
  // лимитов чужого API, а не из-за рынка.
  const tight = candlesNA ? true : market.range_pct <= 2 * s.range_pct;
  const dd = market.drawdown_from_ath_pct;
  const okDd = candlesNA ? true : dd >= s.drawdown_min && dd <= s.drawdown_max;
  // Прирост холдеров: порог holders_growth_min — за 7 ДНЕЙ, значение —
  // ОЦЕНКА из суточного изменения (×7, см. helius.ts). Нет данных — не блокируем.
  const growthNA = holders.holders_growth_na === true;
  const okGrowth = growthNA ? true : holders.holders_growth_pct >= s.holders_growth_min;
  // wash_filter: замер НЕ состоялся (нет данных о сделках — 429/недоступность
  // GeckoTerminal) → НЕ блокируем, value=null. Честный ноль мейкеров из
  // полученной выборки — блокируем как раньше (накрутка объёма).
  const makersNA = holders.makers_na === true;
  const washOK = !s.wash_filter || makersNA || holders.makers_24h >= s.maker_min;
  // Органичность из Jupiter: ИНФОРМАЦИОННАЯ проверка, НЕ блокирует.
  // РЕШЕНИЕ ВЛАДЕЛЬЦА от 12.10.2026: ярлык «low» (score 0) — непрозрачный
  // показатель одного источника, и раньше он В ОДИНОЧКУ убивал кандидата, у
  // которого всё остальное в слое 4 идеально (пример: RKC). Теперь «low»
  // честно помечается отдельным пунктом checks, но НЕ влияет на ok4. От накрутки
  // объёма защищает наша собственная проверка wash_filter (уникальные мейкеры):
  // она остаётся блокирующей, если тумблер включён.
  const organicNA = holders.organic_score == null && !holders.organic_label;
  const organicLabel = (holders.organic_label ?? "").toLowerCase();
  const organicLow = !organicNA
    ? organicLabel
      ? organicLabel === "low"
      : (holders.organic_score ?? 0) < ORGANIC_MIN_SCORE
    : false;
  // Слив ликвидности за сутки (Jupiter stats24h.liquidityChange, %). Нет данных
  // — не блокируем; резкое падение (ниже порога) — блокируем.
  const liqCh = market.liquidity_change_24h_pct ?? null;
  const okLiqChange = liqCh === null ? true : liqCh >= LIQ_DRAIN_MIN_PCT;
  checks.push(
    chk(4, "tight_range", "Узкий коридор накопления", tight, candlesNA ? null : Math.round(market.range_pct * 10) / 10, candlesNA ? "не измерено: нет свечей (не блокирует)" : `≤${2 * s.range_pct}%`),
  );
  checks.push(chk(4, "drawdown", "Падение от максимума", okDd, candlesNA ? null : dd, candlesNA ? "не измерено: нет свечей (не блокирует)" : `${s.drawdown_min}..${s.drawdown_max}%`));
  // Порог трактуется как рост за 7 дней; значение — оценка из суточных данных.
  const growthThreshold = growthNA
    ? "нет данных"
    : isLive
      ? `≥${s.holders_growth_min}% за 7 дней · оценка из суточных данных (×7)`
      : `≥${s.holders_growth_min}% за 7 дней`;
  checks.push(
    chk(4, "holders_growth", "Прирост холдеров за 7 дней", okGrowth, growthNA ? null : holders.holders_growth_pct, growthThreshold),
  );
  // Мейкеры live считаются по частичной выборке сделок — помечаем это в пороге.
  // Замер не состоялся (нет данных о сделках) — подпись с причиной, value=null.
  const makersThreshold = !s.wash_filter
    ? "выключен"
    : makersNA
      ? holders.makers_note || "нет данных о сделках"
      : `≥${s.maker_min}${holders.makers_partial ? " (частичная выборка)" : ""}`;
  checks.push(
    chk(4, "wash_filter", "Защита от накрутки объёма", washOK, makersNA ? null : holders.makers_24h, makersThreshold),
  );
  // Органичность — информационно: ok:true всегда, честная подпись в threshold.
  checks.push(
    chk(
      4,
      "organic_jupiter",
      "Органичность объёма (Jupiter)",
      true,
      organicNA ? null : (holders.organic_score ?? holders.organic_label ?? null),
      organicNA ? "нет данных" : organicLow ? "низкая органичность по оценке Jupiter (не блокирует)" : "не low",
    ),
  );
  checks.push(
    chk(4, "liq_change", "Изменение ликвидности за 24ч", okLiqChange, liqCh === null ? null : Math.round(liqCh * 10) / 10, liqCh === null ? "нет данных" : `≥${LIQ_DRAIN_MIN_PCT}%`),
  );
  const ok4 = tight && okDd && okGrowth && washOK && okLiqChange;

  // Слой 5 — соцсеть: медиаслой (Apify, упоминания в X) + описание проекта.
  // Медиаслой ДОРОГОЙ (тратит кредит Apify), поэтому в живой воронке он
  // опрашивает ТОЛЬКО монеты, дошедшие до сигналов (ok1..ok4) — это и есть
  // защита кредита (см. sources/apify.ts). В mock всё как раньше.
  const socialEligible = s.llm_filter && (!isLive || (ok1 && ok2 && ok3 && ok4));
  let social: SocialData;
  let overview_ru = "";
  if (socialEligible) {
    social = await src.social(ref, market, now);
    overview_ru = await src.overview(ref, market);
  } else {
    social = { sentiment: 0, is_organic: false, summary: "", mentions: [] };
  }
  // Данных нет (нет ключа Apify/Gemini или сбор не удался): проверки видны, но НЕ
  // блокируют и сигнал не создают.
  const llmNA = socialEligible && social.llm_unavailable === true;
  // Лексиконная оценка идёт по словарю, и её шкала не совпадает со шкалой модели:
  // требовать по ней порог «≥6» — значит отбраковывать сигналы наугад (живой
  // пример: 5.7 у монеты с 10 живыми упоминаниями за сутки). Поэтому порог
  // применяется только к оценке модели, а лексиконная показывается как ориентир.
  const lexiconOnly = social.media_method === "lexicon";
  const okSent = !socialEligible || llmNA || lexiconOnly || social.sentiment >= 6;
  const okOrganic = !socialEligible || llmNA || social.is_organic === true;
  const sentValue = !socialEligible || llmNA ? null : social.sentiment;
  const sentThreshold = !s.llm_filter
    ? "выключен"
    : !socialEligible
      ? "не оценивалось (слои 1–4 не пройдены)"
      : llmNA
        ? "нет данных"
        : lexiconOnly
          ? "лексиконная оценка — ориентир, не блокирует"
          : "≥6 (оценка модели)";
  checks.push(chk(5, "sentiment", "Тональность соцсетей", okSent, sentValue, sentThreshold));
  const orgThreshold = !s.llm_filter ? "выключен" : !socialEligible ? "не оценивалось (слои 1–4 не пройдены)" : llmNA ? "нет данных" : "true";
  checks.push(chk(5, "organic", "Органичность интереса", okOrganic, !socialEligible || llmNA ? null : social.is_organic, orgThreshold));
  // Слой 5, медиаслой: минимум упоминаний за 24 ч (порог — константа apify.
  // MIN_MENTIONS_24H). Нет ключа или данных — value=null и НЕ блокирует.
  const mentions24 = social.media_mentions_24h ?? null;
  const mediaAvailable = socialEligible && mentions24 !== null;
  const okMentions = !mediaAvailable || mentions24 >= MIN_MENTIONS_24H;
  const mentionsThreshold = !s.llm_filter
    ? "выключен"
    : !socialEligible
      ? "не оценивалось (слои 1–4 не пройдены)"
      : mediaAvailable
        ? `≥${MIN_MENTIONS_24H} за 24ч`
        : social.media_note || "нет данных";
  checks.push(chk(5, "mentions", "Упоминания в X за 24ч", okMentions, mediaAvailable ? mentions24 : null, mentionsThreshold));
  const ok5 = okSent && okOrganic && okMentions;

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
  // live: окно коридора накопления берём из настроек (range_days).
  setRangeDays(s.screener.range_days);
  // live: предфильтр кандидатов по возрасту/ликвидности — ДО дорогих источников.
  setCandidateFilter(s.screener);
  // Счётчик сетевых запросов обнуляем на границе скана и следим за бюджетом.
  resetRequests();
  const now = virtualNow();
  const startedAt = Date.now();
  const maxMs = getEnvNum("SCAN_MAX_MS") || MAX_SCAN_MS;
  const candidates = await src.listCandidates();
  const rejected: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  const passed: { ref: SourceRef; res: ScreenResult }[] = [];

  let processed = 0;
  for (const ref of candidates) {
    // Бюджет исчерпан (по запросам) ИЛИ вышли за потолок времени скана — дальше
    // НЕ бьём по API. Счётчик виден в rejected_by_layer (форма ответа не
    // меняется, лишь добавляется ключ). Дедлайн нужен потому, что GeckoTerminal
    // троттлится ~30/мин и бюджет запросов сам по себе может идти дольше трёх
    // минут; что наступит раньше — то и остановит скан.
    if (requestCount() >= MAX_SCAN_REQUESTS || Date.now() - startedAt >= maxMs) {
      rejected["budget"] = candidates.length - processed;
      break;
    }
    processed++;
    try {
      const res = await screenCandidate(src, ref, now, s.screener);
      if (res.open_signal) {
        passed.push({ ref, res });
      } else {
        const layer = firstFailLayer(res.checks) ?? 5;
        rejected[String(layer)]++;
      }
    } catch {
      // Один токен/источник упал — не рушим скан целиком, считаем отбраковкой.
      rejected["error"] = (rejected["error"] ?? 0) + 1;
    }
  }

  const ids: number[] = [];
  for (const { ref, res } of passed.slice(0, MAX_PER_SCAN)) {
    ids.push(insertSignal(ref, res, now));
  }

  audit("scan", { found: ids.length, rejected, requests: requestCount(), ms: Date.now() - startedAt }, "screener");
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
