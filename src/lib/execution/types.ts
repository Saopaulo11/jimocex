import type { Database } from "@/lib/db/database";
import type { DecimalString } from "@/lib/money";

/**
 * Execution / liquidity provider contract — provider-NEUTRAL (Slice 5).
 *
 * JimoCex uses external liquidity/execution infrastructure; it has no internal
 * matching engine. The whole application talks to a venue only through the
 * `ExecutionProvider` interface below, so a specific liquidity provider can be
 * introduced — or replaced, or added alongside another — without a change in
 * the Order Engine, the ledger, or any business logic. The core never names a
 * provider.
 *
 * Money crosses this boundary as `DecimalString` (exact decimal text), never a
 * JavaScript number and never a bigint: an adapter parses an upstream body with
 * `parseJsonExact()` / `asDecimalString()` (see `@/lib/money`) so no figure ever
 * passes through a float. These are type-only imports, erased at build, so this
 * module is pure and unit-testable with `node --test`.
 *
 * TRUST RULE (restated in every place it matters): a provider's response is
 * NEVER internal financial truth. It is an instruction to the settlement layer,
 * which validates it against the internal order and the append-only ledger
 * before any balance moves. The ledger is the source of truth; this contract
 * carries intent and external identity, nothing more.
 */

export type OrderSide = Database["public"]["Enums"]["order_side"];
export type OrderType = Database["public"]["Enums"]["order_type"];
export type OrderStatus = Database["public"]["Enums"]["order_status"];

/**
 * A venue's view of an order's lifecycle, in neutral terms. Deliberately its OWN
 * enum, not the internal `order_status`: an adapter translates its venue's raw
 * statuses into these (`normalizeProviderStatus`, `./status-map`), and the
 * lifecycle (`./lifecycle`) decides what each means internally — a provider's
 * vocabulary never leaks into the core, and no status is ever written to an
 * order directly. Anything an adapter cannot place is `UNKNOWN`, which fails
 * closed.
 */
export type ExternalOrderStatus =
  | "ACCEPTED"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  /** A cancel was requested and the venue has not confirmed it: the order may still fill. */
  | "CANCEL_PENDING"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "UNKNOWN";

/** How a venue is addressed. At least one field is always present. */
export type ExternalOrderRef = {
  /** The venue's own order id — persisted to `trading_orders.provider_order_id`. */
  externalOrderId?: string;
  /** Our idempotency reference at the venue — `venueClientOrderIdFor(internal order id)`. */
  clientOrderId?: string;
};

/**
 * The idempotency reference an internal order carries to a venue. Derived from
 * the internal order id — server-generated, globally unique, never typed by a
 * customer — so the same order always presents the same reference and a replayed
 * submission cannot open a second venue order. Deliberately NOT the order's
 * `client_order_id`: that is the browser's form key, unique only per user, so
 * two customers could present the same one to the venue. An adapter whose venue
 * restricts the format may encode this deterministically and injectively.
 */
export function venueClientOrderIdFor(internalOrderId: string): string {
  return internalOrderId;
}

/**
 * What the Execution Service asks a venue to place: the order's identity and its
 * execution intent, nothing financial. No balance, wallet, fee, reserve or
 * ledger instruction crosses this boundary — the venue executes, the internal
 * settlement decides what that means for money. Only LIMIT is supported: the core
 * refuses MARKET before it ever reaches here.
 */
export type ExecutionOrderRequest = {
  /** The internal order this request executes, for the adapter's own correlation. */
  internalOrderId: string;
  /** `venueClientOrderIdFor(internalOrderId)` — the venue's idempotency key. */
  clientOrderId: string;
  /** Canonical pair symbol, e.g. "BTC-USDT". */
  pair: string;
  side: OrderSide;
  type: Extract<OrderType, "LIMIT">;
  /** The customer's limit price. */
  price: DecimalString;
  /** The order's full base amount. */
  amount: DecimalString;
  /** Base not yet filled internally; equals `amount` for a first submission. */
  remainingAmount: DecimalString;
};

/** A venue's acknowledgement of a placement. */
export type ExecutionOrderAck = {
  externalOrderId: string;
  clientOrderId?: string;
  status: ExternalOrderStatus;
  acceptedAt: Date;
};

/** A venue's current view of an order (for polling / reconciliation). */
export type ExecutionOrderView = {
  externalOrderId: string;
  clientOrderId?: string;
  status: ExternalOrderStatus;
  /** Cumulative base filled at the venue. */
  filledAmount: DecimalString;
  remainingAmount: DecimalString;
  /** Volume-weighted average fill price, or null before any fill. */
  avgFillPrice: DecimalString | null;
  /**
   * Cumulative quote moved and fee charged, as the venue reports them. Required
   * from a `CUMULATIVE` adapter (settlement derives each fill from them); a
   * `DISCRETE` adapter reports fills one by one through `getFills` instead.
   */
  cumulativeQuote?: DecimalString;
  cumulativeFee?: DecimalString;
  feeAsset?: string;
};

/**
 * How a venue reports execution, fixed per adapter:
 *   * DISCRETE   — each fill arrives with its own trade id (`getFills`);
 *   * CUMULATIVE — only running totals arrive (`getOrder`), and settlement
 *                  derives each new fill from them (`deriveCumulativeFill`).
 * An order is settled in one mode only; mixing them on one order is refused,
 * because the two id schemes cannot see each other's fills.
 */
