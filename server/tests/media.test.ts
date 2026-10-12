/**
 * media.test.ts — медиаслой (Apify) и слой 5 воронки.
 *
 * Сеть НЕ трогаем: подменяем globalThis.fetch моками. Проверяем:
 *  • устойчивый разбор ответа актора (разные имена полей, мусор пропускаем);
 *  • суточный бюджет публикаций не превышается, сверх лимита актор не запускается;
 *  • кэш реально экономит запрос;
 *  • 401/402 — честное состояние и скан не падает;
 *  • без ключа Apify — «нет ключа» и слой 5 НЕ блокирует сигнал;
 *  • эвристика органичности: накрутка (30 одинаковых текстов одним автором) vs
 *    органика (20 разных авторов).
 */
import "./_setup.ts";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getMedia,
  assessSocial,
  parseItems,
  heuristicsOrganic,
  lexiconSentiment,
  MIN_MENTIONS_24H,
} from "../sources/apify.ts";
import { cacheClear } from "../sources/net.ts";
import { getDb, setSettings, DEFAULT_SETTINGS } from "../db.ts";
import { runScan } from "../screener.ts";

const realFetch = globalThis.fetch;
const ORIG_ENV: Record<string, string | undefined> = { ...process.env };
const ENV_KEYS = [
  "APIFY_TOKEN",
  "APIFY_TWEET_ACTOR",
  "APIFY_MAX_ITEMS",
  "APIFY_TIMEOUT_SEC",
  "APIFY_DAILY_ITEMS",
  "MEDIA_TTL_MIN",
  "GEMINI_API_KEY",
  "DATA_MODE",
  "FLUX_RPC_URL",
];

function resetMedia(): void {
  getDb().exec(
    "DELETE FROM mentions; DELETE FROM media_status; DELETE FROM meta WHERE key LIKE 'apify:spent:%';",
  );
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
  resetMedia();
  setSettings(DEFAULT_SETTINGS);
});

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function ref(mint: string, symbol = "T") {
  return { token_addr: mint, pair_addr: `POOL_${mint}`, symbol, name: symbol };
}

function countMentions(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM mentions").get() as { n: number }).n;
}

/* ─────────── 1. Разбор ответа актора ─────────── */

test("медиаслой: разбор ответа актора — разные имена полей, мусор пропущен", () => {
  const raw: unknown[] = [
    {
      full_text: "gm $ABC pump soon",
      user: { screen_name: "alice" },
      createdAt: "2026-10-12T10:00:00Z",
      favorite_count: 12,
      retweet_count: 3,
      reply_count: 1,
      lang: "en",
      url: "https://x.com/alice/status/1",
    },
    {
      text: "token looks strong",
      author: { userName: "bob" },
      time: "2026-10-12T11:00:00Z",
      likeCount: 5,
      retweetCount: 2,
      replyCount: 0,
      language: "en",
    },
    { foo: "bar" }, // мусор без текста — пропустить
    null,
  ];
  const m = parseItems(raw, 1_760_000_000);
  assert.equal(m.length, 2, "мусорные элементы не превращаются в упоминания");
  assert.equal(m[0].author, "alice");
  assert.equal(m[0].likes, 12);
  assert.equal(m[0].retweets, 3);
  assert.equal(m[0].url, "https://x.com/alice/status/1");
  assert.equal(m[0].ts, Math.floor(Date.parse("2026-10-12T10:00:00Z") / 1000));
  assert.equal(m[1].author, "bob", "автор читается из author.userName");
  assert.ok(m[1].url.startsWith("x://"), "упоминание без url/id получает суррогатный идентификатор");
  assert.equal(m[1].source, "x");
});

/* ─────────── 2. Суточный бюджет ─────────── */

