"use client";

/**
 * A compact price chart drawn from close prices.
 *
 * IMPORTANT: the close prices are converted to `number` HERE, but only to
 * compute SVG pixel coordinates — a chart is a picture, and pixels are not
 * money. No value derived from these numbers is ever shown to the user; every
 * price displayed on the page comes from the exact decimal strings. So this is
 * not a money-in-float violation: it is geometry.
 */
export function PriceChart({
  closes,
  label = "Price chart",
}: {
  closes: string[];
  /** Accessible name; say where the figures come from, e.g. "Price chart (market data)". */
  label?: string;
}) {
  if (closes.length < 2) {
    return (
      <div className="jc-chart-empty jc-muted" role="img" aria-label="No chart data">
        No chart data
      </div>
    );
  }

  // money-guard-allow: close prices → numbers for SVG pixel geometry only; no value derived from these is ever displayed
  const values = closes.map((c) => Number(c)).filter((n) => Number.isFinite(n));
  if (values.length < 2) {
    return <div className="jc-chart-empty jc-muted">No chart data</div>;
  }

  // Plain-number pixel geometry from here down (never money).
  const r = (n: number) => Math.round(n * 100) / 100;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 640;
  const H = 200;
  const pad = 10;
  const stepX = (W - pad * 2) / (values.length - 1);
  const yFor = (v: number) => H - pad - ((v - min) / range) * (H - pad * 2);

  const points = values.map((v, i) => [pad + i * stepX, yFor(v)] as const);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${r(p[0])} ${r(p[1])}`).join(" ");
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const area = `${line} L${r(last[0])} ${H - pad} L${r(first[0])} ${H - pad} Z`;
  const up = values[values.length - 1]! >= values[0]!;
  const stroke = up ? "var(--jc-up)" : "var(--jc-down)";
  const gradientId = up ? "jc-chart-up" : "jc-chart-down";

  return (
    <svg className="jc-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} stroke="none" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
