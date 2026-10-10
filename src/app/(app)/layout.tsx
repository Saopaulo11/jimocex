import Link from "next/link";

import { JimoCexLogo } from "@/components/JimoCexLogo";
import { signOut } from "@/app/auth/actions";
import { requireUser } from "@/lib/auth/session";

/**
 * Shell for the signed-in area.
 *
 * `requireUser()` here is a convenience, not the security boundary: it gives
 * the layout a user to render a header with. Every page and every action below
 * performs its own check, because a layout does not re-run for a Server Action
 * and must never be the only thing standing between a request and account data.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireUser();

  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <header style={{ borderBottom: "1px solid var(--jc-border)" }}>
        <div className="jc-container jc-row-between" style={{ minHeight: 68 }}>
          <Link href="/dashboard" aria-label="JimoCex dashboard">
            <JimoCexLogo size={24} />
          </Link>

          <div className="jc-row">
            <span className="jc-muted" style={{ display: "none" }} data-email>
              {viewer.email}
            </span>
            <span className="jc-badge jc-badge-gold">{viewer.profile.tier_code.replace("_", " ")}</span>
            <form action={signOut}>
              <button type="submit" className="jc-btn jc-btn-ghost">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main style={{ flex: 1, paddingBlock: 32 }}>{children}</main>
    </div>
  );
}
