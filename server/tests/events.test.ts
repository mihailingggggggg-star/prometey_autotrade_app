/**
 * events.test.ts — слой событий-отборщиков БЕЗ сети (мок fetch).
 *
 * Проверяем: каждый из семи отборщиков срабатывает на синтетической истории и
 * НЕ срабатывает, когда не должен (по одному условию-границе); дедуп по
 * (монета, код) работает; при недостатке истории breakout молчит; снимок пишет
 * только монеты в окне возраста; свёртка/ретеншен не удаляют свежие строки;
 * событие доходит до сигнала и сигнал несёт свой код.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServerApp } from "../index.ts";
import { getDb, nowSec, setSettings, DEFAULT_SETTINGS } from "../db.ts";
import { captureSnapshot, cleanupHistory, detectEvents, codesForSignals, takeEventCandidates, markEvents, listEvents } from "../events.ts";
import { runScan } from "../screener.ts";
import type { JupiterToken } from "../sources/jupiter.ts";
import { cacheClear } from "../sources/net.ts";

const realFetch = globalThis.fetch;
const DAY = 86_400;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
async function withFetch(handler: Handler, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Общий «тихий» ответ: новые пулы/сделки/пары пусты, RugCheck даёт базовую линию. */
function quietHandler(over?: (url: string, init?: RequestInit) => Response | null): Handler {
  return (url, init) => {
    const custom = over?.(url, init);
    if (custom) return custom;
    if (url.includes("new_pools") || url.includes("trending_pools")) return jsonResp({ data: [] });
    if (url.includes("/networks/solana/pools")) return jsonResp({ data: [] });
    if (url.includes("/trades")) return jsonResp({ data: [] });
    if (url.includes("/latest/dex/tokens/")) return jsonResp({ pairs: [] });
    if (url.includes("rugcheck")) return jsonResp({ mintAuthority: "active", freezeAuthority: "active", risks: [], markets: [] });
    if (url.includes("geckoterminal")) return jsonResp({ data: [] });
    if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
    if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp([]);
    return jsonResp({ data: [] });
  };
}

function clean(): void {
  getDb().exec("DELETE FROM events; DELETE FROM token_history; DELETE FROM token_safety;");
}

interface HistOver {
  price?: number;
  liq_usd?: number;
  volume_24h?: number;
  holders?: number;
  holder_change_24h?: number | null;
  liq_change_24h?: number | null;
  price_change_24h?: number | null;
  price_change_6h?: number | null;
  fdv?: number;
  organic?: number | null;
}

function seedHist(mint: string, rows: { ts: number; o?: HistOver }[]): void {
  const ins = getDb().prepare(
    "INSERT OR REPLACE INTO token_history" +
      "(mint,ts,price,liq_usd,volume_24h,holders,holder_change_24h,liq_change_24h," +
      "price_change_24h,price_change_6h,fdv,organic) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const r of rows) {
    const o = r.o ?? {};
    ins.run(
      mint,
      r.ts,
      o.price ?? 1,
      o.liq_usd ?? 50_000,
      o.volume_24h ?? 1000,
      o.holders ?? 1000,
      o.holder_change_24h ?? 0,
      o.liq_change_24h ?? 0,
      o.price_change_24h ?? 0,
      o.price_change_6h ?? null,
      o.fdv ?? 5_000_000,
      o.organic ?? 90,
    );
  }
}

/** Полный набор полей токена вселенной для подстановки в detectEvents/captureSnapshot. */
function token(mint: string, ageDays: number, symbol = "TKN", liq = 50_000): JupiterToken {
  return {
    mint,
    symbol,
    name: symbol,
    liq_usd: liq,
    fdv_usd: 5_000_000,
    mcap_usd: 5_000_000,
    usd_price: 1,
    age_days: ageDays,
    volume_24h_usd: 20_000,
    holder_count: 5000,
    holders_change_24h_pct: 0,
    liquidity_change_24h_pct: 0,
    price_change_24h_pct: 0,
    tags: [],
    organic_score: 90,
    organic_label: "high",
    top10_holders_pct: 8,
    freeze_authority_disabled: true,
    mint_authority_disabled: true,
    dev_mints: 0,
  };
}

