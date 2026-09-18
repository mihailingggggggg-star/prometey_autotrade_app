/**
 * Карточка сделки для соцсетей.
 *
 * Рисуется на канвасе, а не собирается из DOM: снимок DOM в браузере делается
 * только через растеризацию SVG-foreignObject — это тянет шрифты, ломается на
 * `backdrop-filter` (а у нас всё приложение на нём) и даёт разный результат в
 * разных браузерах. Канвас же даёт один и тот же пиксель везде, и картинка
 * получается ровно та, что задумана, а не «как отрисовалось у этого телефона».
 *
 * Формат 1080×1350 (4:5) — вертикаль, которую Instagram, Telegram и X
 * показывают без обрезки. Квадрат обрезался бы в ленте по бокам, а 9:16 не
 * влезает в предпросмотр Telegram.
 *
 * Что на карточке и почему именно это: монета и сторона, результат крупно (то,
 * ради чего картинкой делятся), путь цены от входа до выхода с двумя точками,
 * и внизу — знак с призывом. Ни баланса, ни размера позиции, ни номера счёта:
 * человек делится результатом, а не своим депозитом, и подставлять его под
 * чужой взгляд мы не станем.
 */

import { MARK_BOX, MARK_GRAD, MARK_PATH, WORD_BOX, WORD_PATHS } from "./Logo";

export type ShareTrade = {
  symbol: string;
  side: "long" | "short";
  entry: number;
  exit: number;
  pnlPct: number;      // движение цены В ПОЛЬЗУ сделки, %
  r: number;
  closedAt: number;
  heldMin: number;
};

const W = 1080, H = 1350;

/** Общий рисовальщик: и для картинки, и для превью на экране. */
export function drawShareCard(
  cv: HTMLCanvasElement, t: ShareTrade, candles: { time: number; close: number }[], bot: string,
) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  cv.width = W; cv.height = H;
  const good = t.r >= 0;
  const accent = good ? "#30d158" : "#ff453a";

  /* ── Фон: чёрный с красным свечением снизу — та же сцена, что у иконки
     приложения. Карточка и ярлык должны узнаваться как одно приложение. */
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#111114"); bg.addColorStop(0.55, "#070708"); bg.addColorStop(1, "#000000");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, H + 120, 40, W / 2, H + 120, 760);
  glow.addColorStop(0, "rgba(255,63,82,.55)");
  glow.addColorStop(0.45, "rgba(224,24,52,.22)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  const P = 84;

  /* ── Шапка: знак и надпись ─────────────────────────────────────────── */
  drawMark(ctx, P, 78, 74);
  drawWord(ctx, P + 96, 92, 44, "#ffffff");

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(235,235,245,.5)";
  ctx.font = "500 30px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(new Date(t.closedAt).toLocaleDateString("ru-RU",
    { day: "numeric", month: "long" }), W - P, 118);
  ctx.textAlign = "left";

  /* ── Монета и сторона ──────────────────────────────────────────────── */
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 86px -apple-system, 'SF Pro Display', system-ui, sans-serif";
  const coin = t.symbol.replace("USDT", "");
  ctx.fillText(coin, P, 330);
  const cw = ctx.measureText(coin).width;

  const badge = t.side === "long" ? "LONG" : "SHORT";
  ctx.font = "700 30px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  const bw = ctx.measureText(badge).width + 40;
  roundRect(ctx, P + cw + 26, 288, bw, 50, 25);
  ctx.fillStyle = "rgba(255,255,255,.1)"; ctx.fill();
  ctx.fillStyle = "rgba(235,235,245,.75)";
  ctx.fillText(badge, P + cw + 46, 322);

  /* ── Результат: главное число ──────────────────────────────────────── */
  ctx.fillStyle = accent;
  ctx.font = "700 188px -apple-system, 'SF Pro Display', system-ui, sans-serif";
  const main = `${good ? "+" : ""}${t.pnlPct.toFixed(2)}%`;
  ctx.fillText(main, P, 500);

  ctx.fillStyle = "rgba(235,235,245,.6)";
  ctx.font = "600 38px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(`${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R · ${hold(t.heldMin)} в рынке`, P, 556);

  /* ── Путь цены ─────────────────────────────────────────────────────── */
  drawPath(ctx, candles, t, accent, P, 620, W - P * 2, 380);

  /* ── Вход и выход ──────────────────────────────────────────────────── */
  const y = 1090;
  ctx.font = "500 30px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillStyle = "rgba(235,235,245,.5)";
  ctx.fillText("вход", P, y);
  ctx.fillText("выход", P + 300, y);
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 42px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(fmt(t.entry), P, y + 52);
  ctx.fillText(fmt(t.exit), P + 300, y + 52);

  /* ── Призыв ──────────────────────────────────────────────────────────
     Две строки, а не одна: имя бота бывает длинным (@PROMETHEUS_trade_bot), и
     в одной строке с призывом оно наезжало на него — проверено рендером. */
  ctx.fillStyle = "rgba(255,255,255,.08)";
  roundRect(ctx, P, H - 178, W - P * 2, 122, 28); ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 34px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText("Сделку открыл и закрыл бот", P + 36, H - 126);
  ctx.fillStyle = "#ff5a6a";
  ctx.font = "600 32px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(bot ? `t.me/${bot}` : "PROMETHEUS · автотрейд", P + 36, H - 82);
}

