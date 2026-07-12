import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import { posthogIngestHosts } from "./src/lib/posthog-proxy.mjs";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // X-Frame-Options lives in its own rule below — /embed/* must be frameable
  // by other sites (v3/10 #4), everything else stays SAMEORIGIN.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  // Isolate the browsing context: a window we open (or that opens us) can't
  // reach back through window.opener. OAuth here is redirect-based, so this is
  // safe. (CSP is deliberately omitted — it needs a nonce + Sentry/Supabase
  // allowlist and is tracked as a separate, tested change.)
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Don't advertise the framework (removes the `X-Powered-By: Next.js` header).
  poweredByHeader: false,
  // Monorepo: trace from the workspace root so hoisted node_modules land in
  // .next/standalone (Next docs: config/output caveats).
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // pdfkit reads its AFM font-metrics files from disk at runtime (Jul3/06
  // exports); bundling it breaks that path resolution, so load it — and
  // exceljs, likewise native-ish — from node_modules on the server.
  serverExternalPackages: ["pdfkit", "exceljs"],
  // Email HTML templates and /help Markdown are read from disk at runtime
  // (lib/email-templates/compose.ts, server/help-content.ts) — make sure
  // they land in the standalone trace for every route.
  outputFileTracingIncludes: {
    "/*": ["src/lib/email-templates/html/**/*", "content/help/**/*"],
  },
  // PostHog reverse proxy: front analytics through our own origin so
  // ad-blockers don't drop events. Client posts to /ingest (see
  // instrumentation-client). skipTrailingSlashRedirect keeps PostHog's
  // trailing-slash API paths from being 308'd.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // Region-derived from NEXT_PUBLIC_POSTHOG_HOST (see posthog-proxy). Must be
    // set at build time — these rewrite destinations bake into the server.
    const { ingest, assets } = posthogIngestHosts();
    return [
      { source: "/ingest/static/:path*", destination: `${assets}/static/:path*` },
      { source: "/ingest/:path*", destination: `${ingest}/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        // Everything except /embed keeps the clickjacking guard; embeds are
        // read-only widgets designed to be framed by club websites.
        source: "/((?!embed).*)",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
      {
        source: "/embed/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
    ];
  },
  // next/image: only Supabase Storage public objects are optimizable —
  // arbitrary avatar URLs stay on plain <img> (can't enumerate the internet
  // in remotePatterns). Long minimumCacheTTL: logos change rarely and the
  // optimizer output is CPU we don't want to respend (spec 2026-07-12 P2).
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: process.env.NEXT_PUBLIC_SUPABASE_URL
          ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
          : "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
    minimumCacheTTL: 86400,
  },
};

// Pre-wrap config, re-exported by name: withSentryConfig's returned object
// isn't guaranteed to expose `images` in a stable, typed shape, so tests (and
// anything else needing the raw Next config) should import this instead of
// the default export.
export { nextConfig };

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
