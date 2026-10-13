/**
 * hardening.test.ts — правки круга ревью (не подтверждение старого кода):
 *  1) значение ключа не утекает в текст ошибки источника;
 *  3) .env не ломается значением с переводом строки, пробелы обрезаются;
 *  4) антидубль: второе открытие по монете — 409 position_exists; теперь ещё и
 *     ПАРАЛЛЕЛЬНОЕ открытие (Promise.all) — одна позиция, второй вызов 409
 *     (частичный UNIQUE-индекс idx_positions_token_open);
 *  2) гонка двойного Free Riding: две защиты (очередь + атомарный захват) —
 *     интеграционный сторож + отдельный сторож атомарного захвата (см. ниже);
 *  8) цель 2 в статусе free_ride закрывает остаток (tp_full) + пересчёт ТП на докупке;
 * 10) позиция с tp1_fraction=1 из старой базы закрывается (tp_full), а не зависает;
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
import { openPosition, addToPosition, setTp, listPositions, listTrades, advance } from "../demo.ts";
import { setSettings, getSettings, DEFAULT_SETTINGS, getDb } from "../db.ts";
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

test("антидубль: ДВА ПАРАЛЛЕЛЬНЫХ открытия по одной монете — одна позиция, второй 409", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  const scan = await runScan();
  const req = { signal_id: scan.ids[0], usd: 50, order_type: "market" as const };

  // Индекс антидубля создан при инициализации БД.
  const idx = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_positions_token_open'")
    .get();
  assert.ok(idx, "частичный UNIQUE-индекс idx_positions_token_open создан");

  // Обе заявки проходят пред-проверку до await маркет-данных — закрывает индекс.
  const results = await Promise.allSettled([openPosition(req), openPosition(req)]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok.length, 1, "успешно проходит ровно одна заявка");
  assert.equal(bad.length, 1, "вторая заявка отклонена");
  assert.ok(bad[0].reason instanceof ApiError, "отказ — ApiError");
  assert.equal((bad[0].reason as ApiError).code, "position_exists");
  assert.equal((bad[0].reason as ApiError).status, 409);

  const token = getDb().prepare("SELECT token_addr FROM signals WHERE id=?").get(scan.ids[0]) as { token_addr: string };
  const cnt = getDb()
    .prepare("SELECT COUNT(*) AS n FROM positions WHERE token_addr=? AND status!='closed'")
    .get(token.token_addr) as { n: number };
  assert.equal(cnt.n, 1, "в базе ровно одна незакрытая позиция по монете");
  setSettings(DEFAULT_SETTINGS);
});

/* ── 2. Гонка двойного Free Riding ── */

/**
 * Про «параллельность» — честно. Очередь updateQueue СЕРИАЛИЗУЕТ прогоны
 * обслуживания: два обращения к API (advance и listPositions) НЕ выполняют
 * runUpdatePositions одновременно, а строго друг за другом. Формулировка «два
 * прохода идут в один момент» была бы неверной.
 *
 * Защит две, и они перекрываются:
 *   A) атомарный захват free_ride_done (UPDATE ... WHERE free_ride_done=0);
 *   B) очередь updateQueue (сериализация прогонов).
 * Сторож для A — тест «атомарный захват» ниже: он краснеет, если флаг/захват
 * перестанет запрещать повторную продажу. Сторож ровно для B построить нельзя:
 * без очереди захват A всё равно не даёт второй продажи (наблюдаемый итог тот
 * же), поэтому тест «два обращения разом» — интеграционный. Он проверяет, что
 * ИТОГ держится при обслуживании из двух мест сразу, и краснеет, если снять
 * ОБЕ защиты.
 */

