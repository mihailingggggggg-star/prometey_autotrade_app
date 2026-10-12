/**
 * hardening.test.ts — правки второго круга ревью (не подтверждение старого кода):
 *  1) значение ключа не утекает в текст ошибки источника;
 *  3) .env не ломается значением с переводом строки, пробелы обрезаются;
 *  4) антидубль: второе открытие по монете — 409 position_exists;
 *  2) гонка двойного Free Riding: два параллельных чтения продают ровно 50%;
 *  8) цель 2 в статусе free_ride закрывает остаток (tp_full) + пересчёт ТП на докупке;
 *  5) setTp отдаёт реальную цену, а не перенесённую линию;
 *  6) битый % в пути — 400, не 500;
 *  7) tp_percent=null не даёт мгновенный Free Riding;
 *  9) health переживает повреждённый секрет кошелька.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServerApp } from "../index.ts";
import { runScan } from "../screener.ts";
import { openPosition, addToPosition, setTp, listPositions, advance } from "../demo.ts";
import { setSettings, DEFAULT_SETTINGS, getDb } from "../db.ts";
import { httpJson, ApiError, writeEnvKeys, readEnvFile } from "../config.ts";
import { getKeysStatus } from "../keys.ts";
import type { Fill, Position } from "../../shared/types.ts";
import { resetWorld } from "./_setup.ts";

const JSON_HEADERS = { "content-type": "application/json" };

function findPosition(list: Position[], id: number): Position {
  const p = list.find((x) => x.id === id);
  assert.ok(p, `позиция ${id} не найдена`);
  return p;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServerApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/* ── 1. Утечка ключа ── */

test("безопасность: значение ключа не попадает в текст ошибки источника", async () => {
  const secret = "SECRET-KEY-abcdef0123456789";
  // Порт 1 закрыт: соединение отбивается мгновенно, без сети. Ключ — в query.
  await assert.rejects(
    () => httpJson(`http://127.0.0.1:1/?api-key=${secret}`),
    (e: unknown) => {
      assert.ok(e instanceof ApiError, "ожидается ApiError");
      assert.ok(!String((e as Error).message).includes(secret), "значение ключа не должно быть в тексте ошибки");
      assert.ok(String((e as Error).message).includes("api-key=***"), "query-значение заменено на маску");
      return true;
    },
  );
});

/* ── 3. Санитайз .env ── */

test("ключи: значение с переводом строки отбрасывается (400), пробелы обрезаются", () => {
  assert.throws(
    () => writeEnvKeys({ TELEGRAM_BOT_TOKEN: "abc\ndef=1" }),
    (e: unknown) => e instanceof ApiError && (e as ApiError).status === 400,
    "перевод строки в значении — ошибка 400",
  );
  // Мусорная переменная не появилась, «токен» не обрезан.
  assert.equal(readEnvFile()["def"], undefined, "вторая переменная не должна появиться");

  writeEnvKeys({ HELLO_TEST_VALUE: "  spaced  " });
  assert.equal(readEnvFile()["HELLO_TEST_VALUE"], "spaced", "обрамляющие пробелы обрезаны");
});

/* ── 4. Антидубль входа ── */

test("антидубль: повторное открытие по той же монете отклоняется (409)", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  const scan = await runScan();
  await openPosition({ signal_id: scan.ids[0], usd: 50, order_type: "market" });

  await assert.rejects(
    () => openPosition({ signal_id: scan.ids[0], usd: 50, order_type: "market" }),
    (e: unknown) => e instanceof ApiError && (e as ApiError).code === "position_exists" && (e as ApiError).status === 409,
  );

  await withServer(async (base) => {
    const again = await getJson(`${base}/api/positions/open`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ signal_id: scan.ids[0], usd: 50, order_type: "market" }),
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "position_exists");
    assert.ok(again.body.error.message.length > 0, "понятный русский текст отказа");
  });
  setSettings(DEFAULT_SETTINGS);
});

/* ── 2. Гонка двойного Free Riding ── */

test("гонка: два параллельных чтения не продают 50% дважды", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const scan = await runScan();
  // Цель 2 недостижима — позиция остаётся free_ride, тест только про захват.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market", tp_percent: 1000 });
  const originalQty = pos.qty;

  let cur: Position = pos;
  for (let i = 0; i < 500 && !cur.free_ride_done; i++) {
    // Каждый шаг: тик двигает виртуальные часы, а параллельное чтение попадает
    // в тот же момент — на пересечении порога два прохода обслуживания идут
    // одновременно (ровно сценарий гонки из ревью).
    const [, first] = await Promise.all([advance(), listPositions()]);
    cur = findPosition(first, pos.id);
  }
  assert.ok(cur.free_ride_done, "Free Riding должен сработать");

  const db = getDb();
  const tp = db.prepare("SELECT * FROM fills WHERE position_id=? AND kind='tp_50'").all(pos.id) as unknown as Fill[];
  assert.equal(tp.length, 1, "ровно один fill tp_50");
  assert.ok(Math.abs(tp[0].qty - originalQty * 0.5) <= originalQty * 1e-9, "продано ровно 50% объёма");
  assert.ok(Math.abs(cur.qty - originalQty * 0.5) <= originalQty * 1e-9, "в позиции осталось ровно 50%");

  const alerts = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='free_ride'")
    .get(pos.id) as { n: number };
  assert.equal(alerts.n, 1, "ровно один алерт free_ride");

  const net = tp[0].usd - tp[0].fee_usd - tp[0].slippage_usd;
  assert.ok(Math.abs(cur.realized_usd - net) < 0.01, "realized_usd не удвоен (равен net единственного fill)");
  setSettings(DEFAULT_SETTINGS);
});

