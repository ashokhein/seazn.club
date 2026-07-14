import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createSession, postAuthLanding, invalidateUser } from "@/lib/auth";
import { stampTermsAcceptance } from "@/lib/legal";
import {
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  OAUTH_STATE_COOKIE,
  baseUrl,
  googleConfigured,
  googleRedirectUri,
  type GoogleProfile,
} from "@/lib/oauth";

// Redirect against the external base URL, not req.url — behind Fly's proxy
// req.url is the internal binding (http://0.0.0.0:3000), which would send the
// browser to an unreachable address.
function fail(req: Request, reason: string) {
  return NextResponse.redirect(new URL(`/login?error=${reason}`, baseUrl(req)));
}

/** Handle Google's redirect: verify state, exchange code, upsert user, sign in. */
export async function GET(req: Request) {
  if (!googleConfigured()) return fail(req, "google_not_configured");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return fail(req, "oauth_state");
  }

  // 1. Exchange the authorization code for tokens.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: googleRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail(req, "oauth_token");
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return fail(req, "oauth_token");

  // 2. Fetch the user's profile.
  const infoRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) return fail(req, "oauth_userinfo");
  const profile = (await infoRes.json()) as Partial<GoogleProfile>;
  if (!profile.sub || !profile.email) return fail(req, "oauth_userinfo");

  // 3. Resolve to a user: by google_sub, then by email, else create one.
  const userId = await upsertGoogleUser(profile as GoogleProfile);
  // upsert may refresh display_name/avatar for an existing user.
  await invalidateUser(userId);
  // "Continue with Google" sits under the clickwrap notice (GDPR spec
  // 2026-07-14) — record acceptance; no-op if already stamped.
  await stampTermsAcceptance(userId);

  // 4. Sign in.
  await createSession(userId);

  // 5. Honor a saved destination (invite link); otherwise ensure the user has
  //    an org (auto-provisioned if none) and land on the dashboard.
  const next = jar.get("seazn_oauth_next")?.value;
  jar.delete("seazn_oauth_next");
  const landing = await postAuthLanding(userId, next);
  return NextResponse.redirect(new URL(landing.redirect, baseUrl(req)));
}

async function upsertGoogleUser(p: GoogleProfile): Promise<string> {
  const bySub = await sql<{ id: string }[]>`
    select id from users where google_sub = ${p.sub} limit 1`;
  if (bySub[0]) {
    // Refresh display name / avatar opportunistically.
    await sql`
      update users set
        display_name = coalesce(${p.name ?? null}, display_name),
        avatar_url   = coalesce(${p.picture ?? null}, avatar_url)
      where id = ${bySub[0].id}`;
    return bySub[0].id;
  }

  // Guaranteed non-null by the caller; narrow for TypeScript.
  if (!p.email) throw new Error("Google profile is missing an email");

  const byEmail = await sql<{ id: string }[]>`
    select id from users where email = ${p.email} limit 1`;
  if (byEmail[0]) {
    // Google verified the email, so trust it here too.
    await sql`
      update users set
        google_sub = ${p.sub},
        email_verified = true,
        avatar_url = coalesce(${p.picture ?? null}, avatar_url)
      where id = ${byEmail[0].id}`;
    return byEmail[0].id;
  }

  const displayName = p.name || p.email.split("@")[0] || "Member";
  const [created] = await sql<{ id: string }[]>`
    insert into users
      (email, display_name, email_verified, google_sub, avatar_url)
    values (
      ${p.email},
      ${displayName},
      true,
      ${p.sub},
      ${p.picture ?? null}
    )
    returning id`;
  return created.id;
}
