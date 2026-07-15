import { NextRequest, NextResponse } from "next/server";
import { negotiateLocale } from "@/lib/i18n-negotiate";
import { hasLocale } from "@/lib/i18n-constants";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ISR/CDN-cacheable public surfaces (spec 2026-07-12 P5): nonce CSP forces
// dynamic rendering, so these trees stay Report-Only permanently — flipping
// CSP_MODE=enforce hardens the app surface without un-caching spectator pages.
// Cacheable trees: /shared and /embed. /r (registration-ref tree, /r/[ref]) is
// deliberately excluded because it is force-dynamic and processes self-withdraw
// tokens; excluding it from the carve-out costs no caching but keeps enforce
// active on a token-bearing page.
const CACHEABLE_PUBLIC = /^\/(shared|embed)(\/|$)/;

export function isCacheablePublicPath(pathname: string): boolean {
  return CACHEABLE_PUBLIC.test(pathname);
}

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
function cspHeader(nonce: string, opts: { forceReportOnly?: boolean } = {}): { name: string; value: string } {
  const isDev = process.env.NODE_ENV === "development";
  const enforce = process.env.CSP_MODE === "enforce" && !opts.forceReportOnly;
  const value = [
    `default-src 'self'`,
    // Stripe.js is loaded from js.stripe.com for Embedded Checkout.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind ships an external stylesheet; 'unsafe-inline' covers the small
    // inline styles Next injects. Styles are low-risk vs script injection.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    // Stripe: api.stripe.com for tokenization; supabase + sentry as before.
    `connect-src 'self' https://api.stripe.com https://*.supabase.co wss://*.supabase.co https://*.ingest.sentry.io https://*.sentry.io`,
    // Embedded Checkout renders inside a Stripe-hosted iframe.
    `frame-src 'self' https://js.stripe.com https://*.stripe.com https://hooks.stripe.com`,
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
 * Bare hostname for the request: prefer X-Forwarded-Host (Fly.io / reverse
 * proxy; Next dev also sets it — WITH a port), fall back to Host. Ports are
 * stripped; URL parsing handles IPv6 hosts like "[::1]:3000" correctly.
 */
export function requestHostname(request: NextRequest): string {
  const rawHost =
    request.headers.get("x-forwarded-host")?.split(",")[0].trim() ??
    request.headers.get("host") ??
    request.nextUrl.hostname;
  try {
    return new URL(`http://${rawHost}`).hostname;
  } catch {
    return rawHost.split(":")[0];
  }
}

/**
 * games.* hosts serve the /games route tree: games.seazn.club/ is the games
 * listing, games.seazn.club/<slug> plays a game. Any `games.`-prefixed host
 * matches so staging (games.stg…) and local (games.localhost) work unchanged.
 * Returns the rewritten URL, or null when no rewrite applies.
 *
 * Only "/" and single-segment slug paths ("/chess-quest") rewrite — the games
 * tree has no deeper URLs. Everything else (API, /ingest PostHog proxy,
 * public files like /site.webmanifest or /brand/*, and /games itself — never
 * double-prefix) passes through untouched so shared assets keep working on
 * the subdomain.
 */
const GAMES_SLUG_PATH = /^\/[a-z0-9-]+$/;

export function gamesHostRewrite(request: NextRequest): URL | null {
  if (!requestHostname(request).startsWith("games.")) return null;
  const { pathname } = request.nextUrl;
  if (pathname !== "/" && !GAMES_SLUG_PATH.test(pathname)) return null;
  if (pathname === "/games") return null;
  const url = request.nextUrl.clone();
  url.pathname = pathname === "/" ? "/games" : `/games${pathname}`;
  return url;
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
        const appHost = requestHostname(request);
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
  const cacheable = isCacheablePublicPath(request.nextUrl.pathname);
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = cspHeader(nonce, { forceReportOnly: cacheable });

  const requestHeaders = new Headers(request.headers);
  if (!cacheable) {
    // Nonce request headers make Next stamp scripts per-request; cacheable
    // trees skip them so the HTML stays byte-stable for ISR/CDN.
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set(csp.name, csp.value);
  }

  // v5 i18n (spec §4): resolve the request locale once — explicit cookie pick,
  // else Accept-Language negotiation — and expose it via x-seazn-locale for
  // resolveLocale() to read. A request header only; it doesn't change cached
  // HTML unless a page actually reads it (marketing/public do; the shell does
  // not), so it's safe to set on cacheable trees too.
  const cookieLocale = request.cookies.get("seazn_locale")?.value;
  const locale =
    cookieLocale && hasLocale(cookieLocale)
      ? cookieLocale
      : negotiateLocale(request.headers.get("accept-language"));
  requestHeaders.set("x-seazn-locale", locale);

  // Marketing [lang] routing (spec §5): unprefixed marketing paths rewrite to
  // the locale resolved just above — the explicit cookie pick, else Accept-
  // Language (crawlers with no cookie/en get /en, so English stays canonical).
  // This is what makes the footer language switcher work on "/": it writes the
  // cookie and refreshes, and the rewrite then serves the matching prerender
  // without a visible redirect. Localized URLs like /fr/start are served
  // directly. Extend MARKETING_UNPREFIXED as more marketing pages move under
  // [lang].
  const MARKETING_UNPREFIXED = new Set(["/", "/start", "/pricing", "/scheduling", "/formats"]);
  // Marketing trees with sub-paths (e.g. /use-cases/clubs) — prefix match.
  const MARKETING_PREFIXED = ["/use-cases/"];
  const mp = request.nextUrl.pathname;
  if (MARKETING_UNPREFIXED.has(mp) || MARKETING_PREFIXED.some((pre) => mp.startsWith(pre))) {
    const url = request.nextUrl.clone();
    url.pathname = mp === "/" ? `/${locale}` : `/${locale}${mp}`;
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  const rewriteUrl = gamesHostRewrite(request);
  const response = rewriteUrl
    ? NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(csp.name, csp.value);
  return response;
}

export const config = {
  // Run on API routes (CSRF) and all page routes (CSP), but skip Next's static
  // assets, image optimizer, and the favicon — they don't need either.
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
