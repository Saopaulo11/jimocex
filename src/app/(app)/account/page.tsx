import type { Metadata } from "next";

import { AccountStatus, AccountTier, EmailVerification, KycStatus } from "@/components/financial";
import { Card, CardContent, CardHeader, LinkButton } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { formatDate } from "@/lib/datetime";

import { AccountSubnav } from "./AccountSubnav";

export const metadata: Metadata = { title: "Account" };

const SECTIONS = [
  { href: "/account/profile", title: "Profile", body: "Your account details." },
  { href: "/account/security", title: "Security", body: "Password, two-factor and sessions." },
  { href: "/account/sessions", title: "Sessions", body: "Where your account is signed in." },
  { href: "/account/api-keys", title: "API keys", body: "Programmatic access keys." },
  { href: "/account/verification", title: "Verification", body: "Identity status and limits." },
];

export default async function AccountPage() {
  const viewer = await requireUser();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Account</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          {viewer.profile.display_name ?? viewer.email}
        </h1>
      </header>

      <AccountSubnav />

      <Card>
        <CardHeader title="Summary" />
        <CardContent>
          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Email</span>
              <span className="jc-summary-val">{viewer.email}</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Account ID</span>
              <span className="jc-summary-val jc-numeric jc-caption">{viewer.userId}</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Member since</span>
              <span className="jc-summary-val">{formatDate(viewer.profile.created_at)}</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Status</span>
              <span className="jc-summary-val">
                <AccountStatus status={viewer.profile.status} />
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Tier</span>
              <span className="jc-summary-val">
                <AccountTier code={viewer.profile.tier_code} />
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Email</span>
              <span className="jc-summary-val">
                <EmailVerification verified={viewer.emailVerified} />
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Identity</span>
              <span className="jc-summary-val">
                <KycStatus status={viewer.profile.kyc_status} />
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="jc-grid jc-grid-2">
        {SECTIONS.map((section) => (
          <Card key={section.href} variant="interactive">
            <CardContent>
              <div className="jc-row-between" style={{ alignItems: "flex-start" }}>
                <div>
                  <h2 className="jc-h4">{section.title}</h2>
                  <p className="jc-caption" style={{ marginTop: "var(--jc-space-2)" }}>
                    {section.body}
                  </p>
                </div>
                <LinkButton href={section.href} variant="tertiary" size="sm">
                  Open
                </LinkButton>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
