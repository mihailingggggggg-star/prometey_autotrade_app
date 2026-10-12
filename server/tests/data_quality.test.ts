/**
 * data_quality.test.ts — ЧЕСТНОСТЬ И ПРАВДОПОДОБИЕ синтетики демо-контура.
 *
 * Проверяем не факт наличия данных, а их качество:
 *  1) вселенная состоит из ВЫДУМАННЫХ токенов (нет реальных тикеров), адреса —
 *     псевдо-base58 из сида, а не адреса существующих токенов;
 *  2) свечи похожи на настоящие: у большинства баров обе тени, тело меньше
 *     половины диапазона; объём привязан к движению, а не ровный;
 *  3) доходности не гладкие/не периодичные (малая |автокорреляция|, ненулевая
 *     дисперсия);
 *  4) детерминизм: одни данные — один результат при каждом вызове;
 *  5) единство источника: закрытие последней свечи равно mockPrice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mockPrice,
  mockCandles,
  mockProfile,
  mockSymbols,
  refFor,
  tokenRefBySymbol,
  type SourceRef,
} from "../sources/mock.ts";
import type { Candle } from "../../shared/types.ts";

/** Фиксированная эпоха мира → тест не зависит от реальных часов. */
const EPOCH = 1_700_000_000;
const DAY = 86400;

/** Реальные широко известные тикеры — их НЕЛЬЗЯ принимать за выдуманные. */
const REAL_TICKERS = new Set([
  "BONK", "JUP", "JTO", "PYTH", "WIF", "RAY", "ORCA", "TNSR", "DRIFT", "MEW",
  "POPCAT", "BOME", "AERO", "SOL", "USDC", "USDT", "SRM", "MNGO", "SAMO", "STEP",
  "COPE", "ATLAS", "MAPS", "TULIP", "FIDA", "KIN", "GMT", "GST", "SLND", "SHDW",
]);

function candleStats(candles: Candle[]) {
  let n = 0;
  let bothWicks = 0;
  let smallBody = 0;
  const closes: number[] = [];
  const vols: number[] = [];
  const moves: number[] = [];
  for (const [, o, h, l, c, v] of candles) {
    n++;
    const rng = h - l;
    if (rng > 0) {
      if (h > Math.max(o, c) && l < Math.min(o, c)) bothWicks++;
      if (Math.abs(c - o) < rng * 0.5) smallBody++;
    }
    closes.push(c);
    vols.push(v);
    moves.push(Math.abs(c - o) / o);
  }
  return { n, bothWicks: bothWicks / n, smallBody: smallBody / n, closes, vols, moves };
}

function autocorr(closes: number[]): number {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  if (!(varr > 0)) return NaN;
  let cov = 0;
  for (let i = 1; i < rets.length; i++) cov += (rets[i] - mean) * (rets[i - 1] - mean);
  cov /= rets.length;
  return cov / varr;
}

function corr(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let cab = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    cab += (a[i] - ma) * (b[i] - mb);
    sa += (a[i] - ma) ** 2;
    sb += (b[i] - mb) ** 2;
  }
  return cab / Math.sqrt(sa * sb);
}

/* ── 1. Выдуманные токены и псевдо-адреса ── */

test("честность: тикеры вселенной выдуманы, реальных монет нет", () => {
  const symbols = mockSymbols();
  assert.ok(symbols.length >= 20, "во вселенной должно быть достаточно токенов");
  assert.equal(new Set(symbols).size, symbols.length, "символы уникальны");
  for (const sym of symbols) {
    assert.ok(/^[A-Z0-9]{3,10}$/.test(sym), `символ «${sym}» не похож на тикер`);
    assert.ok(!REAL_TICKERS.has(sym), `тикер «${sym}» — реальная монета, а нужен выдуманный`);
  }
  // Прямые проверки: реальные тикеры не должны находиться.
  for (const real of ["BONK", "JUP", "JITO", "PYTH", "WIF"]) {
    assert.equal(tokenRefBySymbol(real), null, `реальный тикер ${real} не должен быть в демо-вселенной`);
  }
});

test("честность: адреса — правдоподобный base58, но не адреса реальных токенов", () => {
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{44}$/;
  const seen = new Set<string>();
  for (let i = 0; i < mockSymbols().length; i++) {
    const ref = refFor(i);
    assert.match(ref.token_addr, B58, "token_addr — base58 из 44 символов");
    assert.match(ref.pair_addr, B58, "pair_addr — base58 из 44 символов");
    assert.notEqual(ref.token_addr, ref.pair_addr, "адрес токена и адрес пары различаются");
    assert.ok(!seen.has(ref.token_addr), "адреса токенов не повторяются");
    seen.add(ref.token_addr);
  }
});

/* ── 2. Правдоподобие свечей ── */

