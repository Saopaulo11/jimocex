import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CurrencyAmount, OrderStatus, Price } from "@/components/financial";
import { OrderSideTag, TradesTable } from "@/components/trade";
import { Alert, Card, CardContent, CardHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { parseMoney } from "@/lib/money";
import { getOrderById, OPEN_STATUSES } from "@/lib/trade/history";

import { CancelOrderButton } from "../CancelOrderButton";

export const metadata: Metadata = { title: "Order" };

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrderById(id);
  if (!order) notFound();

  const cancellable = (OPEN_STATUSES as readonly string[]).includes(order.status);

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Order ID", value: <span className="jc-numeric jc-caption">{order.id}</span> },
    ...(order.clientOrderId
      ? [{ label: "Client order ID", value: <span className="jc-numeric jc-caption">{order.clientOrderId}</span> }]
      : []),
    {
      label: "Market",
      value: (
        <Link href={`/markets/${order.pairSymbol.toLowerCase()}`} className="jc-link">
          {order.baseSymbol}/{order.quoteSymbol}
        </Link>
      ),
    },
    { label: "Side", value: <OrderSideTag side={order.side} /> },
    { label: "Type", value: order.type === "LIMIT" ? "Limit" : "Market" },
    {
      label: "Price",
      value:
        order.price === null ? (
          <span className="jc-muted">Market</span>
        ) : (
          <Price value={parseMoney(order.price)} quoteSymbol={order.quoteSymbol} decimals={order.pricePrecision} />
        ),
    },
    {
      label: "Amount",
      value: <CurrencyAmount value={parseMoney(order.amount)} symbol={order.baseSymbol} decimals={order.amountPrecision} size="sm" />,
    },
    {
      label: "Filled",
      value: <CurrencyAmount value={parseMoney(order.filled)} symbol={order.baseSymbol} decimals={order.amountPrecision} size="sm" />,
    },
    {
      label: "Remaining",
      value: <CurrencyAmount value={parseMoney(order.remaining)} symbol={order.baseSymbol} decimals={order.amountPrecision} size="sm" />,
    },
    {
      label: "Average fill price",
      value:
        order.averagePrice === null ? (
          <span className="jc-muted">—</span>
        ) : (
          <Price value={parseMoney(order.averagePrice)} quoteSymbol={order.quoteSymbol} decimals={order.pricePrecision} />
        ),
    },
    {
      label: "Reserved",
      value:
        order.lockedAsset === null ? (
          <span className="jc-muted">—</span>
        ) : (
          <span className="jc-numeric">
            {order.lockedAmount} {order.lockedAsset}
          </span>
        ),
    },
    { label: "Status", value: <OrderStatus status={order.status} /> },
    { label: "Created", value: <span className="jc-caption">{formatDateTime(order.createdAt)}</span> },
    { label: "Updated", value: <span className="jc-caption">{formatDateTime(order.updatedAt)}</span> },
    ...(order.rejectReason ? [{ label: "Reason", value: <span className="jc-sm">{order.rejectReason}</span> }] : []),
  ];

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <nav className="jc-row jc-row-wrap" aria-label="Related pages" style={{ gap: "var(--jc-space-5)" }}>
          <Link href="/orders" className="jc-link jc-sm">
            ← Orders
          </Link>
          <Link href={`/markets/${order.pairSymbol.toLowerCase()}`} className="jc-link jc-sm">
            {order.baseSymbol}/{order.quoteSymbol} market
          </Link>
          <Link href={`/trade/${order.pairSymbol}`} className="jc-link jc-sm">
            Trade {order.baseSymbol}/{order.quoteSymbol}
          </Link>
        </nav>
        <div className="jc-row-between jc-row-wrap" style={{ marginTop: "var(--jc-space-4)" }}>
          <h1 className="jc-h2">
            {order.baseSymbol}/{order.quoteSymbol}{" "}
            <span style={{ marginLeft: "var(--jc-space-3)" }}>
              <OrderSideTag side={order.side} />
            </span>
          </h1>
          <OrderStatus status={order.status} />
        </div>
      </header>

      {cancellable ? (
        <Alert tone="info" title="This order is still open">
          Its reserved funds stay held until you cancel it. Order execution is not connected in this
          prototype, so it will not fill.
          <div style={{ marginTop: "var(--jc-space-3)" }}>
            <CancelOrderButton orderId={order.id} />
          </div>
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="Order" />
        <CardContent>
          <div className="jc-summary">
            {rows.map((row) => (
              <div key={row.label} className="jc-summary-row">
                <span className="jc-summary-key">{row.label}</span>
                <span className="jc-summary-val">{row.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Trades" as="h2" subtitle="Fills recorded against this order" />
        <TradesTable rows={order.trades} caption="Trades for this order" />
      </Card>
    </div>
  );
}