test("гонка Free Riding: атомарный захват — повторный проход не продаёт второй раз", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const scan = await runScan();
  // Цель 2 недостижима — позиция остаётся free_ride, тест только про захват.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market", tp_percent: 1000 });

  // Догоняем до срабатывания фиксации (первый проход продаёт 50%).
  let cur: Position = pos;
  for (let i = 0; i < 500 && !cur.free_ride_done; i++) {
    await advance();
    cur = findPosition(await listPositions(), pos.id);
  }
  assert.ok(cur.free_ride_done, "Free Riding должен сработать");

  const db = getDb();
  const countTp50 = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM fills WHERE position_id=? AND kind='tp_50'").get(pos.id) as { n: number }).n;
  assert.equal(countTp50(), 1, "после фиксации ровно один fill tp_50");

  // Повторные проходы на достигнутой цене. Именно атомарный захват (флаг
  // free_ride_done) обязан запретить вторую продажу: убери захват — здесь
  // появится второй fill tp_50 и тест покраснеет.
  for (let i = 0; i < 6; i++) {
    await advance();
    await listPositions();
  }
  assert.equal(countTp50(), 1, "повторные проходы не продают второй раз");

  const alerts = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='free_ride'")
    .get(pos.id) as { n: number };
  assert.equal(alerts.n, 1, "ровно один алерт free_ride");
  setSettings(DEFAULT_SETTINGS);
});

test("гонка Free Riding: одновременный вызов advance + listPositions продаёт ровно один раз", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const scan = await runScan();
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market", tp_percent: 1000 });
  const originalQty = pos.qty;

  let cur: Position = pos;
  for (let i = 0; i < 500 && !cur.free_ride_done; i++) {
    // Обслуживание дёргают из двух мест сразу (таймер + опрос экранов). Очередь
    // сериализует прогоны, а на случай наложения захват free_ride_done всё равно
    // запретил бы вторую продажу. Итог обязан быть ровно один.
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

/* ── 10. Позиция с нулевым объёмом не зависает ── */

test("страховка: tp1_fraction=1 из старой базы закрывает позицию (tp_full), а не вешает её", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { ...DEFAULT_SETTINGS.free_ride, tp1_percent: 1, tp1_fraction: 0.5 },
  });
  // Значение из СТАРОЙ базы: валидация его больше не пропускает, но в данных оно есть.
  getDb().prepare("UPDATE settings SET value_json=? WHERE key='free_ride.tp1_fraction'").run("1");
  assert.equal(getSettings().free_ride.tp1_fraction, 1, "подготовка: в базе tp1_fraction=1");

  const scan = await runScan();
  // Цель 2 недостижима: закрытие обязано случиться страховкой на триггере, не по ТП.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market", tp_percent: 1000 });

  let cur: Position = pos;
  for (let i = 0; i < 500 && cur.status !== "closed"; i++) {
    await advance();
    cur = findPosition(await listPositions(), pos.id);
  }
  assert.equal(cur.status, "closed", "позиция с нулевым объёмом обязана закрыться, а не висеть вечно");
  assert.equal(cur.close_reason, "tp_full");
  assert.equal(cur.qty, 0, "остаток обнулён");
  assert.ok(cur.realized_usd > 0, "реализованный результат ненулевой (капитал вернулся)");

  // История: listTrades берёт только status='closed' — сделка обязана туда попасть.
  assert.ok(listTrades(100).some((t) => t.position_id === pos.id), "сделка попала в /api/trades");

  // Дополнительные тики не «переоткрывают» и не дублируют закрытие.
  for (let i = 0; i < 5; i++) await advance();
  const after = getDb().prepare("SELECT qty, status FROM positions WHERE id=?").get(pos.id) as { qty: number; status: string };
  assert.equal(after.status, "closed");
  assert.equal(after.qty, 0);

  // Защита на будущее: НОВОЕ значение 1 отвергается валидацией.
  assert.throws(
    () => setSettings({ free_ride: { tp1_fraction: 1 } }),
    (e: unknown) => e instanceof ApiError && (e as ApiError).code === "invalid_settings",
    "новое tp1_fraction=1 не проходит валидацию",
  );
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
    const scan = await getJson(`${base}/api/scan?sync=1`, { method: "POST" });
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