test("качество: у большинства свечей обе тени и тело меньше половины диапазона", () => {
  for (let i = 0; i < mockSymbols().length; i++) {
    const ref: SourceRef = refFor(i);
    // Окно накопления (тренд плоский) — характер баров наиболее честный.
    const candles = mockCandles(ref.token_addr, "1m", 2000, EPOCH - 3600, EPOCH);
    const st = candleStats(candles);
    assert.ok(st.bothWicks > 0.6, `${ref.symbol}: доля свечей с обеими тенями ${st.bothWicks.toFixed(3)} ≤ 0.6`);
    assert.ok(st.smallBody > 0.3, `${ref.symbol}: доля свечей с телом < половины диапазона ${st.smallBody.toFixed(3)} ≤ 0.3`);
  }
});

test("качество: объём не константа и положительно коррелирует с движением", () => {
  for (let i = 0; i < mockSymbols().length; i++) {
    const ref: SourceRef = refFor(i);
    const candles = mockCandles(ref.token_addr, "1m", 2000, EPOCH - 3600, EPOCH);
    const st = candleStats(candles);
    assert.ok(new Set(st.vols).size > st.n * 0.5, `${ref.symbol}: объём почти константа`);
    const c = corr(st.moves, st.vols);
    assert.ok(c > 0.3, `${ref.symbol}: корреляция объёма с |движением| = ${c.toFixed(3)} ≤ 0.3`);
  }
});

/* ── 3. Не гладкие, не периодичные доходности ── */

test("качество: минутные доходности не гладкие — |автокорреляция| мала, дисперсия ненулевая", () => {
  for (let i = 0; i < mockSymbols().length; i++) {
    const ref: SourceRef = refFor(i);
    const candles = mockCandles(ref.token_addr, "1m", 2000, EPOCH - 3600, EPOCH);
    const st = candleStats(candles);
    const ac = autocorr(st.closes);
    assert.ok(Number.isFinite(ac), `${ref.symbol}: у доходностей нулевая дисперсия`);
    assert.ok(Math.abs(ac) < 0.35, `${ref.symbol}: |автокорреляция| = ${Math.abs(ac).toFixed(3)} ≥ 0.35 (гладкая периодичность)`);
  }
});

/* ── 4. Детерминизм ── */

test("детерминизм: два независимых вызова дают идентичный результат", () => {
  const ref = refFor(0);
  const a = mockCandles(ref.token_addr, "1m", 200, EPOCH + 7200, EPOCH);
  const b = mockCandles(ref.token_addr, "1m", 200, EPOCH + 7200, EPOCH);
  assert.deepEqual(a, b, "свечи не детерминированы");
  assert.equal(
    mockPrice(ref.token_addr, EPOCH + 7200, EPOCH),
    mockPrice(ref.token_addr, EPOCH + 7200, EPOCH),
    "цена не детерминирована",
  );
  // Профиль (режим) тоже стабилен.
  assert.deepEqual(mockProfile(ref.token_addr), mockProfile(ref.token_addr));
});

/* ── 5. Единство источника цены ── */

test("единство источника: закрытие последней свечи совпадает с mockPrice", () => {
  for (let i = 0; i < mockSymbols().length; i++) {
    const ref: SourceRef = refFor(i);
    const now = EPOCH + 7200;
    const candles = mockCandles(ref.token_addr, "1m", 300, now, EPOCH);
    const last = candles[candles.length - 1];
    assert.equal(last[4], mockPrice(ref.token_addr, now, EPOCH), `${ref.symbol}: close последней свечи ≠ mockPrice(now)`);
    // И для дневного таймфрейма тоже.
    const d = mockCandles(ref.token_addr, "1d", 30, now, EPOCH);
    assert.equal(d[d.length - 1][4], mockPrice(ref.token_addr, now, EPOCH), `${ref.symbol}: close 1d-свечи ≠ mockPrice(now)`);
  }
});

test("характер: растущий токен доходит до ~x2 за разумное виртуальное время", () => {
  const ref = refFor(0);
  const prof = mockProfile(ref.token_addr);
  assert.equal(prof.mode, "rising", "первый токен вселенной должен быть растущим");
  const start = mockPrice(ref.token_addr, EPOCH, EPOCH);
  let peak = start;
  for (let d = 0; d <= Math.ceil(prof.pumpDays) + 5; d++) {
    peak = Math.max(peak, mockPrice(ref.token_addr, EPOCH + d * DAY, EPOCH));
  }
  assert.ok(peak >= start * 2, `растущий токен не доходит до x2 (${(peak / start).toFixed(2)}x)`);
  assert.ok(peak < start * 5, `разгон слишком велик для Free Riding (${(peak / start).toFixed(2)}x)`);
});