export type FillReporting = "DISCRETE" | "CUMULATIVE";

/**
 * A venue's running totals for one order — the input a CUMULATIVE venue gives
 * settlement. It is never itself a fill: settlement subtracts what is already
 * settled, from persisted state, and only the difference can move money.
 */
export type ExecutionSnapshot = {
  externalOrderId: string;
  side: OrderSide;
  status: ExternalOrderStatus;
  cumulativeBase: DecimalString;
  cumulativeQuote: DecimalString;
  cumulativeFee: DecimalString;
  feeAsset: string;
  /** When the venue reported these totals (the derived fill's executed_at). */
  observedAt: Date;
};

/** One execution report line. `externalFillId` is the venue's trade id. */
export type ExecutionFill = {
  /** Persisted to `trades.provider_trade_id` (unique) — the replay guard. */
  externalFillId: string;
  externalOrderId: string;
  side: OrderSide;
  price: DecimalString;
  /** Base quantity filled (→ trades.amount). */
  amount: DecimalString;
  /**
   * Quote actually moved on this fill, as the VENUE reports it (→
   * trades.quote_amount). It is authoritative and is NOT `price × amount`: the
   * settlement layer uses this figure directly and never recomputes it from the
   * price (settlement-spec §6/§8). An adapter that only receives a cumulative
   * quote must derive this fill's delta before building the ExecutionFill.
   */
  quoteAmount: DecimalString;
  fee: DecimalString;
  feeAsset: string;
  executedAt: Date;
};

export type ExecutionCancelAck = {
  externalOrderId: string;
  status: ExternalOrderStatus;
};

/** Per-call controls the service applies around every provider call. */
export type ExecutionCallOptions = {
  /** Abort and classify as TIMEOUT after this many ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * The provider interface. A real adapter is `server-only` and holds the venue's
 * credentials; this interface mentions none, because credentials never cross
 * into provider-neutral space and never reach the browser.
 */
export interface ExecutionProvider {
  readonly name: string;
  /** How this venue reports execution; decides which settlement path its fills take. */
  readonly fillReporting: FillReporting;
  /** False when the adapter has no credentials or no venue configured. */
  isConfigured(): boolean;

  placeOrder(request: ExecutionOrderRequest, options?: ExecutionCallOptions): Promise<ExecutionOrderAck>;
  cancelOrder(ref: ExternalOrderRef, options?: ExecutionCallOptions): Promise<ExecutionCancelAck>;
  getOrder(ref: ExternalOrderRef, options?: ExecutionCallOptions): Promise<ExecutionOrderView>;
  getOpenOrders(options?: ExecutionCallOptions): Promise<ExecutionOrderView[]>;
  getFills(ref: ExternalOrderRef, options?: ExecutionCallOptions): Promise<ExecutionFill[]>;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Every provider failure classifies to exactly one of these. The service never
 * surfaces a raw provider error; it maps to a kind, so callers branch on a
 * bounded set and nothing provider-internal (a URL, a key, a stack) leaks out.
 */
export type ExecutionErrorKind =
  | "UNAVAILABLE" // no provider configured / venue unreachable
  | "TIMEOUT" // the call exceeded its deadline
  | "REJECTED" // the venue refused the order (params, risk, insufficient venue liquidity)
  | "DUPLICATE" // the venue reports this clientOrderId already exists
  | "UNKNOWN_ORDER" // the venue has no such order
  | "RATE_LIMITED"
  | "AUTH" // signing / credential failure
  | "NETWORK" // transport failure
  | "PROVIDER_ERROR"; // venue 5xx / malformed response / anything unclassified

/** A classified, safe-to-propagate execution failure. */
export class ExecutionError extends Error {
  readonly kind: ExecutionErrorKind;
  /** Whether re-sending with the SAME clientOrderId is safe. */
  readonly retryable: boolean;
  /**
   * True when it is unknown whether the venue received the request (a timeout
   * or a dropped connection). The caller must RECONCILE (read provider truth by
   * clientOrderId), never blindly resubmit — a resubmit with a new key could
   * double-place.
   */
  readonly ambiguous: boolean;
  readonly providerName?: string;

  constructor(
    kind: ExecutionErrorKind,
    message: string,
    options: { retryable?: boolean; ambiguous?: boolean; providerName?: string } = {},
  ) {
    super(message);
    this.name = "ExecutionError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
    this.providerName = options.providerName;
  }
}

/** A safe, serializable projection of an ExecutionError for a result value. */
export type ExecutionErrorInfo = {
  kind: ExecutionErrorKind;
  retryable: boolean;
  ambiguous: boolean;
  message: string;
};

export function toErrorInfo(error: ExecutionError): ExecutionErrorInfo {
  return { kind: error.kind, retryable: error.retryable, ambiguous: error.ambiguous, message: error.message };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Removes duplicate fills by `externalFillId`, keeping the first occurrence. A
 * venue may replay an execution report; the authoritative guard is the unique
 * `trades.provider_trade_id` in the database, but de-duplicating here keeps a
 * reconciliation pass from attempting the same settlement twice.
 */
export function dedupeFills(fills: readonly ExecutionFill[]): ExecutionFill[] {
  const seen = new Set<string>();
  const out: ExecutionFill[] = [];
  for (const fill of fills) {
    if (seen.has(fill.externalFillId)) continue;
    seen.add(fill.externalFillId);
    out.push(fill);
  }
  return out;
}
