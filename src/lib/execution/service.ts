import {
  ExecutionError,
  dedupeFills,
  toErrorInfo,
  type ExecutionCallOptions,
  type ExecutionCancelAck,
  type ExecutionErrorInfo,
  type ExecutionFill,
  type ExecutionOrderAck,
  type ExecutionOrderRequest,
  type ExecutionOrderView,
  type ExecutionProvider,
  type ExternalOrderRef,
} from "./types.ts";

/**
 * Execution Service (Slice 5) — the seam between the Order Engine and whatever
 * liquidity/execution provider is configured.
 *
 *   Order Engine → ExecutionService → ExecutionProvider → a concrete LP adapter
 *
 * It is a PURE orchestrator: the provider is injected, so this logic is tested
 * with a deterministic test double and no network. It holds no credentials — a
 * real adapter does, behind `server-only`. Everything crosses as provider-
 * neutral types; the core never learns the provider's name.
 *
 * What it guarantees around every provider call:
 *   * a controllable TIMEOUT — a hung venue fails fast, classified, ambiguous;
 *   * CLASSIFICATION — every failure becomes one bounded `ExecutionErrorKind`;
 *     a raw provider error (a URL, a key, a stack) never escapes this class;
 *   * IDEMPOTENCY discipline — placement always carries the internal
 *     `clientOrderId`; an ambiguous failure (timeout/network) is flagged so the
 *     caller RECONCILES rather than blindly resubmitting;
 *   * DEDUPE — a replayed fill is dropped by `externalFillId` before it can
 *     drive a second settlement.
 *
 * What it must NEVER do: treat a provider response as internal financial truth,
 * move a balance, or mutate internal order state. It returns typed results;
 * settlement validates them against the internal order and the append-only
 * ledger before anything is posted.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export type ExecutionResult<T> = { ok: true; value: T } | { ok: false; error: ExecutionErrorInfo };

export type ExecutionServiceOptions = {
  defaultTimeoutMs?: number;
};

export class ExecutionService {
  private readonly provider: ExecutionProvider;
  private readonly defaultTimeoutMs: number;

  constructor(provider: ExecutionProvider, options: ExecutionServiceOptions = {}) {
    this.provider = provider;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Whether a real venue is wired. False means every call returns UNAVAILABLE. */
  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /** Places an order at the venue. The request MUST carry the internal clientOrderId. */
  async submitOrder(
    request: ExecutionOrderRequest,
    options?: ExecutionCallOptions,
  ): Promise<ExecutionResult<ExecutionOrderAck>> {
    return this.run((opts) => this.provider.placeOrder(request, opts), options);
  }

  async cancelOrder(
    ref: ExternalOrderRef,
    options?: ExecutionCallOptions,
  ): Promise<ExecutionResult<ExecutionCancelAck>> {
    return this.run((opts) => this.provider.cancelOrder(ref, opts), options);
  }

  async getOrder(
    ref: ExternalOrderRef,
    options?: ExecutionCallOptions,
  ): Promise<ExecutionResult<ExecutionOrderView>> {
    return this.run((opts) => this.provider.getOrder(ref, opts), options);
  }

  async getOpenOrders(options?: ExecutionCallOptions): Promise<ExecutionResult<ExecutionOrderView[]>> {
    return this.run((opts) => this.provider.getOpenOrders(opts), options);
  }

  /** Fetches fills, with duplicates removed by `externalFillId`. */
  async getFills(
    ref: ExternalOrderRef,
    options?: ExecutionCallOptions,
  ): Promise<ExecutionResult<ExecutionFill[]>> {
    const result = await this.run((opts) => this.provider.getFills(ref, opts), options);
    if (!result.ok) return result;
    return { ok: true, value: dedupeFills(result.value) };
  }

  /**
   * Resolves the venue's current truth for an order by its clientOrderId — the
   * safe recovery after an AMBIGUOUS submit (timeout/network), instead of
   * resubmitting. Returns the venue's view, or a classified error.
   */
  async reconcileByClientOrderId(
    clientOrderId: string,
    options?: ExecutionCallOptions,
  ): Promise<ExecutionResult<ExecutionOrderView>> {
    return this.getOrder({ clientOrderId }, options);
  }

  // -------------------------------------------------------------------------

  private async run<T>(
    call: (options: ExecutionCallOptions) => Promise<T>,
    options?: ExecutionCallOptions,
  ): Promise<ExecutionResult<T>> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    try {
      const value = await this.withTimeout(call({ ...options, timeoutMs }), timeoutMs);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: toErrorInfo(this.classify(error)) };
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ExecutionError("TIMEOUT", `execution provider call exceeded ${ms}ms`, {
            retryable: false,
            ambiguous: true, // the venue may or may not have received it — reconcile, do not resubmit
            providerName: this.provider.name,
          }),
        );
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Turns any thrown value into a classified `ExecutionError`. An adapter is
   * expected to throw `ExecutionError` with the right kind; a raw error is
   * treated as an unexpected provider error and its message is NOT propagated.
   */
  private classify(error: unknown): ExecutionError {
    if (error instanceof ExecutionError) return error;
    return new ExecutionError(
      "PROVIDER_ERROR",
      "the execution provider returned an unexpected error",
      { retryable: false, providerName: this.provider.name },
    );
  }
}
