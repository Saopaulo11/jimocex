import type { Metadata } from "next";

import { AdminStatusBadge, MonoId } from "@/components/admin";
import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { listDeposits } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Deposits" };

export default async function AdminDepositsPage() {
  const deposits = await listDeposits();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Deposits
        </h1>
      </header>

      <Card>
        <CardHeader title={`${deposits.length} deposit${deposits.length === 1 ? "" : "s"}`} subtitle="Most recent first" />
        <Table caption="All deposits">
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Asset</Th>
              <Th>Network</Th>
              <Th numeric>Amount</Th>
              <Th numeric>Confirmations</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {deposits.length === 0 ? (
              <TableStateRow colSpan={7}>
                <EmptyState title="No deposits" description="No deposits have been recorded yet." />
              </TableStateRow>
            ) : (
              deposits.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <MonoId id={d.userId} href={`/admin/users/${d.userId}`} />
                  </Td>
                  <Td>{d.symbol}</Td>
                  <Td>{d.network ?? <span className="jc-muted">—</span>}</Td>
                  <Td numeric>
                    <span className="jc-numeric">{d.amount}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{d.confirmations}</span>
                  </Td>
                  <Td>
                    <AdminStatusBadge value={d.status} />
                  </Td>
                  <Td>
                    <span className="jc-caption">{formatDateTime(d.createdAt)}</span>
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
