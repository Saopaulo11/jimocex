"use client";

import { useState } from "react";

import { AssetIcon, Price, PriceChange, PriceSourceNote } from "@/components/financial";
import { PriceChart } from "@/components/market/PriceChart";
import { ProviderUnavailable, SearchInput } from "@/components/ui";
import { parseMoney } from "@/lib/money";
import type { TerminalMarketData } from "@/lib/markets/ticker";
import type { Market } from "@/lib/markets/types";
import type { OpenOrderView, PairBalance } from "@/lib/trade/types";

import { OpenOrders } from "./OpenOrders";
import { OrderForm } from "./OrderForm";

/**
 * Trading terminal (spec §31).
 *
 * The order form, balances and open orders are real end to end: placing an order
 * calls the atomic engine, the reserve is a real ledger HOLD, and cancelling
 * releases it. A resting limit order does not fill, because no execution
 * provider exists — its OPEN status says exactly that. Which pairs accept orders
 * is `trading_pairs.trading_enabled` in the database (the demo set is BTC-USDT,
 * ETH-USDT, SOL-USDT); every other pair is shown as view only.
 *
 * The price, chart and order book are DEMO data from the prototype market-data
 * source (the same source the Markets pages use), labelled "Demo data" so a
 * demo figure is never mistaken for a live one. When no source is connected they
 * fall back to honest unavailable states.
 */
