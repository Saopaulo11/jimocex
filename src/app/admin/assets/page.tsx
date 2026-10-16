import type { Metadata } from "next";

import { AdminStatusBadge } from "@/components/admin";
import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { listAssetsAdmin } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Assets" };

export default async function AdminAssetsPage() {
  const assets = await listAssetsAdmin();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Assets
        </h1>
      </header>

      <Card>
        <CardHeader title={`${assets.length} asset${assets.length === 1 ? "" : "s"}`} />
        <Table caption="All assets">
          <thead>
            <tr>
              <Th>Symbol</Th>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th numeric>Decimals</Th>
              <Th>Active</Th>
            </tr>
          </thead>
          <tbody>
            {assets.length === 0 ? (
              <TableStateRow colSpan={5}>
                <EmptyState title="No assets" description="No assets are configured yet." />
              </TableStateRow>
            ) : (
              assets.map((a) => (
                <tr key={a.symbol}>
                  <Td>{a.symbol}</Td>
                  <Td>{a.name}</Td>
                  <Td>
                    <span className="jc-muted">{a.type}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{a.decimals}</span>
                  </Td>
                  <Td>
                    <AdminStatusBadge value={a.isActive ? "ACTIVE" : "CLOSED"} />
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
