import type { ReactNode } from "react";

import { Footer } from "./Footer";
import { Header } from "./Header";
import { MobileNav } from "./MobileNav";

/**
 * Shell for pages a signed-out visitor can reach: the landing page, markets,
 * exchange, and the marketing surfaces.
 */
export function PublicShell({
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
      {/* The header's links are hidden below 900px, so without this a visitor on
          a phone has no way to reach Markets, Exchange or Trade (spec §47). */}
      <main id="main" className="jc-shell-main jc-shell-main--with-mobilenav">
        {children}
      </main>
      <Footer />
      <MobileNav />
    </div>
  );
}
