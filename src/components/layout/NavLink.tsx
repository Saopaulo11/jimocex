"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "./nav-config";

/**
 * A header navigation link that knows whether it is the current page.
 *
 * `aria-current="page"` is what drives the gold underline in CSS and what a
 * screen reader announces. Doing it with a class alone would style the state
 * without communicating it.
 */
export function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const isCurrent = pathname === item.href || pathname.startsWith(`${item.href}/`);

  if (item.available === false) {
    return (
      <span className="jc-navlink" aria-disabled="true" title="Coming soon">
        {item.label}
      </span>
    );
  }

  return (
    <Link href={item.href} className="jc-navlink" aria-current={isCurrent ? "page" : undefined}>
      {item.label}
    </Link>
  );
}
