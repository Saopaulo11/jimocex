"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CurrencyAmount, OrderStatus } from "@/components/financial";
import { Alert, AmountInput, Button, LinkButton, Segmented } from "@/components/ui";
import { product } from "@/config/brand";
import { lessThan, parseAmountInput, parseMoney, type AmountInputProblem } from "@/lib/money";
import type { OrderSideValue, OrderStatusValue, OrderTypeValue, PairBalance } from "@/lib/trade/types";

import { placeLimitOrderAction, previewLimitOrderAction, type PreviewActionResult } from "./actions";
import { limitPriceText, seedLimitPrice } from "./limit-price";

/**
 * The live order form (spec §19, §31).
 *
 * It sends the customer's intent and nothing else — pair, side, type, the price
 * and amount as typed, and an idempotency key. The fee and the reserve shown
 * here are computed by the SERVER (`previewLimitOrderAction`) and only displayed;
 * the client never computes or sends them. Validation here is UX only: the
 * server re-checks everything and is the authority.
 *
 * Idempotency: one `clientOrderId` is minted per intended order and reused on a
 * retry, so a resubmit after a network error cannot open a second order or place
 * a second hold. It is cleared only after a success, when the next order legitimately
 * needs a fresh key.
 *
 * MARKET is shown but disabled: with no market-data and no execution provider,
 * an instant order cannot be priced or filled, and the form says so rather than
 * pretending otherwise.
 *
 * The LIMIT Price starts from `referencePrice` — the pair's last price from the
 * public market-data source, the figure the terminal header shows — when there
 * is one (`./limit-price`). It only fills an empty field the customer has not
 * edited: a market-data refresh never replaces a price already there, and the
 * Amount is never filled. The terminal keys this form by pair, so another pair
 * starts a fresh form at that pair's price.
 */

type PairView = {
  symbol: string;
  base: string;
  quote: string;
  tradingEnabled: boolean;
  pricePrecision: number;
  amountPrecision: number;
  /** Exact decimal string from trading_pairs.min_order_size. */
  minOrderSize: string;
};

type FieldErrors = { price?: string; amount?: string };
type Status = "idle" | "submitting" | "success" | "error";

type Placed = {
  orderId: string;
  status: OrderStatusValue;
  reservedAsset: string;
  reservedAmount: string;
};

function problemMessage(problem: AmountInputProblem, field: "price" | "amount"): string {
  switch (problem) {
    case "empty":
      return field === "price" ? "Enter a price." : "Enter an amount.";
    case "malformed":
      return `Enter a valid ${field}.`;
    case "too_many_decimals":
      return `Too many decimal places for this market.`;
    case "too_large":
      return `This ${field} is too large.`;
    case "not_positive":
      return `The ${field} must be greater than zero.`;
  }
}

