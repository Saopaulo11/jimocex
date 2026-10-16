import type { ReactNode } from "react";

import { Header } from "./Header";
import { MobileNav } from "./MobileNav";
import { Sidebar } from "./Sidebar";
import { APP_SIDEBAR, type NavSection } from "./nav-config";

/**
 * Shell for the signed-in area.
 *
 * A persistent sidebar carries the product's information architecture on a wide
 * screen; on a phone it collapses and the bottom bar takes over, so the deeper
 * destinations are never out of reach. No footer: the legal and marketing
 * columns belong on public pages, and a dashboard should end where the data
 * ends.
 *
 * `sections` lets a specialised area (the operator console) swap the sidebar for
 * its own IA while keeping the same chrome; it defaults to the customer sidebar.
 */
export function DashboardShell({
  children,
  accountSlot,
  sections = APP_SIDEBAR,
  sidebarLabel = "Account",
}: {
  children: ReactNode;
  accountSlot?: ReactNode;
  sections?: NavSection[];
  sidebarLabel?: string;
}) {
  return (
    <div className="jc-shell">
      <a className="jc-skip-link" href="#main">
        Skip to content
      </a>
      <Header signedIn accountSlot={accountSlot} />
      <div className="jc-app">
        <Sidebar sections={sections} ariaLabel={sidebarLabel} />
        <main id="main" className="jc-app-main jc-shell-main--with-mobilenav">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
