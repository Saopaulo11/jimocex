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
 * A venue's view of an order's lifecycle. Deliberately its OWN enum, not the
 * internal `order_status`: a provider reports provider states, and the service
 * maps them to internal states (`mapExternalStatus`) rather than letting a
 * provider's vocabulary leak into the core.
 */
export type ExternalOrderStatus =
  | "ACCEPTED"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "UNKNOWN";

/** How a venue is addressed. At least one field is always present. */
export type ExternalOrderRef = {
  /** The venue's own order id — persisted to `trading_orders.provider_order_id`. */
  externalOrderId?: string;
  /** Our idempotency key, echoed by the venue — persisted as `client_order_id`. */
  clientOrderId?: string;
};

/**
 * What the Execution Service asks a venue to place. Only LIMIT is supported:
 * a MARKET order needs a price from a feed and a venue willing to fill at it,
 * and the core refuses MARKET before it ever reaches here.
 */
export type ExecutionOrderRequest = {
  /** Our idempotency key (the internal order's `client_order_id`). */
  clientOrderId: string;
  /** Canonical pair symbol, e.g. "BTC-USDT". */
  pair: string;
  side: OrderSide;
  type: Extract<OrderType, "LIMIT">;
  price: DecimalString;
  amount: DecimalString;
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
  filledAmount: DecimalString;
  remainingAmount: DecimalString;
  /** Volume-weighted average fill price, or null before any fill. */
  avgFillPrice: DecimalString | null;
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
// Pure mapping helpers (provider-neutral → internal)
// ---------------------------------------------------------------------------

/**
 * Maps a venue's order status to the internal `order_status`. A venue's
 * "ACCEPTED" means the order is resting on the book → internal `OPEN`. "UNKNOWN"
 * maps to nothing (null): an order the venue cannot find is a reconciliation
 * event for the caller to resolve against internal state, not a status to write.
 */
export function mapExternalStatus(status: ExternalOrderStatus): OrderStatus | null {
  switch (status) {
    case "ACCEPTED":
    case "OPEN":
      return "OPEN";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "CANCELLED":
      return "CANCELLED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      return "EXPIRED";
    case "UNKNOWN":
      return null;
  }
}

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
