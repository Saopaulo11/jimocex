import type { Metadata } from "next";

import { CurrencyAmount, PriceSourceNote, Stat } from "@/components/financial";
import { HoldingsTable } from "@/components/wallets/tables";
import { Card, CardContent, CardHeader, EmptyState } from "@/components/ui";
import { isPositive, parseMoney } from "@/lib/money";
import { getPortfolio } from "@/lib/portfolio/portfolio";
import { allocationBarWidth, allocationLabel } from "@/lib/portfolio/valuation";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage() {
  const portfolio = await getPortfolio();
  const valuedHoldings = portfolio.holdings.filter((h) => h.valueUsd !== null && isPositive(parseMoney(h.total)));

  return (
    <div className="jc-container jc-stack-lg">
      <header className="jc-row-between jc-row-wrap">
        <div>
          <p className="jc-eyebrow">Portfolio</p>
          <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
            Your assets
          </h1>
        </div>
        <PriceSourceNote demo={portfolio.demo} available={portfolio.valued} context="Valuation" />
      </header>

      <div className="jc-grid jc-grid-2">
        <Card>
          <CardHeader title="Total value" subtitle={`Estimated in ${portfolio.reportingCurrency}`} />
          <CardContent>
            {portfolio.valued && portfolio.totalUsd !== null ? (
              <Stat label="Across all assets" value={<CurrencyAmount value={parseMoney(portfolio.totalUsd)} symbol="USD" decimals={2} size="xl" />} />
            ) : portfolio.hasFunds ? (
              <p className="jc-sm">No price source is connected to value these balances.</p>
            ) : (
              <p className="jc-sm">No assets held yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Allocation" />
          <CardContent>
            {valuedHoldings.length > 0 ? (
              <div className="jc-stack">
                {valuedHoldings.slice(0, 8).map((h) => (
                  <div key={h.symbol} className="jc-alloc-row">
                    <span className="jc-alloc-label">{h.symbol}</span>
                    <span className="jc-alloc-bar" aria-hidden="true">
                      <span className="jc-alloc-fill" style={{ width: `${allocationBarWidth(h.allocationPercent)}%` }} />
                    </span>
                    <span className="jc-alloc-value jc-numeric">{allocationLabel(h.allocationPercent)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing to allocate" description="Your allocation appears here once you hold valued assets." />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader title="Holdings" as="h2" />
        <HoldingsTable rows={portfolio.holdings} showActions />
      </Card>

      {portfolio.demo ? (
        <p className="jc-caption">
          Values use demo market data on this deployment and are estimates for display only. Your balances are exact
          and held in the ledger.
        </p>
      ) : null}
    </div>
  );
}

