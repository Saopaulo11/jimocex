import Link from "next/link";

import { Logo } from "@/components/brand/Logo";
import { brand } from "@/config/brand";

import { FOOTER_NAV } from "./nav-config";

/**
 * Site footer (spec §18).
 *
 * The legal column links to pages that do not exist yet, and they are rendered
 * as plain disabled text rather than as links to a 404 — and, more importantly,
 * the footer makes no claim about licensing, regulation or compliance. Those
 * are statements with legal weight, and none of them has been established.
 */
export function Footer() {
  const year = 2026;

  return (
    <footer className="jc-footer">
      <div className="jc-container">
        <div className="jc-footer-grid">
          <div>
            <Logo variant="compact" size={24} />
            <p className="jc-caption" style={{ marginTop: "var(--jc-space-4)", maxWidth: "34ch" }}>
              One account for digital assets, currency markets and global trading.
            </p>
          </div>

          {FOOTER_NAV.map((column) => (
            <div key={column.heading}>
              <h2 className="jc-footer-heading">{column.heading}</h2>
              <ul className="jc-footer-list">
                {column.items.map((item) => (
                  <li key={item.href}>
                    {item.available === false ? (
                      <span className="jc-footer-link" style={{ color: "var(--jc-text-disabled)" }}>
                        {item.label}
                      </span>
                    ) : (
                      <Link href={item.href} className="jc-footer-link">
                        {item.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="jc-footer-bottom">
          <p className="jc-caption">© {year} {brand.companyName}. All rights reserved.</p>
          <p className="jc-caption" style={{ maxWidth: "62ch" }}>
            Trading digital assets and currency markets carries risk, including the possible loss of
            the amount invested. Nothing on this site is investment advice.
          </p>
        </div>
      </div>
    </footer>
  );
}
