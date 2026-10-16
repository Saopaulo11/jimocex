import { CurrencyAmount, Price } from "@/components/financial";
import { Table, TableStateRow, Td, Th, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { parseMoney } from "@/lib/money";
import type { TradeRow } from "@/lib/trade/history";

import { OrderSideTag } from "./OrderSideTag";

/**
 * Presentational table of executed trades. Display only. Every figure is an
 * exact decimal string parsed to Money before rendering, so the quote total and
 * fee show at the pair's precision rather than a float's.
 */
export function TradesTable({
  rows,
  caption,
  emptyTitle = "No trades yet",
  emptyDescription = "Executed trades will appear here once an order fills.",
}: {
  rows: TradeRow[];
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
          <Th numeric>Price</Th>
          <Th numeric>Amount</Th>
          <Th numeric>Total</Th>
          <Th numeric>Fee</Th>
          <Th>Time</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <TableStateRow colSpan={7}>
            <EmptyState title={emptyTitle} description={emptyDescription} />
          </TableStateRow>
        ) : (
          rows.map((row) => (
            <tr key={row.id}>
              <Td>{row.pairSymbol}</Td>
              <Td>
                <OrderSideTag side={row.side} />
              </Td>
              <Td numeric>
                <Price value={parseMoney(row.price)} quoteSymbol={row.quoteSymbol} decimals={row.pricePrecision} />
              </Td>
              <Td numeric>
                <CurrencyAmount value={parseMoney(row.amount)} symbol={row.baseSymbol} decimals={row.amountPrecision} size="sm" />
              </Td>
              <Td numeric>
                <Price value={parseMoney(row.quoteAmount)} quoteSymbol={row.quoteSymbol} decimals={row.pricePrecision} />
              </Td>
              <Td numeric>
                {row.feeAsset ? (
                  <span className="jc-numeric jc-muted">
                    {row.fee} {row.feeAsset}
                  </span>
                ) : (
                  <span className="jc-muted">—</span>
                )}
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
