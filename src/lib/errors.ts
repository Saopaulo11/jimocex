/**
 * Application errors.
 *
 * Every failure the user can provoke is one of these codes, so a route handler
 * maps an error to a status and a message in one place instead of improvising
 * per endpoint. The `message` is customer-facing and must never leak why a
 * compliance or risk rule fired (spec §24): telling someone which rule flagged
 * them is how a rule gets evaded.
 */

export const ERROR_CODES = {
  UNAUTHENTICATED: { status: 401, message: "Please sign in to continue." },
  EMAIL_NOT_VERIFIED: { status: 403, message: "Please verify your email address to continue." },
  ACCOUNT_SUSPENDED: { status: 403, message: "This account cannot perform financial operations. Please contact support." },
  ACCOUNT_CLOSED: { status: 403, message: "This account is closed." },
  FORBIDDEN: { status: 403, message: "You do not have access to this." },
  TIER_TOO_LOW: { status: 403, message: "Additional verification required." },
  KYC_REQUIRED: { status: 403, message: "Additional verification required." },
  LIMIT_EXCEEDED: { status: 403, message: "This amount exceeds your current limit." },
  LIMIT_BELOW_MINIMUM: { status: 400, message: "This amount is below the minimum for this operation." },
  // Deliberately a refusal, not a guess. When the platform cannot convert an
  // amount to the limit currency it cannot know whether a limit is breached,
  // and approving on an estimated rate is not an option (spec §13).
  LIMIT_CHECK_UNAVAILABLE: { status: 503, message: "We cannot check your limits right now. Please try again shortly." },
  PROVIDER_UNAVAILABLE: { status: 503, message: "Service temporarily unavailable." },
  MARKET_DATA_UNAVAILABLE: { status: 503, message: "Market data is currently unavailable." },
  TRADING_DISABLED: { status: 503, message: "Trading is not available for this market." },
  QUOTE_NOT_USABLE: { status: 409, message: "This quote has expired. Please request a new one." },
  INSUFFICIENT_BALANCE: { status: 400, message: "Insufficient balance." },
  VALIDATION_FAILED: { status: 400, message: "Please check the details and try again." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Please slow down." },
  INTERNAL: { status: 500, message: "Something went wrong. Please try again." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to show the customer. */
  readonly publicMessage: string;
  /** Internal only — logged, never returned in a response body. */
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string, publicMessage?: string) {
    const spec = ERROR_CODES[code];
    super(detail ?? spec.message);
    this.name = "AppError";
    this.code = code;
    this.status = spec.status;
    this.publicMessage = publicMessage ?? spec.message;
    this.detail = detail;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Shapes any thrown value into a response body. An unexpected error becomes a
 * generic INTERNAL: an exception message can carry a column name, a row id or a
 * constraint name, and none of that belongs in a customer's browser.
 */
export function toErrorResponse(error: unknown): { code: ErrorCode; message: string; status: number } {
  if (isAppError(error)) {
    return { code: error.code, message: error.publicMessage, status: error.status };
  }
  return { code: "INTERNAL", message: ERROR_CODES.INTERNAL.message, status: 500 };
}
