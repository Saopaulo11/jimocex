import type { Metadata } from "next";

import {
  AccountStatus,
  AccountTier,
  CurrencyAmount,
  EmailVerification,
  KycStatus,
  PriceSourceNote,
  Stat,
} from "@/components/financial";
import { OrdersTable, TradesTable } from "@/components/trade";
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  LinkButton,
  Table,
  TableStateRow,
  Td,
  Th,
} from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { moneySelect } from "@/lib/db/money-columns";
import { fromDatabaseNullable, isPositive, parseMoney } from "@/lib/money";
import { getPortfolio } from "@/lib/portfolio/portfolio";
import { allocationBarWidth, allocationLabel } from "@/lib/portfolio/valuation";
import { getRecentOrders, getTradeHistory } from "@/lib/trade/history";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Overview" };

const WINDOW_LABEL: Record<string, string> = {
  SINGLE: "Per transaction",
  DAILY: "Per day",
  MONTHLY: "Per month",
};

const OPERATION_LABEL: Record<string, string> = {
  SWAP: "Exchange",
  TRADE: "Trade",
  CRYPTO_DEPOSIT: "Crypto deposit",
  CRYPTO_WITHDRAWAL: "Crypto withdrawal",
  FIAT_DEPOSIT: "Fiat deposit",
  FIAT_WITHDRAWAL: "Fiat withdrawal",
};

const OPERATION_ORDER = ["SWAP", "TRADE", "CRYPTO_DEPOSIT", "CRYPTO_WITHDRAWAL", "FIAT_DEPOSIT", "FIAT_WITHDRAWAL"];

const QUICK_ACTIONS = [
  { label: "Deposit", href: "/wallets/deposit", body: "Add crypto to your account." },
  { label: "Withdraw", href: "/wallets/withdraw", body: "Send crypto to an external address." },
  { label: "Trade", href: "/trade", body: "Place limit orders on a market." },
  { label: "Convert", href: "/exchange", body: "Exchange one asset for another." },
];

