"use client";

import { useState } from "react";

import { AmountInput, Alert, Button, Card, CardContent } from "@/components/ui";

/**
 * Exchange widget (spec §30).
 *
 * The visual foundation of the exchange product, built against the real flow it
 * will carry: the customer enters a send amount, picks the pair, and sees the
 * rate, the fee and what arrives before committing.
 *
 * Every quoted figure is blank. No rate is computed here and none is guessed —
 * a quote comes from the server's QuoteService, priced by a market data
 * provider, and neither is connected. The form is interactive so the layout and
 * the states are real; the numbers stay absent until something authoritative
 * can supply them.
 *
 * When the engine is wired up, the client will still only ever send an amount,
 * a pair and a quote id. Rate, fee and output come back from the server and are
 * never sent to it.
 */
export function ExchangeWidget({
  assets,
  available,
}: {
  assets: { symbol: string; name: string; type: string }[];
  /** False when no execution or liquidity provider is connected. */
  available: boolean;
}) {
  const [fromAsset, setFromAsset] = useState(assets.find((a) => a.symbol === "USDT")?.symbol ?? assets[0]?.symbol ?? "");
  const [toAsset, setToAsset] = useState(assets.find((a) => a.symbol === "BRL")?.symbol ?? assets[1]?.symbol ?? "");
  const [amount, setAmount] = useState("");

  const swap = () => {
    setFromAsset(toAsset);
    setToAsset(fromAsset);
  };

  const assetSelect = (
    id: string,
    label: string,
    value: string,
    onChange: (next: string) => void,
  ) => (
    <>
      <label className="jc-sr-only" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="jc-amount-asset"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // An empty select renders as a bare chevron, which reads as a broken
        // control rather than as missing data.
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
        <div className="jc-exchange-widget">
          <AmountInput
            id="exchange-send"
            label="You send"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
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
            value=""
            placeholder="—"
            readOnly
            assetSlot={assetSelect("exchange-to", "Asset to receive", toAsset, setToAsset)}
            secondary={<span className="jc-muted">Quoted when a provider is connected</span>}
          />

          <div className="jc-summary" style={{ marginTop: "var(--jc-space-2)" }}>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Rate</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Network &amp; service fee</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
            <div className="jc-summary-row">
              <span className="jc-summary-key">Estimated arrival</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
            <div className="jc-summary-row jc-summary-row--total">
              <span className="jc-summary-key">Quote valid for</span>
              <span className="jc-summary-val jc-muted">—</span>
            </div>
          </div>

          {!available ? (
            <Alert tone="warning" title="Exchange provider unavailable">
              No liquidity or execution provider is connected on this deployment, so quotes cannot
              be issued and exchanges cannot be executed.
            </Alert>
          ) : null}

          <Button variant="primary" block size="lg" disabled={!available}>
            {available ? "Get quote" : "Exchange unavailable"}
          </Button>

          <p className="jc-caption" style={{ textAlign: "center" }}>
            Rate and fee are calculated on the server and fixed for the life of a quote.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
