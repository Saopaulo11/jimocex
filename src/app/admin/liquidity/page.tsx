import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Operator · Liquidity" };

export default function AdminLiquidityPage() {
  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Liquidity
        </h1>
      </header>

      <Card>
        <CardHeader title="Liquidity / execution" as="h2" />
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
              <span className="jc-summary-key">Connected</span>
              <span className="jc-summary-val">No</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Supported pairs</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Execution</span>
              <span className="jc-summary-val">Unavailable</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Last sync</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Provider order count</span>
              <span className="jc-summary-val">
                <span className="jc-numeric">0</span>
              </span>
            </div>
          </div>
          <p className="jc-caption jc-muted" style={{ marginTop: "var(--jc-space-5)" }}>
            No liquidity or execution provider is connected on this deployment. No orders are routed externally.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
