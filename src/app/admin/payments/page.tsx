import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Operator · Payments" };

export default function AdminPaymentsPage() {
  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Payments
        </h1>
      </header>

      <Card>
        <CardHeader title="Payments / fiat" as="h2" />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Payment provider</span>
              <span className="jc-summary-val">
                <Badge tone="neutral" glyph={null}>
                  Not connected
                </Badge>
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Fiat deposit</span>
              <span className="jc-summary-val">No</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Fiat withdrawal</span>
              <span className="jc-summary-val">No</span>
            </div>
          </div>
          <p className="jc-caption jc-muted" style={{ marginTop: "var(--jc-space-5)" }}>
            No payment or fiat provider is connected on this deployment. No fiat movement is processed.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
