import { Badge } from "@/components/ui/Badge";

/**
 * The honest label for where a figure on screen comes from.
 *
 * A price is either from the public market-data source ("Market data" —
 * informational, polled, never called "live" or real-time), from the
 * deterministic PROTOTYPE source (must say "Demo data"), or unavailable (say so,
 * show no number). Centralising it means every surface labels its figures the
 * same way and none can quietly present a demo price as a market one.
 */
export function PriceSourceNote({
  demo,
  available,
  context = "Prices",
}: {
  demo: boolean;
  available: boolean;
  /** What the label is about, e.g. "Prices", "Valuation", "Rate". */
  context?: string;
}) {
  if (!available) {
    return (
      <Badge tone="neutral" glyph={null}>
        {context} unavailable
      </Badge>
    );
  }
  if (demo) {
    return (
      <Badge tone="warning" glyph={null}>
        <span className="jc-sr-only">{context} shown are </span>Demo data
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" glyph={null}>
      <span className="jc-sr-only">{context} shown are </span>Market data
    </Badge>
  );
}
