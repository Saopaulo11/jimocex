import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "JimoCex — Trade Crypto, FX & Global Assets",
    template: "%s · JimoCex",
  },
  description:
    "Trade and exchange crypto, fiat and global markets through one modern platform.",
  metadataBase: process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL)
    : undefined,
  openGraph: {
    title: "JimoCex — Trade Crypto, FX & Global Assets",
    description:
      "Trade and exchange crypto, fiat and global markets through one modern platform.",
    siteName: "JimoCex",
    type: "website",
  },
  // Nothing on this platform benefits from being indexed while it is still
  // being built, and a half-finished financial product in search results is a
  // liability. Flipped on at launch.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0f18",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
