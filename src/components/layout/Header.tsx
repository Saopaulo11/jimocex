import Link from "next/link";

import { Logo } from "@/components/brand/Logo";
import { LinkButton } from "@/components/ui/Button";
import { brand } from "@/config/brand";

import { ACCOUNT_NAV, PRIMARY_NAV } from "./nav-config";
import { NavLink } from "./NavLink";

/**
 * Site header (spec §16).
 *
 * One header for the whole product, in two states. The signed-out state offers
 * the way in; the signed-in state adds transactions and the account menu. There
 * is deliberately no third variant: a page that needs its own header is a sign
 * the navigation model is wrong.
 *
 * On a phone the primary links move to the bottom bar, so the header keeps only
 * the mark and the account action — which is what leaves room for the product
 * rather than for its chrome.
 */

export function Header({
  signedIn = false,
  accountSlot,
}: {
  signedIn?: boolean;
  /** Account menu / sign-out, rendered by the shell that knows the viewer. */
  accountSlot?: React.ReactNode;
}) {
  const items = signedIn ? [...PRIMARY_NAV, ...ACCOUNT_NAV] : PRIMARY_NAV;

  return (
    <header className="jc-header">
      <div className="jc-container jc-header-inner">
        <Link href={signedIn ? "/dashboard" : "/"} aria-label={`${brand.name} home`}>
          <Logo variant="compact" size={26} />
        </Link>

        <nav className="jc-header-nav" aria-label="Primary">
          {items.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </nav>

        <div className="jc-header-actions">
          {signedIn ? (
            accountSlot
          ) : (
            <>
              <LinkButton href="/login" variant="ghost" size="sm">
                Log in
              </LinkButton>
              <LinkButton href="/signup" variant="primary" size="sm">
                Sign up
              </LinkButton>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
