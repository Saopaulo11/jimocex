import type { Metadata } from "next";

import { AdminStatusBadge, MonoId } from "@/components/admin";
import { Card, CardContent, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { listKyc } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · KYC" };

export default async function AdminKycPage() {
  const verifications = await listKyc();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          KYC
        </h1>
      </header>

      <Card>
        <CardHeader
          title={`${verifications.length} verification${verifications.length === 1 ? "" : "s"}`}
          subtitle="Most recent first"
        />
        <Table caption="All KYC verifications">
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Status</Th>
              <Th>Provider kind</Th>
              <Th>Target tier</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {verifications.length === 0 ? (
              <TableStateRow colSpan={5}>
                <EmptyState title="No verifications" description="No KYC verifications have been recorded yet." />
              </TableStateRow>
            ) : (
              verifications.map((k) => (
                <tr key={k.id}>
                  <Td>
                    <MonoId id={k.userId} href={`/admin/users/${k.userId}`} />
                  </Td>
                  <Td>
                    <AdminStatusBadge value={k.status} />
                  </Td>
                  <Td>
                    <span className="jc-muted">{k.providerKind}</span>
                  </Td>
                  <Td>{k.targetTier ?? <span className="jc-muted">—</span>}</Td>
                  <Td>
                    <span className="jc-caption">{formatDateTime(k.createdAt)}</span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
        <CardContent>
          <p className="jc-caption jc-muted">No KYC/AML provider is connected on this deployment.</p>
        </CardContent>
      </Card>
    </div>
  );
}
