import type { Metadata } from "next";

import {
  AccountStatus,
  AccountTier,
  CurrencyAmount,
  EmailVerification,
  KycStatus,
  Stat,
} from "@/components/financial";
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
import { isNonZero, toDecimalString } from "@/lib/money";
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

const OPERATION_ORDER = [
  "SWAP",
  "TRADE",
  "CRYPTO_DEPOSIT",
  "CRYPTO_WITHDRAWAL",
  "FIAT_DEPOSIT",
  "FIAT_WITHDRAWAL",
];

export default async function DashboardPage() {
  const viewer = await requireUser();
  const supabase = await createClient();

  // Read through the user-scoped client: RLS confirms these rows are theirs
  // rather than this page trusting the id it was handed.
  const [{ data: tier }, { data: limits }, { data: wallets }] = await Promise.all([
    supabase
      .from("account_tiers")
      .select("code, name, description")
      .eq("code", viewer.profile.tier_code)
      .single(),
    supabase
      .from("tier_limits")
      .select("operation, window_kind, quote_currency, max_amount")
      .eq("tier_code", viewer.profile.tier_code)
      .eq("is_active", true),
    supabase.from("wallets").select("id, available_balance, locked_balance"),
  ]);

  // Money arrives from the client as a JS number rather than an exact decimal —
  // see the note at the top of @/lib/money. Nothing displayed here is affected
  // yet (tier ceilings and minimum sizes are exactly representable), but every
  // read goes through that boundary so the defect has one place to be fixed.
  const hasFunds = (wallets ?? []).some(
    (wallet) => isNonZero(wallet.available_balance) || isNonZero(wallet.locked_balance),
  );

  const sortedLimits = [...(limits ?? [])].sort((a, b) => {
    const byOperation =
      OPERATION_ORDER.indexOf(a.operation) - OPERATION_ORDER.indexOf(b.operation);
    if (byOperation !== 0) return byOperation;
    return a.window_kind.localeCompare(b.window_kind);
  });

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
          You can sign in and look around, but operations that require a verified address will ask
          for confirmation first.
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------ portfolio */}
      <Card>
        <CardHeader title="Portfolio" subtitle="Across all assets" as="h2" />
        <CardContent>
          {hasFunds ? (
            <div className="jc-stat-pair">
              <Stat label="Available" value={<span className="jc-amount-display jc-amount-display--lg">See wallets</span>} />
              <Stat label="Locked" value={<span className="jc-amount-display jc-amount-display--lg">See wallets</span>} />
            </div>
          ) : (
            <div className="jc-stat-pair">
              {/* A dash, not 0.00. A zero is a claim about a balance; a dash is
                  the absence of one, which is what an empty account actually is
                  before any asset has ever been held. */}
              <Stat label="Available" value={null} pending />
              <Stat label="Locked" value={null} pending />
            </div>
          )}

          <p className="jc-caption" style={{ marginTop: "var(--jc-space-5)" }}>
            Total portfolio value needs a price feed to convert between assets. None is connected
            on this deployment, so no total is shown.
          </p>
        </CardContent>
      </Card>

      {/* -------------------------------------------------------- quick actions */}
      <div className="jc-grid jc-grid-2">
        {[
          { label: "Deposit", href: "/wallets", available: false, body: "No crypto or fiat provider is connected." },
          { label: "Withdraw", href: "/wallets", available: false, body: "No payout provider is connected." },
          { label: "Exchange", href: "/exchange", available: true, body: "Convert between assets at a quoted rate." },
          { label: "Trade", href: "/trade", available: true, body: "Place market and limit orders." },
        ].map((action) => (
          <Card key={action.label} variant={action.available ? "interactive" : "default"}>
            <CardContent>
              <div className="jc-row-between" style={{ alignItems: "flex-start" }}>
                <div>
                  <h3 className="jc-h4">{action.label}</h3>
                  <p className="jc-caption" style={{ marginTop: "var(--jc-space-2)", maxWidth: "36ch" }}>
                    {action.body}
                  </p>
                </div>
                <LinkButton
                  href={action.href}
                  variant="tertiary"
                  size="sm"
                  disabled={!action.available}
                >
                  {action.available ? "Open" : "Unavailable"}
                </LinkButton>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* --------------------------------------------------------- transactions */}
      <Card>
        <CardHeader title="Recent activity" as="h2" />
        <EmptyState
          title="No transactions yet"
          description="Deposits, exchanges, trades and withdrawals will appear here once providers are connected and your first operation settles."
        />
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
                Verification is requested when an operation requires it. Risk and compliance rules
                may ask for it before a tier&rsquo;s limit is reached.
              </p>
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
        <CardHeader
          title="Your limits"
          subtitle="Checked on the server for every operation"
          as="h2"
        />

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
                    <span className="jc-muted">
                      {WINDOW_LABEL[limit.window_kind] ?? limit.window_kind}
                    </span>
                  </Td>
                  <Td numeric>
                    {limit.max_amount === null ? (
                      <span className="jc-muted">By arrangement</span>
                    ) : (
                      <CurrencyAmount
                        value={toDecimalString(limit.max_amount)}
                        symbol={limit.quote_currency}
                        decimals={0}
                      />
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>

        <CardContent>
          <p className="jc-caption">
            These are upper bounds, not entitlements. An operation can still be declined or sent
            for verification by risk and compliance rules below these figures.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
