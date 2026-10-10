import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Alert } from "@/components/ui";
import { getViewer } from "@/lib/auth/session";
import { listMarkets } from "@/lib/markets/pairs";

import { MarketsTable } from "./MarketsTable";

export const metadata: Metadata = {
  title: "Markets",
  description: "Track prices, volume and movement across every market listed on JimoCex.",
};

export default async function MarketsPage() {
  const [viewer, { markets, pricesAvailable }] = await Promise.all([getViewer(), listMarkets()]);

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Markets</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            Listed markets
          </h1>
          <p className="jc-body" style={{ maxWidth: "60ch" }}>
            Crypto, stablecoin, crypto-to-fiat and currency pairs available on the platform.
          </p>
        </header>

        {!pricesAvailable ? (
          <Alert tone="info" title="Market data is currently unavailable">
            No price feed is connected on this deployment. Pair listings below are real platform
            configuration; prices, changes and volumes are left blank rather than estimated.
          </Alert>
        ) : null}

        <MarketsTable markets={markets} pricesAvailable={pricesAvailable} />
      </div>
    </PublicShell>
  );
}
