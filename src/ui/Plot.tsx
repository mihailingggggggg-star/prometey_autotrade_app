/**
 * Plot — графики аналитики: линия и столбики, оба с наведением.
 *
 * Свой SVG, а не lightweight-charts: там ось X — время биржи и свечная модель,
 * а здесь по X может быть день, час суток, корзина R или монета. Натягивать
 * свечной график на «винрейт по дням» — больше кода, чем нарисовать полсотни
 * линий самому.
 *
 * Координаты считаем в ПИКСЕЛЯХ по измеренной ширине, а не в viewBox с
 * растяжением: при растяжении подпись и точка расходятся с пальцем, а наведение
 * тут главное — цифры читают именно так.
 */

import { useEffect, useRef, useState } from "react";

export type Pt = { x: number; y: number; label?: string };

const PAD = { l: 2, r: 2, t: 8, b: 14 };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const fit = () => setW(ref.current?.clientWidth || 320);
    fit();
    const ro = new ResizeObserver(fit);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

/** Линия с заливкой. Для кумулятивной прибыли и любых «как менялось со
 *  временем». Наведение показывает точку и подпись. */
export function LinePlot({ data, height = 140, color, fmt, xfmt, zero }: {
  data: Pt[]; height?: number; color?: string;
  fmt: (v: number) => string; xfmt?: (v: number) => string; zero?: boolean;
}) {
  const { ref, w } = useWidth();
  const [hi, setHi] = useState<number | null>(null);
  if (data.length < 2) {
    return (
      <div ref={ref} className="flex items-center justify-center text-[12px]"
           style={{ height, color: "var(--label-3)" }}>
        мало данных — нужно хотя бы две точки
      </div>
    );
  }
  const lo = Math.min(...data.map((p) => p.y), zero ? 0 : Infinity);
  const up = Math.max(...data.map((p) => p.y), zero ? 0 : -Infinity);
  const H = height - PAD.t - PAD.b;
  const X = (i: number) => PAD.l + (i * (w - PAD.l - PAD.r)) / (data.length - 1);
  const Y = (v: number) => PAD.t + H - ((v - lo) / (up - lo || 1)) * H;
  const line = data.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const area = `${line} L${X(data.length - 1).toFixed(1)},${height - PAD.b} L${X(0).toFixed(1)},${height - PAD.b} Z`;
  const good = data[data.length - 1].y >= data[0].y;
  const c = color || (good ? "var(--green)" : "var(--red)");
  const cur = hi == null ? null : data[hi];

  return (
    <div ref={ref} className="relative select-none" style={{ height }}>
      <svg width={w} height={height}
           onPointerMove={(e) => {
             const r = (e.currentTarget as SVGElement).getBoundingClientRect();
             const rel = (e.clientX - r.left - PAD.l) / Math.max(1, w - PAD.l - PAD.r);
             setHi(Math.max(0, Math.min(data.length - 1, Math.round(rel * (data.length - 1)))));
           }}
           onPointerLeave={() => setHi(null)}>
        <defs>
          <linearGradient id="plotFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c} stopOpacity="0.28" />
            <stop offset="100%" stopColor={c} stopOpacity="0" />
          </linearGradient>
        </defs>
        {zero && lo < 0 && up > 0 && (
          <line x1={PAD.l} x2={w - PAD.r} y1={Y(0)} y2={Y(0)}
                stroke="var(--label-3)" strokeWidth="1" strokeDasharray="3 3" />
        )}
        <path d={area} fill="url(#plotFill)" />
        <path d={line} fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={X(data.length - 1)} cy={Y(data[data.length - 1].y)} r="3.5" fill={c} />
        {cur && (
          <>
            <line x1={X(hi!)} x2={X(hi!)} y1={PAD.t} y2={height - PAD.b}
                  stroke="var(--label-3)" strokeWidth="1" />
            <circle cx={X(hi!)} cy={Y(cur.y)} r="4.5" fill={c} stroke="var(--bg)" strokeWidth="2" />
          </>
        )}
      </svg>
      {/* Подпись под пальцем — обычным div: текст в SVG не переносится и не
          умеет стекло, а читать её нужно именно как подпись. */}
      {cur && (
        <div className="absolute top-0 px-2 py-[3px] rounded-[9px] text-[11px] font-semibold
                        tabular-nums glass-lens pointer-events-none whitespace-nowrap"
             style={{ left: Math.min(Math.max(X(hi!) - 40, 0), Math.max(0, w - 92)) }}>
          {fmt(cur.y)}
          {(cur.label || xfmt) && (
            <span style={{ color: "var(--label-2)" }}> · {cur.label || xfmt!(cur.x)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Столбики. Годится и для значений со знаком (прибыль по дням), и для
 *  количеств (сделок в день, распределение R). */
export function BarPlot({ data, height = 140, fmt, good }: {
  data: { label: string; y: number; good?: boolean }[]; height?: number;
  fmt: (v: number) => string; good?: string;
}) {
  const { ref, w } = useWidth();
  const [hi, setHi] = useState<number | null>(null);
  if (!data.length) {
    return (
      <div ref={ref} className="flex items-center justify-center text-[12px]"
           style={{ height, color: "var(--label-3)" }}>нет данных</div>
    );
  }
  const vals = data.map((d) => d.y);
  const up = Math.max(...vals, 0), lo = Math.min(...vals, 0);
  const H = height - PAD.t - PAD.b;
  const step = (w - PAD.l - PAD.r) / data.length;
  const bw = Math.max(2, Math.min(22, step * 0.62));
  const Y = (v: number) => PAD.t + H - ((v - lo) / (up - lo || 1)) * H;
  const y0 = Y(0);
  const cur = hi == null ? null : data[hi];

  return (
    <div ref={ref} className="relative select-none" style={{ height }}>
      <svg width={w} height={height}
           onPointerMove={(e) => {
             const r = (e.currentTarget as SVGElement).getBoundingClientRect();
             setHi(Math.max(0, Math.min(data.length - 1,
               Math.floor((e.clientX - r.left - PAD.l) / step))));
           }}
           onPointerLeave={() => setHi(null)}>
        {lo < 0 && (
          <line x1={PAD.l} x2={w - PAD.r} y1={y0} y2={y0}
                stroke="var(--label-3)" strokeWidth="1" strokeDasharray="3 3" />
        )}
        {data.map((d, i) => {
          const x = PAD.l + i * step + (step - bw) / 2;
          const y = d.y >= 0 ? Y(d.y) : y0;
          const h = Math.max(1.5, Math.abs(Y(d.y) - y0));
          const c = d.good === undefined
            ? (d.y >= 0 ? (good || "var(--green)") : "var(--red)")
            : (d.good ? (good || "var(--green)") : "var(--red)");
          return (
            <rect key={i} x={x} y={y} width={bw} height={h} rx={Math.min(3, bw / 2)}
                  fill={c} opacity={hi == null || hi === i ? 1 : 0.42} />
          );
        })}
        {/* Подписи по оси — когда столбиков мало. У восьми они читаются, у
            тридцати превратились бы в серую кашу, и там их роль берёт на себя
            подпись под пальцем. Один столбик без подписи вообще читается как
            сбой отрисовки, а не как «данные за один день». */}
        {data.length <= 8 && data.map((d, i) => (
          <text key={i} x={PAD.l + i * step + step / 2} y={height - 3}
                textAnchor="middle" fontSize="9" fill="var(--label-3)">
            {d.label.length > 9 ? `${d.label.slice(0, 8)}…` : d.label}
          </text>
        ))}
      </svg>
      {cur && (
        <div className="absolute top-0 px-2 py-[3px] rounded-[9px] text-[11px] font-semibold
                        tabular-nums glass-lens pointer-events-none whitespace-nowrap"
             style={{ left: Math.min(Math.max(PAD.l + hi! * step - 30, 0), Math.max(0, w - 100)) }}>
          {fmt(cur.y)}<span style={{ color: "var(--label-2)" }}> · {cur.label}</span>
        </div>
      )}
    </div>
  );
}
