import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
  if (
    request.nextUrl.pathname.startsWith("/api/") &&
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
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
