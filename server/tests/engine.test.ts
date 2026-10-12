/**
 * engine.test.ts — демо-движок: Free Riding, издержки, идемпотентность алертов,
 * time-stop. Виртуальные часы двигаем вручную через advance().
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { runScan } from "../screener.ts";
import { setSettings, DEFAULT_SETTINGS, getDb } from "../db.ts";
import { openPosition, advance, listPositions } from "../demo.ts";
import type { Fill, Position } from "../../shared/types.ts";
import { resetWorld } from "./_setup.ts";

function findPosition(list: Position[], id: number): Position {
  const p = list.find((x) => x.id === id);
  assert.ok(p, `позиция ${id} не найдена`);
  return p;
}

test("движок: Free Riding фиксирует ровно 50% объёма, статус free_ride, алерт не дублируется", async () => {
  // Крупный тик, чтобы разгон 3–10 дней уложился в разумное число шагов.
  resetWorld();
  setSettings({ ...DEFAULT_SETTINGS, demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 360 } });
  const scan = await runScan();
  assert.ok(scan.ids.length >= 1, "нужен хотя бы один сигнал");
  const signalId = scan.ids[0];

  // Цель 2 намеренно недостижима (11x): тест про Free Riding, а не про закрытие
  // остатка — иначе линия ТП совпала бы с триггером и позиция закрылась бы сразу.
  const pos = await openPosition({ signal_id: signalId, usd: 100, order_type: "market", tp_percent: 1000 });
  assert.equal(pos.status, "open");
  const originalQty = pos.qty;
  assert.ok(originalQty > 0);

  let current = pos;
  for (let i = 0; i < 80 && !current.free_ride_done; i++) {
    await advance();
    current = findPosition(await listPositions(), pos.id);
  }
  assert.ok(current.free_ride_done, "Free Riding должен сработать при +100%");
  assert.equal(current.status, "free_ride");

  const db = getDb();
  const tp50 = db
    .prepare("SELECT * FROM fills WHERE position_id=? AND kind='tp_50'")
    .all(pos.id) as unknown as Fill[];
  assert.equal(tp50.length, 1, "должна быть ровно одна фиксация tp_50");
  assert.ok(Math.abs(tp50[0].qty - originalQty * 0.5) < originalQty * 1e-6, "зафиксировано ровно 50% объёма");
  assert.ok(tp50[0].fee_usd + tp50[0].slippage_usd > 0, "издержки выхода вычтены из результата");
  assert.ok(current.realized_usd > 0, "капитал вернулся (realized > 0)");

  const freeRideAlerts = db
    .prepare("SELECT * FROM alerts WHERE position_id=? AND kind='free_ride'")
    .all(pos.id);
  assert.equal(freeRideAlerts.length, 1, "алерт free_ride создан один раз");

  // Дополнительные тики не должны плодить дубли алерта.
  for (let i = 0; i < 5; i++) await advance();
  const again = db.prepare("SELECT * FROM alerts WHERE position_id=? AND kind='free_ride'").all(pos.id);
  assert.equal(again.length, 1, "повторный вызов не дублирует алерт");
});

test("движок: time-stop даёт алерт после положенного числа виртуальных дней", async () => {
  resetWorld();
  setSettings({ ...DEFAULT_SETTINGS, demo: { ...DEFAULT_SETTINGS.demo, time_stop_days: 14, tick_minutes: 720 } });
  const scan = await runScan();
  // Цель 2 недостижима: позиция должна ДОЖИТЬ до time-stop, а не закрыться на ТП.
  const pos = await openPosition({ signal_id: scan.ids[0], usd: 50, order_type: "market", tp_percent: 1000 });

  // 14 дней = 28 тиков по 720 минут; гоняем с запасом.
  for (let i = 0; i < 30; i++) await advance();

  const db = getDb();
  const tsAlerts = db
    .prepare("SELECT * FROM alerts WHERE position_id=? AND kind='time_stop'")
    .all(pos.id);
  assert.ok(tsAlerts.length >= 1, "после срока должен появиться алерт time_stop");

  setSettings(DEFAULT_SETTINGS); // вернуть дефолты
});

test("движок: liquidity drain даёт critical-алерт при просадке пула", async () => {
  resetWorld();
  setSettings({ ...DEFAULT_SETTINGS, demo: { ...DEFAULT_SETTINGS.demo, tick_minutes: 720 } });
  const scan = await runScan();
  // Токен с утечкой ликвидности — JTO (DRAIN_INDEX): ищем его сигнал.
  const db = getDb();
  const drainSignal = db
    .prepare("SELECT id, token_addr FROM signals WHERE symbol='JTO' ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  const signalId = drainSignal ? drainSignal.id : scan.ids[0];
  const pos = await openPosition({ signal_id: signalId, usd: 50, order_type: "market" });

  for (let i = 0; i < 30; i++) await advance();

  const alerts = db
    .prepare("SELECT * FROM alerts WHERE position_id=? AND kind='liq_drain'")
    .all(pos.id) as unknown as { severity: string }[];
  assert.ok(alerts.length >= 1, "при сильной просадке ликвидности должен быть алерт liq_drain");
  assert.equal(alerts[0].severity, "critical");
  setSettings(DEFAULT_SETTINGS);
});
