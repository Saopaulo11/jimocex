import Link from "next/link";

import { BRAND_TAGLINE, Logo } from "@/components/brand/Logo";
import { brand } from "@/config/brand";

/**
 * Authentication shell (spec §34).
 *
 * Two columns on a desktop: the brand panel carries the identity and the
 * tagline so the form beside it can stay severe — email, password, one action,
 * nothing else. On a phone the panel collapses and only the mark remains above
 * the form.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="jc-auth">
      <aside className="jc-auth-brand">
        <Link href="/" aria-label={`${brand.name} home`}>
          <Logo variant="compact" size={28} />
        </Link>

        <div>
          <p className="jc-display" style={{ maxWidth: "14ch", fontSize: "clamp(2.25rem, 2.6vw, 3rem)" }}>
            Global markets.
            <br />
            One platform.
          </p>
          <p
            className="jc-label"
            style={{ marginTop: "var(--jc-space-6)", color: "var(--jc-gold)" }}
          >
            {BRAND_TAGLINE}
          </p>
        </div>

        <p className="jc-caption" style={{ maxWidth: "44ch" }}>
          One account for digital assets, currency markets and global trading.
        </p>
      </aside>

      <main className="jc-auth-form-side">
        <div className="jc-auth-form">
          <div className="jc-auth-mobile-brand">
            <Link href="/" aria-label={`${brand.name} home`}>
              <Logo variant="compact" size={26} />
            </Link>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
