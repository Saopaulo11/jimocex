"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavSection } from "./nav-config";

/**
 * The signed-in application sidebar.
 *
 * Reads its sections from nav-config, so the IA lives in one place. A route
 * whose page does not exist yet renders as a disabled row (never a link to a
 * 404), exactly as the header and footer treat `available: false`. Active state
 * is driven by `aria-current="page"`, which both styles the row and announces
 * it to a screen reader.
 */

const ICONS: Record<string, React.ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </svg>
  ),
  markets: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 14.5 7.5 9l3.5 3.5L17 5.5" />
      <path d="M13 5.5h4v4" />
    </svg>
  ),
  trade: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 16V9M8 16V4M12 16v-5M16 16V7" />
    </svg>
  ),
  exchange: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h11l-2.5-2.5M16 13H5l2.5 2.5" />
    </svg>
  ),
  portfolio: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M10 3a7 7 0 1 0 7 7h-7V3Z" />
      <path d="M13 3.5A6 6 0 0 1 16.5 7H13V3.5Z" />
    </svg>
  ),
  wallet: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="3" y="5.5" width="14" height="10" rx="2" />
      <path d="M13 10.5h2.5" strokeLinecap="round" />
    </svg>
  ),
  orders: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h8a1 1 0 0 1 1 1v11l-2-1.3-1.5 1-1.5-1-1.5 1L7 15.7 5 17V5a1 1 0 0 1 1-1Z" />
      <path d="M8 8h4M8 11h4" />
    </svg>
  ),
  account: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5a6 6 0 0 1 12 0" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" strokeLinecap="round" />
    </svg>
  ),
  support: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7" />
      <path d="M7.8 7.8a2.2 2.2 0 0 1 3.4.3c.6.9-.2 1.6-.9 2.1-.5.4-.8.7-.8 1.3" />
      <path d="M10 14.2h.01" />
    </svg>
  ),
};

export function Sidebar({ sections, ariaLabel = "Account" }: { sections: NavSection[]; ariaLabel?: string }) {
  const pathname = usePathname();

  const isCurrent = (href: string) =>
    href === "/dashboard" || href === "/admin"
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="jc-sidebar" aria-label={ariaLabel}>
      {sections.map((section) => (
        <div key={section.heading} className="jc-sidebar-section">
          <p className="jc-sidebar-heading">{section.heading}</p>
          <ul className="jc-sidebar-list">
            {section.items.map((item) => {
              const icon = item.icon ? ICONS[item.icon] : null;
              if (item.available === false) {
                return (
                  <li key={item.href}>
                    <span className="jc-sidebar-link" aria-disabled="true" title="Coming soon">
                      {icon ? <span className="jc-sidebar-icon" aria-hidden="true">{icon}</span> : null}
                      <span>{item.label}</span>
                    </span>
                  </li>
                );
              }
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="jc-sidebar-link"
                    aria-current={isCurrent(item.href) ? "page" : undefined}
                  >
                    {icon ? <span className="jc-sidebar-icon" aria-hidden="true">{icon}</span> : null}
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
