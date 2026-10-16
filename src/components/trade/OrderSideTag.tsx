import type { OrderSideValue } from "@/lib/trade/types";

/** BUY / SELL as a coloured word — the word, not the colour, carries the meaning. */
export function OrderSideTag({ side }: { side: OrderSideValue | null }) {
  if (side === null) return <span className="jc-muted">—</span>;
  return (
    <span className={`jc-side ${side === "BUY" ? "jc-side--buy" : "jc-side--sell"}`}>
      {side === "BUY" ? "Buy" : "Sell"}
    </span>
  );
}
