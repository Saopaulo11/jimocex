/**
 * Loading placeholders (spec §27).
 *
 * A skeleton has to match the shape of what replaces it. One that does not
 * causes a layout jump on load, which on a trading screen can move a button
 * under a cursor that is already descending on it.
 *
 * All of these are aria-hidden and sit inside a container marked aria-busy: a
 * screen reader should hear "loading", not a description of grey rectangles.
 */

export function Skeleton({
  width = "100%",
  height = 16,
  radius,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}) {
  return (
    <span
      className={["jc-skeleton", className].filter(Boolean).join(" ")}
      style={{ display: "block", width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({ lines = 3, lastWidth = "60%" }: { lines?: number; lastWidth?: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? lastWidth : "100%"} />
      ))}
    </span>
  );
}

export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div style={{ padding: "var(--jc-space-4)" }} aria-busy="true" aria-label="Loading">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--jc-space-5)" }}>
        {Array.from({ length: rows }, (_, r) => (
          <div
            key={r}
            style={{
              display: "grid",
              gridTemplateColumns: `1.6fr ${"1fr ".repeat(Math.max(1, columns - 1))}`,
              gap: "var(--jc-space-4)",
              alignItems: "center",
            }}
          >
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton key={c} height={14} width={c === 0 ? "70%" : "50%"} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="jc-card" style={{ padding: "var(--jc-space-5)" }} aria-busy="true" aria-label="Loading">
      <Skeleton height={12} width="35%" />
      <div style={{ height: "var(--jc-space-4)" }} />
      <Skeleton height={28} width="55%" />
      <div style={{ height: "var(--jc-space-4)" }} />
      <SkeletonText lines={2} />
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="jc-spinner" aria-hidden="true" />
      <span className="jc-sr-only">{label}</span>
    </span>
  );
}