/** Картинка файлом — для «Поделиться» и для сохранения. */
export function shareCardBlob(
  t: ShareTrade, candles: { time: number; close: number }[], bot: string,
): Promise<Blob | null> {
  const cv = document.createElement("canvas");
  drawShareCard(cv, t, candles, bot);
  return new Promise((res) => cv.toBlob((b) => res(b), "image/png", 0.98));
}

/* ── Мелочи рисования ──────────────────────────────────────────────────── */

/** Линия цены от входа до выхода с двумя точками и пунктирами уровней. */
function drawPath(
  ctx: CanvasRenderingContext2D, candles: { time: number; close: number }[],
  t: ShareTrade, accent: string, x0: number, y0: number, w: number, h: number,
) {
  if (candles.length < 2) return;
  const lo = Math.min(...candles.map((c) => c.close), t.entry, t.exit);
  const hi = Math.max(...candles.map((c) => c.close), t.entry, t.exit);
  const span = hi - lo || 1;
  const t0 = candles[0].time, t1 = candles[candles.length - 1].time;
  const px = (ms: number) => x0 + ((ms - t0) / Math.max(t1 - t0, 1)) * w;
  const py = (p: number) => y0 + h - ((p - lo) / span) * h;

  // Заливка под линией — чтобы график читался как площадь, а не как нитка.
  ctx.beginPath();
  ctx.moveTo(px(candles[0].time), py(candles[0].close));
  for (const c of candles) ctx.lineTo(px(c.time), py(c.close));
  const last = candles[candles.length - 1];
  ctx.lineTo(px(last.time), y0 + h);
  ctx.lineTo(px(candles[0].time), y0 + h);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, y0, 0, y0 + h);
  fill.addColorStop(0, hexA(accent, 0.28));
  fill.addColorStop(1, hexA(accent, 0));
  ctx.fillStyle = fill; ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(candles[0].time), py(candles[0].close));
  for (const c of candles) ctx.lineTo(px(c.time), py(c.close));
  ctx.strokeStyle = accent; ctx.lineWidth = 4; ctx.lineJoin = "round"; ctx.stroke();

  // Точки входа и выхода — по времени и цене, как на самом графике.
  const openAt = t.closedAt - t.heldMin * 60000;
  dot(ctx, px(openAt), py(t.entry), "#ffffff");
  dot(ctx, px(t.closedAt), py(t.exit), accent);
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,.75)"; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
}

/** Знак логотипа. Тот же путь, что в интерфейсе, тем же градиентом. */
function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const k = size / MARK_BOX.w;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.translate(-MARK_BOX.x, -MARK_BOX.y);
  const g = ctx.createLinearGradient(
    MARK_BOX.x + MARK_BOX.w * 0.1, MARK_BOX.y - MARK_BOX.h * 0.07,
    MARK_BOX.x + MARK_BOX.w * 0.9, MARK_BOX.y + MARK_BOX.h * 1.07);
  for (const s of MARK_GRAD) g.addColorStop(s.at, s.color);
  ctx.fillStyle = g;
  ctx.fill(new Path2D(MARK_PATH));
  ctx.restore();
}

/** Надпись. Одним цветом — это текст, а не знак. */
function drawWord(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, color: string) {
  const k = h / WORD_BOX.h;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.translate(-WORD_BOX.x, -WORD_BOX.y);
  ctx.fillStyle = color;
  for (const d of WORD_PATHS) ctx.fill(new Path2D(d));
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number,
                   w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const hold = (m: number) =>
  m < 60 ? `${m} мин` : m < 1440 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} д`;

const fmt = (v: number) =>
  v >= 1000 ? v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })
            : v.toPrecision(5).replace(/\.?0+$/, "").replace(".", ",");
