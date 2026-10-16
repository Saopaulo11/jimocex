import type { Metadata } from "next";

import { AdminStatusBadge, MonoId } from "@/components/admin";
import { OrderSideTag } from "@/components/trade";
import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { listOrders, type AdminOrderRow } from "@/lib/admin/reads";
import type { OrderSideValue } from "@/lib/trade/types";

export const metadata: Metadata = { title: "Operator · Orders" };

export default async function AdminOrdersPage() {
  const orders: AdminOrderRow[] = await listOrders();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Orders
        </h1>
      </header>

      <Card>
        <CardHeader title={`${orders.length} order${orders.length === 1 ? "" : "s"}`} subtitle="Most recent first" />
        <Table caption="All orders">
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Pair</Th>
              <Th>Side</Th>
              <Th>Type</Th>
              <Th numeric>Price</Th>
              <Th numeric>Amount</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <TableStateRow colSpan={8}>
                <EmptyState title="No orders" description="No orders have been placed yet." />
              </TableStateRow>
            ) : (
              orders.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <MonoId id={o.userId} href={`/admin/users/${o.userId}`} />
                  </Td>
                  <Td>{o.pair}</Td>
                  <Td>
                    <OrderSideTag side={o.side as OrderSideValue} />
                  </Td>
                  <Td>
                    <span className="jc-muted">{o.type}</span>
                  </Td>
                  <Td numeric>{o.price ? <span className="jc-numeric">{o.price}</span> : <span className="jc-muted">Market</span>}</Td>
                  <Td numeric>
                    <span className="jc-numeric">{o.amount}</span>
                  </Td>
                  <Td>
                    <AdminStatusBadge value={o.status} />
                  </Td>
                  <Td>
                    <span className="jc-caption">{formatDateTime(o.createdAt)}</span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
