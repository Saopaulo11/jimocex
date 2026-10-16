/**
 * Exchange quote view types, shared between the server quote builder and the
 * client widget. Client-safe (no server-only imports); every money value is an
 * exact decimal string.
 */

export type ExchangeQuote = {
  fromSymbol: string;
  toSymbol: string;
  fromDecimals: number;
  toDecimals: number;
  amount: string;
  /** 1 `from` = `rate` `to`. */
  rate: string;
  grossReceive: string;
  fee: string;
  feeAsset: string;
  netReceive: string;
  demo: boolean;
};

export type ExchangeQuoteErrorCode =
  | "VALIDATION_FAILED"
  | "SAME_ASSET"
  | "UNKNOWN_ASSET"
  | "RATE_UNAVAILABLE";

export type ExchangeQuoteResult =
  | { ok: true; quote: ExchangeQuote }
  | { ok: false; code: ExchangeQuoteErrorCode; message: string };
