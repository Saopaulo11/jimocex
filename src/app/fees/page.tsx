import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";
import { moneySelect } from "@/lib/db/money-columns";
import { fromDatabase, fromDatabaseNullable, isZero, toDecimalString } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Fees",
  description: `The fee schedule for ${brand.name}, enforced on the server for every operation.`,
};

const OPERATION_LABEL: Record<string, string> = {
  TRADE: "Trade",
  SWAP: "Exchange",
  DEPOSIT: "Crypto deposit",
  WITHDRAWAL: "Crypto withdrawal",
  FIAT_DEPOSIT: "Fiat deposit",
  FIAT_WITHDRAWAL: "Fiat withdrawal",
};

const OPERATION_ORDER = ["TRADE", "SWAP", "DEPOSIT", "WITHDRAWAL", "FIAT_DEPOSIT", "FIAT_WITHDRAWAL"];

type FeeRow = {
  operation: string;
  asset: string;
  tier: string;
  percent: string;
  fixed: string | null;
};

async function readFees(): Promise<FeeRow[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("fee_rules")
      .select(moneySelect("fee_rules", "operation, tier_code, percentage, fixed_fee, asset:asset_id(symbol)"))
      .eq("is_active", true)
      .overrideTypes<
        {
          operation: string;
          tier_code: string | null;
          percentage: string;
          fixed_fee: string;
          asset: { symbol: string } | null;
        }[],
        { merge: false }
      >();
    if (error || !data) return [];
    return data
      .map((row) => {
        const fixed = fromDatabaseNullable(row.fixed_fee, "fee_rules.fixed_fee");
        return {
          operation: row.operation,
          asset: row.asset?.symbol ?? "All",
          tier: row.tier_code ?? "All",
          percent: toDecimalString(fromDatabase(row.percentage, "fee_rules.percentage")),
          fixed: fixed === null || isZero(fixed) ? null : toDecimalString(fixed),
        };
      })
      .sort((a, b) => OPERATION_ORDER.indexOf(a.operation) - OPERATION_ORDER.indexOf(b.operation));
  } catch {
    return [];
  }
}

export default async function FeesPage() {
  const [viewer, fees] = await Promise.all([getViewer(), readFees()]);

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Fees</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            Fee schedule
          </h1>
          <p className="jc-body">
            These are the fees {brand.name} applies. They are configuration in the database and are computed on the
            server for every operation — never set in the browser. You always see the exact fee before you commit.
          </p>
        </header>

        <Card>
          <CardHeader title="Current fees" subtitle="By operation" />
          <Table caption="Fee schedule by operation">
            <thead>
              <tr>
                <Th>Operation</Th>
                <Th>Asset</Th>
                <Th>Tier</Th>
                <Th numeric>Percentage</Th>
                <Th numeric>Fixed</Th>
              </tr>
            </thead>
            <tbody>
              {fees.length === 0 ? (
                <TableStateRow colSpan={5}>
                  <EmptyState title="Fee schedule unavailable" description="The fee rules could not be read right now." />
                </TableStateRow>
              ) : (
                fees.map((row, i) => (
                  <tr key={`${row.operation}-${row.asset}-${row.tier}-${i}`}>
                    <Td>{OPERATION_LABEL[row.operation] ?? row.operation}</Td>
                    <Td>
                      <span className="jc-muted">{row.asset}</span>
                    </Td>
                    <Td>
                      <span className="jc-muted">{row.tier === "All" ? "All" : row.tier.replace("_", " ")}</span>
                    </Td>
                    <Td numeric>
                      <span className="jc-numeric">{row.percent}%</span>
                    </Td>
                    <Td numeric>{row.fixed ? <span className="jc-numeric">{row.fixed}</span> : <span className="jc-muted">—</span>}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
          <CardContent>
            <p className="jc-caption">
              A percentage applies to the operation&rsquo;s value; a fixed component, where set, is added. Network fees
              for on-chain withdrawals are set by the payout provider at processing time — none is connected on this
              deployment.
            </p>
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
