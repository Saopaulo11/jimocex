import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardContent, CardHeader } from "@/components/ui";
import { DepositsTable, LedgerTable, WithdrawalsTable } from "@/components/wallets/tables";
import { getDeposits, getLedgerEntries, getWithdrawals } from "@/lib/wallets/wallets";

export const metadata: Metadata = { title: "Transactions" };

export default async function TransactionsPage() {
  const [entries, deposits, withdrawals] = await Promise.all([
    getLedgerEntries(),
    getDeposits(),
    getWithdrawals(),
  ]);

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <Link href="/wallets" className="jc-link jc-sm">
          ← Wallets
        </Link>
        <p className="jc-eyebrow" style={{ marginTop: "var(--jc-space-4)" }}>
          Transactions
        </p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Account activity
        </h1>
      </header>

      <Card>
        <CardHeader
          title="Ledger movements"
          subtitle="Every balance change, from the append-only ledger"
          as="h2"
        />
        <LedgerTable rows={entries} />
        <CardContent>
          <p className="jc-caption">
            This is the authoritative record of every change to your balances. A deposit, trade, exchange or withdrawal
            each appears here as one or more entries when it settles.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Deposits" as="h2" />
        <DepositsTable rows={deposits} />
      </Card>

      <Card>
        <CardHeader title="Withdrawals" as="h2" />
        <WithdrawalsTable rows={withdrawals} />
      </Card>
    </div>
  );
}
