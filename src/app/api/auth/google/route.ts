import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  GOOGLE_AUTH_URL,
  OAUTH_STATE_COOKIE,
  googleConfigured,
  googleRedirectUri,
} from "@/lib/oauth";

/** Start the Google OAuth2 sign-in flow (redirects to Google's consent page). */
export async function GET(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.redirect(
      new URL("/login?error=google_not_configured", req.url),
    );
  }

  const state = crypto.randomUUID();
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  // Preserve a post-login destination (e.g. an invite link) across the redirect.
  const next = new URL(req.url).searchParams.get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    jar.set("safe_oauth_next", next, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600,
    });
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID as string,
    redirect_uri: googleRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });

  return NextResponse.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
}
