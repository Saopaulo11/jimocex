/**
 * Navigation, in one place.
 *
 * The header, the mobile bar and the footer all read from here, so a route that
 * is added or renamed moves everywhere at once instead of being updated in
 * three files and missed in a fourth.
 *
 * `available: false` marks a route whose page does not exist yet. It renders as
 * a disabled item rather than being hidden: the product's shape is part of what
 * the navigation communicates, and a link that 404s is worse than one that says
 * "not yet".
 */

export type NavItem = {
  href: string;
  label: string;
  available?: boolean;
};

/** Main navigation, signed out and signed in alike. */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/markets", label: "Markets" },
  { href: "/exchange", label: "Exchange" },
  { href: "/trade", label: "Trade" },
  { href: "/wallets", label: "Wallets", available: false },
];

/** Added once signed in. */
export const ACCOUNT_NAV: NavItem[] = [
  { href: "/transactions", label: "Transactions", available: false },
];

/** Bottom bar on mobile — four destinations, no more. */
export const MOBILE_NAV: NavItem[] = [
  { href: "/markets", label: "Markets" },
  { href: "/exchange", label: "Exchange" },
  { href: "/trade", label: "Trade" },
  { href: "/wallets", label: "Wallets", available: false },
];

export const FOOTER_NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Platform",
    items: [
      { href: "/markets", label: "Markets" },
      { href: "/exchange", label: "Exchange" },
      { href: "/trade", label: "Trade" },
      { href: "/wallets", label: "Wallets", available: false },
    ],
  },
  {
    heading: "Company",
    items: [
      { href: "/about", label: "About", available: false },
      { href: "/fees", label: "Fees", available: false },
      { href: "/how-it-works", label: "How it works", available: false },
      { href: "/blog", label: "Blog", available: false },
    ],
  },
  {
    heading: "Support",
    items: [
      { href: "/help", label: "Help centre", available: false },
      { href: "/contact", label: "Contact", available: false },
      { href: "/status", label: "System status", available: false },
    ],
  },
  {
    heading: "Legal",
    items: [
      { href: "/terms", label: "Terms of Service", available: false },
      { href: "/privacy", label: "Privacy Policy", available: false },
      { href: "/risk", label: "Risk Disclosure", available: false },
    ],
  },
];
