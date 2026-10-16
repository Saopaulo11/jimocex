import type { Metadata } from "next";
import Link from "next/link";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "About",
  description: `What ${brand.name} is and how it is built.`,
};

export default async function AboutPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">About</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            About {brand.name}
          </h1>
          <p className="jc-body-lg">{brand.tagline}</p>
          <p className="jc-body" style={{ marginTop: "var(--jc-space-3)" }}>
            {brand.description}
          </p>
        </header>

        <Card>
          <CardHeader title="What this is" />
          <CardContent>
            <p className="jc-sm">
              {brand.name} is a modern, multi-asset exchange product that brings trading, exchange
              (swaps), deposits and withdrawals together in one interface. It is designed around a
              single idea: the numbers you see should be the numbers that are true.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Our approach" />
          <CardContent>
            <div className="jc-stack-lg">
              <div>
                <h3 className="jc-h5" style={{ marginBottom: "var(--jc-space-2)" }}>
                  Exact money accounting
                </h3>
                <p className="jc-sm">
                  Balances, holds and fees are computed on the server from an append-only ledger and
                  a published fee schedule — never estimated in the browser. You always see the exact
                  fee and reserve before you commit to an operation.
                </p>
              </div>
              <div>
                <h3 className="jc-h5" style={{ marginBottom: "var(--jc-space-2)" }}>
                  Honest states
                </h3>
                <p className="jc-sm">
                  Where a feature depends on a provider that is not connected, the product says so
                  plainly rather than showing a fabricated figure. A screen that cannot be filled
                  explains why instead of guessing.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="A prototype, not a live exchange" />
          <CardContent>
            <p className="jc-sm">
              This is a prototype and demonstration deployment. No live trading, custody, market-data
              or fiat providers are connected. Orders are not executed against a venue, deposits are
              not monitored or credited, and withdrawal requests are recorded but never sent. Nothing
              here involves real funds, and {brand.name} is not an offer of financial services. See
              the{" "}
              <Link href="/how-it-works" className="jc-link">
                how it works
              </Link>{" "}
              page for what each step does today.
            </p>
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
