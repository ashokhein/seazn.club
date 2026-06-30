import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TypeScript still type-checks the build; ESLint is run separately via
  // `npm run lint` to avoid coupling builds to lint config quirks.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
