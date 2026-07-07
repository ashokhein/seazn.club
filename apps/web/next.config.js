import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Monorepo: trace from the workspace root so hoisted node_modules land in
  // .next/standalone (Next docs: config/output caveats).
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // pdfkit reads its AFM font-metrics files from disk at runtime (Jul3/06
  // exports); bundling it breaks that path resolution, so load it — and
  // exceljs, likewise native-ish — from node_modules on the server.
  serverExternalPackages: ["pdfkit", "exceljs"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Source map upload — set SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT in CI
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Disable source map upload when auth token absent (local dev)
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },

  // Tree-shake Sentry logger statements from client bundle
  disableLogger: true,

  // Don't auto-instrument routes that we instrument manually
  autoInstrumentServerFunctions: false,
});
