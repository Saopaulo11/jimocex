import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Operator · Custody" };

export default function AdminCustodyPage() {
  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Custody
        </h1>
      </header>

      <Card>
        <CardHeader title="Custody" as="h2" />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Provider status</span>
              <span className="jc-summary-val">
                <Badge tone="neutral" glyph={null}>
                  Not connected
                </Badge>
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Supported assets</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Deposit support</span>
              <span className="jc-summary-val">No</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Withdrawal support</span>
              <span className="jc-summary-val">No</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Last synchronization</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
          </div>
          <p className="jc-caption jc-muted" style={{ marginTop: "var(--jc-space-5)" }}>
            No custody provider is connected on this deployment. No deposit addresses are issued and no payouts are
            executed.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
