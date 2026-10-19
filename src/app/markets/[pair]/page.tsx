import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PublicShell } from "@/components/layout";
import { AssetIcon, Price, PriceChange, PriceSourceNote, Stat } from "@/components/financial";
import { PriceChart } from "@/components/market/PriceChart";
import { Card, CardContent, CardHeader, LinkButton } from "@/components/ui";
import { getViewer } from "@/lib/auth/session";
import { parseMoney } from "@/lib/money";
import { listMarkets } from "@/lib/markets/pairs";
import { getCandles, getTicker } from "@/lib/markets/ticker";

export async function generateMetadata({ params }: { params: Promise<{ pair: string }> }): Promise<Metadata> {
  const { pair } = await params;
  return { title: `${pair.replace("-", "/").toUpperCase()} · Markets` };
}

export default async function MarketPairPage({ params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  const symbol = pair.toUpperCase();

  const [viewer, { markets }, ticker, candles] = await Promise.all([
    getViewer(),
    listMarkets(),
    getTicker(symbol),
    getCandles(symbol, "1d", 60),
  ]);

  const market = markets.find((m) => m.symbol === symbol);
  if (!market && markets.length > 0) notFound();
  if (!market) {
    // Listing unavailable entirely; render an honest shell rather than a 404.
    return (
      <PublicShell signedIn={Boolean(viewer)}>
        <div className="jc-container jc-section">
          <p className="jc-sm">Market listing is unavailable right now. Please try again shortly.</p>
        </div>
      </PublicShell>
    );
  }

  const t = ticker.ticker;
  const closes = candles.candles.map((c) => c.close as string);

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container jc-section jc-stack-lg">
        <header>
          <Link href="/markets" className="jc-link jc-sm">
            ← Markets
          </Link>
          <div className="jc-row jc-row-wrap" style={{ gap: "var(--jc-space-4)", alignItems: "center", marginTop: "var(--jc-space-4)" }}>
            <AssetIcon symbol={market.base} size="lg" />
            <div>
              <h1 className="jc-h2">
                {market.base}/{market.quote}
              </h1>
              <p className="jc-caption">{market.type.replace("_", " / ")}</p>
            </div>
            <div style={{ marginLeft: "auto" }}>
              <PriceSourceNote demo={ticker.demo} available={ticker.available} />
            </div>
          </div>
        </header>

        <div className="jc-grid" style={{ gridTemplateColumns: "1fr", gap: "var(--jc-space-6)" }}>
          <Card>
            <CardContent>
              <div className="jc-row-between jc-row-wrap" style={{ alignItems: "flex-end", gap: "var(--jc-space-6)" }}>
                <div>
                  <p className="jc-stat-label">Last price</p>
                  {t ? (
                    <div className="jc-row" style={{ gap: "var(--jc-space-4)", alignItems: "baseline" }}>
                      <span className="jc-amount-display jc-amount-display--xl">
                        <Price value={parseMoney(t.price)} quoteSymbol={market.quote} decimals={market.pricePrecision} />
                      </span>
                      {t.changePercent24h ? <PriceChange percent={parseMoney(t.changePercent24h)} /> : null}
                    </div>
                  ) : (
                    <span className="jc-amount-display jc-amount-display--lg jc-muted">—</span>
                  )}
                </div>
                <div className="jc-row jc-row-wrap" style={{ gap: "var(--jc-space-3)" }}>
                  <LinkButton href={`/trade/${market.symbol}`} variant="primary" size="md" disabled={!market.tradingEnabled}>
                    {market.tradingEnabled ? "Trade" : "Trading unavailable"}
                  </LinkButton>
                </div>
              </div>

              <div style={{ marginTop: "var(--jc-space-6)" }}>
                {candles.available && closes.length > 1 ? (
                  <PriceChart closes={closes} label={candles.demo ? "Price chart (demo data)" : "Price chart (market data)"} />
                ) : (
                  <div className="jc-chart-empty jc-muted">Price chart unavailable</div>
                )}
                {candles.available ? (
                  <p className="jc-caption" style={{ marginTop: "var(--jc-space-3)" }}>
                    {candles.demo
                      ? "Demo data — a deterministic daily series for demonstration, not a live market."
                      : "Market data — daily candles from a public source. For information only; not an executable quote."}
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <div className="jc-grid jc-grid-2">
            <Card>
              <CardHeader title="24h statistics" as="h2" />
              <CardContent>
                <div className="jc-stat-pair">
                  <Stat
                    label="24h High"
                    value={t?.high24h ? <Price value={parseMoney(t.high24h)} quoteSymbol={market.quote} decimals={market.pricePrecision} /> : <span className="jc-muted">—</span>}
                  />
                  <Stat
                    label="24h Low"
                    value={t?.low24h ? <Price value={parseMoney(t.low24h)} quoteSymbol={market.quote} decimals={market.pricePrecision} /> : <span className="jc-muted">—</span>}
                  />
                </div>
                <div style={{ marginTop: "var(--jc-space-5)" }}>
                  <Stat
                    label={`24h Volume (${market.base})`}
                    value={t?.volume24h ? <span className="jc-numeric">{t.volume24h}</span> : <span className="jc-muted">—</span>}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader title="Market information" as="h2" />
              <CardContent>
                <div className="jc-summary">
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Base asset</span>
                    <span className="jc-summary-val">{market.base}</span>
                  </div>
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Quote asset</span>
                    <span className="jc-summary-val">{market.quote}</span>
                  </div>
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Price precision</span>
                    <span className="jc-summary-val">{market.pricePrecision} dp</span>
                  </div>
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Amount precision</span>
                    <span className="jc-summary-val">{market.amountPrecision} dp</span>
                  </div>
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Minimum order</span>
                    <span className="jc-summary-val jc-numeric">{market.minOrderSize} {market.base}</span>
                  </div>
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Limit orders</span>
                    <span className="jc-summary-val">
                      {market.tradingEnabled ? "Enabled — funds are reserved on placement" : "Not enabled"}
                    </span>
                  </div>
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Order execution</span>
                    <span className="jc-summary-val">Not connected — orders do not fill</span>
                  </div>
                  <div className="jc-summary-row">
                    <span className="jc-summary-key">Exchange</span>
                    <span className="jc-summary-val">{market.swapEnabled ? "Enabled" : "Not connected"}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
