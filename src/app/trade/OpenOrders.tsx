"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CurrencyAmount, OrderStatus, Price } from "@/components/financial";
import { OrderSideTag } from "@/components/trade";
import { Alert, Button, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { parseMoney } from "@/lib/money";
import type { OpenOrderView } from "@/lib/trade/types";

const TYPE_LABEL: Record<string, string> = { LIMIT: "Limit", MARKET: "Market" };

import { cancelOrderAction } from "./actions";

/**
 * Open Orders (spec §19, §31).
 *
 * Real rows, read from `trading_orders` for the signed-in user under RLS — never
 * a hardcoded list. Cancelling calls the atomic `cancel_order` RPC through the
 * server action; on success the page is refreshed so the order's new status and
 * the released balance come straight from the database, not from local state.
 *
 * A UTC timestamp is rendered with a fixed format rather than
 * `toLocaleString()`, which would differ between the server and the client and
 * trip hydration.
 */
function formatTimestamp(iso: string): string {
  // "2026-10-15T14:09:03.123Z" → "2026-10-15 14:09 UTC"
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function OpenOrders({ orders }: { orders: OpenOrderView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onCancel(orderId: string) {
    setError(null);
    setCancellingId(orderId);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof cancelOrderAction>>;
      try {
        result = await cancelOrderAction(orderId);
      } catch {
        // No answer: the cancel may or may not have happened. Re-read from the database.
        setCancellingId(null);
        setError("We could not confirm the cancellation. Open orders now show their current status.");
        router.refresh();
        return;
      }
      setCancellingId(null);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Re-read balances and orders from the database — the released hold and
      // the CANCELLED status are the server's truth, not a local edit.
      router.refresh();
    });
  }

  return (
    <section className="jc-panel" aria-label="Open orders" style={{ marginTop: "var(--jc-space-4)" }}>
      <div className="jc-panel-head">
        <span className="jc-panel-title">Open orders</span>
      </div>

      {error ? (
        <div style={{ marginBottom: "var(--jc-space-3)" }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      <Table caption="Your resting orders">
        <thead>
          <tr>
            <Th>Market</Th>
            <Th>Side</Th>
            <Th>Type</Th>
            <Th numeric>Price</Th>
            <Th numeric>Amount</Th>
            <Th>Status</Th>
            <Th>Placed</Th>
            <Th>
              <span className="jc-sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 ? (
            <TableStateRow colSpan={8}>
              <EmptyState
                title="No open orders"
                description="Orders you place rest here with their reserved funds until they are cancelled."
              />
            </TableStateRow>
          ) : (
            orders.map((order) => {
              const busy = pending && cancellingId === order.id;
              return (
                <tr key={order.id}>
                  <Td>
                    <Link href={`/orders/${order.id}`} className="jc-link" aria-label={`Order details: ${order.baseSymbol}/${order.quoteSymbol}`}>
                      <span style={{ fontWeight: 500 }}>{order.baseSymbol}</span>
                      <span className="jc-muted">/{order.quoteSymbol}</span>
                    </Link>
                  </Td>
                  <Td>
                    <OrderSideTag side={order.side} />
                  </Td>
                  <Td>
                    <span className="jc-muted">{TYPE_LABEL[order.type] ?? order.type}</span>
                  </Td>
                  <Td numeric>
                    {order.price === null ? (
                      <span className="jc-muted">—</span>
                    ) : (
                      <Price
                        value={parseMoney(order.price)}
                        quoteSymbol={order.quoteSymbol}
                        decimals={order.pricePrecision}
                      />
                    )}
                  </Td>
                  <Td numeric>
                    <CurrencyAmount
                      value={parseMoney(order.amount)}
                      symbol={order.baseSymbol}
                      decimals={order.amountPrecision}
                    />
                  </Td>
                  <Td>
                    <OrderStatus status={order.status} />
                  </Td>
                  <Td>
                    <span className="jc-caption">{formatTimestamp(order.createdAt)}</span>
                  </Td>
                  <Td>
                    <Button
                      variant="tertiary"
                      size="sm"
                      onClick={() => onCancel(order.id)}
                      loading={busy}
                      loadingLabel="Cancelling"
                      disabled={pending}
                    >
                      Cancel
                    </Button>
                  </Td>
                </tr>
              );
            })
          )}
        </tbody>
      </Table>
    </section>
  );
}
