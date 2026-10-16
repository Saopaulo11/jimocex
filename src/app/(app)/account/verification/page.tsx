import type { Metadata } from "next";

import { AccountTier, KycStatus } from "@/components/financial";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

import { AccountSubnav } from "../AccountSubnav";

export const metadata: Metadata = { title: "Verification" };

export default async function VerificationPage() {
  const viewer = await requireUser();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Account</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Verification
        </h1>
      </header>

      <AccountSubnav />

      <Card>
        <CardHeader title="Identity" action={<KycStatus status={viewer.profile.kyc_status} />} />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Account tier</span>
              <span className="jc-summary-val">
                <AccountTier code={viewer.profile.tier_code} />
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Identity verification (KYC)</span>
              <span className="jc-summary-val">
                <KycStatus status={viewer.profile.kyc_status} />
              </span>
            </div>
          </div>
          <p className="jc-caption" style={{ marginTop: "var(--jc-space-5)" }}>
            Verification is requested when an operation requires it. Risk and compliance rules may ask for it before a
            tier&rsquo;s limit is reached. Your limits are shown on the dashboard.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Compliance providers" as="h2" />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">KYC provider</span>
              <span className="jc-summary-val">
                <Badge tone="neutral" glyph={null}>Not connected</Badge>
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">AML screening</span>
              <span className="jc-summary-val">
                <Badge tone="neutral" glyph={null}>Not connected</Badge>
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Risk state</span>
              <span className="jc-summary-val">
                {viewer.profile.status === "RESTRICTED" ? (
                  <Badge tone="warning" glyph={null}>Under review</Badge>
                ) : (
                  <Badge tone="success" glyph={null}>Normal</Badge>
                )}
              </span>
            </div>
          </div>
          <p className="jc-caption" style={{ marginTop: "var(--jc-space-5)" }}>
            No KYC or AML provider is connected on this deployment. The interface and account model are ready for one;
            verification cannot be started until a provider is configured.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
