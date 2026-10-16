import type { Metadata } from "next";

import { AccountStatus, AccountTier } from "@/components/financial";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/datetime";

import { AccountSubnav } from "../AccountSubnav";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const viewer = await requireUser();
  const p = viewer.profile;

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Account</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Profile
        </h1>
      </header>

      <AccountSubnav />

      <Card>
        <CardHeader title="Account details" />
        <CardContent>
          <div className="jc-summary">
            <Row k="Display name" v={p.display_name ?? "—"} />
            <Row k="Email" v={viewer.email} />
            <Row k="Account ID" v={<span className="jc-numeric jc-caption">{viewer.userId}</span>} />
            <Row k="Country" v={p.country_code ?? "—"} />
            <Row k="Status" v={<AccountStatus status={p.status} />} />
            <Row k="Tier" v={<AccountTier code={p.tier_code} />} />
            <Row k="Created" v={formatDateTime(p.created_at)} />
            <Row k="Updated" v={formatDateTime(p.updated_at)} />
          </div>
          <p className="jc-caption" style={{ marginTop: "var(--jc-space-5)" }}>
            Editing profile details is not available in this prototype. Contact support to change account information.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="jc-summary-row">
      <span className="jc-summary-key">{k}</span>
      <span className="jc-summary-val">{v}</span>
    </div>
  );
}
