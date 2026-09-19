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

import { MARK_BODY, MARK_BOX, MARK_EYES, MARK_GRAD, WORD_BOX, WORD_PATHS } from "./Logo";

export type ShareTrade = {
  symbol: string;
  side: "long" | "short";
  entry: number;
  exit: number;
  pnlPct: number;      // движение цены В ПОЛЬЗУ сделки, %
  pnlUsd: number;      // сколько вышло деньгами
  r: number;
  closedAt: number;
  heldMin: number;
};

/**
 * ЧЕМ хвастаться — процентом или деньгами. Две карточки, а не одна с выбором
 * внутри: это разные публикации для разных людей. Процент сравним у всех и
 * ничего не говорит о размере счёта; деньги убедительнее, но показывают, каким
 * объёмом вы торгуете. Решать за человека, что из этого он готов показать
 * подписчикам, мы не вправе — поэтому даём обе и подписываем разницу.
 */
export type ShareKind = "pct" | "usd";

export type ShareEquity = {
  net: number;         // итог периода деньгами
  netR: number;
  n: number; wins: number; loss: number;
  periodLabel: string; // «30 дней», «Всё время» — то, что выбрано сверху
  to: number;          // на какой момент собрана картинка
};

const W = 1080, H = 1350;

/* Свечи для карточки. Те же, что на графике сделки, — полный OHLC: линия
   закрытий прячет фитили, то есть ровно те движения, из-за которых сделка и
   выглядит так, как выглядит. */
export type ShareCandle = { time: number; open: number; high: number; low: number; close: number };

/** Общий рисовальщик: и для картинки, и для превью на экране. */
export function drawShareCard(
  cv: HTMLCanvasElement, t: ShareTrade, candles: ShareCandle[], bot: string,
  kind: ShareKind = "pct",
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
  const main = kind === "usd"
    ? `${t.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(t.pnlUsd).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${good ? "+" : ""}${t.pnlPct.toFixed(2)}%`;
  /* Кегль подбираем ПОД СТРОКУ, а не задаём числом: «+$1 284,50» длиннее
     «+4.85%» почти вдвое, и фиксированный размер уводил бы его за поле. */
  ctx.fillStyle = accent;
  ctx.font = fitFont(ctx, main, W - P * 2, 188, "700", "SF Pro Display");
  ctx.fillText(main, P, 500);

  // Вторая величина — подписью: карточка про процент всё равно обязана
  // сказать, сколько это денег, и наоборот. Прячем одно ради другого только
  // в размере, а не в наличии.
  const second = kind === "usd"
    ? `${good ? "+" : ""}${t.pnlPct.toFixed(2)}%`
    : `${t.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(t.pnlUsd).toFixed(2)}`;
  ctx.fillStyle = "rgba(235,235,245,.6)";
  ctx.font = "600 38px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(`${second} · ${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R · ${hold(t.heldMin)} в рынке`, P, 556);

  /* ── Свечи с точками входа и выхода ────────────────────────────────── */
  drawCandles(ctx, candles, t, accent, P, 626, W - P * 2, 376);

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
  t: ShareTrade, candles: ShareCandle[], bot: string, kind: ShareKind = "pct",
): Promise<Blob | null> {
  const cv = document.createElement("canvas");
  drawShareCard(cv, t, candles, bot, kind);
  return new Promise((res) => cv.toBlob((b) => res(b), "image/png", 0.98));
}

/**
 * Карточка КУМУЛЯТИВНОЙ ПРИБЫЛИ за период.
 *
 * Отличается от карточки сделки не оформлением, а предметом: там одна сделка и
 * её путь, тут — кривая счёта и то, из чего она сложилась. Поэтому здесь
 * уместен винрейт и число сделок (у одной сделки их нет вовсе) и неуместны
 * вход с выходом.
 *
 * Депозита на карточке нет и не будет: кривая показана ОТ НУЛЯ, то есть только
 * заработанное. Человек делится результатом, а не размером своего счёта.
 */
