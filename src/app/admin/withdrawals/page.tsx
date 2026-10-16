import type { Metadata } from "next";

import { AdminStatusBadge, MonoId } from "@/components/admin";
import { Card, CardContent, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { listWithdrawals } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Withdrawals" };

export default async function AdminWithdrawalsPage() {
  const withdrawals = await listWithdrawals();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Withdrawals
        </h1>
      </header>

      <Card>
        <CardHeader
          title={`${withdrawals.length} withdrawal${withdrawals.length === 1 ? "" : "s"}`}
          subtitle="Most recent first"
        />
        <Table caption="All withdrawals">
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Asset</Th>
              <Th>Network</Th>
              <Th numeric>Amount</Th>
              <Th numeric>Fee</Th>
              <Th>Destination</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {withdrawals.length === 0 ? (
              <TableStateRow colSpan={8}>
                <EmptyState title="No withdrawals" description="No withdrawal requests have been made yet." />
              </TableStateRow>
            ) : (
              withdrawals.map((w) => (
                <tr key={w.id}>
                  <Td>
                    <MonoId id={w.userId} href={`/admin/users/${w.userId}`} />
                  </Td>
                  <Td>{w.symbol}</Td>
                  <Td>{w.network ?? <span className="jc-muted">—</span>}</Td>
                  <Td numeric>
                    <span className="jc-numeric">{w.amount}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{w.fee}</span>
                  </Td>
                  <Td>
                    <span className="jc-numeric jc-caption" title={w.destination}>
                      {w.destination.length > 10 ? `${w.destination.slice(0, 10)}…` : w.destination}
                    </span>
                  </Td>
                  <Td>
                    <AdminStatusBadge value={w.status} />
                  </Td>
                  <Td>
                    <span className="jc-caption">{formatDateTime(w.createdAt)}</span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
        <CardContent>
          <p className="jc-caption jc-muted">
            Withdrawals are reviewed here; no payout is executed. No provider is connected on this deployment.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
