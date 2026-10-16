import { signOut } from "@/app/auth/actions";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { DashboardShell, PublicShell } from "@/components/layout";
import { ADMIN_SIDEBAR } from "@/components/layout/nav-config";
import { Alert } from "@/components/ui";
import { getAdminViewer } from "@/lib/auth/session";

/**
 * Operator console shell.
 *
 * Access is decided by `getAdminViewer()` — the same real check as
 * `requireAdmin` (an active `admin_users` row, which a user cannot create for
 * themselves). A signed-in non-staff visitor sees an honest "not authorized"
 * page rather than an error. This is a convenience gate for the chrome; every
 * admin page and read re-establishes staff authority on its own, because a
 * layout does not re-run for a Server Action.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminViewer();

  if (!admin) {
    return (
      <PublicShell>
        <div className="jc-container jc-section">
          <Alert tone="danger" title="Operator access only">
            This area is for platform staff. Your account does not have operator access.
          </Alert>
        </div>
      </PublicShell>
    );
  }

  return (
    <DashboardShell
      sections={ADMIN_SIDEBAR}
      sidebarLabel="Operator console"
      accountSlot={
        <AccountMenu
          email={admin.email}
          tierLabel={`Staff · ${admin.adminRole.replace("_", " ")}`}
          signOutAction={signOut}
        />
      }
    >
      {children}
    </DashboardShell>
  );
}
