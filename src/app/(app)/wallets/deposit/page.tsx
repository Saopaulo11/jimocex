import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardContent, CardHeader } from "@/components/ui";
import { DepositsTable } from "@/components/wallets/tables";
import { requireUser } from "@/lib/auth/session";
import { buildDepositAddresses, getAssetNetworks, getDeposits } from "@/lib/wallets/wallets";

import { DepositPanel } from "./DepositPanel";

export const metadata: Metadata = { title: "Deposit" };

export default async function DepositPage() {
  const [viewer, assets, deposits] = await Promise.all([requireUser(), getAssetNetworks(), getDeposits()]);
  const addresses = buildDepositAddresses(viewer.userId, assets);

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <Link href="/wallets" className="jc-link jc-sm">
          ← Wallets
        </Link>
        <p className="jc-eyebrow" style={{ marginTop: "var(--jc-space-4)" }}>
          Deposit
        </p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Receive crypto
        </h1>
      </header>

      <Card>
        <CardHeader title="Choose asset and network" />
        <CardContent>
          <DepositPanel assets={assets} addresses={addresses} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Deposit history" as="h2" />
        <DepositsTable rows={deposits} />
      </Card>
    </div>
  );
}