test("медиаслой: суточный бюджет публикаций не превышается", async () => {
  resetMedia();
  process.env.APIFY_TOKEN = "TEST";
  process.env.APIFY_DAILY_ITEMS = "3";
  process.env.APIFY_MAX_ITEMS = "50";
  process.env.MEDIA_TTL_MIN = "30";
  let calls = 0;
  await withFetch(
    async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { maxItems: number };
      return jsonResp(
        Array.from({ length: body.maxItems }, (_, i) => ({ text: `t${i}`, createdAt: "2026-10-12T00:00:00Z", lang: "en" })),
      );
    },
    async () => {
      const a = await getMedia(ref("BUD_MINT_A", "AAA"));
      const b = await getMedia(ref("BUD_MINT_B", "BBB"));
      assert.equal(calls, 1, "в рамках суточного бюджета актор запускается один раз");
      assert.equal(a.available, true);
      assert.equal(a.mentions.length, 3, "запрошен максимум по остатку бюджета");
      assert.equal(b.available, false);
      assert.match(b.note, /бюджет/i, "исчерпание бюджета — понятная причина, не блокирует скан");
      assert.equal(countMentions(), 3, "собрано ровно в пределах суточного лимита");
    },
  );
});

/* ─────────── 3. Кэш экономит запрос ─────────── */

test("медиаслой: кэш экономит запрос — повторно за упоминаниями не ходим", async () => {
  resetMedia();
  process.env.APIFY_TOKEN = "TEST";
  process.env.APIFY_DAILY_ITEMS = "1000";
  process.env.APIFY_MAX_ITEMS = "50";
  process.env.MEDIA_TTL_MIN = "30";
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return jsonResp([
        { text: "hello $CC", author: { userName: "a" }, createdAt: "2026-10-12T00:00:00Z", lang: "en", url: "https://x.com/a/1" },
      ]);
    },
    async () => {
      const first = await getMedia(ref("CACHE_MINT", "CC"));
      const second = await getMedia(ref("CACHE_MINT", "CC"));
      assert.equal(calls, 1, "второй вызов в пределах TTL не идёт в сеть");
      assert.equal(first.source, "apify");
      assert.equal(second.source, "cache");
      assert.equal(second.mentions.length, 1, "из кэша возвращается собранное упоминание");
      assert.equal(second.available, true);
    },
  );
});

/* ─────────── 4. 401 / 402 — честное состояние ─────────── */

test("медиаслой: 401 (ключ) и 402 (кредит) — честное состояние, без исключения", async () => {
  resetMedia();
  process.env.APIFY_TOKEN = "BAD";
  process.env.APIFY_DAILY_ITEMS = "1000";
  process.env.MEDIA_TTL_MIN = "30";
  await withFetch(
    async () => jsonResp({ error: "unauthorized" }, 401),
    async () => {
      const r = await getMedia(ref("AUTH_MINT", "AU"));
      assert.equal(r.available, false);
      assert.match(r.note, /401|ключ/i);
      // Оценка при недоступном медиаслое не бросает и помечает слой как «нет данных».
      const s = await assessSocial(ref("AUTH_MINT", "AU"));
      assert.equal(s.llm_unavailable, true, "без данных слой 5 не блокирует");
      assert.equal(s.media_mentions_24h, null);
    },
  );
  resetMedia();
  await withFetch(
    async () => jsonResp({ error: "payment required" }, 402),
    async () => {
      const r = await getMedia(ref("CREDIT_MINT", "CR"));
      assert.equal(r.available, false);
      assert.match(r.note, /кредит|402/i);
    },
  );
});

/* ─────────── 5. Без ключа: «нет ключа» и слой 5 не блокирует ─────────── */

