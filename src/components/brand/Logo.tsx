import { brand } from "@/config/brand";

import { LogoMark } from "./LogoMark";

/**
 * The brand logo. Every placement in the product goes through this component,
 * and the name it renders comes from the central brand config (`@/config/brand`)
 * — not a literal here — so a white-label client changes it in one place.
 *
 * Variants:
 *   full     mark + wordmark, optionally with the tagline. Marketing surfaces.
 *   compact  mark + wordmark, no tagline. Headers and dense UI.
 *   mark     monogram alone. Favicon-scale placements and mobile headers.
 *
 * The wordmark is set in the brand serif rather than drawn as paths, so it stays
 * selectable text, scales with the user's font settings, and costs nothing to
 * load. A wordmark may be a plain name or a two-tone split — the JimoCex default
 * splits "Jimo" (ivory) + "Cex" (gold), which keeps the lockup from reading as a
 * gold logo. A plain-string wordmark renders in the text colour with the gold
 * confined to the monogram.
 */

type Variant = "full" | "compact" | "mark";

type Props = {
  variant?: Variant;
  /** Height of the monogram in pixels; the wordmark scales from it. */
  size?: number;
  /** Only meaningful for `full`. */
  tagline?: boolean;
  /** Draw in the inherited colour — for print, light backgrounds, watermarks. */
  monochrome?: boolean;
  className?: string;
};

// Back-compat re-exports, now sourced from the central brand configuration.
export const BRAND_NAME = brand.name;
export const BRAND_TAGLINE = brand.tagline;

export function Logo({
  variant = "compact",
  size = 28,
  tagline = false,
  monochrome = false,
  className,
}: Props) {
  if (variant === "mark") {
    return <LogoMark size={size} title={BRAND_NAME} monochrome={monochrome} className={className} />;
  }

  const showTagline = variant === "full" && tagline;
  const textColor = monochrome ? "currentColor" : "var(--jc-text)";
  const accentColor = monochrome ? "currentColor" : "var(--jc-gold)";
  const wordmark = brand.wordmark;

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.3 }}
    >
      {/* Hidden from assistive tech: the wordmark below is the accessible name. */}
      <LogoMark size={size} monochrome={monochrome} />

      <span style={{ display: "flex", flexDirection: "column", gap: size * 0.1 }}>
        <span
          style={{
            fontFamily: "var(--jc-font-serif)",
            fontSize: size * 0.82,
            lineHeight: 1,
            letterSpacing: "-0.015em",
            whiteSpace: "nowrap",
          }}
        >
          {typeof wordmark === "string" ? (
            <span style={{ color: textColor }}>{wordmark}</span>
          ) : (
            <>
              <span style={{ color: textColor }}>{wordmark.primary}</span>
              <span style={{ color: accentColor }}>{wordmark.accent}</span>
            </>
          )}
        </span>

        {showTagline ? (
          <span
            style={{
              fontSize: Math.max(9, size * 0.23),
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--jc-text-muted)",
              lineHeight: 1.2,
              whiteSpace: "nowrap",
            }}
          >
            {BRAND_TAGLINE}
          </span>
        ) : null}
      </span>
    </span>
  );
}
