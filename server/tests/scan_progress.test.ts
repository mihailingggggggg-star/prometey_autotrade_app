/**
 * scan_progress.test.ts — состояние скана для визуализатора (/api/scan/status).
 *
 * Проверяем, что состояние ЧЕСТНОЕ: до скана — пусто и «не запускался»; во время
 * скана running=true и заполнена фаза (сброс синхронный, опрос видит скан сразу);
 * после — «завершено» с итогом, сходящимся с результатом runScan. Плюс живой
 * маршрут GET /api/scan/status (дешёвый, без сети).
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { runScan, getScanStatus, MAX_SCAN_REQUESTS } from "../screener.ts";
import { createServerApp } from "../index.ts";
import { setSettings, DEFAULT_SETTINGS } from "../db.ts";
import { resetWorld } from "./_setup.ts";

test("прогресс: состояние скана честно и доступно", () => {
  resetWorld();
  const s = getScanStatus();
  assert.equal(s.running, false, "когда скан не идёт — running=false");
  // Файлы делят один процесс: скан мог уже отработать в соседнем тесте, поэтому
  // состояние либо «не запускался», либо «завершено» — оба честные.
  assert.ok(s.stage === "не запускался" || s.stage === "завершено", `фаза честная: ${s.stage}`);
  assert.equal(s.budget_total, MAX_SCAN_REQUESTS, "потолок запросов виден наружу");
  assert.ok(s.candidates_total >= 0 && s.candidates_done >= 0 && s.signals_found >= 0);
  assert.equal(typeof s.last_note, "string");
  assert.equal(typeof s.by_layer, "object");
});

test("прогресс: во время скана running=true и фаза, после — итог «завершено»", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);

  const pending = runScan();
  // Состояние сбрасывается СИНХРОННО (до первого await) — опрос сразу видит скан,
  // а не итог прошлого запуска.
  const during = getScanStatus();
  assert.equal(during.running, true, "во время скана running=true");
  assert.ok(during.stage.length > 0, "фаза заполнена словами");
  assert.equal(during.budget_total, MAX_SCAN_REQUESTS);

  const r = await pending;
  const after = getScanStatus();
  assert.equal(after.running, false, "после скана running=false");
  assert.equal(after.stage, "завершено");
  assert.ok(after.candidates_total > 0, "кандидаты найдены в выборке");
  assert.equal(after.candidates_done, after.candidates_total, "в mock без лимита проверены все кандидаты");
  assert.equal(after.signals_found, r.found, "счётчик сигналов сходится с итогом скана");
  assert.ok(after.elapsed_ms >= 0, "прошедшее время измерено");
  assert.equal(typeof after.by_layer, "object", "отбраковка по слоям отдаётся");
  assert.match(after.last_note, /завершено/, "последняя строка говорит о завершении");
});

test("прогресс: GET /api/scan/status отдаёт JSON с running и итогом", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  const server = createServerApp();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const before = (await (await fetch(`${base}/api/scan/status`)).json()) as Record<string, unknown>;
    assert.equal(before.running, false, "эндпоинт живёт и до скана");
    assert.ok("stage" in before && "by_layer" in before && "last_note" in before, "поля визуализатора на месте");

    await fetch(`${base}/api/scan`, { method: "POST" });
    const after = (await (await fetch(`${base}/api/scan/status`)).json()) as Record<string, unknown>;
    assert.equal(after.running, false);
    assert.equal(after.stage, "завершено");
    assert.ok(Number(after.candidates_total) > 0, "итог последнего скана виден после работы");
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
});
