import type { ReactNode } from "react";

import { Header } from "./Header";
import { MobileNav } from "./MobileNav";

/**
 * Shell for the signed-in area.
 *
 * No footer: the legal and marketing columns belong on public pages, and a
 * dashboard should end where the data ends. The bottom navigation takes its
 * place on a phone.
 */
export function DashboardShell({
  children,
  accountSlot,
}: {
  children: ReactNode;
  accountSlot?: ReactNode;
}) {
  return (
    <div className="jc-shell">
      <a className="jc-skip-link" href="#main">
        Skip to content
      </a>
      <Header signedIn accountSlot={accountSlot} />
      <main
        id="main"
        className="jc-shell-main jc-shell-main--with-mobilenav"
        style={{ paddingBlock: "var(--jc-space-8)" }}
      >
        {children}
      </main>
      <MobileNav />
    </div>
  );
}
