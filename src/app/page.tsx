import Link from "next/link";

import { JimoCexLogo } from "@/components/JimoCexLogo";

/**
 * Placeholder landing page.
 *
 * The full homepage — hero, product switcher, exchange widget, markets — is a
 * later phase. What is here now states the three products honestly and does not
 * pretend to prices or volumes the platform cannot yet source.
 */
export default function HomePage() {
  return (
    <main>
      <header style={{ borderBottom: "1px solid var(--jc-border)" }}>
        <div
          className="jc-container jc-row-between"
          style={{ minHeight: 72 }}
        >
          <JimoCexLogo size={26} />
          <nav className="jc-row" aria-label="Account">
            <Link href="/login" className="jc-btn jc-btn-ghost">
              Log in
            </Link>
            <Link href="/signup" className="jc-btn jc-btn-primary">
              Sign up
            </Link>
          </nav>
        </div>
      </header>

      <section className="jc-container" style={{ paddingBlock: "clamp(56px, 10vw, 112px)" }}>
        <p className="jc-eyebrow">One account. Three core products.</p>
        <h1 style={{ marginBlock: "16px 20px", maxWidth: "18ch" }}>
          Trade crypto, FX &amp; global assets.
        </h1>
        <p className="jc-lede" style={{ maxWidth: "54ch" }}>
          One account. One platform. Multiple markets.
        </p>

        <div className="jc-row" style={{ marginTop: 32, flexWrap: "wrap" }}>
          <Link href="/signup" className="jc-btn jc-btn-primary">
            Start trading
          </Link>
          <Link href="/markets" className="jc-btn jc-btn-secondary">
            View markets
          </Link>
        </div>
      </section>

      <section
        className="jc-container"
        style={{ paddingBottom: "clamp(56px, 10vw, 112px)" }}
        aria-label="Products"
      >
        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          }}
        >
          {[
            { title: "Exchange", body: "Trade assets instantly." },
            { title: "Trade", body: "Trade crypto and FX markets." },
            { title: "Markets", body: "Track prices, volume and market movements." },
          ].map((product) => (
            <article key={product.title} className="jc-card">
              <h2 style={{ fontSize: "1.25rem", marginBottom: 8 }}>{product.title}</h2>
              <p style={{ color: "var(--jc-text-secondary)" }}>{product.body}</p>
            </article>
          ))}
        </div>

        {/* The platform is not connected to a market data or execution
            provider. Saying so here is better than a screen of dashes the
            visitor has to interpret. */}
        <p className="jc-muted" style={{ marginTop: 24 }}>
          Market data and trading are not yet available on this deployment.
        </p>
      </section>
    </main>
  );
}
