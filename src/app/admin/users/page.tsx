import type { Metadata } from "next";

import { AdminStatusBadge, MonoId } from "@/components/admin";
import { Card, CardHeader, EmptyState, Table, TableStateRow, Td, Th } from "@/components/ui";
import { formatDate } from "@/lib/datetime";
import { listUsers } from "@/lib/admin/reads";

export const metadata: Metadata = { title: "Operator · Users" };

export default async function AdminUsersPage() {
  const users = await listUsers();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Operator console</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Users
        </h1>
      </header>

      <Card>
        <CardHeader title={`${users.length} user${users.length === 1 ? "" : "s"}`} />
        <Table caption="All users">
          <thead>
            <tr>
              <Th>Email</Th>
              <Th>User ID</Th>
              <Th>Tier</Th>
              <Th>KYC</Th>
              <Th>Status</Th>
              <Th>Joined</Th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <TableStateRow colSpan={6}>
                <EmptyState title="No users" description="No user accounts exist yet." />
              </TableStateRow>
            ) : (
              users.map((u) => (
                <tr key={u.userId}>
                  <Td>
                    <a className="jc-link" href={`/admin/users/${u.userId}`}>
                      {u.displayName ?? u.email}
                    </a>
                    {u.displayName ? <span className="jc-caption" style={{ display: "block" }}>{u.email}</span> : null}
                  </Td>
                  <Td>
                    <MonoId id={u.userId} href={`/admin/users/${u.userId}`} />
                  </Td>
                  <Td>
                    <span className="jc-muted">{u.tier.replace("_", " ")}</span>
                  </Td>
                  <Td>
                    <AdminStatusBadge value={u.kyc} />
                  </Td>
                  <Td>
                    <AdminStatusBadge value={u.status} />
                  </Td>
                  <Td>
                    <span className="jc-caption">{formatDate(u.createdAt)}</span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
