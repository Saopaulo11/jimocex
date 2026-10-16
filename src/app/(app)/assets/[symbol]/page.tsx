import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AssetIcon, CurrencyAmount, PriceSourceNote, Stat } from "@/components/financial";
import { OrdersTable } from "@/components/trade";
import { LedgerTable } from "@/components/wallets/tables";
import { Card, CardContent, CardHeader, LinkButton } from "@/components/ui";
import { parseMoney } from "@/lib/money";
import { listAssets } from "@/lib/markets/pairs";
import { getPortfolio } from "@/lib/portfolio/portfolio";
import { getRecentOrders } from "@/lib/trade/history";
import { getAssetNetworks, getLedgerEntries } from "@/lib/wallets/wallets";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  return { title: `${symbol.toUpperCase()} · Asset` };
}

export default async function AssetDetailPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: raw } = await params;
  const symbol = raw.toUpperCase();

  const [assets, portfolio, entries, orders, networks] = await Promise.all([
    listAssets(),
    getPortfolio(),
    getLedgerEntries(200),
    getRecentOrders(100),
    getAssetNetworks(),
  ]);

  const asset = assets.find((a) => a.symbol === symbol);
  if (!asset) notFound();

  const holding = portfolio.holdings.find((h) => h.symbol === symbol);
  const assetEntries = entries.filter((e) => e.symbol === symbol);
  const relatedOrders = orders.filter((o) => o.baseSymbol === symbol || o.quoteSymbol === symbol);
  const hasNetworks = networks.some((n) => n.symbol === symbol);

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <Link href="/assets" className="jc-link jc-sm">
          ← Portfolio
        </Link>
        <div className="jc-row" style={{ gap: "var(--jc-space-4)", alignItems: "center", marginTop: "var(--jc-space-4)" }}>
          <AssetIcon symbol={symbol} size="lg" />
          <div>
            <h1 className="jc-h2">{asset.name}</h1>
            <p className="jc-caption">{symbol} · {asset.type}</p>
          </div>
        </div>
      </header>

      <Card>
        <CardHeader
          title="Balance"
          action={<PriceSourceNote demo={portfolio.demo} available={portfolio.valued} context="Valuation" />}
        />
        <CardContent>
          <div className="jc-stat-pair">
            <Stat
              label="Available"
              value={<CurrencyAmount value={parseMoney(holding?.available ?? "0")} symbol={symbol} decimals={asset.decimals} size="lg" />}
            />
            <Stat
              label="Locked"
              value={<CurrencyAmount value={parseMoney(holding?.locked ?? "0")} symbol={symbol} decimals={asset.decimals} size="lg" />}
              hint="Reserved for open orders and pending withdrawals"
            />
          </div>
          <div style={{ marginTop: "var(--jc-space-5)" }}>
            <Stat
              label="Total"
              value={<CurrencyAmount value={parseMoney(holding?.total ?? "0")} symbol={symbol} decimals={asset.decimals} size="md" />}
              hint={holding?.valueUsd ? `≈ ${holding.valueUsd} USD (demo)` : undefined}
            />
          </div>

          <div className="jc-row jc-row-wrap" style={{ marginTop: "var(--jc-space-6)", gap: "var(--jc-space-3)" }}>
            {hasNetworks ? (
              <>
                <LinkButton href="/wallets/deposit" variant="primary" size="sm">
                  Deposit
                </LinkButton>
                <LinkButton href="/wallets/withdraw" variant="secondary" size="sm">
                  Withdraw
                </LinkButton>
              </>
            ) : (
              <span className="jc-caption">Deposits and withdrawals for {symbol} need a connected provider.</span>
            )}
            <LinkButton href="/markets" variant="ghost" size="sm">
              View markets
            </LinkButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Transactions" as="h2" subtitle={`Ledger movements in ${symbol}`} />
        <LedgerTable rows={assetEntries} />
      </Card>

      <Card>
        <CardHeader title="Related orders" as="h2" />
        <OrdersTable
          rows={relatedOrders}
          caption={`Orders involving ${symbol}`}
          emptyTitle="No related orders"
          emptyDescription={`Orders on a market involving ${symbol} will appear here.`}
        />
      </Card>
    </div>
  );
}
