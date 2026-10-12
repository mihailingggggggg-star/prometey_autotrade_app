/**
 * Логотип токена.
 *
 * В демо-контуре нет ни загруженных картинок, ни ключей к внешним CDN, поэтому
 * знак рисуется из самого тикера: две буквы на градиенте, цвет которого
 * детерминированно выводится из символа. Один и тот же токен всегда получает
 * один и тот же цвет — глаз привязывает место в ленте к монете, а не к
 * случайной заливке.
 */
export function TokenLogo({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const src = (symbol || "?").toUpperCase();
  const hue = [...src].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360;
  return (
    <span
      className="rounded-full flex items-center justify-center font-bold text-white shrink-0 select-none"
      style={{
        width: size, height: size,
        background: `linear-gradient(145deg, hsl(${hue} 62% 44%), hsl(${(hue + 42) % 360} 58% 24%))`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,.18)",
      }}
      aria-hidden
    >
      <span style={{ fontSize: Math.round(size * 0.36), letterSpacing: "-0.02em" }}>
        {src.slice(0, 2)}
      </span>
    </span>
  );
}
