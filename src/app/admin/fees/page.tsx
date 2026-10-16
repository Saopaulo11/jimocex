import type { Metadata } from "next";

import { AdminStatusBadge } from "@/components/admin";
import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { listFeeRulesAdmin } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Fees" };

export default async function AdminFeesPage() {
  const rules = await listFeeRulesAdmin();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Fees
        </h1>
      </header>

      <Card>
        <CardHeader title={`${rules.length} fee rule${rules.length === 1 ? "" : "s"}`} />
        <Table caption="All fee rules">
          <thead>
            <tr>
              <Th>Operation</Th>
              <Th>Asset</Th>
              <Th>Tier</Th>
              <Th numeric>Percentage</Th>
              <Th numeric>Fixed fee</Th>
              <Th>Active</Th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <TableStateRow colSpan={6}>
                <EmptyState title="No fee rules" description="No fee rules are configured yet." />
              </TableStateRow>
            ) : (
              rules.map((r, i) => (
                <tr key={`${r.operation}-${r.asset}-${r.tier}-${i}`}>
                  <Td>{r.operation}</Td>
                  <Td>{r.asset}</Td>
                  <Td>{r.tier}</Td>
                  <Td numeric>
                    <span className="jc-numeric">{r.percentage}%</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{r.fixedFee}</span>
                  </Td>
                  <Td>
                    <AdminStatusBadge value={r.isActive ? "ACTIVE" : "CLOSED"} />
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
