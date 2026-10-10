import { signOut } from "@/app/auth/actions";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { DashboardShell } from "@/components/layout";
import { requireUser } from "@/lib/auth/session";

/**
 * Shell for the signed-in area.
 *
 * `requireUser()` here gives the header someone to render; it is a convenience,
 * not the security boundary. Every page and every Server Action below performs
 * its own check, because a layout does not re-run for a Server Action and must
 * never be the only thing between a request and account data.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireUser();

  return (
    <DashboardShell
      accountSlot={
        <AccountMenu
          email={viewer.email}
          tierLabel={viewer.profile.tier_code.replace("_", " ")}
          signOutAction={signOut}
        />
      }
    >
      {children}
    </DashboardShell>
  );
}
