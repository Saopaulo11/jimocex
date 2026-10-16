import type { Metadata } from "next";

import { AppShell } from "@/components/layout";
import { getViewer } from "@/lib/auth/session";
import { listMarkets } from "@/lib/markets/pairs";
import { getTerminalMarketData } from "@/lib/markets/ticker";
import { getOpenOrders, getWalletBalances } from "@/lib/trade/account";

import { TradeTerminal } from "./TradeTerminal";

export const metadata: Metadata = {
  title: "Trade",
  description: "Place market and limit orders across crypto and currency pairs.",
};

/** Opens on the first listed market; /trade/[pair] selects a specific one. */
export default async function TradePage() {
  const [viewer, { markets }] = await Promise.all([getViewer(), listMarkets()]);
  const selected = markets[0] ?? null;

  const signedIn = Boolean(viewer);
  // Balances and orders are read only for a signed-in user, through the
  // user-scoped client (RLS), so a logged-out visitor can still see the market.
  const [balances, openOrders, market] = await Promise.all([
    signedIn ? getWalletBalances() : Promise.resolve([]),
    signedIn ? getOpenOrders() : Promise.resolve([]),
    getTerminalMarketData(selected?.symbol ?? null),
  ]);

  return (
    <AppShell signedIn={signedIn}>
      <TradeTerminal
        markets={markets}
        selected={selected}
        market={market}
        signedIn={signedIn}
        verified={Boolean(viewer?.emailVerified)}
        balances={balances}
        openOrders={openOrders}
      />
    </AppShell>
  );
}
