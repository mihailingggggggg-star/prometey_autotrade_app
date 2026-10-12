/**
 * regression.test.ts — регрессия по дефектам интеграции (не подтверждение кода):
 *  1) мир mock-вселенной действительно движется (иначе демо-контур «стоит»);
 *  2) Free Riding целиком: ровно 50% объёма, один алерт, net-результат;
 *  3) после time_stop_days без импульса появляется алерт time_stop;
 *  4) формы ответов /api/deposits (AnalyticsSummary) и /api/alerts/:id/seen (Alert).
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServerApp } from "../index.ts";
import { runScan } from "../screener.ts";
import { openPosition, advance, listPositions } from "../demo.ts";
import { setSettings, DEFAULT_SETTINGS, getDb, ensureClock, worldStart } from "../db.ts";
import { mockPrice, mockProfile, tokenRefBySymbol } from "../sources/mock.ts";
import type { Fill, Position } from "../../shared/types.ts";
import { resetWorld } from "./_setup.ts";

const DAY = 86400;

function findPosition(list: Position[], id: number): Position {
  const p = list.find((x) => x.id === id);
  assert.ok(p, `позиция ${id} не найдена`);
  return p;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

const JSON_HEADERS = { "content-type": "application/json" };

test("мир движется: растущий токен проходит ≥1% за 8 виртуальных часов", () => {
  resetWorld();
  ensureClock();
  // Дефолт тика обязан быть 360 мин (§2 плана): на медленном тике контур «стоит».
  assert.equal(DEFAULT_SETTINGS.demo.tick_minutes, 360, "дефолт tick_minutes должен быть 360");

  const epoch = worldStart();
  const ref = tokenRefBySymbol("BONK");
  assert.ok(ref, "BONK должен быть в mock-вселенной");
  const prof = mockProfile(ref.token_addr);
  assert.equal(prof.mode, "rising", "тестовый токен должен быть растущим");

  // Середина разгона — максимальный наклон; тут 8ч далеко не «сотые доли процента».
  const t0 = epoch + Math.round(prof.pumpDays * 0.5 * DAY);
  const p0 = mockPrice(ref.token_addr, t0, epoch);
  const p1 = mockPrice(ref.token_addr, t0 + 8 * 3600, epoch);
  const moved = Math.abs(p1 - p0) / p0;
  assert.ok(moved >= 0.01, `за 8 виртуальных часов цена изменилась на ${(moved * 100).toFixed(2)}%, нужно ≥1%`);
});

test("движок: Free Riding целиком — 50% объёма, один алерт, net-pnl", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const scan = await runScan();
  assert.ok(scan.ids.length >= 1, "нужен хотя бы один сигнал");
  // Цель 2 недостижима (11x): проверяем Free Riding, а не закрытие остатка.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 100, order_type: "market", tp_percent: 1000 });
  const originalQty = pos.qty;
  assert.ok(originalQty > 0);

  // Прокручиваем виртуальное время до прохода +1%.
  let cur = pos;
  for (let i = 0; i < 300 && !cur.free_ride_done; i++) {
    await advance();
    cur = findPosition(await listPositions(), pos.id);
  }
  assert.ok(cur.free_ride_done, "Free Riding должен сработать на +1%");
  assert.equal(cur.status, "free_ride");
  assert.equal(cur.free_ride_done, true);

  const db = getDb();
  const tp = db
    .prepare("SELECT * FROM fills WHERE position_id=? AND kind='tp_50'")
    .all(pos.id) as unknown as Fill[];
  assert.equal(tp.length, 1, "ровно одна фиксация tp_50");
  assert.ok(Math.abs(tp[0].qty - originalQty * 0.5) <= originalQty * 1e-9, "зафиксировано ровно 50% объёма");
  assert.ok(Math.abs(cur.qty - originalQty * 0.5) <= originalQty * 1e-9, "в позиции осталось ровно 50%");

  // net: комиссия пула и проскальзывание уже вычтены из реализованной суммы.
  const gross = tp[0].usd;
  const net = gross - tp[0].fee_usd - tp[0].slippage_usd;
  assert.ok(tp[0].fee_usd > 0, "комиссия выхода ненулевая");
  assert.ok(tp[0].slippage_usd > 0, "проскальзывание выхода ненулевое");
  assert.ok(Math.abs(cur.realized_usd - net) < 0.01, "realized_usd — net (gross минус издержки)");
  assert.ok(cur.realized_usd < gross, "реализовано меньше gross: издержки учтены");
  // PnL позиции = net-реализация + остаток по текущей цене − вложенное.
  const expectedPnl = cur.realized_usd + cur.qty * cur.current_price - cur.usd_in;
  assert.ok(Math.abs(cur.pnl_usd - expectedPnl) < 0.01, "pnl_usd согласован с net-составляющими");
  assert.ok(cur.fees_usd + cur.slippage_usd > 0, "издержки позиции учтены в pnl_usd");

  const cnt1 = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='free_ride'")
    .get(pos.id) as { n: number };
  assert.equal(cnt1.n, 1, "алерт free_ride создан один раз");

  // Повторная прокрутка не создаёт второй алерт.
  for (let i = 0; i < 5; i++) await advance();
  const cnt2 = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE position_id=? AND kind='free_ride'")
    .get(pos.id) as { n: number };
  assert.equal(cnt2.n, 1, "повторная прокрутка не дублирует алерт free_ride");
});

test("движок: после time_stop_days без импульса появляется алерт time_stop", async () => {
  resetWorld();
  setSettings({ ...DEFAULT_SETTINGS, demo: { ...DEFAULT_SETTINGS.demo, time_stop_days: 14, tick_minutes: 720 } });
  const scan = await runScan();
  // Цель 2 недостижима — позиция должна дожить до time-stop.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 50, order_type: "market", tp_percent: 1000 });
  for (let i = 0; i < 30; i++) await advance();
  const db = getDb();
  const alerts = db.prepare("SELECT * FROM alerts WHERE position_id=? AND kind='time_stop'").all(pos.id);
  assert.ok(alerts.length >= 1, "после срока должен появиться алерт time_stop");
  setSettings(DEFAULT_SETTINGS);
});

test("формы ответов: /api/deposits и /api/alerts/:id/seen отдают DTO из shared/types", async () => {
  resetWorld();
  setSettings({
    ...DEFAULT_SETTINGS,
    demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 60 },
    free_ride: { tp1_percent: 1, tp1_fraction: 0.5 },
  });
  const server = createServerApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const scan = await getJson(`${base}/api/scan`, { method: "POST" });
    assert.ok(scan.body.ids.length >= 1);
    const opened = await getJson(`${base}/api/positions/open`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ signal_id: scan.body.ids[0], usd: 100, order_type: "market" }),
    });
    assert.equal(opened.status, 200);

    // --- /api/deposits → AnalyticsSummary (поля, а не только 200) ---
    const before = await getJson(`${base}/api/analytics/summary`);
    const dep = await getJson(`${base}/api/deposits`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ usd: 100 }),
    });
    assert.equal(dep.status, 200);
    for (const key of [
      "balance",
      "deposited",
      "equity",
      "equity_curve",
      "winrate",
      "avg_profit_pct",
      "by_outcome",
      "trades_count",
      "open_count",
      "costs_usd",
    ]) {
      assert.ok(key in dep.body, `в ответе /api/deposits нет поля ${key}`);
    }
    assert.ok(Array.isArray(dep.body.equity_curve), "equity_curve — массив точек");
    assert.ok(dep.body.deposited >= before.body.deposited + 100 - 0.01, "пополнение учтено сразу");

    // --- /api/alerts/:id/seen для несуществующего id → 404 ---
    const nf = await getJson(`${base}/api/alerts/999999/seen`, { method: "POST" });
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, "alert_not_found");
    assert.equal(nf.body.error.message, "алерт не найден");

    // --- создаём алерт прокруткой виртуального времени и отмечаем его ---
    for (let i = 0; i < 200; i++) {
      await advance();
      const list = await getJson(`${base}/api/alerts`);
      if (list.body.some((a: any) => a.kind === "free_ride")) break;
    }
    const alerts = await getJson(`${base}/api/alerts`);
    const target = alerts.body.find((a: any) => a.kind === "free_ride");
    assert.ok(target, "после прокрутки должен появиться алерт free_ride");

    const seen = await getJson(`${base}/api/alerts/${target.id}/seen`, { method: "POST" });
    assert.equal(seen.status, 200);
    for (const key of ["id", "ts", "position_id", "symbol", "kind", "message", "severity", "seen"]) {
      assert.ok(key in seen.body, `в ответе /api/alerts/:id/seen нет поля ${key}`);
    }
    assert.equal(seen.body.id, target.id);
    assert.equal(seen.body.seen, true);
    assert.equal(seen.body.kind, "free_ride");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  setSettings(DEFAULT_SETTINGS);
});
