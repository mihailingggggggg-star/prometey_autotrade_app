/**
 * strategy.test.ts — правки ТРЕТЬЕГО круга: ядро стратегии Free Riding.
 *
 * Суть: цель 2 (остаток) по умолчанию — это tp2_percent (x5), а не триггер
 * фиксации tp1_percent. Иначе сразу после фиксации половины цена уже ≥ tp_price
 * и остаток закрывался бы на следующем тике — «бесплатный полёт» длился бы один
 * тик, и стратегии Free Riding не существовало бы.
 *
 * Тесты обязаны падать при возврате старого поведения:
 *  • дефолт брал бы tp1_percent → остаток закрывался сразу (тест 1, тест 4);
 *  • валидация «tp2 > tp1» не существовала бы (тест 3).
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServerApp } from "../index.ts";
import { runScan } from "../screener.ts";
import { openPosition, addToPosition, listPositions, advance } from "../demo.ts";
import { setSettings, DEFAULT_SETTINGS, getDb } from "../db.ts";
import { ApiError } from "../config.ts";
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

/* ── 1. Дефолты: остаток живёт тик за тиком, не закрывается ── */

test("стратегия: при дефолтах остаток free_ride НЕ закрывается по цели 2 сразу после фиксации", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS); // tp1_percent=100, tp2_percent=400
  const scan = await runScan();
  // Без tp_percent: цель 2 берётся из настроек (tp2_percent).
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market" });
  assert.equal(pos.tp_percent, DEFAULT_SETTINGS.free_ride.tp2_percent, "дефолтная цель 2 = tp2_percent");
  assert.ok(pos.tp_price > pos.entry_price * 2, "линия ТП (цель 2) выше триггера фиксации (+100%)");

  const originalQty = pos.qty;
  let cur = pos;
  // Догоняем до фиксации половины на +100%.
  for (let i = 0; i < 120 && !cur.free_ride_done; i++) {
    await advance();
    cur = findPosition(await listPositions(), pos.id);
  }
  assert.ok(cur.free_ride_done, "Free Riding должен сработать на +100%");
  assert.equal(cur.status, "free_ride");
  const qtyAfterFix = cur.qty;
  assert.ok(Math.abs(qtyAfterFix - originalQty * 0.5) <= originalQty * 1e-9, "продано ровно 50% объёма");

  // Ещё несколько тиков: цена растёт к ~x2.2, но не к x5 — остаток остаётся.
  for (let i = 0; i < 10; i++) {
    await advance();
    cur = findPosition(await listPositions(), pos.id);
  }
  assert.equal(cur.status, "free_ride", "остаток продолжает жить, позиция не закрыта");
  assert.ok(Math.abs(cur.qty - qtyAfterFix) <= originalQty * 1e-12, "объём остатка не меняется");
  assert.ok(cur.peak_price > 0, "peak_price обновляется");
  const remaining = cur.realized_usd + cur.qty * cur.current_price - cur.usd_in;
  assert.ok(Math.abs(cur.pnl_usd - remaining) < 0.01, "pnl по остатку согласован");

  const db = getDb();
  const tp50 = db
    .prepare("SELECT COUNT(*) AS n FROM fills WHERE position_id=? AND kind='tp_50'")
    .get(pos.id) as { n: number };
  assert.equal(tp50.n, 1, "фиксация половины ровно одна");
  const closes = db
    .prepare("SELECT COUNT(*) AS n FROM fills WHERE position_id=? AND kind='close'")
    .get(pos.id) as { n: number };
  assert.equal(closes.n, 0, "полного закрытия по цели 2 быть не должно");
  const fr = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='free_ride'")
    .get(pos.id) as { n: number };
  assert.equal(fr.n, 1, "алерт free_ride ровно один");
  const tpReached = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='tp_reached'")
    .get(pos.id) as { n: number };
  assert.equal(tpReached.n, 0, "цель 2 не достигнута — алерта tp_reached нет");
  setSettings(DEFAULT_SETTINGS);
});

/* ── 2. Явная цель 2 выше триггера: закрытие ровно на ней ── */

