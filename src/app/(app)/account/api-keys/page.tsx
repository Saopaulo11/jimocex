import type { Metadata } from "next";

import { Card, CardContent, CardHeader, EmptyState } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

import { AccountSubnav } from "../AccountSubnav";
import { ApiKeysPanel } from "./ApiKeysPanel";

export const metadata: Metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  await requireUser();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Account</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          API keys
        </h1>
      </header>

      <AccountSubnav />

      <Card>
        <CardHeader title="Create a key" />
        <CardContent>
          <ApiKeysPanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Your keys" as="h2" />
        <EmptyState
          title="No keys"
          description="This prototype does not store API keys. A real key store (hashed secrets, scopes, revocation) would back this list once programmatic access is enabled."
        />
      </Card>
    </div>
  );
}
