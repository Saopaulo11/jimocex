import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Alert } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";
import { listMarkets } from "@/lib/markets/pairs";
import { getTickers } from "@/lib/markets/ticker";
import type { MarketTicker } from "@/lib/markets/types";

import { MarketsTable } from "./MarketsTable";

export const metadata: Metadata = {
  title: "Markets",
  description: `Track prices, volume and movement across every market listed on ${brand.name}.`,
};

export default async function MarketsPage() {
  const [viewer, { markets }, tickerData] = await Promise.all([getViewer(), listMarkets(), getTickers()]);

  const tickers: Record<string, MarketTicker> = {};
  for (const [pair, t] of tickerData.tickers) {
    tickers[pair] = {
      price: t.price,
      changePercent24h: t.changePercent24h,
      high24h: t.high24h,
      low24h: t.low24h,
      volume24h: t.volume24h,
    };
  }

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

        {!tickerData.available ? (
          <Alert tone="info" title="Market data is currently unavailable">
            {tickerData.kind === "live"
              ? "The market-data source cannot be reached right now."
              : "No price feed is connected on this deployment."}{" "}
            Pair listings below are real platform configuration; prices, changes and volumes are left blank rather than
            estimated.
          </Alert>
        ) : tickerData.demo ? (
          <Alert tone="warning" title="Demo market data">
            The pair listings are real platform configuration, but the prices, changes and volumes shown are
            deterministic demo data — not a live market feed. They update once a day and are for demonstration only.
          </Alert>
        ) : (
          <Alert tone="info" title="Market data">
            Prices, changes and volumes come from a public market-data source and are refreshed periodically. They are
            for information only — not executable quotes. A pair the source does not cover shows a dash.
          </Alert>
        )}

        <MarketsTable markets={markets} tickers={tickers} pricesAvailable={tickerData.available} />
      </div>
    </PublicShell>
  );
}
