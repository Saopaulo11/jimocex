"use client";

import { useId } from "react";

/**
 * JimoCex brand mark.
 *
 * The monogram is a hexagonal "JC" built from flat facets with a gold gradient
 * across them, drawn as inline SVG rather than shipped as a raster: it stays
 * sharp at any size, inherits colour where it should, and costs no extra
 * request on the critical path.
 *
 * The gradient id comes from React's `useId()`. An SVG gradient is referenced by
 * a document-wide id, so two marks on one page sharing an id would make the
 * second resolve to the first's definition — and break outright if that first
 * instance later unmounts. `useId()` gives each instance its own, and does so
 * without mutating state during render, which a module-level counter would.
 * That is also why this is a client component: `useId` is a hook.
 */

type Props = {
  /** Height in pixels; the width follows the aspect ratio. */
  size?: number;
  /** Render the wordmark and tagline beside the monogram. */
  variant?: "mark" | "lockup";
  /** Tagline under the wordmark. Only drawn in the lockup. */
  showTagline?: boolean;
  className?: string;
};

export function JimoCexLogo({
  size = 32,
  variant = "lockup",
  showTagline = false,
  className,
}: Props) {
  const gradientId = `jc-gold-${useId()}`;

  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F0D79A" />
          <stop offset="0.45" stopColor="#D4AF55" />
          <stop offset="1" stopColor="#A8822C" />
        </linearGradient>
      </defs>

      {/* Hexagonal outline */}
      <path
        d="M32 2 60 18v28L32 62 4 46V18L32 2Z"
        stroke={`url(#${gradientId})`}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />

      {/* J — descends and hooks left */}
      <path
        d="M35 17v22a8 8 0 0 1-8 8h-3a8 8 0 0 1-8-8v-2"
        stroke={`url(#${gradientId})`}
        strokeWidth="5"
        strokeLinecap="square"
      />

      {/* C — open to the right, sharing the J's vertical rhythm */}
      <path
        d="M49 22a12 12 0 0 0-9-4 14 14 0 0 0 0 28 12 12 0 0 0 9-4"
        stroke={`url(#${gradientId})`}
        strokeWidth="5"
        strokeLinecap="square"
      />
    </svg>
  );

  if (variant === "mark") {
    return (
      <span className={className} style={{ display: "inline-flex" }}>
        {mark}
        <span className="jc-sr-only">JimoCex</span>
      </span>
    );
  }

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.32 }}
    >
      {mark}
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontSize: size * 0.72,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1,
          }}
        >
          <span style={{ color: "var(--jc-text)" }}>Jimo</span>
          <span style={{ color: "var(--jc-gold)" }}>Cex</span>
        </span>
        {showTagline ? (
          <span
            style={{
              fontSize: size * 0.21,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--jc-text-muted)",
              lineHeight: 1,
            }}
          >
            Global markets. Real opportunities.
          </span>
        ) : null}
      </span>
    </span>
  );
}
