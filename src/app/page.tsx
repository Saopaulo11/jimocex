import type { Metadata } from "next";

import { BRAND_TAGLINE } from "@/components/brand/Logo";
import { PublicShell } from "@/components/layout";
import { Card, CardContent, LinkButton } from "@/components/ui";
import { getViewer } from "@/lib/auth/session";
import { listMarkets } from "@/lib/markets/pairs";

export const metadata: Metadata = {
  title: "JimoCex — Global Markets & Digital Assets",
  description:
    "One account for digital assets, currency markets and global trading. Exchange, trade and track markets on a single platform.",
};

const PRODUCTS = [
  {
    name: "Exchange",
    href: "/exchange",
    body: "Convert between digital assets and currencies at a quoted rate, with the fee shown before you commit.",
  },
  {
    name: "Trade",
    href: "/trade",
    body: "Place market and limit orders across crypto and currency pairs from one order book.",
  },
  {
    name: "Markets",
    href: "/markets",
    body: "Track prices, volume and movement across every listed pair.",
  },
];

/**
 * What the platform actually provides, stated without embellishment (spec §42).
 *
 * Nothing here claims a licence, a regulator, a bank partnership or an audit.
 * Those are statements with legal weight and none of them has been established;
 * the list is confined to properties the architecture genuinely has.
 */
const TRUST = [
  { title: "Segregated ledger", body: "Every balance is derived from an append-only ledger that cannot be edited after the fact." },
  { title: "Server-side limits", body: "Limits, fees and eligibility are decided on the server. The interface displays the result; it never computes one." },
  { title: "Controlled withdrawals", body: "Outbound transfers pass limit, risk and compliance checks before any provider is called." },
  { title: "Multi-asset", body: "Crypto, stablecoins and currency markets under one account and one set of controls." },
];

const TIERS = [
  { code: "Tier 0", name: "Email registration", body: "Up to $5,000 equivalent, subject to risk and compliance requirements." },
  { code: "Tier 1", name: "Identity verification", body: "Higher limits across exchange, trading and withdrawals." },
  { code: "Tier 2", name: "Enhanced verification", body: "Enhanced due diligence completed. Higher limits again." },
  { code: "Tier 3", name: "Institutional", body: "Limits set by arrangement rather than by schedule." },
];