export function TradeTerminal({
  markets,
  selected,
  market,
  signedIn,
  verified,
  balances,
  openOrders,
}: {
  markets: Market[];
  selected: Market | null;
  market: TerminalMarketData;
  signedIn: boolean;
  verified: boolean;
  balances: PairBalance[];
  openOrders: OpenOrderView[];
}) {
  const [query, setQuery] = useState("");

  const filtered = markets.filter((m) => m.symbol.includes(query.trim().toUpperCase()));

  const base = selected?.base ?? "—";
  const quote = selected?.quote ?? "—";
  const pricePrecision = selected?.pricePrecision ?? 2;
  const amountPrecision = selected?.amountPrecision ?? 2;

  const baseBalance = selected ? balances.find((b) => b.symbol === selected.base) ?? null : null;
  const quoteBalance = selected ? balances.find((b) => b.symbol === selected.quote) ?? null : null;

  const ticker = market.selectedTicker;

  return (
    <>
      <div className="jc-terminal">
        {/* ----------------------------------------------------- market list */}
        <aside className="jc-panel jc-terminal-markets" aria-label="Markets">
          <div style={{ marginBottom: "var(--jc-space-3)" }}>
            <SearchInput
              id="terminal-search"
              label="Search markets"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div style={{ maxHeight: 420, overflowY: "auto" }} className="jc-terminal-marketlist">
            {filtered.map((m) => {
              const isSelected = m.symbol === selected?.symbol;
              const t = market.tickers[m.symbol];
              return (
                <a
                  key={m.symbol}
                  href={`/trade/${m.symbol}`}
                  aria-current={isSelected ? "page" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--jc-space-3)",
                    padding: "var(--jc-space-3) var(--jc-space-2)",
                    borderRadius: "var(--jc-radius-sm)",
                    background: isSelected ? "var(--jc-gold-softer)" : undefined,
                    borderLeft: isSelected ? "2px solid var(--jc-gold)" : "2px solid transparent",
                  }}
                >
                  <span style={{ fontSize: "var(--jc-text-sm)" }}>
                    <span style={{ fontWeight: 500 }}>{m.base}</span>
                    <span className="jc-muted">/{m.quote}</span>
                    <span className="jc-caption" style={{ display: "block" }}>
                      {m.tradingEnabled ? "Limit orders" : "View only"}
                    </span>
                  </span>
                  <span className="jc-numeric" style={{ fontSize: "var(--jc-text-sm)", textAlign: "right" }}>
                    {t ? (
                      <>
                        {t.price}
                        {t.changePercent24h ? (
                          <span style={{ display: "block" }}>
                            <PriceChange percent={parseMoney(t.changePercent24h)} />
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="jc-muted">—</span>
                    )}
                  </span>
                </a>
              );
            })}

            {filtered.length === 0 ? (
              <p className="jc-caption" style={{ padding: "var(--jc-space-4) var(--jc-space-2)" }}>
                No markets match.
              </p>
            ) : null}
          </div>
        </aside>

        {/* ----------------------------------------------------------- chart */}
        <section className="jc-panel jc-terminal-chart" aria-label="Price chart">
          <div className="jc-panel-head">
            <div className="jc-row">
              <AssetIcon symbol={base} size="lg" />
              <div>
                <p style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                  {base}
                  <span className="jc-muted">/{quote}</span>
                </p>
                <p className="jc-caption">
                  {selected?.tradingEnabled
                    ? "Limit orders enabled · execution not connected"
                    : "Trading not enabled · view only"}
                </p>
              </div>
            </div>

            <div className="jc-row" style={{ gap: "var(--jc-space-6)", alignItems: "flex-start" }}>
              <span className="jc-stat">
                <span className="jc-stat-label">Last price</span>
                <span className="jc-numeric">
                  {ticker ? (
                    <Price value={parseMoney(ticker.price)} quoteSymbol={quote} decimals={pricePrecision} />
                  ) : (
                    <span className="jc-muted">—</span>
                  )}
                </span>
              </span>
              <span className="jc-stat">
                <span className="jc-stat-label">24h change</span>
                <span className="jc-numeric">
                  {ticker?.changePercent24h ? (
                    <PriceChange percent={parseMoney(ticker.changePercent24h)} />
                  ) : (
                    <span className="jc-muted">—</span>
                  )}
                </span>
              </span>
              <PriceSourceNote demo={market.demo} available={market.available} />
            </div>
          </div>

          <div style={{ minHeight: 320, display: "grid", placeItems: "center", padding: "var(--jc-space-4)" }}>
            {market.available && market.chartCloses.length > 1 ? (
              <div style={{ width: "100%" }}>
                <PriceChart closes={market.chartCloses} />
                <p className="jc-caption" style={{ marginTop: "var(--jc-space-3)", textAlign: "center" }}>
                  Demo data — a deterministic daily series for demonstration, not a live market.
                </p>
              </div>
            ) : (
              <ProviderUnavailable
                what="Price chart"
                description="No market data provider is connected, so no candles are available for this pair."
              />
            )}
          </div>
        </section>

        {/* ------------------------------------------------------ order book */}
        <section className="jc-panel jc-terminal-book" aria-label="Order book">
          <div className="jc-panel-head">
            <span className="jc-panel-title">Order book</span>
            {market.demo && market.book ? (
              <span className="jc-caption">Demo</span>
            ) : null}
          </div>
          {market.available && market.book ? (
            <div className="jc-book">
              <div className="jc-book-col" aria-label="Bids">
                {market.book.bids.map((lvl, i) => (
                  <div key={`b${i}`} className="jc-book-row">
                    <span className="jc-numeric jc-change--up">{lvl.price}</span>
                    <span className="jc-numeric jc-muted">{lvl.amount}</span>
                  </div>
                ))}
              </div>
              <div className="jc-book-col" aria-label="Asks">
                {market.book.asks.map((lvl, i) => (
                  <div key={`a${i}`} className="jc-book-row">
                    <span className="jc-numeric jc-change--down">{lvl.price}</span>
                    <span className="jc-numeric jc-muted">{lvl.amount}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ minHeight: 180, display: "grid", placeItems: "center" }}>
              <ProviderUnavailable what="Order book" />
            </div>
          )}
        </section>

        {/* ------------------------------------------------------ order form */}
        <section className="jc-panel jc-terminal-form" aria-label="Place an order">
          {selected ? (
            <OrderForm
              pair={{
                symbol: selected.symbol,
                base: selected.base,
                quote: selected.quote,
                tradingEnabled: selected.tradingEnabled,
                pricePrecision,
                amountPrecision,
                minOrderSize: selected.minOrderSize,
              }}
              signedIn={signedIn}
              verified={verified}
              baseBalance={baseBalance}
              quoteBalance={quoteBalance}
            />
          ) : (
            <p className="jc-caption">No market is selected.</p>
          )}
        </section>
      </div>

      {/* ------------------------------------------------------- open orders */}
      {signedIn ? <OpenOrders orders={openOrders} /> : null}
    </>
  );
}
