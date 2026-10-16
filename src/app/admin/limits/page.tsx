import type { Metadata } from "next";

import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { listTierLimitsAdmin } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Limits" };

export default async function AdminLimitsPage() {
  const limits = await listTierLimitsAdmin();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Limits
        </h1>
      </header>

      <Card>
        <CardHeader title={`${limits.length} limit${limits.length === 1 ? "" : "s"}`} />
        <Table caption="All tier limits">
          <thead>
            <tr>
              <Th>Tier</Th>
              <Th>Operation</Th>
              <Th>Window</Th>
              <Th numeric>Max</Th>
            </tr>
          </thead>
          <tbody>
            {limits.length === 0 ? (
              <TableStateRow colSpan={4}>
                <EmptyState title="No limits" description="No tier limits are configured yet." />
              </TableStateRow>
            ) : (
              limits.map((l, i) => (
                <tr key={`${l.tier}-${l.operation}-${l.window}-${i}`}>
                  <Td>{l.tier}</Td>
                  <Td>{l.operation}</Td>
                  <Td>
                    <span className="jc-muted">{l.window}</span>
                  </Td>
                  <Td numeric>
                    {l.max !== null ? (
                      <span className="jc-numeric">
                        {l.max} {l.currency}
                      </span>
                    ) : (
                      <span className="jc-muted">By arrangement</span>
                    )}
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
