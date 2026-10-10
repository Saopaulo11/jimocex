import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Surfaces a mistaken client-side import of a server-only module as a build
  // error rather than as a secret in the browser bundle.
  serverExternalPackages: [],
};

export default nextConfig;
