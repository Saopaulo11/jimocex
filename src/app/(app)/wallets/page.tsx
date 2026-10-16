import type { Metadata } from "next";

import { CurrencyAmount, PriceSourceNote, Stat } from "@/components/financial";
import { Card, CardContent, CardHeader, LinkButton } from "@/components/ui";
import { parseMoney } from "@/lib/money";
import { getPortfolio } from "@/lib/portfolio/portfolio";

import { WalletsList } from "./WalletsList";

export const metadata: Metadata = { title: "Wallets" };

export default async function WalletsPage() {
  const portfolio = await getPortfolio();

  return (
    <div className="jc-container jc-stack-lg">
      <header className="jc-row-between jc-row-wrap">
        <div>
          <p className="jc-eyebrow">Wallets</p>
          <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
            Balances
          </h1>
        </div>
        <div className="jc-row jc-row-wrap">
          <LinkButton href="/wallets/deposit" variant="primary" size="sm">
            Deposit
          </LinkButton>
          <LinkButton href="/wallets/withdraw" variant="secondary" size="sm">
            Withdraw
          </LinkButton>
          <LinkButton href="/wallets/transactions" variant="ghost" size="sm">
            Transactions
          </LinkButton>
        </div>
      </header>

      <Card>
        <CardHeader
          title="Total balance"
          subtitle={`Estimated in ${portfolio.reportingCurrency}`}
          action={<PriceSourceNote demo={portfolio.demo} available={portfolio.valued} context="Valuation" />}
        />
        <CardContent>
          {portfolio.valued && portfolio.totalUsd !== null ? (
            <Stat label="Total value" value={<CurrencyAmount value={parseMoney(portfolio.totalUsd)} symbol="USD" decimals={2} size="xl" />} />
          ) : portfolio.hasFunds ? (
            <p className="jc-sm">No price source is connected to value these balances in a single currency.</p>
          ) : (
            <p className="jc-sm">You have no balances yet. Make a deposit or an exchange to get started.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Assets" as="h2" />
        <CardContent>
          <WalletsList rows={portfolio.holdings} />
        </CardContent>
      </Card>
    </div>
  );
}
