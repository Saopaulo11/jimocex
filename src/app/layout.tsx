import type { Metadata, Viewport } from "next";

import { brand } from "@/config/brand";

import "./globals.css";

const title = `${brand.name} — ${brand.tagline}`;

export const metadata: Metadata = {
  title: {
    default: title,
    template: `%s · ${brand.name}`,
  },
  description: brand.description,
  metadataBase: process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL)
    : undefined,
  openGraph: {
    title,
    description: brand.description,
    siteName: brand.name,
    type: "website",
  },
  // Nothing on this platform benefits from being indexed while it is still
  // being built, and a half-finished financial product in search results is a
  // liability. Flipped on at launch.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: brand.theme.backgroundColor,
  colorScheme: brand.theme.colorScheme,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
