import type { Metadata } from "next";

import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { listPairsAdmin } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Markets" };

export default async function AdminMarketsPage() {
  const pairs = await listPairsAdmin();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Markets
        </h1>
      </header>

      <Card>
        <CardHeader title={`${pairs.length} pair${pairs.length === 1 ? "" : "s"}`} />
        <Table caption="All trading pairs">
          <thead>
            <tr>
              <Th>Pair</Th>
              <Th>Type</Th>
              <Th>Trading</Th>
              <Th>Exchange</Th>
              <Th numeric>Price dp</Th>
              <Th numeric>Amount dp</Th>
              <Th numeric>Min order</Th>
            </tr>
          </thead>
          <tbody>
            {pairs.length === 0 ? (
              <TableStateRow colSpan={7}>
                <EmptyState title="No pairs" description="No trading pairs are configured yet." />
              </TableStateRow>
            ) : (
              pairs.map((p) => (
                <tr key={p.symbol}>
                  <Td>{p.symbol}</Td>
                  <Td>
                    <span className="jc-muted">{p.type}</span>
                  </Td>
                  <Td>{p.tradingEnabled ? "Yes" : "No"}</Td>
                  <Td>{p.swapEnabled ? "Yes" : "No"}</Td>
                  <Td numeric>
                    <span className="jc-numeric">{p.pricePrecision}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{p.amountPrecision}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{p.minOrderSize}</span>
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
