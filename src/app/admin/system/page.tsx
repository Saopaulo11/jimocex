import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader, type BadgeTone } from "@/components/ui";
import { marketDataStatus } from "@/lib/markets/ticker";

export const metadata: Metadata = { title: "Operator · System" };

const PROVIDERS: { name: string; status: string; tone: BadgeTone }[] = [
  { name: "Liquidity / execution", status: "Not connected", tone: "neutral" },
  { name: "Custody", status: "Not connected", tone: "neutral" },
  { name: "Payments / fiat", status: "Not connected", tone: "neutral" },
  { name: "KYC / AML", status: "Not connected", tone: "neutral" },
  { name: "Notifications", status: "Not connected", tone: "neutral" },
];

const ENVIRONMENT: { key: string; value: string }[] = [
  { key: "Runtime", value: "Node.js" },
  { key: "Framework", value: "Next.js App Router" },
  { key: "Mode", value: "Prototype" },
];

export default function AdminSystemPage() {
  const marketData = marketDataStatus();
  const providers = [{ name: "Market data", status: marketData.status, tone: marketData.tone }, ...PROVIDERS];
  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          System
        </h1>
      </header>

      <Card>
        <CardHeader title="Environment" as="h2" />
        <CardContent>
          <div className="jc-summary">
            {ENVIRONMENT.map((r) => (
              <div key={r.key} className="jc-summary-row">
                <span className="jc-summary-key">{r.key}</span>
                <span className="jc-summary-val">{r.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Build" as="h2" />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Version</span>
              <span className="jc-summary-val">prototype</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Database" as="h2" />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Status</span>
              <span className="jc-summary-val">
                <Badge tone="success" glyph={null}>
                  Connected
                </Badge>
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Provider</span>
              <span className="jc-summary-val">Supabase</span>
            </div>
          </div>
        </CardContent>
      </Card>

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
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Operations" as="h2" />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Maintenance mode</span>
              <span className="jc-summary-val">
                <Badge tone="neutral" glyph={null}>
                  Off
                </Badge>
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Feature flags</span>
              <span className="jc-summary-val jc-muted">None enabled on this deployment</span>
            </div>
          </div>
          <p className="jc-caption jc-muted" style={{ marginTop: "var(--jc-space-5)" }}>
            No secrets, keys, or environment values are shown here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
