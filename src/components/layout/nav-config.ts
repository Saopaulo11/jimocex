/**
 * Navigation, in one place.
 *
 * The header, the sidebar, the mobile bar and the footer all read from here, so
 * a route that is added or renamed moves everywhere at once instead of being
 * updated in four files and missed in a fifth.
 *
 * `available: false` marks a route whose page does not exist yet. It renders as
 * a disabled item rather than being hidden: the product's shape is part of what
 * the navigation communicates, and a link that 404s is worse than one that says
 * "not yet". As each section of the product lands, its flag flips to available
 * here and nowhere else.
 */

export type NavItem = {
  href: string;
  label: string;
  available?: boolean;
  /** Optional icon id; the sidebar and mobile bar map it to an inline SVG. */
  icon?: string;
};

export type NavSection = {
  heading: string;
  items: NavItem[];
};

/** Main header navigation, signed out and signed in alike. */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/markets", label: "Markets" },
  { href: "/exchange", label: "Exchange" },
  { href: "/trade", label: "Trade" },
];

/** Added to the header once signed in. Deeper destinations live in the sidebar. */
export const ACCOUNT_NAV: NavItem[] = [];

/**
 * The signed-in application sidebar (the `(app)` area). Grouped so a growing
 * product stays legible: what you do, what you hold, and who you are.
 */
export const APP_SIDEBAR: NavSection[] = [
  {
    heading: "Trade",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
      { href: "/markets", label: "Markets", icon: "markets" },
      { href: "/trade", label: "Trade", icon: "trade" },
      { href: "/exchange", label: "Exchange", icon: "exchange" },
    ],
  },
  {
    heading: "Assets",
    items: [
      { href: "/assets", label: "Portfolio", icon: "portfolio" },
      { href: "/wallets", label: "Wallets", icon: "wallet" },
      { href: "/orders", label: "Orders", icon: "orders" },
    ],
  },
  {
    heading: "Account",
    items: [
      { href: "/account", label: "Account", icon: "account" },
      { href: "/settings", label: "Settings", icon: "settings" },
      { href: "/support", label: "Support", icon: "support" },
    ],
  },
];

/** The operator console sidebar (`/admin`). Built in a later slice. */
export const ADMIN_SIDEBAR: NavSection[] = [
  {
    heading: "Overview",
    items: [
      { href: "/admin", label: "Dashboard" },
      { href: "/admin/system", label: "System" },
      { href: "/admin/audit", label: "Audit log" },
    ],
  },
  {
    heading: "Customers",
    items: [
      { href: "/admin/users", label: "Users" },
      { href: "/admin/kyc", label: "KYC / AML" },
    ],
  },
  {
    heading: "Activity",
    items: [
      { href: "/admin/orders", label: "Orders" },
      { href: "/admin/trades", label: "Trades" },
      { href: "/admin/deposits", label: "Deposits" },
      { href: "/admin/withdrawals", label: "Withdrawals" },
    ],
  },
  {
    heading: "Configuration",
    items: [
      { href: "/admin/assets", label: "Assets" },
      { href: "/admin/markets", label: "Markets" },
      { href: "/admin/fees", label: "Fees" },
      { href: "/admin/limits", label: "Limits" },
    ],
  },
  {
    heading: "Providers",
    items: [
      { href: "/admin/providers", label: "Providers" },
      { href: "/admin/liquidity", label: "Liquidity" },
      { href: "/admin/custody", label: "Custody" },
      { href: "/admin/payments", label: "Payments" },
    ],
  },
];

/** Bottom bar on mobile — the five destinations a customer reaches most. */
export const MOBILE_NAV: NavItem[] = [
  { href: "/markets", label: "Markets" },
  { href: "/trade", label: "Trade" },
  { href: "/wallets", label: "Wallets" },
  { href: "/orders", label: "Orders" },
  { href: "/account", label: "Account" },
];

export const FOOTER_NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Platform",
    items: [
      { href: "/markets", label: "Markets" },
      { href: "/exchange", label: "Exchange" },
      { href: "/trade", label: "Trade" },
      { href: "/wallets", label: "Wallets" },
    ],
  },
  {
    heading: "Company",
    items: [
      { href: "/about", label: "About" },
      { href: "/fees", label: "Fees" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/blog", label: "Blog" },
    ],
  },
  {
    heading: "Support",
    items: [
      { href: "/support", label: "Help centre" },
      { href: "/support/contact", label: "Contact" },
      { href: "/status", label: "System status" },
    ],
  },
  {
    heading: "Legal",
    items: [
      { href: "/terms", label: "Terms of Service" },
      { href: "/privacy", label: "Privacy Policy" },
      { href: "/risk", label: "Risk Disclosure" },
    ],
  },
];
