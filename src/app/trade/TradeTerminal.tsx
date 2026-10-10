"use client";

import { useState } from "react";

import { AssetIcon } from "@/components/financial";
import { AmountInput, Button, ProviderUnavailable, SearchInput, Segmented } from "@/components/ui";
import type { Market } from "@/lib/markets/types";

/**
 * Trading terminal (spec §31).
 *
 * The real four-panel layout — markets, chart, order book, order form — built
 * so that connecting a provider is a matter of filling the panels, not of
 * rebuilding the screen.
 *
 * Every panel that would show market data shows an explicit unavailable state
 * instead. No candles are drawn, no book is populated, no last price is
 * invented. The order form is laid out and its validation states are real, but
 * submission is disabled because no execution provider exists to receive it:
 * a form that accepted an order it cannot place would be lying about what
 * happened next.
 */
export function TradeTerminal({
  markets,
  selected,
  pricesAvailable,
}: {
  markets: Market[];
  selected: Market | null;
  pricesAvailable: boolean;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [query, setQuery] = useState("");

  const filtered = markets.filter((market) =>
    market.symbol.includes(query.trim().toUpperCase()),
  );

  const base = selected?.base ?? "—";
  const quote = selected?.quote ?? "—";

  // Orders need both a selected market with trading switched on and an
  // execution provider. Neither is true yet, so the form stays inert.
  const canTrade = Boolean(selected?.tradingEnabled);

  return (
    <div className="jc-terminal">
      {/* ------------------------------------------------------- market list */}
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
          {filtered.map((market) => {
            const isSelected = market.symbol === selected?.symbol;
            return (
              <a
                key={market.symbol}
                href={`/trade/${market.symbol}`}
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
                  <span style={{ fontWeight: 500 }}>{market.base}</span>
                  <span className="jc-muted">/{market.quote}</span>
                </span>
                <span className="jc-caption jc-numeric jc-muted">
                  {pricesAvailable ? null : "—"}
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

      {/* ------------------------------------------------------------- chart */}
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
                {selected?.tradingEnabled ? "Trading enabled" : "Trading disabled"}
              </p>
            </div>
          </div>

          <div className="jc-row" style={{ gap: "var(--jc-space-6)" }}>
            <span className="jc-stat">
              <span className="jc-stat-label">Last price</span>
              <span className="jc-numeric jc-muted">—</span>
            </span>
            <span className="jc-stat">
              <span className="jc-stat-label">24h change</span>
              <span className="jc-numeric jc-muted">—</span>
            </span>
          </div>
        </div>

        <div style={{ minHeight: 320, display: "grid", placeItems: "center" }}>
          <ProviderUnavailable
            what="Price chart"
            description="No market data provider is connected, so no candles are available for this pair. Nothing is being drawn in their place."
          />
        </div>
      </section>

      {/* -------------------------------------------------------- order book */}
      <section className="jc-panel jc-terminal-book" aria-label="Order book and recent trades">
        <div className="jc-panel-head">
          <span className="jc-panel-title">Order book</span>
        </div>
        <div style={{ minHeight: 180, display: "grid", placeItems: "center" }}>
          <ProviderUnavailable what="Order book" />
        </div>
      </section>

      {/* -------------------------------------------------------- order form */}
      <section className="jc-panel jc-terminal-form" aria-label="Place an order">
        <Segmented
          label="Order side"
          block
          value={side}
          onChange={setSide}
          options={[
            { value: "buy", label: selected ? `Buy ${base}` : "Buy", side: "buy" },
            { value: "sell", label: selected ? `Sell ${base}` : "Sell", side: "sell" },
          ]}
        />

        <div style={{ marginBlock: "var(--jc-space-4)" }}>
          <Segmented
            label="Order type"
            value={orderType}
            onChange={setOrderType}
            options={[
              { value: "limit", label: "Limit" },
              { value: "market", label: "Market" },
            ]}
          />
        </div>

        <div className="jc-stack">
          {orderType === "limit" ? (
            <AmountInput
              id="order-price"
              label="Price"
              placeholder="0.00"
              assetSlot={<span className="jc-amount-asset">{quote}</span>}
              disabled
            />
          ) : null}

          <AmountInput
            id="order-amount"
            label="Amount"
            placeholder="0.00"
            assetSlot={<span className="jc-amount-asset">{base}</span>}
            balance={<span>Available —</span>}
            disabled
          />

          <div className="jc-summary">
            <div className="jc-summary-row">
              <span className="jc-summary-key">Order value</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Estimated fee</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
          </div>

          <Button
            variant={canTrade ? (side === "buy" ? "primary" : "danger") : "tertiary"}
            block
            size="lg"
            disabled={!canTrade}
          >
            {canTrade ? `${side === "buy" ? "Buy" : "Sell"} ${base}` : "Trading unavailable"}
          </Button>

          <p className="jc-caption">
            No execution provider is connected, so orders cannot be placed. Balances, fees and
            limits are calculated on the server when they are.
          </p>
        </div>
      </section>
    </div>
  );
}
