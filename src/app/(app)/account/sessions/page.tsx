import type { Metadata } from "next";

import { Badge, Card, CardContent, CardHeader, EmptyState, Table, Td, Th } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

import { AccountSubnav } from "../AccountSubnav";

export const metadata: Metadata = { title: "Sessions" };

export default async function SessionsPage() {
  const viewer = await requireUser();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Account</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Sessions
        </h1>
      </header>

      <AccountSubnav />

      <Card>
        <CardHeader title="Active sessions" subtitle="Where your account is currently signed in" />
        <Table caption="Your active sessions">
          <thead>
            <tr>
              <Th>Session</Th>
              <Th>Account</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>This device</Td>
              <Td>{viewer.email}</Td>
              <Td>
                <Badge tone="success">Active now</Badge>
              </Td>
            </tr>
          </tbody>
        </Table>
        <CardContent>
          <p className="jc-caption">
            Only the current session is shown in this prototype. Listing and revoking sessions across devices requires
            the authentication provider&rsquo;s session API, which is not wired up here. To end this session, sign out
            from the account menu.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Login history" as="h2" />
        <EmptyState title="No history available" description="Sign-in history needs the authentication provider's audit feed, which is not connected." />
      </Card>
    </div>
  );
}
