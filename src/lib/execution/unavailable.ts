import "server-only";

import {
  ExecutionError,
  type ExecutionCancelAck,
  type ExecutionFill,
  type ExecutionOrderAck,
  type ExecutionOrderRequest,
  type ExecutionOrderView,
  type ExecutionProvider,
  type ExternalOrderRef,
} from "./types";

/**
 * The execution provider used when no venue is connected — the default.
 *
 * It is not a mock and it does not simulate fills: it refuses every call with a
 * classified `UNAVAILABLE` error. A deployment with no venue therefore cannot
 * place, cancel, or report an order through a venue at all; a limit order that
 * was reserved stays `OPEN` in the ledger (its funds held) and never pretends to
 * have executed. Inventing a fill here would be the single most dangerous
 * shortcut in an exchange — a fabricated execution moves real balances against
 * nothing — so this class has nowhere to put one.
 */
export class UnavailableExecutionProvider implements ExecutionProvider {
  readonly name = "unavailable";

  isConfigured(): boolean {
    return false;
  }

  private refuse(): never {
    throw new ExecutionError("UNAVAILABLE", "no execution provider is configured for this deployment", {
      retryable: false,
      ambiguous: false,
      providerName: this.name,
    });
  }

  async placeOrder(_request: ExecutionOrderRequest): Promise<ExecutionOrderAck> {
    this.refuse();
  }

  async cancelOrder(_ref: ExternalOrderRef): Promise<ExecutionCancelAck> {
    this.refuse();
  }

  async getOrder(_ref: ExternalOrderRef): Promise<ExecutionOrderView> {
    this.refuse();
  }

  async getOpenOrders(): Promise<ExecutionOrderView[]> {
    this.refuse();
  }

  async getFills(_ref: ExternalOrderRef): Promise<ExecutionFill[]> {
    this.refuse();
  }
}
