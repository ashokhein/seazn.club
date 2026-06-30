import "server-only";

export const OAUTH_STATE_COOKIE = "safe_oauth_state";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

/** True when Google OAuth env vars are present. */
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * The app's external base URL. Prefers an explicit override so the redirect URI
 * always matches what is registered in the Google Cloud console; otherwise it
 * is derived from the incoming request's origin.
 */
export function baseUrl(req: Request): string {
  const override =
    process.env.OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (override) return override.replace(/\/$/, "");
  return new URL(req.url).origin;
}

/** The Google redirect URI (must be registered in the Google console). */
export function googleRedirectUri(req: Request): string {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl(req)}/api/auth/google/callback`;
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
}
