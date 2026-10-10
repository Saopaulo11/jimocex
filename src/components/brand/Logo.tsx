import { LogoMark } from "./LogoMark";

/**
 * The JimoCex logo. Every placement in the product goes through this component.
 *
 * Variants:
 *   full     mark + wordmark, optionally with the tagline. Marketing surfaces.
 *   compact  mark + wordmark, no tagline. Headers and dense UI.
 *   mark     monogram alone. Favicon-scale placements and mobile headers.
 *
 * The wordmark is set in the brand serif rather than drawn as paths, so it stays
 * selectable text, scales with the user's font settings, and costs nothing to
 * load. The gold is confined to "Cex" and the monogram; "Jimo" stays ivory,
 * which is what keeps the lockup from reading as a gold logo.
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

export const BRAND_NAME = "JimoCex";
export const BRAND_TAGLINE = "Global markets. Real opportunities.";

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
          <span style={{ color: monochrome ? "currentColor" : "var(--jc-text)" }}>Jimo</span>
          <span style={{ color: monochrome ? "currentColor" : "var(--jc-gold)" }}>Cex</span>
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
