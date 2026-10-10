import type { Metadata } from "next";

import { AppShell } from "@/components/layout";
import { getViewer } from "@/lib/auth/session";
import { listMarkets } from "@/lib/markets/pairs";

import { TradeTerminal } from "./TradeTerminal";

export const metadata: Metadata = {
  title: "Trade",
  description: "Place market and limit orders across crypto and currency pairs.",
};

/** Opens on the first listed market; /trade/[pair] selects a specific one. */
export default async function TradePage() {
  const [viewer, { markets, pricesAvailable }] = await Promise.all([getViewer(), listMarkets()]);

  return (
    <AppShell signedIn={Boolean(viewer)}>
      <TradeTerminal
        markets={markets}
        selected={markets[0] ?? null}
        pricesAvailable={pricesAvailable}
      />
    </AppShell>
  );
}
