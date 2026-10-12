/**
 * screener.test.ts — воронка слоёв 1–5.
 * Проверяем: при дефолтах скан находит сигналы; ужесточённые из настроек
 * ликвидность/возраст реально срезают воронку (ползунки влияют на результат).
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { runScan } from "../screener.ts";
import { setSettings, DEFAULT_SETTINGS } from "../db.ts";
import { resetWorld } from "./_setup.ts";

test("воронка: при дефолтных настройках скан находит сигналы", async () => {
  resetWorld();
  setSettings(DEFAULT_SETTINGS);
  const r = await runScan();
  assert.ok(r.found >= 3, `ожидали >=3 сигнала, получили ${r.found}`);
  assert.equal(r.ids.length, r.found);
  // диагностика отбраковки присутствует
  assert.ok("rejected_by_layer" in r);
});

test("воронка: ужесточённая ликвидность из настроек срезает все сигналы", async () => {
  resetWorld();
  setSettings({ ...DEFAULT_SETTINGS, screener: { ...DEFAULT_SETTINGS.screener, liq_min: 20000, liq_max: 20001 } });
  const r = await runScan();
  assert.equal(r.found, 0, "при узком окне ликвидности сигналов быть не должно");
  assert.ok(r.rejected_by_layer["3"] >= 1, "слой 3 должен отметить отбраковку");
  setSettings(DEFAULT_SETTINGS); // вернуть дефолты для других тестов
});

test("воронка: ужесточённый возраст из настроек срезает все сигналы", async () => {
  resetWorld();
  setSettings({ ...DEFAULT_SETTINGS, screener: { ...DEFAULT_SETTINGS.screener, age_min: 30, age_max: 31 } });
  const r = await runScan();
  assert.equal(r.found, 0);
  setSettings(DEFAULT_SETTINGS);
});
