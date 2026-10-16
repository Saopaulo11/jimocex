"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/account", label: "Overview" },
  { href: "/account/profile", label: "Profile" },
  { href: "/account/security", label: "Security" },
  { href: "/account/sessions", label: "Sessions" },
  { href: "/account/api-keys", label: "API keys" },
  { href: "/account/verification", label: "Verification" },
];

/** Horizontal sub-navigation shared by the account pages. */
export function AccountSubnav() {
  const pathname = usePathname();
  return (
    <nav className="jc-subnav" aria-label="Account sections">
      {LINKS.map((link) => {
        const active = link.href === "/account" ? pathname === "/account" : pathname === link.href;
        return (
          <Link key={link.href} href={link.href} className="jc-subnav-link" aria-current={active ? "page" : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
