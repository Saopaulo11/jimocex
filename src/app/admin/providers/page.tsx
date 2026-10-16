import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader, type BadgeTone } from "@/components/ui";

export const metadata: Metadata = { title: "Operator · Providers" };

const PROVIDER_CLASSES: { name: string; adapter: string; status: string; tone: BadgeTone }[] = [
  { name: "Liquidity / execution", adapter: "unavailable", status: "Not configured", tone: "neutral" },
  { name: "Custody", adapter: "unavailable", status: "Not configured", tone: "neutral" },
  { name: "KYC", adapter: "unavailable", status: "Not configured", tone: "neutral" },
  { name: "AML", adapter: "unavailable", status: "Not configured", tone: "neutral" },
  { name: "Payments", adapter: "unavailable", status: "Not configured", tone: "neutral" },
  { name: "Fiat", adapter: "unavailable", status: "Not configured", tone: "neutral" },
  { name: "Market data", adapter: "prototype", status: "Demo", tone: "warning" },
  { name: "Notifications", adapter: "unavailable", status: "Not configured", tone: "neutral" },
];

export default function AdminProvidersPage() {
  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Providers
        </h1>
      </header>

      <Card>
        <CardContent>
          <p className="jc-muted">
            This is a configuration surface for the client to connect providers later. No secrets or API credentials are
            shown or accepted here.
          </p>
        </CardContent>
      </Card>

      <div className="jc-grid jc-grid-2">
        {PROVIDER_CLASSES.map((p) => (
          <Card key={p.name}>
            <CardHeader title={p.name} as="h2" />
            <CardContent>
              <div className="jc-summary">
                <div className="jc-summary-row">
                  <span className="jc-summary-key">Adapter</span>
                  <span className="jc-summary-val jc-muted">{p.adapter}</span>
                </div>
                <div className="jc-summary-row">
                  <span className="jc-summary-key">Status</span>
                  <span className="jc-summary-val">
                    <Badge tone={p.tone} glyph={null}>
                      {p.status}
                    </Badge>
                  </span>
                </div>
                <div className="jc-summary-row">
                  <span className="jc-summary-key">Environment</span>
                  <span className="jc-summary-val jc-muted">—</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
