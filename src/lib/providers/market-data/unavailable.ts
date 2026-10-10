import "server-only";

import { AppError } from "@/lib/errors";

import type {
  Candle,
  CandleInterval,
  MarketDataProvider,
  OrderBook,
  PublicTrade,
  Ticker,
} from "./types";

/**
 * The provider used when no real market data source is connected.
 *
 * It is not a mock and it is not a stub that returns zeros: it refuses, on
 * every call, with MARKET_DATA_UNAVAILABLE. The UI then shows "Market data is
 * currently unavailable" (spec §13), and the LimitEngine refuses to approve an
 * operation it cannot value (spec §13).
 *
 * The alternative — generating plausible prices — is the single most dangerous
 * shortcut available in this codebase. A fabricated rate is indistinguishable
 * from a real one on screen, and a customer would be making real decisions, and
 * eventually real transfers, against a number nobody computed from a market.
 * Spec §80.1 forbids it, and so does this class, by having nowhere to put one.
 */
export class UnavailableMarketDataProvider implements MarketDataProvider {
  readonly name = "unavailable";

  isConfigured(): boolean {
    return false;
  }

  private refuse(): never {
    throw new AppError(
      "MARKET_DATA_UNAVAILABLE",
      "no market data provider is configured for this deployment",
    );
  }

  async getTicker(_pair: string): Promise<Ticker> {
    this.refuse();
  }

  async getTickers(_pairs?: string[]): Promise<Ticker[]> {
    this.refuse();
  }

  async getOrderBook(_pair: string, _depth?: number): Promise<OrderBook> {
    this.refuse();
  }

  async getCandles(_pair: string, _interval: CandleInterval, _limit?: number): Promise<Candle[]> {
    this.refuse();
  }

  async getRecentTrades(_pair: string, _limit?: number): Promise<PublicTrade[]> {
    this.refuse();
  }
}