function eventsOf(mint: string, code?: string): { code: string; status: string; signal_id: number | null; note: string }[] {
  const db = getDb();
  return (code
    ? db.prepare("SELECT code,status,signal_id,note FROM events WHERE token_addr=? AND code=?").all(mint, code)
    : db.prepare("SELECT code,status,signal_id,note FROM events WHERE token_addr=?").all(mint)) as {
    code: string;
    status: string;
    signal_id: number | null;
    note: string;
  }[];
}

/* ─────────────── отборщики по СВОЕЙ истории ─────────────── */

test("события: dry_spike срабатывает и молчит на границе цены", async () => {
  clean();
  const now = nowSec();
  const fire = "DRYfire0000000000000000000000000000000000";
  const quiet = "DRYquiet000000000000000000000000000000000";
  const base = (i: number) => ({ ts: now - (20 - i) * 3600 });
  // Фон: 19 снимков с оборотом 1000 (медиана 1000). Последний — всплеск ×3.
  seedHist(fire, [
    ...Array.from({ length: 19 }, (_, i) => ({ ...base(i), o: { volume_24h: 1000, price_change_24h: 0 } })),
    { ts: now, o: { volume_24h: 3000, price_change_24h: 1, holder_change_24h: 2 } },
  ]);
  // Граница: тот же всплеск, но цена ушла на +10% (> 5%) → не «сухой».
  seedHist(quiet, [
    ...Array.from({ length: 19 }, (_, i) => ({ ...base(i), o: { volume_24h: 1000, price_change_24h: 0 } })),
    { ts: now, o: { volume_24h: 3000, price_change_24h: 10, holder_change_24h: 2 } },
  ]);
  await withFetch(quietHandler(), async () => {
    await detectEvents(now, new Map());
  });
  assert.equal(eventsOf(fire, "dry_spike").length, 1, "сухой всплеск должен сработать");
  assert.equal(eventsOf(quiet, "dry_spike").length, 0, "при движении цены > 5% — не сухой всплеск");
});

test("события: breakout срабатывает на выходе из коридора с объёмом", async () => {
  clean();
  const now = nowSec();
  const fire = "BRKfire0000000000000000000000000000000000";
  const quiet = "BRKquiet000000000000000000000000000000000";
  // 5 дней по 6 часов: коридор 100, оборот 1000. Последний — 120 (+20% за 6ч) и ×3 объём.
  const span = (last: { price: number; volume_24h: number }) =>
    [
      ...Array.from({ length: 20 }, (_, i) => ({ ts: now - (20 - i) * 6 * 3600, o: { price: 100, volume_24h: 1000 } })),
      { ts: now, o: { ...last, price_change_24h: 0 } },
    ];
  seedHist(fire, span({ price: 120, volume_24h: 3000 }));
  seedHist(quiet, span({ price: 103, volume_24h: 3000 })); // +3% за 6ч — порога нет
  await withFetch(quietHandler(), async () => {
    await detectEvents(now, new Map());
  });
  assert.equal(eventsOf(fire, "breakout").length, 1, "пробой коридора на объёме должен сработать");
  assert.equal(eventsOf(quiet, "breakout").length, 0, "рост ниже порога +8% — не пробой");
});

test("события: мало истории — breakout молчит (не выдумывает коридор)", async () => {
  clean();
  const now = nowSec();
  const mint = "BRKlittle00000000000000000000000000000000";
  // Всего 10 снимков за ~9 часов: span < 3 дней → коридор не считаем.
  seedHist(
    mint,
    Array.from({ length: 10 }, (_, i) => ({
      ts: now - (10 - i) * 3600,
      o: { price: i === 9 ? 200 : 100, volume_24h: 3000 },
    })),
  );
  await withFetch(quietHandler(), async () => {
    await detectEvents(now, new Map());
  });
  assert.equal(eventsOf(mint, "breakout").length, 0, "при короткой истории breakout обязан молчать");
});

