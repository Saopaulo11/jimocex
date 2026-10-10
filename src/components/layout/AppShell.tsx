import type { ReactNode } from "react";

import { Header } from "./Header";
import { MobileNav } from "./MobileNav";

/**
 * Shell for full-bleed application screens — the trading terminal above all.
 *
 * Unlike PublicShell and DashboardShell it applies no container and no vertical
 * padding: a terminal lays out edge to edge, and the page owns its own grid.
 */
export function AppShell({
  children,
  signedIn = false,
  accountSlot,
}: {
  children: ReactNode;
  signedIn?: boolean;
  accountSlot?: ReactNode;
}) {
  return (
    <div className="jc-shell">
      <a className="jc-skip-link" href="#main">
        Skip to content
      </a>
      <Header signedIn={signedIn} accountSlot={accountSlot} />
      <main id="main" className="jc-shell-main jc-shell-main--with-mobilenav">
        {children}
      </main>
      <MobileNav />
    </div>
  );
}
