import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader, LinkButton } from "@/components/ui";
import { getAdminStats } from "@/lib/admin/reads";
import { marketDataStatus } from "@/lib/markets/ticker";

export const metadata: Metadata = { title: "Operator · Dashboard" };

const PROVIDERS = [
  { name: "Liquidity / execution", status: "Not connected", tone: "neutral" as const },
  { name: "Custody", status: "Not connected", tone: "neutral" as const },
  { name: "Payments / fiat", status: "Not connected", tone: "neutral" as const },
  { name: "KYC / AML", status: "Not connected", tone: "neutral" as const },
  { name: "Notifications", status: "Not connected", tone: "neutral" as const },
];

export default async function AdminDashboardPage() {
  const stats = await getAdminStats();
  const marketData = marketDataStatus();
  const providers = [{ name: "Market data", status: marketData.status, tone: marketData.tone }, ...PROVIDERS];

  const metrics = [
    { label: "Users", value: stats.users },
    { label: "Orders", value: stats.orders },
    { label: "Open orders", value: stats.openOrders },
    { label: "Trades", value: stats.trades },
    { label: "Deposits", value: stats.deposits },
    { label: "Withdrawals", value: stats.withdrawals },
  ];

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Overview
        </h1>
      </header>

      <div className="jc-grid jc-grid-3">
        {metrics.map((m) => (
          <Card key={m.label}>
            <CardContent>
              <span className="jc-stat-label">{m.label}</span>
              <div className="jc-amount-display jc-amount-display--xl" style={{ marginTop: "var(--jc-space-2)" }}>
                {m.value.toLocaleString("en-US")}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {stats.pendingWithdrawals > 0 ? (
        <Card>
          <CardContent>
            <div className="jc-row-between jc-row-wrap">
              <div>
                <h2 className="jc-h4">Pending withdrawals</h2>
                <p className="jc-caption" style={{ marginTop: "var(--jc-space-2)" }}>
                  {stats.pendingWithdrawals} request(s) awaiting review.
                </p>
              </div>
              <LinkButton href="/admin/withdrawals" variant="secondary" size="sm">
                Review
              </LinkButton>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Provider status" subtitle="External integrations the client connects" as="h2" />
        <CardContent>
          <div className="jc-summary">
            {providers.map((p) => (
              <div key={p.name} className="jc-summary-row">
                <span className="jc-summary-key">{p.name}</span>
                <span className="jc-summary-val">
                  <Badge tone={p.tone} glyph={null}>
                    {p.status}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
          <p className="jc-caption" style={{ marginTop: "var(--jc-space-5)" }}>
            No external provider is connected on this deployment. Each is an adapter behind a server-side boundary,
            ready to be configured — see the Providers section.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