test("медиаслой: без ключа Apify — «нет ключа» и слой 5 не блокирует сигнал", async () => {
  delete process.env.APIFY_TOKEN;
  delete process.env.GEMINI_API_KEY;
  resetMedia();
  // Сеть не должна дёргаться вовсе: без ключа актор не запускается.
  await withFetch(
    async (url) => {
      throw new Error("сеть не должна использоваться без ключа: " + url);
    },
    async () => {
      const r = await getMedia(ref("NOKEY_MINT", "NK"));
      assert.equal(r.available, false);
      assert.match(r.note, /нет ключа/i);
      const s = await assessSocial(ref("NOKEY_MINT", "NK"));
      assert.equal(s.llm_unavailable, true);
      assert.equal(s.media_mentions_24h, null);
      assert.equal(s.mentions.length, 0);
    },
  );

  // Живой скан без ключей Apify/Gemini: кандидат должен дойти до сигнала —
  // проверка слоя 5 видна, но не блокирует.
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);
  const DAY = 86_400_000;
  const mint = "MEDIATEST0000000000000000000000000000000000";
  const rows: number[][] = [
    [100, 105, 95, 100, 1000],
    [50, 50, 35, 40, 600],
    ...Array.from({ length: 14 }, () => [20, 24, 19, 20, 50]),
  ];
  const daily = { data: { attributes: { ohlcv_list: rows.map((r, i) => [nowS - (rows.length - i) * 86400, ...r]) } } };
  const handler = (url: string): Response => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag"))
      return jsonResp([
        {
          id: mint,
          symbol: "MED",
          name: "Med",
          createdAt: new Date(nowMs - 60 * DAY).toISOString(),
          firstPool: { id: `POOL_${mint}`, createdAt: new Date(nowMs - 60 * DAY).toISOString() },
          liquidity: 50_000,
          fdv: 5e6,
          mcap: 5e6,
          usdPrice: 1,
          organicScore: 90,
          organicScoreLabel: "high",
          audit: { topHoldersPercentage: 8, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
          stats24h: { buyVolume: 12_000, sellVolume: 8_000, holderChange: 5, liquidityChange: -1 },
        },
      ]);
    if (
      url.includes("token-profiles") ||
      url.includes("token-boosts") ||
      url.includes("trending_pools") ||
      url.includes("new_pools")
    )
      return jsonResp([]);
    if (url.includes("/ohlcv/")) return jsonResp(daily);
    if (url.includes("/trades"))
      return jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
    if (url.includes("/networks/solana/pools")) return jsonResp({ data: [] });
    if (url.includes("/latest/dex/tokens/"))
      return jsonResp({
        pairs: [
          {
            chainId: "solana",
            pairAddress: `POOL_${mint}`,
            baseToken: { address: mint, symbol: "MED", name: "Med" },
            priceUsd: "1",
            liquidity: { usd: 50_000 },
            marketCap: 5e6,
            pairCreatedAt: nowMs - 60 * DAY,
            volume: { h24: 20_000 },
          },
        ],
      });
    if (url.includes("rugcheck"))
      return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
    throw new Error("неожиданный запрос: " + url);
  };
  await withFetch(
    (url) => handler(url),
    async () => {
      const r = await runScan();
      assert.equal(r.found, 1, `без ключей Apify/Gemini сигнал обязан пройти слой 5: ${JSON.stringify(r.rejected_by_layer)}`);
      const row = getDb().prepare("SELECT checks_json FROM signals WHERE id=?").get(r.ids[0]) as { checks_json: string };
      const checks = JSON.parse(row.checks_json) as { code: string; ok: boolean; value: unknown; threshold: string }[];
      const m = checks.find((c) => c.code === "mentions");
      assert.ok(m, "проверка медиаслоя видна в списке");
      assert.equal(m!.ok, true, "без данных проверка не блокирует");
      assert.equal(m!.value, null, "значение честно null");
      assert.match(m!.threshold, /нет ключа/i);
    },
  );
});

/* ─────────── 6. Эвристика органичности ─────────── */

test("медиаслой: эвристика органичности — накрутка vs органика", () => {
  const now = 1_760_000_000;
  const spam = Array.from({ length: 30 }, (_, i) => ({
    ts: now - i * 60,
    source: "x",
    author: "bot",
    text: "BUY NOW $X",
    url: `u${i}`,
    likes: 0,
    retweets: 0,
    replies: 0,
    lang: "en",
  }));
  const organic = Array.from({ length: 20 }, (_, i) => ({
    ts: now - i * 600,
    source: "x",
    author: `user${i}`,
    text: `idea number ${i} about the project`,
    url: `v${i}`,
    likes: 1,
    retweets: 0,
    replies: 0,
    lang: "en",
  }));
  const spamH = heuristicsOrganic(spam);
  assert.equal(spamH.is_organic, false, "30 одинаковых текстов одним автором — накрутка");
  assert.ok(spamH.dup_ratio > 0.9);
  const orgH = heuristicsOrganic(organic);
  assert.equal(orgH.is_organic, true, "20 разных авторов — органика");
  assert.equal(orgH.authors, 20);
  // Лексикон тональности: «pump»/«strong» — позитив, «scam»/«rug» — негатив.
  assert.ok(lexiconSentiment([{ ...spam[0], text: "huge pump, very bullish" }]) >= 6);
  assert.ok(lexiconSentiment([{ ...spam[0], text: "this is a scam and rug pull" }]) <= 4);
  assert.equal(MIN_MENTIONS_24H, 5);
});
