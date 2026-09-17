export const money = (v: number, sign = false) =>
  (sign && v > 0 ? "+" : v < 0 ? "−" : "") +
  "$" + Math.abs(v).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const pct = (v: number, sign = true) =>
  (sign && v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";

export const rr = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "R";

/** Цена монеты: дешёвые монеты нельзя схлопывать в «0.00». */
export const price = (v: number) => {
  if (!v) return "—";
  const d = v >= 100 ? 2 : v >= 1 ? 4 : v >= 0.01 ? 5 : 8;
  return v.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const ago = (ts: number) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} д назад`;
};

export const dt = (ts: number) =>
  new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const plural = (n: number, a: string, b: string, c: string) => {
  const x = Math.abs(n) % 100, y = x % 10;
  if (x > 10 && x < 20) return c;
  if (y > 1 && y < 5) return b;
  if (y === 1) return a;
  return c;
};
