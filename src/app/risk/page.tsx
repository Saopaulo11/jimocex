import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Risk Disclosure",
  description: `Risk Disclosure for trading digital assets on ${brand.name}.`,
};

export default async function RiskPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Legal</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            Risk Disclosure
          </h1>
          <p className="jc-body">
            Trading digital assets carries real risk. This page sets out, in plain language, the
            risks that apply when trading on a live platform.
          </p>
        </header>

        <Card>
          <CardHeader title="Prototype notice" />
          <CardContent>
            <p className="jc-sm">
              On this deployment, no real trading occurs. {brand.name} is a prototype with no live
              trading, custody or fiat providers connected, so no real funds are at risk here. The
              points below describe the risks that would apply to a real exchange, and are provided
              so the demonstration is honest about them.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Price volatility" />
          <CardContent>
            <p className="jc-sm">
              Digital asset prices can move sharply and without warning. The value of an asset can
              fall as well as rise, and you could lose some or all of the money you put in.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Liquidity and execution" />
          <CardContent>
            <p className="jc-sm">
              There may not always be a buyer or seller at the price you want. Orders may fill
              partially, at a worse price than expected, or not at all during periods of stress.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Irreversibility and custody" />
          <CardContent>
            <p className="jc-sm">
              On-chain transfers are generally irreversible: a withdrawal sent to the wrong address
              or network cannot be recovered. Holding digital assets carries the risk of loss through
              error, theft or loss of access credentials.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="No advice" />
          <CardContent>
            <p className="jc-sm">
              Nothing in {brand.name} is investment, legal or tax advice. Only trade with money you
              can afford to lose, and seek independent professional advice if you are unsure.
            </p>
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
