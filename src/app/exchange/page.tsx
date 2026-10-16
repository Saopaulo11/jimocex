import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Alert, Card, CardContent } from "@/components/ui";
import { getViewer } from "@/lib/auth/session";
import { listAssets, listMarkets } from "@/lib/markets/pairs";
import { getTickers } from "@/lib/markets/ticker";

import { ExchangeWidget } from "./ExchangeWidget";

export const metadata: Metadata = {
  title: "Exchange",
  description: "Convert between digital assets and currencies at a quoted rate.",
};

const STEPS = [
  { n: "01", title: "Choose the pair", body: "Pick what you are sending and what you want to receive." },
  { n: "02", title: "Review the quote", body: "The rate, the fee and the amount that arrives are fixed for the life of the quote." },
  { n: "03", title: "Confirm", body: "Funds are held, the exchange is executed, and the ledger records both sides." },
];

export default async function ExchangePage() {
  const [viewer, assets, { markets }, tickers] = await Promise.all([
    getViewer(),
    listAssets(),
    listMarkets(),
    getTickers(),
  ]);

  // Two separate capabilities: a rate can be quoted (demo or live market data),
  // and an exchange can be executed (a pair with swaps enabled + a venue). The
  // second is false here — no provider is connected — so quotes work but
  // execution does not, and the UI says exactly that.
  const quoteAvailable = tickers.available;
  const executionAvailable = markets.some((market) => market.swapEnabled);

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container jc-section">
        <div
          style={{
            display: "grid",
            gap: "var(--jc-space-12)",
            gridTemplateColumns: "1fr",
            alignItems: "start",
          }}
        >
          <div className="jc-grid" style={{ gridTemplateColumns: "1fr", gap: "var(--jc-space-12)" }}>
            <header style={{ maxWidth: "52ch" }}>
              <p className="jc-eyebrow">Exchange</p>
              <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-4)" }}>
                Convert assets at a quoted rate.
              </h1>
              <p className="jc-body-lg">
                One rate, one fee, shown before you commit. Crypto to crypto, crypto to currency,
                and currency to currency from the same account.
              </p>
            </header>

            {quoteAvailable && tickers.demo ? (
              <Alert tone="warning" title="Demo rates">
                Quotes use deterministic demo market data on this deployment, and no execution provider is connected —
                so you can see a full quote, but an exchange cannot be executed. Fees are from the real fee schedule.
              </Alert>
            ) : null}

            <div
              style={{
                display: "grid",
                gap: "var(--jc-space-10)",
                gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                alignItems: "start",
              }}
            >
              <div style={{ maxWidth: 440 }}>
                <ExchangeWidget assets={assets} quoteAvailable={quoteAvailable} executionAvailable={executionAvailable} />
              </div>

              <div className="jc-stack-lg">
                <Card>
                  <CardContent>
                    <h2 className="jc-h4" style={{ marginBottom: "var(--jc-space-5)" }}>
                      How an exchange works
                    </h2>
                    <ol className="jc-stack" style={{ gap: "var(--jc-space-5)" }}>
                      {STEPS.map((step) => (
                        <li key={step.n} className="jc-row" style={{ alignItems: "flex-start", gap: "var(--jc-space-4)" }}>
                          <span className="jc-label" style={{ color: "var(--jc-gold)", paddingTop: 2 }}>
                            {step.n}
                          </span>
                          <span>
                            <span style={{ display: "block", fontWeight: 500, marginBottom: 2 }}>
                              {step.title}
                            </span>
                            <span className="jc-sm">{step.body}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </CardContent>
                </Card>

                <p className="jc-caption" style={{ maxWidth: "58ch" }}>
                  Limits apply per account tier and are checked on the server for every exchange.
                  Risk and compliance rules may require verification before a tier&rsquo;s limit is
                  reached.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