export default async function HomePage() {
  const [viewer, { markets, pricesAvailable }] = await Promise.all([getViewer(), listMarkets()]);

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      {/* ---------------------------------------------------------------- hero */}
      <section className="jc-hero">
        <div className="jc-container jc-hero-inner">
          <div>
            <p className="jc-eyebrow">{BRAND_TAGLINE}</p>

            <h1 className="jc-display" style={{ marginBlock: "var(--jc-space-5) var(--jc-space-6)" }}>
              Global markets.
              <br />
              One platform.
            </h1>

            <p className="jc-body-lg" style={{ maxWidth: "46ch" }}>
              One account for digital assets, currency markets and global trading.
            </p>

            <div className="jc-row jc-row-wrap" style={{ marginTop: "var(--jc-space-8)" }}>
              <LinkButton href="/markets" variant="primary" size="lg">
                Explore markets
              </LinkButton>
              <LinkButton href={viewer ? "/trade" : "/signup"} variant="tertiary" size="lg">
                Start trading
              </LinkButton>
            </div>

            <div className="jc-trust-row">
              {["Multi-asset account", "Append-only ledger", "Server-side controls"].map((item) => (
                <span key={item} className="jc-trust-item">
                  <span aria-hidden="true" style={{ color: "var(--jc-gold)" }}>—</span>
                  {item}
                </span>
              ))}
            </div>
          </div>

          {/* The listed pairs are real configuration. The prices are not shown,
              because no provider can supply them — see lib/markets/pairs.ts. */}
          <Card variant="elevated" aria-label="Listed markets">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--jc-space-4) var(--jc-space-5)",
                borderBottom: "1px solid var(--jc-border)",
              }}
            >
              <span className="jc-panel-title">Listed markets</span>
              <span className="jc-caption">{markets.length} pairs</span>
            </div>

            <div>
              {markets.slice(0, 6).map((market, index) => (
                <div
                  key={market.symbol}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--jc-space-4)",
                    padding: "var(--jc-space-3) var(--jc-space-5)",
                    borderTop: index === 0 ? "none" : "1px solid var(--jc-border-subtle)",
                  }}
                >
                  <span style={{ fontSize: "var(--jc-text-sm)", fontWeight: 500 }}>
                    {market.base}
                    <span className="jc-muted">/{market.quote}</span>
                  </span>
                  <span className="jc-caption jc-numeric">
                    {pricesAvailable ? null : "—"}
                  </span>
                </div>
              ))}

              {markets.length === 0 ? (
                // Keeps the panel's height and shape when the listing cannot be
                // read, so the hero does not collapse into a stub that reads as
                // a broken component rather than an honest state.
                <div style={{ padding: "var(--jc-space-8) var(--jc-space-5)" }}>
                  <p className="jc-sm" style={{ marginBottom: "var(--jc-space-2)" }}>
                    Market listing is currently unavailable.
                  </p>
                  <p className="jc-caption">
                    The pair list could not be reached. Nothing is shown in its place.
                  </p>
                </div>
              ) : null}
            </div>

            <div style={{ padding: "var(--jc-space-3) var(--jc-space-5)", borderTop: "1px solid var(--jc-border)" }}>
              <p className="jc-caption">
                Market data is currently unavailable — no price feed is connected on this
                deployment.
              </p>
            </div>
          </Card>
        </div>
      </section>

      {/* ------------------------------------------------------------ products */}
      <section className="jc-container jc-section" aria-labelledby="products-heading">
        <p className="jc-eyebrow">One account. Three core products.</p>
        <h2 id="products-heading" className="jc-h2" style={{ marginBlock: "var(--jc-space-4) var(--jc-space-8)" }}>
          Everything in one place.
        </h2>

        <div className="jc-grid jc-grid-3">
          {PRODUCTS.map((product) => (
            <Card key={product.name} variant="interactive">
              <CardContent>
                <h3 className="jc-h3" style={{ marginBottom: "var(--jc-space-3)" }}>
                  {product.name}
                </h3>
                <p className="jc-sm" style={{ marginBottom: "var(--jc-space-5)" }}>
                  {product.body}
                </p>
                <LinkButton href={product.href} variant="link">
                  Open {product.name.toLowerCase()} →
                </LinkButton>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* --------------------------------------------------------------- trust */}
      <section
        className="jc-section"
        style={{ background: "var(--jc-bg-secondary)", borderBlock: "1px solid var(--jc-border)" }}
        aria-labelledby="trust-heading"
      >
        <div className="jc-container">
          <p className="jc-eyebrow">How the platform is built</p>
          <h2 id="trust-heading" className="jc-h2" style={{ marginBlock: "var(--jc-space-4) var(--jc-space-8)" }}>
            Controls where they belong.
          </h2>

          <div className="jc-grid jc-grid-2">
            {TRUST.map((item) => (
              <div key={item.title} style={{ paddingTop: "var(--jc-space-5)", borderTop: "1px solid var(--jc-border)" }}>
                <h3 className="jc-h4" style={{ marginBottom: "var(--jc-space-2)" }}>
                  {item.title}
                </h3>
                <p className="jc-sm">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- tiers */}
      <section className="jc-container jc-section" aria-labelledby="tiers-heading">
        <p className="jc-eyebrow">Account tiers</p>
        <h2 id="tiers-heading" className="jc-h2" style={{ marginBlock: "var(--jc-space-4) var(--jc-space-8)" }}>
          Verification when it is needed.
        </h2>

        <div className="jc-grid jc-grid-2">
          {TIERS.map((tier) => (
            <Card key={tier.code}>
              <CardContent>
                <p className="jc-label" style={{ color: "var(--jc-gold)" }}>
                  {tier.code}
                </p>
                <h3 className="jc-h4" style={{ marginBlock: "var(--jc-space-2) var(--jc-space-2)" }}>
                  {tier.name}
                </h3>
                <p className="jc-sm">{tier.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="jc-caption" style={{ marginTop: "var(--jc-space-6)", maxWidth: "76ch" }}>
          Tier limits are upper bounds, not entitlements. Risk, compliance and jurisdiction rules
          apply to every operation and may require verification before a tier&rsquo;s limit is
          reached.
        </p>
      </section>

      {/* ----------------------------------------------------------------- cta */}
      <section className="jc-container" style={{ paddingBottom: "var(--jc-space-24)" }}>
        <Card variant="elevated">
          <CardContent>
            <div
              className="jc-row-between jc-row-wrap"
              style={{ gap: "var(--jc-space-6)", padding: "var(--jc-space-4)" }}
            >
              <div>
                <h2 className="jc-h3" style={{ marginBottom: "var(--jc-space-2)" }}>
                  Open an account
                </h2>
                <p className="jc-sm" style={{ maxWidth: "48ch" }}>
                  Registration takes an email address. Verification is requested only when an
                  operation requires it.
                </p>
              </div>
              <LinkButton href="/signup" variant="primary" size="lg">
                Create account
              </LinkButton>
            </div>
          </CardContent>
        </Card>
      </section>
    </PublicShell>
  );
}
