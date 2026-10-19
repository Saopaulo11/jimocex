import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Badge, Card, CardContent, CardHeader, type BadgeTone } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";
import { marketDataStatus } from "@/lib/markets/ticker";

export const metadata: Metadata = {
  title: "System status",
  description: `Current status of ${brand.name} components.`,
};

const COMPONENTS: { name: string; status: string; tone: BadgeTone; note: string }[] = [
  {
    name: "Platform",
    status: "Operational",
    tone: "success",
    note: "The application, accounts and ledger are running normally.",
  },
  // Market data is filled in at render time from the selected provider (marketDataStatus()).
  { name: "Market data", status: "", tone: "neutral", note: "" },
  {
    name: "Trading engine",
    status: "Awaiting provider",
    tone: "neutral",
    note: "No execution venue is connected, so orders are recorded but not matched or filled.",
  },
  {
    name: "Deposits",
    status: "Awaiting provider",
    tone: "neutral",
    note: "No custodian is connected, so deposits are not detected or credited.",
  },
  {
    name: "Withdrawals",
    status: "Awaiting provider",
    tone: "neutral",
    note: "No payout provider is connected, so requests are recorded but never sent.",
  },
  {
    name: "Exchange",
    status: "Awaiting provider",
    tone: "neutral",
    note: "Swap execution depends on a provider that is not connected on this deployment.",
  },
];

export default async function StatusPage() {
  const viewer = await getViewer();
  const marketData = marketDataStatus();
  const components = COMPONENTS.map((component) =>
    component.name === "Market data"
      ? { ...component, status: marketData.status, tone: marketData.tone, note: marketData.note }
      : component,
  );

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Status</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            System status
          </h1>
          <p className="jc-body">
            The current state of each {brand.name} component. Because this is a prototype, several
            components await a real provider and no uptime figures are reported.
          </p>
        </header>

        <Card>
          <CardHeader title="Components" />
          <CardContent>
            <div className="jc-stack-lg">
              {components.map((component) => (
                <div key={component.name}>
                  <div className="jc-row" style={{ gap: "var(--jc-space-3)", alignItems: "center" }}>
                    <h3 className="jc-h5">{component.name}</h3>
                    <Badge tone={component.tone} glyph={null}>
                      {component.status}
                    </Badge>
                  </div>
                  <p className="jc-caption" style={{ marginTop: "var(--jc-space-2)" }}>
                    {component.note}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