test("стратегия: явная цель 2 выше триггера — остаток закрывается ровно на ней (tp_full)", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 360 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const scan = await runScan();
  // Триггер +1%, цель 2 = +100% (x2) — достижима: разгон идёт до ~x2.2.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market", tp_percent: 100 });
  assert.equal(pos.tp_percent, 100, "явная цель 2 уважается");

  let cur = pos;
  for (let i = 0; i < 200 && cur.status !== "closed"; i++) {
    await advance();
    cur = findPosition(await listPositions(), pos.id);
  }
  assert.equal(cur.status, "closed", "остаток закрыт на цели 2");
  assert.equal(cur.close_reason, "tp_full");
  assert.equal(cur.qty, 0);

  const db = getDb();
  const closeFill = db
    .prepare("SELECT * FROM fills WHERE position_id=? AND kind='close' ORDER BY id DESC LIMIT 1")
    .get(pos.id) as unknown as Fill;
  assert.ok(closeFill.price >= cur.tp_price * (1 - 1e-3), "закрытие не раньше достижения цели 2");
  const tp50 = db
    .prepare("SELECT COUNT(*) AS n FROM fills WHERE position_id=? AND kind='tp_50'")
    .get(pos.id) as { n: number };
  assert.equal(tp50.n, 1, "фиксация половины отработала до цели 2");
  const tpReached = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='tp_reached'")
    .get(pos.id) as { n: number };
  assert.equal(tpReached.n, 1, "алерт tp_reached ровно один");
  setSettings(DEFAULT_SETTINGS);
});

/* ── 3. Валидация: цель 2 обязана быть строго выше триггера ── */

test("валидация: tp2_percent <= tp1_percent отвергается (invalid_settings)", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS); // tp1_percent=100, tp2_percent=400

  // Равенство триггеру недопустимо: остаток продался бы сразу после фиксации.
  assert.throws(
    () => setSettings({ free_ride: { tp2_percent: 100 } }),
    (e: unknown) => e instanceof ApiError && e.code === "invalid_settings" && e.status === 400,
    "tp2 == tp1 отвергается",
  );
  assert.throws(
    () => setSettings({ free_ride: { tp2_percent: 50 } }),
    (e: unknown) => e instanceof ApiError && e.code === "invalid_settings" && e.status === 400,
    "tp2 < tp1 отвергается",
  );

  // Корректное значение принимается и сохраняется.
  const ok = setSettings({ free_ride: { tp2_percent: 500 } });
  assert.equal(ok.free_ride.tp2_percent, 500);

  // Тот же отказ — на уровне HTTP.
  await withServer(async (base) => {
    const res = await getJson(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ free_ride: { tp2_percent: 10 } }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "invalid_settings");
    assert.ok(String(res.body.error.message).length > 0, "понятный русский текст отказа");
  });
  setSettings(DEFAULT_SETTINGS);
});

/* ── 4. Докупка: цель 2 от новой средней по СОХРАНЁННОМУ tp_percent ── */

test("докупка: цель 2 считается от новой средней по сохранённому tp_percent и не сбрасывает free_ride", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const scan = await runScan();
  // Без tp_percent: цель 2 = tp2_percent = 400.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market" });
  assert.equal(pos.tp_percent, 400);
  assert.ok(pos.note.includes("free_ride"), "режим позиции — free_ride");

  // Меняем настройку ЗАДНИМ ЧИСЛОМ: на цель уже открытой позиции влиять не должна.
  setSettings({ free_ride: { tp2_percent: 800 } });

  await advance();
  const added = await addToPosition(pos.id, 50);
  assert.notEqual(added.entry_price, pos.entry_price, "средняя цена входа изменилась");
  assert.equal(added.tp_percent, 400, "цель 2 — сохранённый tp_percent позиции, а не новые настройки (800)");
  const expected = added.entry_price * (1 + added.tp_percent / 100);
  assert.ok(
    Math.abs(added.tp_price - expected) <= Math.abs(expected) * 1e-3,
    `tp_price=${added.tp_price} должен следовать за новой средней (${expected})`,
  );
  assert.ok(added.note.includes("free_ride"), "докупка не сбрасывает режим free_ride");
  assert.notEqual(added.status, "closed", "позиция остаётся в работе");
  setSettings(DEFAULT_SETTINGS);
});