test("события: lp_inflow срабатывает и молчит при движении цены", async () => {
  clean();
  const now = nowSec();
  const fire = "LPfire00000000000000000000000000000000000";
  const quiet = "LPquiet0000000000000000000000000000000000";
  seedHist(fire, [{ ts: now, o: { liq_change_24h: 20, price_change_24h: 2 } }]);
  seedHist(quiet, [{ ts: now, o: { liq_change_24h: 20, price_change_24h: 8 } }]);
  await withFetch(quietHandler(), async () => {
    await detectEvents(now, new Map());
  });
  assert.equal(eventsOf(fire, "lp_inflow").length, 1, "приток ликвидности при плоской цене");
  assert.equal(eventsOf(quiet, "lp_inflow").length, 0, "движение цены > 5% — не «плоская цена»");
});

test("события: holders_accel срабатывает и молчит при движении цены", async () => {
  clean();
  const now = nowSec();
  const fire = "HLDfire0000000000000000000000000000000000";
  const quiet = "HLDquiet000000000000000000000000000000000";
  seedHist(fire, [{ ts: now, o: { holder_change_24h: 3, price_change_24h: 1 } }]);
  seedHist(quiet, [{ ts: now, o: { holder_change_24h: 3, price_change_24h: 6 } }]);
  await withFetch(quietHandler(), async () => {
    await detectEvents(now, new Map());
  });
  assert.equal(eventsOf(fire, "holders_accel").length, 1, "ускорение холдеров при плоской цене");
  assert.equal(eventsOf(quiet, "holders_accel").length, 0, "движение цены > 5% — не срабатывает");
});

/* ─────────────── отборщики по внешним (кэшируемым) данным ─────────────── */

test("события: new_pool срабатывает на зрелом токене и молчит на молодом", async () => {
  clean();
  cacheClear(); // список new_pools кэшируется — не переиспользуем пустой из соседнего теста
  const now = nowSec();
  const mature = "NEWPOOLmature00000000000000000000000000000";
  const young = "NEWPOOLyoung000000000000000000000000000000";
  const uni = new Map<string, JupiterToken>([
    [mature, token(mature, 60)],
    [young, token(young, 3)],
  ]);
  const pools = [
    {
      attributes: { address: "POOLm", name: "M/SOL", reserve_in_usd: "40000", base_token_price_usd: "1", volume_usd: { h24: "9000" } },
      relationships: { base_token: { data: { id: `solana_${mature}` } } },
    },
    {
      attributes: { address: "POOLy", name: "Y/SOL", reserve_in_usd: "40000", base_token_price_usd: "1", volume_usd: { h24: "9000" } },
      relationships: { base_token: { data: { id: `solana_${young}` } } },
    },
  ];
  await withFetch(
    quietHandler((url) => (url.includes("new_pools") ? jsonResp({ data: pools }) : null)),
    async () => {
      await detectEvents(now, uni);
    },
  );
  assert.equal(eventsOf(mature, "new_pool").length, 1, "новый пул у монеты 60 дн — событие");
  assert.equal(eventsOf(young, "new_pool").length, 0, "монета 3 дн — вне окна 7..180");
});

test("события: safety_cleared — только на ПЕРЕХОДЕ прав минта", async () => {
  clean();
  cacheClear();
  const now = nowSec();
  const transition = "SAFEtransition0000000000000000000000000000";
  const firstSeen = "SAFEfirstseen00000000000000000000000000000";
  seedHist(transition, [{ ts: now }]); // монета в поле зрения (есть снимок)
  seedHist(firstSeen, [{ ts: now }]);
  // Предыдущее наблюдение: у transition права БЫЛИ активны (база в token_safety).
  getDb()
    .prepare("INSERT INTO token_safety(mint,mint_revoked,lp_locked_pct,ts) VALUES(?,0,0,?)")
    .run(transition, now - 3600);
  // RugCheck теперь отдаёт «права отозваны» для обеих монет.
  const handler = quietHandler((url) =>
    url.includes("rugcheck")
      ? jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] })
      : null,
  );
  await withFetch(handler, async () => {
    await detectEvents(now, new Map());
  });
  const evs = eventsOf(transition, "safety_cleared");
  assert.equal(evs.length, 1, "права СТАЛИ отозваны — событие-разрешение");
  assert.match(evs[0].note, /минта/);
  assert.equal(eventsOf(firstSeen, "safety_cleared").length, 0, "первое наблюдение — только база, не событие");
});

