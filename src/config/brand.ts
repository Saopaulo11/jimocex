/**
 * Brand & product configuration — the single place a white-label client changes
 * to make this exchange their own (Slice 4).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS — and, more importantly, what it is NOT
 * ---------------------------------------------------------------------------
 *
 * This file is PRESENTATION and PRODUCT configuration only. It is imported by
 * both server and client components, so it ends up in the browser bundle. That
 * is fine: every value here is public by nature — a name, a colour, a support
 * link, which products appear in the navigation.
 *
 * It is NOT a security boundary, and nothing here can move a financial control:
 *
 *   * fees come from the `fee_rules` table and the server FeeEngine;
 *   * limits come from `tier_limits` and the server LimitEngine;
 *   * who may trade comes from Supabase Auth + the DAL (`@/lib/auth/session`);
 *   * whether a pair is tradable comes from `trading_pairs.trading_enabled`;
 *   * balances and holds come from the append-only ledger;
 *   * all of the above are enforced under RLS and the service-role boundary.
 *
 * A `product` flag below only decides what the INTERFACE offers. Turning
 * `enabledMarketOrders` on does not make a market order executable — the engine
 * still refuses MARKET (no venue). Listing a pair in `enabledMarkets` does not
 * make it tradable — `trading_pairs.trading_enabled` does. Never put a secret, a
 * credential, a fee, a limit or an authorization decision in this file.
 */

/** A wordmark: a plain name, or a two-tone split (primary text + accent). */
export type Wordmark = string | { primary: string; accent: string };

export type BrandTheme = {
  /** The accent ("gold"). Mirrors `--jc-gold` in src/styles/tokens.css. */
  accentColor: string;
  /** App chrome background. Mirrors the dark base and feeds `themeColor`. */
  backgroundColor: string;
  colorScheme: "dark" | "light";
};

export type NamedLink = { label: string; href: string };

export type Brand = {
  /** Canonical plain name — metadata, titles, accessible labels. */
  name: string;
  /** Visual wordmark; defaults to `name` when a split is not given. */
  wordmark: Wordmark;
  tagline: string;
  /** One line used in metadata descriptions and marketing surfaces. */
  description: string;
  /** Legal / company display name for the copyright line and legal pages. */
  companyName: string;
  supportEmail: string;
  supportUrl: string;
  /**
   * Asset paths, relative to `public/`. The inline monogram geometry lives in
   * `src/components/brand/LogoMark.tsx`; a client replaces that artwork and
   * these files together. See `public/brand/README.md`.
   */
  logo: { full: string; mark: string; monochromeMark: string };
  /** Favicon is the Next file-convention route `src/app/icon.svg`. */
  favicon: string;
  theme: BrandTheme;
  legalLinks: NamedLink[];
  socialLinks: NamedLink[];
};

export type Product = {
  /** Which pairs the UI surfaces: every active+listed pair ("all"), or an allow-list of symbols. Visibility only — `trading_pairs.trading_enabled` is authoritative. */
  enabledMarkets: "all" | readonly string[];
  /** Whether the Trade product is offered in the UI. */
  enabledTrading: boolean;
  /** Whether the limit-order form is offered. */
  enabledLimitOrders: boolean;
  /** Whether the UI offers market orders. The engine refuses MARKET regardless until an execution venue is connected. */
  enabledMarketOrders: boolean;
  /** Whether the Exchange (swap) product is offered in the UI. */
  enabledExchange: boolean;
  /**
   * Whether to show DETERMINISTIC DEMO market data when no real feed is named.
   *
   * Presentation only, and never a security control: it changes what numbers
   * the UI displays, nothing a customer can transact against. The demo source
   * is labelled "Demo data" wherever it appears. A real deployment sets this
   * `false` (and names a real feed in `JIMOCEX_MARKET_DATA_PROVIDER`); leaving
   * it `false` with no feed named shows an honest "unavailable" everywhere.
   */
  demoMarketData: boolean;
};

/**
 * The default brand: JimoCex. A new client edits THIS object (or replaces the
 * file) — see docs/white-label.md. The default deliberately preserves the exact
 * current look: the two-tone "Jimo" + "Cex" wordmark and the gold accent.
 */
export const brand: Brand = {
  name: "JimoCex",
  wordmark: { primary: "Jimo", accent: "Cex" },
  tagline: "Global markets. Real opportunities.",
  description:
    "Trade and exchange crypto, fiat and global markets through one modern platform.",
  companyName: "JimoCex",
  supportEmail: "support@jimocex.example",
  supportUrl: "/support",
  logo: {
    full: "/brand/jimocex-logo-dark.svg",
    mark: "/brand/jimocex-mark.svg",
    monochromeMark: "/brand/jimocex-mark-mono.svg",
  },
  favicon: "/icon.svg",
  theme: {
    accentColor: "#c9a45c",
    backgroundColor: "#0a0f18",
    colorScheme: "dark",
  },
  legalLinks: [
    { label: "Terms of Service", href: "/terms" },
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Risk Disclosure", href: "/risk" },
  ],
  socialLinks: [],
};

export const product: Product = {
  enabledMarkets: "all",
  enabledTrading: true,
  enabledLimitOrders: true,
  // Off: no market-data and no execution provider are connected. The UI shows
  // market orders as unavailable; the engine refuses them either way.
  enabledMarketOrders: false,
  enabledExchange: true,
  // On for this prototype: show deterministic demo prices (labelled "Demo
  // data") so every surface is alive. A real deployment sets this false and
  // names a real feed in JIMOCEX_MARKET_DATA_PROVIDER. Presentation only.
  demoMarketData: true,
};

/** The accessible / plain brand name, whatever shape the wordmark takes. */
export function brandName(): string {
  return brand.name;
}

/** The wordmark as plain text (both halves of a split joined). */
export function wordmarkText(wordmark: Wordmark = brand.wordmark): string {
  return typeof wordmark === "string" ? wordmark : `${wordmark.primary}${wordmark.accent}`;
}
