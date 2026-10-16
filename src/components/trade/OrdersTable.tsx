import Link from "next/link";

import { CurrencyAmount, OrderStatus, Price } from "@/components/financial";
import { Table, TableStateRow, Td, Th, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { divideMoney, formatMoney, isPositive, multiplyMoney, parseMoney } from "@/lib/money";
import type { OrderRow } from "@/lib/trade/history";

import { OrderSideTag } from "./OrderSideTag";

const TYPE_LABEL: Record<string, string> = { LIMIT: "Limit", MARKET: "Market" };

/**
 * Presentational table of orders (display only — no cancel here; the Open
 * Orders panel owns that interaction). Every money value arrives as a decimal
 * string and is parsed to Money before it is rendered through the financial
 * primitives, so precision is the pair's, not the browser's.
 */
export function OrdersTable({
  rows,
  caption,
  emptyTitle = "No orders",
  emptyDescription = "Orders you place will appear here.",
}: {
  rows: OrderRow[];
  caption: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>Pair</Th>
          <Th>Side</Th>
          <Th>Type</Th>
          <Th numeric>Price</Th>
          <Th numeric>Amount</Th>
          <Th numeric>Filled</Th>
          <Th>Status</Th>
          <Th>Date</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <TableStateRow colSpan={8}>
            <EmptyState title={emptyTitle} description={emptyDescription} />
          </TableStateRow>
        ) : (
          rows.map((row) => (
            <tr key={row.id}>
              <Td>
                <Link href={`/orders/${row.id}`} className="jc-link">
                  {row.pairSymbol}
                </Link>
              </Td>
              <Td>
                <OrderSideTag side={row.side} />
              </Td>
              <Td>
                <span className="jc-muted">{TYPE_LABEL[row.type] ?? row.type}</span>
              </Td>
              <Td numeric>
                {row.price === null ? (
                  <span className="jc-muted">Market</span>
                ) : (
                  <Price value={parseMoney(row.price)} quoteSymbol={row.quoteSymbol} decimals={row.pricePrecision} />
                )}
              </Td>
              <Td numeric>
                <CurrencyAmount value={parseMoney(row.amount)} symbol={row.baseSymbol} decimals={row.amountPrecision} size="sm" />
              </Td>
              <Td numeric>
                <span className="jc-numeric jc-muted">
                  {formatFillPercent(row.filled, row.amount)}
                </span>
              </Td>
              <Td>
                <OrderStatus status={row.status} />
              </Td>
              <Td>
                <span className="jc-caption">{formatDateTime(row.createdAt)}</span>
              </Td>
            </tr>
          ))
        )}
      </tbody>
    </Table>
  );
}

/** "0%" / "100%" / "42%" — the share of the order that has filled. */
function formatFillPercent(filled: string, amount: string): string {
  const filledMoney = parseMoney(filled);
  const amountMoney = parseMoney(amount);
  if (!isPositive(amountMoney)) return "—";
  // (filled / amount) * 100, through the money helpers — exact, no raw ops.
  const pct = multiplyMoney(divideMoney(filledMoney, amountMoney), parseMoney("100"));
  return `${formatMoney(pct, { decimals: 0 })}%`;
}
