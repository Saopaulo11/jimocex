import type { Metadata } from "next";
import Link from "next/link";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "How it works",
  description: `The steps to using ${brand.name}, and what each one does today.`,
};

const STEPS: { title: string; body: string; note: string }[] = [
  {
    title: "1. Create an account",
    body: "Sign up with your email and a password. Your tier sets the operation limits that are checked on the server for everything you do.",
    note: "No KYC/AML provider is connected, so identity verification cannot be started on this deployment.",
  },
  {
    title: "2. Deposit",
    body: "Choose an asset and network to see a deposit address for receiving crypto into your account.",
    note: "No custodian is connected: the address shown is a prototype, is not monitored, and deposits are not detected or credited.",
  },
  {
    title: "3. Trade or Exchange",
    body: "Place limit orders on a market, or swap one asset for another. Fees and reserves are computed on the server and shown before you commit.",
    note: "No execution venue is connected, so market orders are refused and submitted orders are not matched or filled.",
  },
  {
    title: "4. Withdraw",
    body: "Enter an asset, network, destination and amount to request a withdrawal. The request is recorded with status Requested.",
    note: "No payout provider is connected: requests are recorded for review and never completed automatically. Nothing is sent.",
  },
];

export default async function HowItWorksPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">How it works</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            How {brand.name} works
          </h1>
          <p className="jc-body">
            Four steps take you from signing up to moving assets. Because this is a prototype, each
            step also states its current limitation honestly.
          </p>
        </header>

        {STEPS.map((step) => (
          <Card key={step.title}>
            <CardHeader title={step.title} />
            <CardContent>
              <p className="jc-sm">{step.body}</p>
              <p className="jc-caption" style={{ marginTop: "var(--jc-space-3)" }}>
                Prototype note: {step.note}
              </p>
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader title="Where to go next" />
          <CardContent>
            <p className="jc-sm">
              Browse the{" "}
              <Link href="/markets" className="jc-link">
                markets
              </Link>
              , open the{" "}
              <Link href="/trade" className="jc-link">
                trade
              </Link>{" "}
              screen to place an order, or use{" "}
              <Link href="/exchange" className="jc-link">
                exchange
              </Link>{" "}
              to swap between assets.
            </p>
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
