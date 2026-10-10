import type { ReactNode } from "react";

/**
 * Badge (spec §24).
 *
 * Every tone carries a glyph as well as a colour. That is not decoration:
 * colour alone fails for roughly one in twelve men, and "is this transfer
 * completed or failed" is not a question to answer with hue alone.
 */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "gold";

const GLYPH: Record<BadgeTone, string | null> = {
  success: "✓",
  warning: "!",
  danger: "×",
  info: "•",
  gold: null,
  neutral: null,
};

export function Badge({
  tone = "neutral",
  glyph,
  pill = false,
  children,
  className,
}: {
  tone?: BadgeTone;
  /** Overrides the tone's default glyph. Pass null to omit it entirely. */
  glyph?: string | null;
  pill?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const mark = glyph === undefined ? GLYPH[tone] : glyph;

  return (
    <span
      className={[
        "jc-badge",
        `jc-badge--${tone}`,
        pill ? "jc-badge--pill" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {mark ? (
        <span className="jc-badge-glyph" aria-hidden="true">
          {mark}
        </span>
      ) : null}
      {children}
    </span>
  );
}
