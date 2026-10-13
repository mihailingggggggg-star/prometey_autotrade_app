/**
 * scan_async.test.ts — асинхронный запуск скана (POST /api/scan).
 *
 * Скан длится минутами, и браузер телефона обрывает такой долгий HTTP-ответ
 * (особенно при блокировке экрана), а клиент трактует обрыв как «сервер не
 * отвечает». Поэтому POST /api/scan теперь отвечает СРАЗУ (202), скан идёт в
 * фоне, а итог клиент забирает из GET /api/scan/status (last_result).
 *
 * Проверяем: запуск не ждёт окончания; ?sync=1 сохраняет прежнее поведение
 * (ждёт и отдаёт ScanResult); повторный запуск во время скана не стартует второй
 * и сообщает running:true; last_result появляется после завершения и совпадает с
 * тем, что вернул ?sync=1.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startScan, getScanStatus } from "../screener.ts";
import { createServerApp } from "../index.ts";
import { setSettings, DEFAULT_SETTINGS } from "../db.ts";
import { resetWorld } from "./_setup.ts";
import type { ScanResult } from "../../shared/types.ts";

/** Дождаться конца возможного скана из соседнего теста (файлы делят процесс). */
async function waitIdle(timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (getScanStatus().running) {
    if (Date.now() - t0 > timeoutMs) throw new Error("скан не завершился за отведённое время");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

test("async: startScan возвращает управление сразу, не дожидаясь конца скана", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  await waitIdle();

  const r = startScan();
  assert.equal(r.started, true, "первый запуск стартовал скан");
  assert.equal(r.running, true, "вернули running=true");
  // beginScanState синхронный (до первого await), поэтому сразу после возврата
  // скан УЖЕ идёт — управление к нам вернулось раньше его окончания.
  assert.equal(getScanStatus().running, true, "скан идёт сразу после возврата из startScan");

  // Повторный запуск во время идущего скана НЕ стартует второй скан.
  const r2 = startScan();
  assert.equal(r2.started, false, "повторный запуск не стартует второй скан");
  assert.equal(r2.running, true, "идущий скан виден как running=true");

  await waitIdle();
  const st = getScanStatus();
  assert.equal(st.running, false, "после завершения running=false");
  assert.equal(st.stage, "завершено");
  assert.ok(st.finished_ts > 0, "finished_ts выставлен после завершения");
  assert.ok(st.last_result, "last_result доступен без ожидания");
  assert.equal(st.last_result!.found, st.signals_found, "last_result.found сходится со счётчиком");
});

test("async: POST /api/scan отвечает 202 сразу; ?sync=1 ждёт и отдаёт ScanResult; last_result совпадает", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  await waitIdle();

  const server = createServerApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // 1. Асинхронный запуск: 202 и тело {started, running} — не дожидаясь конца.
    const t0 = Date.now();
    const started = await fetch(`${base}/api/scan`, { method: "POST" });
    const startedMs = Date.now() - t0;
    assert.equal(started.status, 202, "асинхронный запуск отвечает 202");
    const sb = (await started.json()) as { started: boolean; running: boolean };
    assert.equal(sb.started, true, "скан стартовал этим вызовом");
    assert.equal(sb.running, true, "скан идёт");
    assert.ok(startedMs < 5000, `ответ пришёл за ${startedMs} мс, без ожидания скана`);

    // 2. Повторное нажатие во время идущего скана: второй скан не стартует.
    //    Гонки нет: состояние выставляется синхронно до отправки первого 202,
    //    а mock-скан длится дольше кругового HTTP-запроса. Если скан всё же
    //    успел завершиться — это уже честный новый запуск, и мы это признаём.
    if (getScanStatus().running) {
      const again = await getJson(`${base}/api/scan`, { method: "POST" });
      assert.equal(again.status, 202, "повторный запуск тоже 202");
      assert.equal(again.body.running, true, "идyщий скан виден как running=true");
      assert.equal(again.body.started, false, "повторный запуск не стартовал второй скан");
    }

    await waitIdle();

    // 3. Синхронный маршрут сохранён: ждёт скан и отдаёт ScanResult (200).
    const sync = await getJson(`${base}/api/scan?sync=1`, { method: "POST" });
    assert.equal(sync.status, 200, "?sync=1 отвечает 200");
    assert.equal(typeof sync.body.found, "number", "?sync=1 отдаёт ScanResult.found");
    assert.ok(Array.isArray(sync.body.ids), "?sync=1 отдаёт ScanResult.ids");

    // 4. last_result из статуса — тот же ScanResult, что вернул ?sync=1.
    const st = await getJson(`${base}/api/scan/status`);
    assert.equal(st.body.running, false, "после скана running=false");
    assert.ok(st.body.finished_ts > 0, "finished_ts выставлен");
    const last = st.body.last_result as ScanResult | null;
    assert.ok(last, "last_result не пуст после завершения");
    assert.equal(last!.found, sync.body.found, "last_result.found совпадает с ?sync=1");
    assert.deepEqual(last!.ids, sync.body.ids, "last_result.ids совпадает с ?sync=1");
    assert.deepEqual(last!.rejected_by_layer, sync.body.rejected_by_layer, "last_result.rejected_by_layer совпадает с ?sync=1");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
