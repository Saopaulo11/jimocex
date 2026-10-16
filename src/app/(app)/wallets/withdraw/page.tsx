import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardContent, CardHeader } from "@/components/ui";
import { WithdrawalsTable } from "@/components/wallets/tables";
import { getPortfolio } from "@/lib/portfolio/portfolio";
import { getAssetNetworks, getWithdrawals } from "@/lib/wallets/wallets";

import { WithdrawPanel } from "./WithdrawPanel";

export const metadata: Metadata = { title: "Withdraw" };

export default async function WithdrawPage() {
  const [assets, withdrawals, portfolio] = await Promise.all([getAssetNetworks(), getWithdrawals(), getPortfolio()]);

  const balances: Record<string, { available: string; decimals: number }> = {};
  for (const h of portfolio.holdings) {
    balances[h.symbol] = { available: h.available, decimals: h.decimals };
  }

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <Link href="/wallets" className="jc-link jc-sm">
          ← Wallets
        </Link>
        <p className="jc-eyebrow" style={{ marginTop: "var(--jc-space-4)" }}>
          Withdraw
        </p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Send crypto
        </h1>
      </header>

      <Card>
        <CardHeader title="Withdrawal request" />
        <CardContent>
          <WithdrawPanel assets={assets} balances={balances} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Withdrawal history" as="h2" />
        <WithdrawalsTable rows={withdrawals} />
      </Card>
    </div>
  );
}
