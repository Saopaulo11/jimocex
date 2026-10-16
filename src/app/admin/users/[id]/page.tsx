import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminStatusBadge, MonoId } from "@/components/admin";
import { Card, CardContent, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";
import { getUserDetail } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · User" };

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getUserDetail(id);
  if (!detail) notFound();

  const { profile, wallets } = detail;

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <Link href="/admin/users" className="jc-link jc-sm">
          ← Users
        </Link>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-4)" }}>
          {profile.displayName ?? profile.email}
        </h1>
      </header>

      <Card>
        <CardHeader title="Profile" />
        <CardContent>
          <div className="jc-summary">
            <Row k="Email" v={profile.email} />
            <Row k="User ID" v={<MonoId id={profile.userId} />} />
            <Row k="Tier" v={profile.tier.replace("_", " ")} />
            <Row k="KYC" v={<AdminStatusBadge value={profile.kyc} />} />
            <Row k="Status" v={<AdminStatusBadge value={profile.status} />} />
            <Row k="Joined" v={formatDateTime(profile.createdAt)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Balances" as="h2" />
        <Table caption="User balances">
          <thead>
            <tr>
              <Th>Asset</Th>
              <Th numeric>Available</Th>
              <Th numeric>Locked</Th>
            </tr>
          </thead>
          <tbody>
            {wallets.length === 0 ? (
              <TableStateRow colSpan={3}>
                <EmptyState title="No balances" description="This user holds no assets." />
              </TableStateRow>
            ) : (
              wallets.map((w) => (
                <tr key={w.symbol}>
                  <Td>{w.symbol}</Td>
                  <Td numeric>
                    <span className="jc-numeric">{w.available}</span>
                  </Td>
                  <Td numeric>
                    <span className="jc-numeric">{w.locked}</span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
        <CardContent>
          <p className="jc-caption">
            Balances are read-only here. Any adjustment goes through the ledger (`ledger_post`) — never a table write
            from this console.
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
