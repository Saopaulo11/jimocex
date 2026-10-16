import type { Metadata } from "next";

import { MonoId } from "@/components/admin";
import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { listTrades } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Trades" };

export default async function AdminTradesPage() {
  const trades = await listTrades();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Trades
        </h1>
      </header>

      <Card>
        <CardHeader title={`${trades.length} trade${trades.length === 1 ? "" : "s"}`} subtitle="Most recent first" />
        <Table caption="All trades">
          <thead>
            <tr>
              <Th>Trade ID</Th>
              <Th>Pair</Th>
              <Th numeric>Price</Th>
              <Th numeric>Amount</Th>
              <Th numeric>Total</Th>
              <Th numeric>Fee</Th>
              <Th>Provider trade id</Th>
              <Th>Settled</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <TableStateRow colSpan={9}>
                <EmptyState title="No trades" description="No trades have settled yet." />
              </TableStateRow>
            ) : (
              trades.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <MonoId id={t.id} />
                  </Td>
                  <Td>{t.pair}</Td>
                  <Td numeric>
                    <span className="jc-numeric">{t.price}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{t.amount}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{t.quote}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{t.fee}</span>
                  </Td>
                  <Td>{t.providerTradeId ? <MonoId id={t.providerTradeId} /> : <span className="jc-muted">—</span>}</Td>
                  <Td>
                    <span className="jc-caption">{formatDateTime(t.settledAt)}</span>
                  </Td>
                  <Td>
                    <span className="jc-caption">{formatDateTime(t.createdAt)}</span>
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
