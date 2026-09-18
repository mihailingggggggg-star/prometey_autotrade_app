/**
 * Рыночные данные — НАСТОЯЩИЕ, с публичного API Bybit.
 *
 * Почему именно Bybit: бот торгует там же, значит цена в интерфейсе и цена, по
 * которой исполнится ордер, — одна и та же. Любой другой источник (CoinGecko,
 * Binance) показывал бы соседний рынок: на мелких монетах расхождение доходит
 * до процентов, и человек видел бы PnL, которого у него нет.
 *
 * Публичные эндпоинты Bybit не требуют ключа и отдают CORS-заголовки, поэтому
 * мини-апп ходит к бирже напрямую, без нашего сервера. Ключи здесь не нужны и
 * не используются: это read-only рыночные данные.
 *
 * Два канала:
 *   REST  /v5/market/kline, /v5/market/tickers — история и первый снимок;
 *   WS    wss://stream.bybit.com/v5/public/linear — тики и живая свеча.
 * REST нужен обоим: WS отдаёт только изменения, и без снимка первые секунды
 * экран был бы пустым.
 */

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type Ticker = { last: number; pct24h: number; high24h: number; low24h: number; ts: number };
export type Feed = "live" | "connecting" | "offline";

/** Зеркало на случай, если основной хост недоступен у провайдера. */
const HOSTS = ["https://api.bybit.com", "https://api.bytick.com"];
const WS_URL = "wss://stream.bybit.com/v5/public/linear";

export const INTERVALS = [
  { id: "5", label: "5м" },
  { id: "15", label: "15м" },
  { id: "60", label: "1ч" },
  { id: "240", label: "4ч" },
] as const;
export type Interval = (typeof INTERVALS)[number]["id"];

/* ── REST ─────────────────────────────────────────────────────────────────── */

let host = 0;

async function api(path: string): Promise<any> {
  // Ходим по хостам по кругу: сеть могла отвалиться у одного, а не у биржи.
  for (let i = 0; i < HOSTS.length; i++) {
    const h = HOSTS[(host + i) % HOSTS.length];
    try {
      const r = await fetch(h + path, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.retCode !== 0) throw new Error(j.retMsg || "bybit error");
      host = (host + i) % HOSTS.length;
      return j.result;
    } catch (e) {
      if (i === HOSTS.length - 1) throw e;
    }
  }
}

/** Свечи. Bybit отдаёт от новых к старым — переворачиваем: график ждёт по
 *  возрастанию времени и на обратном порядке молча рисует пустоту. */
export async function fetchCandles(symbol: string, interval: Interval, limit = 200): Promise<Candle[]> {
  const r = await api(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return (r.list as string[][])
    .map((k) => ({
      time: Math.floor(+k[0] / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    }))
    .reverse();
}

/** Свечи ЗА ОТРЕЗОК — для закрытой сделки: её окно давно уехало от «последних
 *  200 свечей», и без границ график показывал бы сегодняшний рынок вместо той
 *  сделки, которую открыли посмотреть. */
export async function fetchRange(symbol: string, interval: Interval,
                                 startMs: number, endMs: number): Promise<Candle[]> {
  const r = await api(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}`
    + `&start=${Math.floor(startMs)}&end=${Math.ceil(endMs)}&limit=1000`);
  return (r.list as string[][])
    .map((k) => ({
      time: Math.floor(+k[0] / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    }))
    .reverse();
}

export async function fetchTicker(symbol: string): Promise<Ticker | null> {
  const r = await api(`/v5/market/tickers?category=linear&symbol=${symbol}`);
  const t = r.list?.[0];
  if (!t) return null;
  return {
    last: +t.lastPrice, pct24h: +t.price24hPcnt * 100,
    high24h: +t.highPrice24h, low24h: +t.lowPrice24h, ts: Date.now(),
  };
}

/** Шаг цены инструмента — по числу знаков в последней цене. Нужен графику:
 *  с precision по умолчанию (2 знака) монета за $0.0143 рисуется прямой. */
export function decimalsOf(v: number | string): number {
  const s = String(v);
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(8, s.length - i - 1);
}

/* ── WebSocket ────────────────────────────────────────────────────────────── */

type Handler = (data: any, type: string) => void;

const subs = new Map<string, Set<Handler>>();
const feedWatchers = new Set<(f: Feed) => void>();
let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let feed: Feed = "connecting";

export const feedState = () => feed;
export function onFeed(cb: (f: Feed) => void) {
  feedWatchers.add(cb);
  return () => feedWatchers.delete(cb);
}
function setFeed(f: Feed) {
  if (f === feed) return;
  feed = f;
  feedWatchers.forEach((cb) => cb(f));
}

function send(op: "subscribe" | "unsubscribe", args: string[]) {
  if (ws?.readyState === WebSocket.OPEN && args.length) ws.send(JSON.stringify({ op, args }));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setFeed("connecting");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    attempt = 0;
    setFeed("live");
    send("subscribe", [...subs.keys()]);
    // Bybit рвёт молчащее соединение через 20с — своё «жив» шлём сами.
    pingTimer = setInterval(() => ws?.send(JSON.stringify({ op: "ping" })), 18000);
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (!m.topic) return;
    subs.get(m.topic)?.forEach((h) => h(m.data, m.type));
  };

  const down = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
    setFeed("offline");
    if (!subs.size) return;
    // Разрыв — не событие рынка. Экспоненциальная пауза, потолок 20с: так
    // мини-апп переживает переезд из метро в лифт, не устраивая шторм запросов.
    const wait = Math.min(20000, 800 * 2 ** attempt++);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, wait);
  };
  ws.onclose = down;
  ws.onerror = () => ws?.close();
}

/** Подписка на топик с подсчётом ссылок: один экран может открыть тот же тикер
 *  дважды (карточка и деталь), и отписка одного не должна гасить второго. */
export function subscribe(topic: string, h: Handler): () => void {
  let set = subs.get(topic);
  if (!set) {
    set = new Set();
    subs.set(topic, set);
    send("subscribe", [topic]);
  }
  set.add(h);
  connect();
  return () => {
    const s = subs.get(topic);
    if (!s) return;
    s.delete(h);
    if (!s.size) { subs.delete(topic); send("unsubscribe", [topic]); }
  };
}

/* Вкладку свернули — соединение биржа рвёт сама, а браузер замораживает
   таймеры. Возвращаемся — проверяем и поднимаем заново, иначе экран показывал
   бы застывшую цену как настоящую. */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && subs.size) connect();
  });
}
