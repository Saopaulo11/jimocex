import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/layout";
import { getViewer } from "@/lib/auth/session";
import { listMarkets } from "@/lib/markets/pairs";

import { TradeTerminal } from "../TradeTerminal";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pair: string }>;
}): Promise<Metadata> {
  const { pair } = await params;
  return { title: `${pair.replace("-", "/")} · Trade` };
}

export default async function TradePairPage({ params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  const [viewer, { markets, pricesAvailable }] = await Promise.all([getViewer(), listMarkets()]);

  const selected = markets.find((market) => market.symbol === pair.toUpperCase());

  // An unknown pair is a 404 rather than a silent fallback to the first market:
  // quietly showing a different market than the URL names is how someone ends
  // up acting on the wrong one.
  if (!selected && markets.length > 0) notFound();

  return (
    <AppShell signedIn={Boolean(viewer)}>
      <TradeTerminal
        markets={markets}
        selected={selected ?? null}
        pricesAvailable={pricesAvailable}
      />
    </AppShell>
  );
}
