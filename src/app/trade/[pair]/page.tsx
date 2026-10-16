import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/layout";
import { getViewer } from "@/lib/auth/session";
import { listMarkets } from "@/lib/markets/pairs";
import { getTerminalMarketData } from "@/lib/markets/ticker";
import { getOpenOrders, getWalletBalances } from "@/lib/trade/account";

import { TradeTerminal } from "../TradeTerminal";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pair: string }>;
}): Promise<Metadata> {
  const { pair } = await params;
  return { title: `${pair.replace("-", "/").toUpperCase()} · Trade` };
}

export default async function TradePairPage({ params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  const [viewer, { markets }] = await Promise.all([getViewer(), listMarkets()]);

  const selected = markets.find((m) => m.symbol === pair.toUpperCase());

  // An unknown pair is a 404 rather than a silent fallback to the first market:
  // quietly showing a different market than the URL names is how someone ends
  // up acting on the wrong one.
  if (!selected && markets.length > 0) notFound();

  const signedIn = Boolean(viewer);
  const [balances, openOrders, market] = await Promise.all([
    signedIn ? getWalletBalances() : Promise.resolve([]),
    signedIn ? getOpenOrders() : Promise.resolve([]),
    getTerminalMarketData(selected?.symbol ?? null),
  ]);

  return (
    <AppShell signedIn={signedIn}>
      <TradeTerminal
        markets={markets}
        selected={selected ?? null}
        market={market}
        signedIn={signedIn}
        verified={Boolean(viewer?.emailVerified)}
        balances={balances}
        openOrders={openOrders}
      />
    </AppShell>
  );
}
