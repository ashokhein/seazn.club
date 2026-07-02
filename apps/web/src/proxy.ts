import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Build the Content-Security-Policy for a page request (doc 04 §5).
 *
 * script-src uses a per-request nonce + 'strict-dynamic'; Next.js reads the
 * enforcing CSP header and automatically stamps the nonce onto its framework
 * and page scripts, so no per-tag wiring is needed. connect-src allows Supabase
 * (realtime websockets) and Sentry ingest; img-src allows arbitrary https for
 * player/org avatars.
 *
 * Default is Content-Security-Policy-Report-Only so a missing directive can
 * never break the running app — set CSP_MODE=enforce (after verifying the
 * browser console on staging) to switch to blocking. Enforcing nonce CSP forces
 * dynamic rendering (no static/CDN caching), which is why it is opt-in.
 */
function cspHeader(nonce: string): { name: string; value: string } {
  const isDev = process.env.NODE_ENV === "development";
  const enforce = process.env.CSP_MODE === "enforce";
  const value = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind ships an external stylesheet; 'unsafe-inline' covers the small
    // inline styles Next injects. Styles are low-risk vs script injection.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.ingest.sentry.io https://*.sentry.io`,
    `frame-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
    `upgrade-insecure-requests`,
  ].join("; ");
  return {
    name: enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    value,
  };
}

/**
 * CSRF protection: for every mutating API call, the Origin header must match
 * the app host. Browsers always send Origin on cross-origin requests, so a
 * mismatch means a third-party site is trying to trigger an action on behalf
 * of a logged-in user.
 *
 * Google OAuth callback is a GET — unaffected.
 * Same-origin fetch calls (from our own UI) always pass because their Origin
 * matches the host the app is running on.
 */
export function proxy(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (isApi) {
    if (
      !request.nextUrl.pathname.startsWith("/api/webhooks/") &&
      !SAFE_METHODS.has(request.method)
    ) {
      const origin = request.headers.get("origin");
      // Session cookies are SameSite=Lax — browsers won't attach them on
      // cross-origin mutations, so CSRF is already blocked at the cookie layer.
      // Only do an explicit host check when the browser sends Origin so we catch
      // any cross-origin request that somehow carries credentials.
      // Absent Origin (same-origin fetch in some browsers/curl) → allow through.
      if (origin) {
        // Prefer X-Forwarded-Host (Fly.io / reverse proxy). Fall back to Host
        // header, stripping port so "localhost:3000" → "localhost".
        const appHost =
          request.headers.get("x-forwarded-host")?.split(",")[0].trim() ??
          request.headers.get("host")?.split(":")[0] ??
          request.nextUrl.hostname;
        try {
          const originHostname = new URL(origin).hostname;
          if (originHostname !== appHost) {
            return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
          }
        } catch {
          return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
        }
      }
    }
    // API responses don't render HTML — no CSP needed.
    return NextResponse.next();
  }

  // Page requests: attach a per-request nonce + CSP.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = cspHeader(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next reads the enforcing CSP header on the request to stamp script nonces.
  requestHeaders.set(csp.name, csp.value);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(csp.name, csp.value);
  return response;
}

export const config = {
  // Run on API routes (CSRF) and all page routes (CSP), but skip Next's static
  // assets, image optimizer, and the favicon — they don't need either.
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
