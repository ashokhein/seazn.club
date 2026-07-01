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
    if (!origin) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    // Use X-Forwarded-Host when behind a reverse proxy (Fly.io, Vercel, etc.)
    // so the comparison is against the public hostname, not the internal port.
    const appHost =
      request.headers.get("x-forwarded-host") ?? request.nextUrl.hostname;
    try {
      const originHostname = new URL(origin).hostname;
      if (originHostname !== appHost) {
        return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