/* ── 8. Цель 2 и пересчёт ТП ── */

test("цель 2: остаток у free_ride закрывается по tp_price (tp_full)", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const scan = await runScan();
  // Цель 2 (1.03x) чуть выше триггера Free Riding (1.01x) и достижима.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market", tp_percent: 3 });

  let cur: Position = pos;
  for (let i = 0; i < 1000 && cur.status !== "closed"; i++) {
    await advance();
    cur = findPosition(await listPositions(), pos.id);
  }
  assert.equal(cur.status, "closed", "остаток должен закрыться на цели 2");
  assert.equal(cur.close_reason, "tp_full");
  assert.equal(cur.qty, 0);

  const db = getDb();
  const tp50 = db
    .prepare("SELECT COUNT(*) AS n FROM fills WHERE position_id=? AND kind='tp_50'")
    .get(pos.id) as { n: number };
  assert.equal(tp50.n, 1, "Free Riding отработал до цели 2");
  const tpAlerts = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='tp_reached'")
    .get(pos.id) as { n: number };
  assert.ok(tpAlerts.n >= 1, "алерт tp_reached при достижении цели 2");
  setSettings(DEFAULT_SETTINGS);
});

test("докупка: tp_price пересчитывается от новой средней цены входа", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  const scan = await runScan();
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market" });
  for (let i = 0; i < 3; i++) await advance();

  const added = await addToPosition(pos.id, 50);
  assert.notEqual(added.entry_price, pos.entry_price, "средняя цена входа изменилась");
  const expectedTp = added.entry_price * (1 + added.tp_percent / 100);
  assert.ok(
    Math.abs(added.tp_price - expectedTp) <= Math.abs(expectedTp) * 1e-3,
    `tp_price=${added.tp_price} должен следовать за новой средней (${expectedTp})`,
  );
  setSettings(DEFAULT_SETTINGS);
});

/* ── 5. setTp отдаёт реальную цену ── */

test("setTp возвращает реальную рыночную цену, а не линию ТП", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  const scan = await runScan();
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 50, order_type: "market" });

  const weird = pos.entry_price * 10;
  const after = await setTp(pos.id, weird);
  assert.equal(after.tp_price, Number(weird.toPrecision(6)), "линия ТП записана как указано");
  assert.ok(after.current_price > 0);
  assert.notEqual(after.current_price, after.tp_price, "current_price не должен быть подменён линией ТП");
  setSettings(DEFAULT_SETTINGS);
});

/* ── 6. Битый % в пути ── */

test("битый % в пути даёт 400 invalid_path, а не 500", async () => {
  resetWorld();
  await withServer(async (base) => {
    const res = await getJson(`${base}/api/signals/%zz`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "invalid_path");
  });
});

/* ── 7. tp_percent=null ── */

test("open с tp_percent=null берёт дефолт и не даёт мгновенный Free Riding", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  await withServer(async (base) => {
    const scan = await getJson(`${base}/api/scan`, { method: "POST" });
    const opened = await getJson(`${base}/api/positions/open`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ signal_id: scan.body.ids[0], usd: 50, order_type: "market", tp_percent: null }),
    });
    assert.equal(opened.status, 200);
    // Дефолтная цель 2 для free_ride — это tp2_percent (остаток до x5), а не
    // триггер tp1_percent: иначе остаток закрывался бы сразу после фиксации.
    assert.equal(opened.body.tp_percent, DEFAULT_SETTINGS.free_ride.tp2_percent, "null → дефолт-цель2, а не 0");
    assert.equal(opened.body.free_ride_done, false);
    assert.equal(opened.body.status, "open");

    // Без движения цены Free Riding не срабатывает даже после пересчёта.
    const list = await getJson(`${base}/api/positions`);
    const p = list.body.find((x: any) => x.id === opened.body.id);
    assert.equal(p.free_ride_done, false, "мгновенного Free Riding нет");
  });
  setSettings(DEFAULT_SETTINGS);
});

/* ── 9. Повреждённый секрет кошелька ── */

test("health переживает повреждённый секрет кошелька (200, wallet.set=false)", async () => {
  // Битый блоб: формат наш, но тег/IV невалидны — расшифровка падает.
  writeEnvKeys({ WALLET_SECRET: "v1:AAAA:BBBB:CCCC" });
  const status = getKeysStatus();
  assert.equal(status.wallet.set, false, "повреждённый секрет → wallet.set=false");
  assert.equal(status.wallet.address, "");

  await withServer(async (base) => {
    const health = await getJson(`${base}/api/health`);
    assert.equal(health.status, 200, "health остаётся живым");
    assert.equal(health.body.ok, true);
    assert.equal(health.body.keys.wallet, false);
  });
});
