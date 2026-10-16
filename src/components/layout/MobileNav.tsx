"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { MOBILE_NAV } from "./nav-config";

/**
 * Bottom navigation for phones (spec §47).
 *
 * Not a shrunken desktop header: on a phone the four things a customer does
 * live within thumb reach at the bottom of the screen, and account settings go
 * behind a separate menu rather than competing with them.
 */

const ICONS: Record<string, React.ReactNode> = {
  "/markets": (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 14.5 7.5 9l3.5 3.5L17 5.5" />
      <path d="M13 5.5h4v4" />
    </svg>
  ),
  "/exchange": (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h11l-2.5-2.5M16 13H5l2.5 2.5" />
    </svg>
  ),
  "/trade": (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 16V9M8 16V4M12 16v-5M16 16V7" />
    </svg>
  ),
  "/wallets": (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="3" y="5.5" width="14" height="10" rx="2" />
      <path d="M13 10.5h2.5" strokeLinecap="round" />
    </svg>
  ),
  "/orders": (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h8a1 1 0 0 1 1 1v11l-2-1.3-1.5 1-1.5-1-1.5 1L7 15.7 5 17V5a1 1 0 0 1 1-1Z" />
      <path d="M8 8h4M8 11h4" />
    </svg>
  ),
  "/account": (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5a6 6 0 0 1 12 0" />
    </svg>
  ),
};

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="jc-mobilenav" aria-label="Primary">
      {MOBILE_NAV.map((item) => {
        const isCurrent = pathname === item.href || pathname.startsWith(`${item.href}/`);

        if (item.available === false) {
          return (
            <span key={item.href} className="jc-mobilenav-item" aria-disabled="true">
              <span aria-hidden="true">{ICONS[item.href]}</span>
              {item.label}
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            className="jc-mobilenav-item"
            aria-current={isCurrent ? "page" : undefined}
          >
            <span aria-hidden="true">{ICONS[item.href]}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
