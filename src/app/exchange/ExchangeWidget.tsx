"use client";

import { useState } from "react";

import { AmountInput, Alert, Button, Card, CardContent } from "@/components/ui";
import type { ExchangeQuote } from "@/lib/exchange/types";

import { quoteExchangeAction } from "./actions";

/**
 * Exchange widget (spec §30), prototype.
 *
 * The customer enters a send amount and picks the pair; the rate, fee and
 * receive amount come back from the server (demo market data + real fee rules).
 * The client sends only the two assets and the amount string — never a rate, a
 * fee or a receive amount. Confirmation is honest: no execution or liquidity
 * provider is connected, so an exchange cannot be performed, and the result
 * says so rather than pretending a trade settled.
 */
export function ExchangeWidget({
  assets,
  quoteAvailable,
  executionAvailable,
}: {
  assets: { symbol: string; name: string; type: string }[];
  /** A (demo or live) rate can be quoted. */
  quoteAvailable: boolean;
  /** An exchange can actually be executed (needs a venue — none here). */
  executionAvailable: boolean;
}) {
  const [fromAsset, setFromAsset] = useState(assets.find((a) => a.symbol === "USDT")?.symbol ?? assets[0]?.symbol ?? "");
  const [toAsset, setToAsset] = useState(assets.find((a) => a.symbol === "BRL")?.symbol ?? assets[1]?.symbol ?? "");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<ExchangeQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const swap = () => {
    setFromAsset(toAsset);
    setToAsset(fromAsset);
    setQuote(null);
    setConfirmed(false);
  };

  const getQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setConfirmed(false);
    try {
      const result = await quoteExchangeAction({ fromSymbol: fromAsset, toSymbol: toAsset, amountInput: amount });
      if (result.ok) {
        setQuote(result.quote);
      } else {
        setQuote(null);
        setError(result.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const assetSelect = (id: string, label: string, value: string, onChange: (next: string) => void) => (
    <>
      <label className="jc-sr-only" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="jc-amount-asset"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setQuote(null);
          setConfirmed(false);
        }}
        disabled={assets.length === 0}
      >
        {assets.length === 0 ? (
          <option value="">—</option>
        ) : (
          assets.map((asset) => (
            <option key={asset.symbol} value={asset.symbol}>
              {asset.symbol}
            </option>
          ))
        )}
      </select>
    </>
  );

  return (
    <Card variant="elevated">
      <CardContent>
        <form className="jc-exchange-widget" onSubmit={getQuote}>
          <AmountInput
            id="exchange-send"
            label="You send"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setQuote(null);
              setConfirmed(false);
            }}
            placeholder="0.00"
            assetSlot={assetSelect("exchange-from", "Asset to send", fromAsset, setFromAsset)}
          />

          <div className="jc-swap-divider">
            <button type="button" className="jc-swap-btn" onClick={swap} aria-label="Swap direction">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 2.5v11M5 13.5 2.5 11M11 13.5v-11M11 2.5 13.5 5" />
              </svg>
            </button>
          </div>

          <AmountInput
            id="exchange-receive"
            label="You receive"
            value={quote ? quote.netReceive : ""}
            placeholder="—"
            readOnly
            assetSlot={assetSelect("exchange-to", "Asset to receive", toAsset, setToAsset)}
            secondary={quote ? <span className="jc-muted">After a {quote.fee} {quote.feeAsset} fee</span> : <span className="jc-muted">Quoted on request</span>}
          />

          <div className="jc-summary" style={{ marginTop: "var(--jc-space-2)" }}>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Rate</span>
              <span className="jc-summary-val jc-numeric">
                {quote ? `1 ${quote.fromSymbol} ≈ ${quote.rate} ${quote.toSymbol}` : <span className="jc-muted">—</span>}
              </span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Fee</span>
              <span className="jc-summary-val jc-numeric">{quote ? `${quote.fee} ${quote.feeAsset}` : <span className="jc-muted">—</span>}</span>
            </div>
            <div className="jc-summary-row jc-summary-row--total">
              <span className="jc-summary-key">You receive</span>
              <span className="jc-summary-val jc-numeric">{quote ? `${quote.netReceive} ${quote.toSymbol}` : <span className="jc-muted">—</span>}</span>
            </div>
          </div>

          {error ? (
            <Alert tone="danger">{error}</Alert>
          ) : null}

          {quote?.demo ? (
            <Alert tone="warning" title="Demo quote">
              This rate comes from demo market data, not a live feed. The fee is computed from the real fee schedule.
            </Alert>
          ) : null}

          <Button type="submit" variant="primary" block size="lg" loading={loading} disabled={loading || !quoteAvailable || assets.length === 0}>
            {quoteAvailable ? "Get quote" : "Quotes unavailable"}
          </Button>

          {quote ? (
            <Button
              type="button"
              variant="secondary"
              block
              size="lg"
              disabled={!executionAvailable}
              onClick={() => setConfirmed(true)}
            >
              {executionAvailable ? "Confirm exchange" : "Execution unavailable"}
            </Button>
          ) : null}

          {confirmed && !executionAvailable ? (
            <Alert tone="info" title="No exchange was performed">
              {quote?.demo ? "This is a demo quote." : "This is an indicative quote from market data."} No execution or
              liquidity provider is connected on this deployment, so the exchange cannot be executed and nothing has moved.
            </Alert>
          ) : null}

          <p className="jc-caption" style={{ textAlign: "center" }}>
            Rate and fee are calculated on the server. Limits apply per account tier and are checked for every exchange.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