export function drawEquityCard(
  cv: HTMLCanvasElement, e: ShareEquity, points: { x: number; y: number }[],
  bot: string, kind: ShareKind = "usd",
) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  cv.width = W; cv.height = H;
  const good = e.net >= 0;
  const accent = good ? "#30d158" : "#ff453a";

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#111114"); bg.addColorStop(0.55, "#070708"); bg.addColorStop(1, "#000000");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, H + 120, 40, W / 2, H + 120, 760);
  glow.addColorStop(0, "rgba(255,63,82,.55)");
  glow.addColorStop(0.45, "rgba(224,24,52,.22)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  const P = 84;
  drawMark(ctx, P, 78, 74);
  drawWord(ctx, P + 96, 92, 44, "#ffffff");
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(235,235,245,.5)";
  ctx.font = "500 30px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(new Date(e.to).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }), W - P, 118);
  ctx.textAlign = "left";

  ctx.fillStyle = "rgba(235,235,245,.55)";
  ctx.font = "600 34px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText("КУМУЛЯТИВНАЯ ПРИБЫЛЬ", P, 252);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 62px -apple-system, 'SF Pro Display', system-ui, sans-serif";
  ctx.fillText(e.periodLabel, P, 330);

  const main = kind === "pct"
    ? `${good ? "+" : ""}${e.netR.toFixed(2)}R`
    : `${good ? "+" : "−"}$${Math.abs(e.net).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  ctx.fillStyle = accent;
  ctx.font = fitFont(ctx, main, W - P * 2, 176);
  ctx.fillText(main, P, 500);

  const second = kind === "pct"
    ? `${good ? "+" : "−"}$${Math.abs(e.net).toFixed(2)}`
    : `${good ? "+" : ""}${e.netR.toFixed(2)}R`;
  const decided = e.wins + e.loss;
  const wr = decided ? Math.round((e.wins / decided) * 100) : null;
  ctx.fillStyle = "rgba(235,235,245,.6)";
  ctx.font = "600 38px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(`${second} · ${e.n} ${plural(e.n, "сделка", "сделки", "сделок")}`
    + (wr === null ? "" : ` · винрейт ${wr}%`), P, 556);

  drawEquity(ctx, points, accent, P, 626, W - P * 2, 376);

  /* Подписи внизу — про СОСТАВ результата, а не про счёт. */
  const y = 1090;
  ctx.font = "500 30px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillStyle = "rgba(235,235,245,.5)";
  ctx.fillText("в плюс", P, y);
  ctx.fillText("в минус", P + 300, y);
  ctx.font = "600 42px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillStyle = "#30d158"; ctx.fillText(String(e.wins), P, y + 52);
  ctx.fillStyle = "#ff453a"; ctx.fillText(String(e.loss), P + 300, y + 52);

  ctx.fillStyle = "rgba(255,255,255,.08)";
  roundRect(ctx, P, H - 178, W - P * 2, 122, 28); ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 34px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText("Все сделки открыл и закрыл бот", P + 36, H - 126);
  ctx.fillStyle = "#ff5a6a";
  ctx.font = "600 32px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.fillText(bot ? `t.me/${bot}` : "PROMETHEUS · автотрейд", P + 36, H - 82);
}

export function equityCardBlob(
  e: ShareEquity, points: { x: number; y: number }[], bot: string, kind: ShareKind = "usd",
): Promise<Blob | null> {
  const cv = document.createElement("canvas");
  drawEquityCard(cv, e, points, bot, kind);
  return new Promise((res) => cv.toBlob((b) => res(b), "image/png", 0.98));
}

/** Кривая накопленного результата. Ноль подписан: без него провал под ноль
 *  читается как «просто пониже», а это совсем другое состояние счёта. */
function drawEquity(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[],
                    accent: string, x0: number, y0: number, w: number, h: number) {
  if (pts.length < 2) return;
  const PADY = 36;
  const ys = pts.map((p) => p.y);
  const lo = Math.min(...ys, 0), hi = Math.max(...ys, 0);
  const span = (hi - lo) || 1;
  const t0 = pts[0].x, t1 = pts[pts.length - 1].x;
  /* Правый край поджат на радиус точки: последняя точка стоит ровно на конце
     кривой, и без отступа её обрезало бы полем карточки. */
  const DOT = 18;
  const px = (v: number) => x0 + ((v - t0) / Math.max(t1 - t0, 1)) * (w - DOT);
  const py = (v: number) => y0 + PADY + (h - PADY * 2) - ((v - lo) / span) * (h - PADY * 2);

  const zero = py(0);
  ctx.setLineDash([8, 10]); ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(235,235,245,.26)";
  ctx.beginPath(); ctx.moveTo(x0, zero); ctx.lineTo(x0 + w, zero); ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(px(pts[0].x), py(pts[0].y));
  for (const p of pts) ctx.lineTo(px(p.x), py(p.y));
  ctx.lineTo(px(t1), zero);
  ctx.lineTo(px(t0), zero);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, y0, 0, y0 + h);
  fill.addColorStop(0, hexA(accent, 0.3));
  fill.addColorStop(1, hexA(accent, 0));
  ctx.fillStyle = fill; ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(pts[0].x), py(pts[0].y));
  for (const p of pts) ctx.lineTo(px(p.x), py(p.y));
  ctx.strokeStyle = accent; ctx.lineWidth = 5;
  ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();

  const last = pts[pts.length - 1];
  dot(ctx, px(last.x), py(last.y), accent);
}

const plural = (n: number, a: string, b: string, c: string) => {
  const m = Math.abs(n) % 100, d = m % 10;
  if (m > 10 && m < 20) return c;
  if (d > 1 && d < 5) return b;
  return d === 1 ? a : c;
};

/* ── Мелочи рисования ──────────────────────────────────────────────────── */

/**
 * Свечи сделки с точками входа и выхода и линейкой расстояния.
 *
 * СВЕЧИ, А НЕ ЛИНИЯ. Линия закрытий прячет фитили — то есть ровно те движения,
 * из-за которых сделка и выглядит так, как выглядит: заход под стоп, прокол
 * цели, тонкий хвост на входе. Карточкой делятся с людьми, которые читают
 * графики, и нарисованная нитка вместо свечей читается как приукрашивание.
 *
 * МАСШТАБ СЧИТАЕТСЯ ПО ВСЕМУ, ЧТО НАДО ПОКАЗАТЬ, и зажимается в отведённую
 * коробку: и хай/лой свечей, и вход, и выход. Раньше график строился по
 * закрытиям, и уровень, выходящий за них, уезжал за край — а вместе с ним и
 * подпись. Поля сверху и снизу оставлены под подписи точек, чтобы они не
 * наезжали ни на текст карточки, ни на сами свечи.
 */
function drawCandles(
  ctx: CanvasRenderingContext2D, candles: ShareCandle[], t: ShareTrade,
  accent: string, x0: number, y0: number, w: number, h: number,
) {
  if (candles.length < 2) return;
  const PADY = 46;                       // поля под подписи точек внутри коробки
  const lo = Math.min(...candles.map((c) => c.low), t.entry, t.exit);
  const hi = Math.max(...candles.map((c) => c.high), t.entry, t.exit);
  const span = (hi - lo) || 1;
  const t0 = candles[0].time, t1 = candles[candles.length - 1].time;
  const px = (ms: number) => x0 + ((ms - t0) / Math.max(t1 - t0, 1)) * w;
  const py = (p: number) => y0 + PADY + (h - PADY * 2) - ((p - lo) / span) * (h - PADY * 2);

  const step = w / candles.length;
  const bw = Math.max(2, Math.min(18, step * 0.62));
  const UP = "rgba(48,209,88,.85)", DOWN = "rgba(255,69,58,.85)";

  for (const c of candles) {
    const x = px(c.time);
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? UP : DOWN;
    ctx.lineWidth = Math.max(1.5, bw * 0.18);
    ctx.beginPath(); ctx.moveTo(x, py(c.high)); ctx.lineTo(x, py(c.low)); ctx.stroke();
    const yo = py(c.open), yc = py(c.close);
    ctx.fillStyle = up ? UP : DOWN;
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(2, Math.abs(yc - yo)));
  }

  /* Точки входа и выхода — по ОБЕИМ осям: время и цена. Подпись ставится с той
     стороны, где есть место, иначе у края она обрезалась бы. */
  const openAt = t.closedAt - t.heldMin * 60000;
  const xe = clamp(px(openAt), x0 + 6, x0 + w - 6), ye = py(t.entry);
  const xx = clamp(px(t.closedAt), x0 + 6, x0 + w - 6), yx = py(t.exit);

  ctx.setLineDash([8, 10]); ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(235,235,245,.28)";
  ctx.beginPath(); ctx.moveTo(x0, ye); ctx.lineTo(x0 + w, ye); ctx.stroke();
  ctx.strokeStyle = hexA(accent, 0.38);
  ctx.beginPath(); ctx.moveTo(x0, yx); ctx.lineTo(x0 + w, yx); ctx.stroke();
  ctx.setLineDash([]);

  drawRuler(ctx, xe, ye, xx, yx, accent, t.pnlPct, x0, x0 + w);

  dot(ctx, xe, ye, "#ffffff");
  dot(ctx, xx, yx, accent);
  tag(ctx, "вход", xe, ye, x0, x0 + w, "rgba(235,235,245,.75)");
  tag(ctx, "выход", xx, yx, x0, x0 + w, accent);
}

/**
 * Линейка расстояния — строго ВЕРТИКАЛЬНАЯ, как на графике закрытой сделки.
 * По диагонали от точки к точке она мерила бы заодно и время, а время тут
 * подписано отдельно; вертикаль отвечает ровно на один вопрос — насколько
 * ушла цена. Сторону выбираем ту, где есть место.
 */
function drawRuler(ctx: CanvasRenderingContext2D, xe: number, ye: number,
                   xx: number, yx: number, accent: string, pct: number,
                   left: number, right: number) {
  const GAP = 46;
  const x = xx + GAP < right - 40 ? xx + GAP : Math.max(left + 40, xx - GAP);
  const top = Math.min(ye, yx), bot = Math.max(ye, yx);
  if (bot - top < 26) return;             // мерить нечего — не рисуем ничего

  ctx.strokeStyle = hexA(accent, 0.75);
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
  for (const y of [top, bot]) {
    ctx.beginPath(); ctx.moveTo(x - 13, y); ctx.lineTo(x + 13, y); ctx.stroke();
  }

  const label = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  ctx.font = "700 30px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  const lw = ctx.measureText(label).width + 26;
  const lx = clamp(x - lw / 2, left, right - lw);
  roundRect(ctx, lx, (top + bot) / 2 - 22, lw, 44, 14);
  ctx.fillStyle = "rgba(0,0,0,.72)"; ctx.fill();
  ctx.fillStyle = accent;
  ctx.textAlign = "center";
  ctx.fillText(label, lx + lw / 2, (top + bot) / 2 + 10);
  ctx.textAlign = "left";
}

/** Подпись у точки — НА ПОДЛОЖКЕ.
 *
 *  Без подложки она ложится прямо на свечи: «выход» зелёным поверх зелёных
 *  тел не читается вовсе (проверено рендером). Тёмная плашка отделяет подпись
 *  от графика, не пряча его. Сторона выбирается та, где есть место. */
function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
             left: number, right: number, color: string) {
  ctx.font = "600 26px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  const tw = ctx.measureText(text).width;
  const pad = 14, bw = tw + pad * 2, bh = 38;
  const bx = x + 24 + bw < right ? x + 24 : Math.max(left, x - 24 - bw);
  roundRect(ctx, bx, y - bh / 2, bw, bh, 12);
  ctx.fillStyle = "rgba(0,0,0,.66)"; ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, bx + pad, y + 9);
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Подобрать кегль так, чтобы строка влезла в ширину. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, max: number,
                 size: number, weight = "700", family = "SF Pro Display"): string {
  let px = size;
  for (; px > 60; px -= 4) {
    ctx.font = `${weight} ${px}px -apple-system, '${family}', system-ui, sans-serif`;
    if (ctx.measureText(text).width <= max) break;
  }
  return ctx.font;
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
  ctx.fill(new Path2D(MARK_BODY));
  // Белки — поверх тела, как в интерфейсе. Зрачки остаются градиентными:
  // это дырки внутри самих белков.
  ctx.fillStyle = "#fff";
  ctx.fill(new Path2D(MARK_EYES));
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
