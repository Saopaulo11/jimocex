/**
 * The JC monogram — the single source of this geometry in the codebase.
 *
 * Nothing else draws the mark. `Logo.tsx` composes it, the favicon and the
 * OpenGraph image reference the matching files in `public/brand/`, and when the
 * final original artwork arrives it replaces the paths HERE and in those two
 * files, and nowhere else.
 *
 * Construction: a hexagonal frame with an angular J and C set inside it. The
 * facets are flat two-tone gold rather than a gradient glow — the mark should
 * read as struck metal on a letterhead, not as a crypto logo.
 *
 * `title` renders an accessible name when the mark stands alone. When it sits
 * beside the wordmark the SVG is hidden from assistive technology instead, so a
 * screen reader does not announce "JimoCex JimoCex".
 */

type Props = {
  size?: number;
  /** Accessible name. Omit when a visible wordmark already names the brand. */
  title?: string;
  /** Ignore the gold palette and draw in the inherited text colour. */
  monochrome?: boolean;
  className?: string;
};

export function LogoMark({ size = 32, title, monochrome = false, className }: Props) {
  const light = monochrome ? "currentColor" : "var(--jc-gold-hover, #d9b876)";
  const base = monochrome ? "currentColor" : "var(--jc-gold, #c9a45c)";
  const deep = monochrome ? "currentColor" : "var(--jc-gold-muted, #9b7e42)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* Hexagonal frame */}
      <path
        d="M32 3.5 57 18v28L32 60.5 7 46V18L32 3.5Z"
        stroke={base}
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Top facet of the frame, a shade lighter — the only bevel in the mark */}
      <path d="M32 3.5 57 18l-3 1.7L32 7 10 19.7 7 18 32 3.5Z" fill={light} />

      {/* J — flat cap, straight stem, angular hook */}
      <path d="M19 19h17v4.5h-6.2V38a8.3 8.3 0 0 1-8.3 8.3h-2.6a8.3 8.3 0 0 1-8.3-8.3v-2.2h4.6V38a3.7 3.7 0 0 0 3.7 3.7h2.6a3.7 3.7 0 0 0 3.7-3.7V23.5H19V19Z" fill={base} />

      {/* C — an open ring built from straight facets, not an arc */}
      <path d="M53.5 25.4l-4.2 1.9a9 9 0 0 0-7.6-4.1 9.8 9.8 0 0 0 0 19.6 9 9 0 0 0 7.6-4.1l4.2 1.9a13.6 13.6 0 0 1-11.8 6.7 14.4 14.4 0 0 1 0-28.6 13.6 13.6 0 0 1 11.8 6.7Z" fill={deep} />
    </svg>
  );
}