export function OrderForm({
  pair,
  signedIn,
  verified,
  baseBalance,
  quoteBalance,
  referencePrice,
}: {
  pair: PairView;
  signedIn: boolean;
  verified: boolean;
  baseBalance: PairBalance | null;
  quoteBalance: PairBalance | null;
  /** The pair's last market-data price (exact decimal string), or null when there is none. */
  referencePrice: string | null;
}) {
  const router = useRouter();

  const [side, setSide] = useState<OrderSideValue>("BUY");
  const [type, setType] = useState<OrderTypeValue>("LIMIT");
  const [priceText, setPriceText] = useState(() => limitPriceText(referencePrice, pair.pricePrecision) ?? "");
  // Set once the customer types in Price; from then on the field is theirs.
  const [priceEdited, setPriceEdited] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [preview, setPreview] = useState<Extract<PreviewActionResult, { ok: true }> | null>(null);

  // Minted lazily on first submit, reused across retries, cleared after success.
  const clientOrderIdRef = useRef<string | null>(null);

  // A market price that arrives after the form opened (or after a placement
  // cleared it) fills the empty, unedited Price field. Adjusted during render,
  // not in an effect, so the field never paints empty and then jumps; it settles
  // in one pass because a filled field is no longer seeded.
  const seededPrice = seedLimitPrice({
    edited: priceEdited,
    current: priceText,
    reference: referencePrice,
    pricePrecision: pair.pricePrecision,
  });
  if (seededPrice !== null) setPriceText(seededPrice);
  const priceFromMarket = !priceEdited && priceText !== "";

  const canTrade = signedIn && verified && pair.tradingEnabled;
  const submitting = status === "submitting";
  const base = pair.base;
  const quote = pair.quote;
  // Presentation flag only: the engine refuses MARKET regardless until an
  // execution venue is connected. Default off → shown as unavailable.
  const marketBlocked = type === "MARKET" && !product.enabledMarketOrders;

  // Parse the typed inputs against the pair's own precision. UX only — the
  // server re-validates and is authoritative.
  function validateInputs():
    | { ok: true; priceValid: boolean }
    | { ok: false; errors: FieldErrors } {
    const errors: FieldErrors = {};

    const amount = parseAmountInput(amountText, { maxDecimals: pair.amountPrecision });
    if (!amount.ok) {
      errors.amount = problemMessage(amount.problem, "amount");
    } else if (lessThan(amount.value, parseMoney(pair.minOrderSize))) {
      errors.amount = `Below the ${base} minimum of ${pair.minOrderSize}.`;
    }

    if (type === "LIMIT") {
      const price = parseAmountInput(priceText, { maxDecimals: pair.pricePrecision });
      if (!price.ok) errors.price = problemMessage(price.problem, "price");
    }

    if (errors.amount || errors.price) return { ok: false, errors };
    return { ok: true, priceValid: true };
  }

  // Server-computed fee/reserve preview, debounced, for a valid LIMIT order.
  // All state updates happen inside the (async) timeout, never synchronously in
  // the effect body — the latter would cascade renders on every keystroke.
  useEffect(() => {
    let active = true;
    const canPreview = canTrade && type === "LIMIT" && validateInputs().ok;

    const timer = setTimeout(async () => {
      if (!canPreview) {
        if (active) setPreview(null);
        return;
      }
      try {
        const result = await previewLimitOrderAction({
          pairSymbol: pair.symbol,
          side,
          type,
          priceInput: priceText,
          amountInput: amountText,
          clientOrderId: null,
        });
        if (active) setPreview(result.ok ? result : null);
      } catch {
        // A preview that never came back shows nothing rather than a stale figure.
        if (active) setPreview(null);
      }
    }, canPreview ? 400 : 0);

    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceText, amountText, side, type, canTrade, pair.symbol]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canTrade || marketBlocked || submitting) return;

    const check = validateInputs();
    if (!check.ok) {
      setFieldErrors(check.errors);
      return;
    }
    setFieldErrors({});

    if (!clientOrderIdRef.current) clientOrderIdRef.current = crypto.randomUUID();

    setStatus("submitting");
    setMessage(null);

    let result: Awaited<ReturnType<typeof placeLimitOrderAction>>;
    try {
      result = await placeLimitOrderAction({
        pairSymbol: pair.symbol,
        side,
        type,
        priceInput: priceText,
        amountInput: amountText,
        clientOrderId: clientOrderIdRef.current,
      });
    } catch {
      // No answer — a dropped connection, a timeout. The server may well have
      // placed the order and reserved its funds, so this is NOT "not placed".
      // Keep the key: submitting again returns that same order (first wins)
      // instead of placing and reserving a second one.
      setStatus("error");
      setMessage(
        "We could not confirm this order — it may have been placed. Check Open Orders. Submitting again is safe: it cannot place the order twice.",
      );
      router.refresh();
      return;
    }

    if (result.ok) {
      setStatus("success");
      setPlaced({
        orderId: result.orderId,
        status: result.status,
        reservedAsset: result.reservedAsset,
        reservedAmount: result.reservedAmount,
      });
      // A fresh form: the Price starts again from the current market price, if any.
      setPriceText("");
      setPriceEdited(false);
      setAmountText("");
      setPreview(null);
      // A placed order is done with its key; the next order needs a fresh one.
      clientOrderIdRef.current = null;
      // Re-read balances and open orders from the database.
      router.refresh();
    } else {
      setStatus("error");
      setMessage(result.message);
      // Keep the key: a retry of THIS order must stay idempotent.
    }
  }

  const sideWord = side === "BUY" ? "Buy" : "Sell";
  const submitLabel = canTrade ? `${sideWord} ${base}` : "Trading unavailable";

  return (
    <form className="jc-stack" onSubmit={onSubmit} noValidate>
      <Segmented
        label="Order side"
        block
        value={side}
        onChange={setSide}
        options={[
          { value: "BUY", label: `Buy ${base}`, side: "buy" },
          { value: "SELL", label: `Sell ${base}`, side: "sell" },
        ]}
      />

      <div style={{ marginBlock: "var(--jc-space-4)" }}>
        <Segmented
          label="Order type"
          value={type}
          onChange={setType}
          options={[
            { value: "LIMIT", label: "Limit" },
            { value: "MARKET", label: "Market" },
          ]}
        />
      </div>

      {marketBlocked ? (
        <Alert tone="warning" title="Market orders are unavailable">
          Market orders are unavailable until market data and an execution provider are connected.
          Place a limit order with a price instead.
        </Alert>
      ) : null}

      <div className="jc-stack">
        {type === "LIMIT" ? (
          <AmountInput
            id="order-price"
            label="Price"
            placeholder="0.00"
            inputMode="decimal"
            value={priceText}
            onChange={(event) => {
              setPriceText(event.target.value);
              setPriceEdited(true);
            }}
            assetSlot={<span className="jc-amount-asset">{quote}</span>}
            secondary={
              priceFromMarket ? "Filled from the last market price — not an executable quote. Edit it to set your limit." : undefined
            }
            error={fieldErrors.price}
            disabled={!canTrade}
          />
        ) : null}

        <AmountInput
          id="order-amount"
          label="Amount"
          placeholder="0.00"
          inputMode="decimal"
          value={amountText}
          onChange={(event) => setAmountText(event.target.value)}
          assetSlot={<span className="jc-amount-asset">{base}</span>}
          balance={
            <span>
              Available {baseBalance ? `${baseBalance.available} ${base}` : `— ${base}`}
            </span>
          }
          error={fieldErrors.amount}
          disabled={!canTrade}
        />

        {/* --------------------------------------------------- balances (real) */}
        <div className="jc-summary">
          <div className="jc-summary-row">
            <span className="jc-summary-key">{quote} available</span>
            <span className="jc-summary-val">
              {quoteBalance ? (
                <CurrencyAmount
                  value={parseMoney(quoteBalance.available)}
                  symbol={quote}
                  decimals={quoteBalance.decimals}
                />
              ) : (
                <span className="jc-muted">—</span>
              )}
            </span>
          </div>
          <div className="jc-summary-row">
            <span className="jc-summary-key">{quote} reserved</span>
            <span className="jc-summary-val">
              {quoteBalance ? (
                <CurrencyAmount
                  value={parseMoney(quoteBalance.locked)}
                  symbol={quote}
                  decimals={quoteBalance.decimals}
                />
              ) : (
                <span className="jc-muted">—</span>
              )}
            </span>
          </div>
          <div className="jc-summary-row">
            <span className="jc-summary-key">{base} available</span>
            <span className="jc-summary-val">
              {baseBalance ? (
                <CurrencyAmount
                  value={parseMoney(baseBalance.available)}
                  symbol={base}
                  decimals={baseBalance.decimals}
                />
              ) : (
                <span className="jc-muted">—</span>
              )}
            </span>
          </div>
          <div className="jc-summary-row">
            <span className="jc-summary-key">{base} reserved</span>
            <span className="jc-summary-val">
              {baseBalance ? (
                <CurrencyAmount
                  value={parseMoney(baseBalance.locked)}
                  symbol={base}
                  decimals={baseBalance.decimals}
                />
              ) : (
                <span className="jc-muted">—</span>
              )}
            </span>
          </div>
        </div>

        {/* ------------------------------------------- server-computed estimate */}
        <div className="jc-summary">
          <div className="jc-summary-row">
            <span className="jc-summary-key">Order value</span>
            <span className="jc-summary-val">
              {preview ? (
                <CurrencyAmount value={parseMoney(preview.notional)} symbol={quote} decimals={pair.pricePrecision} />
              ) : (
                <span className="jc-muted">—</span>
              )}
            </span>
          </div>
          <div className="jc-summary-row">
            <span className="jc-summary-key">Estimated fee</span>
            <span className="jc-summary-val">
              {preview ? (
                <CurrencyAmount value={parseMoney(preview.fee)} symbol={quote} decimals={pair.pricePrecision} />
              ) : (
                <span className="jc-muted">—</span>
              )}
            </span>
          </div>
          <div className="jc-summary-row jc-summary-row--total">
            <span className="jc-summary-key">Reserved on placement</span>
            <span className="jc-summary-val">
              {preview ? (
                <CurrencyAmount
                  value={parseMoney(preview.reservedAmount)}
                  symbol={preview.reservedAsset}
                  decimals={preview.reservedAsset === base ? pair.amountPrecision : pair.pricePrecision}
                />
              ) : (
                <span className="jc-muted">—</span>
              )}
            </span>
          </div>
        </div>

        {status === "success" && placed ? (
          <Alert tone="success" title="Order placed">
            <OrderStatus status={placed.status} />{" "}
            {placed.status === "OPEN" ? (
              <>
                Reserved {placed.reservedAmount} {placed.reservedAsset}. It rests in Open Orders until
                you cancel it — execution is not connected in this prototype, so it will not fill.
              </>
            ) : (
              <>This matches an order you already submitted; it is shown as recorded.</>
            )}{" "}
            <Link href={`/orders/${placed.orderId}`} className="jc-link">
              View order {placed.orderId.slice(0, 8)}
            </Link>
          </Alert>
        ) : null}

        {status === "error" && message ? (
          <Alert tone="danger" title="Order not placed">
            {message}
          </Alert>
        ) : null}

        {!signedIn ? (
          <>
            <Alert tone="info" title="Sign in to trade">
              Placing an order requires a signed-in, verified account.
            </Alert>
            <LinkButton href={`/login?next=/trade/${pair.symbol}`} variant="primary" block size="lg">
              Sign in to trade
            </LinkButton>
          </>
        ) : !verified ? (
          <Alert tone="warning" title="Verify your email to trade">
            Confirm your email address before placing orders.
          </Alert>
        ) : !pair.tradingEnabled ? (
          <Alert tone="warning" title="Trading unavailable">
            Trading is not enabled for this market yet.
          </Alert>
        ) : null}

        {canTrade ? (
          <Button
            type="submit"
            variant={marketBlocked ? "tertiary" : side === "BUY" ? "primary" : "danger"}
            block
            size="lg"
            loading={submitting}
            loadingLabel="Placing order"
            disabled={marketBlocked}
          >
            {submitLabel}
          </Button>
        ) : null}

        <p className="jc-caption">
          Balances, fees, limits and the reserve are all calculated on the server. A resting limit
          order holds its funds but does not fill until an execution provider is connected.
        </p>
      </div>
    </form>
  );
}