test("события: large_buyer срабатывает на крупной покупке и молчит на мелких", async () => {
  clean();
  cacheClear();
  const now = nowSec();
  const big = "LBbig000000000000000000000000000000000000";
  const small = "LBsmall0000000000000000000000000000000000";
  seedHist(big, [{ ts: now }]);
  seedHist(small, [{ ts: now }]);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const trades = (list: number[]) => ({
    data: list.map((usd) => ({ attributes: { kind: "buy", volume_in_usd: String(usd), block_timestamp: iso(now - 120), tx_from_address: "x" } })),
  });
  const handler = quietHandler((url) => {
    if (url.includes("/latest/dex/tokens/")) {
      const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
      return jsonResp({
        pairs: addrs.map((a) => ({
          chainId: "solana",
          pairAddress: `POOL_${a}`,
          baseToken: { address: a, symbol: "T", name: "T" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
        })),
      });
    }
    if (url.includes("/trades")) {
      if (url.includes(big)) return jsonResp(trades([5000, 40, 40, 40]));
      return jsonResp(trades([40, 40, 40, 40]));
    }
    return null;
  });
  await withFetch(handler, async () => {
    await detectEvents(now, new Map());
  });
  assert.equal(eventsOf(big, "large_buyer").length, 1, "покупка $5000 ≥ порога — событие");
  assert.equal(eventsOf(small, "large_buyer").length, 0, "мелкие покупки ниже порога");
});

test("события: large_buyer не срабатывает на микроскопической медиане пула", async () => {
  clean();
  cacheClear();
  const now = nowSec();
  // Микро-пул: медиана ~$0.1, максимум $1 («×9 от $0.1» — шум, не крупный заход).
  const tiny = "LBtiny0000000000000000000000000000000000";
  // Живой пул: медиана ~$200, покупка $1500 (7.5× медианы, но < $2000).
  const alive = "LBalive000000000000000000000000000000000";
  seedHist(tiny, [{ ts: now }]);
  seedHist(alive, [{ ts: now }]);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const trades = (list: number[]) => ({
    data: list.map((usd) => ({ attributes: { kind: "buy", volume_in_usd: String(usd), block_timestamp: iso(now - 120), tx_from_address: "x" } })),
  });
  const handler = quietHandler((url) => {
    if (url.includes("/latest/dex/tokens/")) {
      const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
      return jsonResp({
        pairs: addrs.map((a) => ({
          chainId: "solana",
          pairAddress: `POOL_${a}`,
          baseToken: { address: a, symbol: "T", name: "T" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
        })),
      });
    }
    if (url.includes("/trades")) {
      if (url.includes(tiny)) return jsonResp(trades([1, 0.1, 0.1, 0.1]));
      return jsonResp(trades([1500, 200, 200, 200]));
    }
    return null;
  });
  await withFetch(handler, async () => {
    await detectEvents(now, new Map());
  });
  assert.equal(eventsOf(tiny, "large_buyer").length, 0, "микроскопическая медиана — относительный путь не работает");
  assert.equal(eventsOf(alive, "large_buyer").length, 1, "$1500 ≥ 3× медианы $200 при живой медиане — событие");
});

/* ─────────────── дедуп, снимок, уборка ─────────────── */

test("события: дедуп по (монета, код) не плодит записи", async () => {
  clean();
  const now = nowSec();
  const mint = "DEDUP000000000000000000000000000000000000";
  seedHist(mint, [
    ...Array.from({ length: 19 }, (_, i) => ({ ts: now - (20 - i) * 3600, o: { volume_24h: 1000 } })),
    { ts: now, o: { volume_24h: 3000, price_change_24h: 1, holder_change_24h: 2 } },
  ]);
  await withFetch(quietHandler(), async () => {
    await detectEvents(now, new Map());
    await detectEvents(now + 60, new Map()); // тот же всплеск в пределах TTL
  });
  assert.equal(eventsOf(mint, "dry_spike").length, 1, "повтор в пределах EVENT_TTL_MIN не пишется");
});

test("снимок: пишет только монеты в окне стратегии по возрасту", () => {
  clean();
  setSettings(DEFAULT_SETTINGS); // окно 7..180 дней
  const now = nowSec();
  const young = "SNAPyoung00000000000000000000000000000000";
  const inside = "SNAPinside0000000000000000000000000000000";
  const old = "SNAPold0000000000000000000000000000000000";
  const uni = new Map<string, JupiterToken>([
    [young, token(young, 5)],
    [inside, token(inside, 60)],
    [old, token(old, 300)],
  ]);
  const n = captureSnapshot(uni, now);
  assert.equal(n, 1, "записан ровно один токен — в окне возраста");
  const rows = getDb().prepare("SELECT mint FROM token_history").all() as { mint: string }[];
  assert.deepEqual(rows.map((r) => r.mint), [inside]);
});

test("уборка: свёртка и ретеншен не трогают свежие строки", () => {
  clean();
  const now = nowSec();
  const mint = "CLEANup0000000000000000000000000000000000";
  const cutoff = now - 48 * 3600;
  // Свежие (внутри 48ч) — остаются как есть.
  seedHist(mint, [
    { ts: now, o: { volume_24h: 500 } },
    { ts: now - 3600, o: { volume_24h: 500 } },
  ]);
  // Две строки одной «часовой» корзины старше 48ч — должны свернуться в одну.
  const bucket = Math.floor((cutoff - 1000) / 3600) * 3600;
  const t1 = bucket + 100;
  const t2 = bucket + 900;
  seedHist(mint, [
    { ts: t1, o: { volume_24h: 100 } },
    { ts: t2, o: { volume_24h: 300 } },
  ]);
  // Старше 30 дней — удаляется.
  seedHist(mint, [{ ts: now - 31 * DAY, o: { volume_24h: 7 } }]);

  cleanupHistory(now);

  const fresh = getDb()
    .prepare("SELECT COUNT(*) AS n FROM token_history WHERE mint=? AND ts>=?")
    .get(mint, now - 48 * 3600) as { n: number };
  assert.equal(fresh.n, 2, "свежие строки не тронуты");
  const old = getDb().prepare("SELECT COUNT(*) AS n FROM token_history WHERE mint=? AND ts<?").get(mint, now - 30 * DAY) as { n: number };
  assert.equal(old.n, 0, "строка старше ретеншена удалена");
  const collapsed = getDb()
    .prepare("SELECT ts, volume_24h FROM token_history WHERE mint=? AND ts<?")
    .all(mint, now - 48 * 3600) as { ts: number; volume_24h: number }[];
  assert.equal(collapsed.length, 1, "подчасовая корзина свернулась в одну строку");
  assert.equal(collapsed[0].ts % 3600, 0, "свёрнутая строка выровнена по часу");
  assert.equal(collapsed[0].volume_24h, 200, "объём свёрнут как среднее (100 и 300)");
});

/* ─────────────── связь с воронкой и API ─────────────── */

/** Дневные свечи зрелой монеты: ATH=105, узкий коридор 19..24, просадка ~81%. */
function dailyMature(): number[][] {
  const nowS = Math.floor(Date.now() / 1000);
  const early: number[][] = [
    [100, 105, 95, 100, 1000],
    [85, 85, 60, 65, 800],
    [50, 50, 35, 40, 600],
  ];
  const flat = Array.from({ length: 14 }, () => [20, 24, 19, 20, 50]);
  const rows = [...early, ...flat];
  return rows.map((r, i) => [nowS - (rows.length - i) * 86400, ...r]);
}

const MATURE = "EVMature0000000000000000000000000000000000";

test("событие доходит до сигнала: статус signaled и сигнал несёт свой код", async () => {
  clean();
  process.env.DATA_MODE = "live";
  delete process.env.FLUX_RPC_URL;
  cacheClear();
  setSettings(DEFAULT_SETTINGS);
  const now = nowSec();
  getDb()
    .prepare("INSERT INTO events(ts,token_addr,symbol,code,label_ru,note,metrics_json,status,signal_id) VALUES(?,?,?,?,?,?,?,'new',NULL)")
    .run(now, MATURE, "MTR", "dry_spike", "сухой всплеск: объём вырос, цена стоит", "вставлено тестом", "{}");

  const daily = { data: { attributes: { ohlcv_list: dailyMature() } } };
  const handler: Handler = (url, init) => {
    if (url.includes("lite-api.jup.ag/tokens/v2/tag")) return jsonResp([token(MATURE, 60, "MTR")]);
    if (url.includes("token-profiles") || url.includes("token-boosts")) return jsonResp([]);
    if (url.includes("/ohlcv/")) return jsonResp(daily);
    if (url.includes("/trades"))
      return jsonResp({ data: Array.from({ length: 130 }, (_, i) => ({ attributes: { tx_from_address: `m${i}` } })) });
    if (url.includes("trending_pools") || url.includes("new_pools")) return jsonResp({ data: [] });
    if (url.includes("/networks/solana/pools")) return jsonResp({ data: [] });
    if (url.includes("/latest/dex/tokens/")) {
      const addrs = decodeURIComponent(url.split("/latest/dex/tokens/")[1].split("?")[0]).split(",");
      return jsonResp({
        pairs: addrs.map((a) => ({
          chainId: "solana",
          pairAddress: `POOL_${a}`,
          baseToken: { address: a, symbol: "MTR", name: "Mature" },
          priceUsd: "1",
          liquidity: { usd: 50_000 },
          marketCap: 5_000_000,
          pairCreatedAt: Date.now() - 60 * DAY * 1000,
          volume: { h24: 20_000 },
        })),
      });
    }
    if (url.includes("rugcheck"))
      return jsonResp({ mintAuthority: null, freezeAuthority: null, risks: [], markets: [{ lp: { lpLockedPct: 100 } }] });
    void init;
    return jsonResp({ data: [] });
  };

  let signalId = 0;
  await withFetch(handler, async () => {
    const r = await runScan();
    assert.equal(r.found, 1, `ожидали 1 сигнал от событийного кандидата, получили ${r.found}: ${JSON.stringify(r.rejected_by_layer)}`);
    signalId = r.ids[0];
  });

  const ev = getDb().prepare("SELECT status, signal_id FROM events WHERE token_addr=?").get(MATURE) as {
    status: string;
    signal_id: number | null;
  };
  assert.equal(ev.status, "signaled", "событие стало сигналом");
  assert.equal(ev.signal_id, signalId, "событие ссылается на свой сигнал");
  assert.deepEqual(codesForSignals([signalId]).get(signalId), ["dry_spike"], "сигнал помнит код события");

  // Кандидат из событий отдаётся воронке вместе с кодами.
  const cands = takeEventCandidates(10).filter((c) => c.ref.token_addr === MATURE);
  assert.equal(cands.length, 0, "после сигнала событие уже не new");

  // API: сигнал несёт поле events.
  const server = createServerApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/signals/${signalId}`);
    const body = (await res.json()) as { signal: { events?: string[] } };
    assert.deepEqual(body.signal.events, ["dry_spike"], "DTO сигнала несёт коды событий");
    const evres = await fetch(`${base}/api/events?limit=10`);
    const evbody = (await evres.json()) as { token_addr: string; code: string; status: string }[];
    assert.ok(evbody.some((e) => e.token_addr === MATURE && e.code === "dry_spike"), "GET /api/events отдаёт событие");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  process.env.DATA_MODE = "mock";
  setSettings(DEFAULT_SETTINGS);
});

test("события: listEvents и markEvents — дешёвое чтение и исход", () => {
  clean();
  const now = nowSec();
  const mint = "LIST000000000000000000000000000000000000";
  getDb()
    .prepare("INSERT INTO events(ts,token_addr,symbol,code,label_ru,note,metrics_json,status,signal_id) VALUES(?,?,?,?,?,?,?,'new',NULL)")
    .run(now, mint, "LST", "lp_inflow", "приток ликвидности", "n", JSON.stringify({ liq_change_24h: 20 }));
  const list = listEvents({ limit: 10, token: mint });
  assert.equal(list.length, 1);
  assert.equal(list[0].code, "lp_inflow");
  assert.equal(list[0].metrics.liq_change_24h, 20);
  markEvents([list[0].id], "rejected");
  assert.equal(listEvents({ limit: 10, token: mint, status: "rejected" }).length, 1);
});