export default async function DashboardPage() {
  const viewer = await requireUser();
  const supabase = await createClient();

  const [{ data: tier }, { data: limits }, portfolio, recentOrders, recentTrades] = await Promise.all([
    supabase.from("account_tiers").select("code, name, description").eq("code", viewer.profile.tier_code).single(),
    supabase
      .from("tier_limits")
      .select(moneySelect("tier_limits", "operation, window_kind, quote_currency, max_amount"))
      .eq("tier_code", viewer.profile.tier_code)
      .eq("is_active", true)
      .overrideTypes<
        { operation: string; window_kind: string; quote_currency: string; max_amount: string | null }[],
        { merge: false }
      >(),
    getPortfolio(),
    getRecentOrders(5),
    getTradeHistory(5),
  ]);

  const sortedLimits = (limits ?? [])
    .map((limit) => ({
      operation: limit.operation,
      window_kind: limit.window_kind,
      quote_currency: limit.quote_currency,
      max: fromDatabaseNullable(limit.max_amount, "tier_limits.max_amount"),
    }))
    .sort((a, b) => {
      const byOperation = OPERATION_ORDER.indexOf(a.operation) - OPERATION_ORDER.indexOf(b.operation);
      if (byOperation !== 0) return byOperation;
      return a.window_kind.localeCompare(b.window_kind);
    });

  const topHoldings = portfolio.holdings
    .filter((h) => h.valueUsd !== null && isPositive(parseMoney(h.total)))
    .slice(0, 6);

  return (
    <div className="jc-container jc-stack-lg">
      <header className="jc-row-between jc-row-wrap">
        <div>
          <p className="jc-eyebrow">Overview</p>
          <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
            {viewer.profile.display_name ?? viewer.email}
          </h1>
        </div>
        <div className="jc-row jc-row-wrap">
          <AccountTier code={viewer.profile.tier_code} name={tier?.name} />
          <AccountStatus status={viewer.profile.status} />
          <EmailVerification verified={viewer.emailVerified} />
        </div>
      </header>

      {viewer.profile.status !== "ACTIVE" ? (
        <Alert tone="danger" title={`This account is ${viewer.profile.status.toLowerCase()}`}>
          Financial operations are restricted. Please contact support.
        </Alert>
      ) : null}

      {!viewer.emailVerified ? (
        <Alert tone="warning" title="Your email address is not confirmed">
          You can sign in and look around, but operations that require a verified address will ask for confirmation
          first.
        </Alert>
      ) : null}

      {/* -------------------------------------------------------------- portfolio */}
      <Card>
        <CardHeader
          title="Portfolio"
          subtitle={`Estimated value in ${portfolio.reportingCurrency}`}
          as="h2"
          action={<PriceSourceNote demo={portfolio.demo} available={portfolio.valued} context="Valuation" />}
        />
        <CardContent>
          {portfolio.valued && portfolio.totalUsd !== null ? (
            <>
              <Stat
                label="Total value"
                value={<CurrencyAmount value={parseMoney(portfolio.totalUsd)} symbol="USD" decimals={2} size="xl" />}
              />
              <div className="jc-stat-pair" style={{ marginTop: "var(--jc-space-5)" }}>
                <Stat
                  label="Available"
                  value={
                    portfolio.availableUsd === null ? (
                      <span className="jc-muted">—</span>
                    ) : (
                      <CurrencyAmount value={parseMoney(portfolio.availableUsd)} symbol="USD" decimals={2} size="lg" />
                    )
                  }
                />
                <Stat
                  label="Locked"
                  value={
                    portfolio.lockedUsd === null ? (
                      <span className="jc-muted">—</span>
                    ) : (
                      <CurrencyAmount value={parseMoney(portfolio.lockedUsd)} symbol="USD" decimals={2} size="lg" />
                    )
                  }
                  hint="Reserved for open orders and pending withdrawals"
                />
              </div>

              {topHoldings.length > 0 ? (
                <div className="jc-stack" style={{ marginTop: "var(--jc-space-6)" }}>
                  <p className="jc-label">Allocation</p>
                  {topHoldings.map((h) => (
                    <div key={h.symbol} className="jc-alloc-row">
                      <span className="jc-alloc-label">{h.symbol}</span>
                      <span className="jc-alloc-bar" aria-hidden="true">
                        <span className="jc-alloc-fill" style={{ width: `${allocationBarWidth(h.allocationPercent)}%` }} />
                      </span>
                      <span className="jc-alloc-value jc-numeric">{allocationLabel(h.allocationPercent)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <p className="jc-caption" style={{ marginTop: "var(--jc-space-5)" }}>
                Valuation uses demo market data on this deployment. It is an estimate for display only — your balances
                are exact and held in the ledger.
              </p>
            </>
          ) : portfolio.hasFunds ? (
            <div className="jc-stack">
              <p className="jc-sm">You hold balances, but no price source is connected to value them in a single currency.</p>
              <LinkButton href="/assets" variant="tertiary" size="sm">
                View balances
              </LinkButton>
            </div>
          ) : (
            <EmptyState
              title="No assets yet"
              description="Deposit crypto or make your first exchange and your balances will appear here."
            />
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------- quick actions */}
      <div className="jc-grid jc-grid-2">
        {QUICK_ACTIONS.map((action) => (
          <Card key={action.label} variant="interactive">
            <CardContent>
              <div className="jc-row-between" style={{ alignItems: "flex-start" }}>
                <div>
                  <h3 className="jc-h4">{action.label}</h3>
                  <p className="jc-caption" style={{ marginTop: "var(--jc-space-2)", maxWidth: "36ch" }}>
                    {action.body}
                  </p>
                </div>
                <LinkButton href={action.href} variant="tertiary" size="sm">
                  Open
                </LinkButton>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ------------------------------------------------------------ recent orders */}
      <Card>
        <CardHeader
          title="Recent orders"
          as="h2"
          action={
            <LinkButton href="/orders" variant="ghost" size="sm">
              View all
            </LinkButton>
          }
        />
        <OrdersTable
          rows={recentOrders}
          caption="Your five most recent orders"
          emptyTitle="No orders yet"
          emptyDescription="Place a limit order on the Trade screen and it will appear here."
        />
      </Card>

      {/* ------------------------------------------------------------ recent trades */}
      <Card>
        <CardHeader title="Recent trades" as="h2" />
        <TradesTable rows={recentTrades} caption="Your five most recent trades" />
      </Card>

      {/* --------------------------------------------------------- verification */}
      <div className="jc-grid jc-grid-2">
        <Card>
          <CardHeader title="Verification" as="h2" />
          <CardContent>
            <div className="jc-stack">
              <div className="jc-row-between">
                <span className="jc-sm">Identity verification</span>
                <KycStatus status={viewer.profile.kyc_status} />
              </div>
              <p className="jc-caption">
                Verification is requested when an operation requires it. Risk and compliance rules may ask for it before
                a tier&rsquo;s limit is reached.
              </p>
              <LinkButton href="/account/verification" variant="tertiary" size="sm">
                View verification
              </LinkButton>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Account tier" as="h2" />
          <CardContent>
            <p className="jc-sm">{tier?.description ?? "Tier details are unavailable."}</p>
          </CardContent>
        </Card>
      </div>

      {/* --------------------------------------------------------------- limits */}
      <Card>
        <CardHeader title="Your limits" subtitle="Checked on the server for every operation" as="h2" />
        <Table caption="Limits for your account tier, by operation and window">
          <thead>
            <tr>
              <Th>Operation</Th>
              <Th>Window</Th>
              <Th numeric>Maximum</Th>
            </tr>
          </thead>
          <tbody>
            {sortedLimits.length === 0 ? (
              <TableStateRow colSpan={3}>
                <EmptyState title="No limits configured" description="No limit policy is set for this tier." />
              </TableStateRow>
            ) : (
              sortedLimits.map((limit) => (
                <tr key={`${limit.operation}-${limit.window_kind}`}>
                  <Td>{OPERATION_LABEL[limit.operation] ?? limit.operation}</Td>
                  <Td>
                    <span className="jc-muted">{WINDOW_LABEL[limit.window_kind] ?? limit.window_kind}</span>
                  </Td>
                  <Td numeric>
                    {limit.max === null ? (
                      <span className="jc-muted">By arrangement</span>
                    ) : (
                      <CurrencyAmount value={limit.max} symbol={limit.quote_currency} decimals={0} />
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
        <CardContent>
          <p className="jc-caption">
            These are upper bounds, not entitlements. An operation can still be declined or sent for verification by
            risk and compliance rules below these figures.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

