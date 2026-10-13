/**
 * routes.test.ts — HTTP-роуты на живом сервере (эфемерный порт): health, скан,
 * лента, карточка с checks/indicators, покупка и закрытие позиции, сделки и аналитика.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServerApp } from "../index.ts";
import { resetWorld } from "./_setup.ts";

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

const JSON_HEADERS = { "content-type": "application/json" };

test("роуты: health, scan, signals и покупка/закрытие позиции", async () => {
  resetWorld();
  const server = createServerApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const health = await getJson(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.mode, "mock");

    // ?sync=1 — прежнее синхронное поведение: ждём скан и получаем ScanResult.
    const scan = await getJson(`${base}/api/scan?sync=1`, { method: "POST" });
    assert.equal(scan.status, 200);
    assert.ok(scan.body.found >= 1, "скан должен найти сигналы");
    const signalId = scan.body.ids[0];

    const signals = await getJson(`${base}/api/signals`);
    assert.equal(signals.status, 200);
    assert.ok(Array.isArray(signals.body) && signals.body.length >= 1);

    const detail = await getJson(`${base}/api/signals/${signalId}`);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.checks) && detail.body.checks.length > 0, "checks[] заполнен");
    assert.equal(typeof detail.body.indicators.svd, "number", "indicators{} заполнен");
    assert.equal(typeof detail.body.overview_ru, "string");

    const open = await getJson(`${base}/api/positions/open`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ signal_id: signalId, usd: 50, order_type: "market" }),
    });
    assert.equal(open.status, 200);
    assert.ok(open.body.id > 0);
    assert.equal(open.body.status, "open");

    const close = await getJson(`${base}/api/positions/${open.body.id}/close`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fraction: 1 }),
    });
    assert.equal(close.status, 200);
    assert.equal(close.body.position.status, "closed");
    assert.ok(close.body.fill && close.body.fill.kind === "close");

    const trades = await getJson(`${base}/api/trades`);
    assert.equal(trades.status, 200);
    assert.ok(trades.body.some((t: any) => t.position_id === open.body.id));

    const summary = await getJson(`${base}/api/analytics/summary`);
    assert.equal(summary.status, 200);
    assert.ok(summary.body.trades_count >= 1);
    assert.ok(Array.isArray(summary.body.equity_curve));

    // Несуществующий маршрут — формат ошибки и 404.
    const missing = await getJson(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.equal(typeof missing.body.error.code, "string");
    assert.equal(typeof missing.body.error.message, "string");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
