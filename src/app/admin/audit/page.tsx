import type { Metadata } from "next";

import { MonoId } from "@/components/admin";
import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { listAudit } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Audit" };

export default async function AdminAuditPage() {
  const entries = await listAudit();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Audit log
        </h1>
      </header>

      <Card>
        <CardHeader title={`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`} subtitle="Most recent first" />
        <Table caption="Audit log entries">
          <thead>
            <tr>
              <Th>Action</Th>
              <Th>Actor type</Th>
              <Th>Entity</Th>
              <Th>Entity id</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <TableStateRow colSpan={5}>
                <EmptyState title="No audit entries" description="No audit entries have been recorded yet." />
              </TableStateRow>
            ) : (
              entries.map((a) => (
                <tr key={a.id}>
                  <Td>{a.action}</Td>
                  <Td>
                    <span className="jc-muted">{a.actorType}</span>
                  </Td>
                  <Td>{a.entityType ?? <span className="jc-muted">—</span>}</Td>
                  <Td>{a.entityId ? <MonoId id={a.entityId} /> : <span className="jc-muted">—</span>}</Td>
                  <Td>
                    <span className="jc-caption">{formatDateTime(a.createdAt)}</span>
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
