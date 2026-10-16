import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader, LinkButton } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

import { AccountSubnav } from "../AccountSubnav";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const viewer = await requireUser();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Account</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Security
        </h1>
      </header>

      <AccountSubnav />

      <Card>
        <CardHeader title="Password" />
        <CardContent>
          <div className="jc-row-between jc-row-wrap">
            <p className="jc-sm" style={{ maxWidth: "48ch" }}>
              Change your password through the secure reset flow. You will receive a link by email.
            </p>
            <LinkButton href="/forgot-password" variant="secondary" size="sm">
              Change password
            </LinkButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Two-factor authentication" action={<Badge tone="neutral" glyph={null}>Not enabled</Badge>} />
        <CardContent>
          <p className="jc-sm" style={{ maxWidth: "52ch" }}>
            Two-factor authentication is not available in this prototype. The interface is ready for it; a real
            authenticator or SMS provider would be connected before it is offered.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Sessions" />
        <CardContent>
          <div className="jc-row-between jc-row-wrap">
            <p className="jc-sm" style={{ maxWidth: "48ch" }}>
              Review where your account is signed in.
            </p>
            <LinkButton href="/account/sessions" variant="tertiary" size="sm">
              View sessions
            </LinkButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Email" />
        <CardContent>
          <p className="jc-sm">
            {viewer.emailVerified
              ? "Your email address is confirmed."
              : "Your email address is not yet confirmed. Some operations require a confirmed address."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
