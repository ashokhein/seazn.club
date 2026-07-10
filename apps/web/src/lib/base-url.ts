import "server-only";
// RSC-side twin of oauth.ts baseUrl(req): pages have no Request, so read the
// forwarded headers via next/headers. Same override order.
import { headers } from "next/headers";

export async function baseUrlFromHeaders(): Promise<string> {
  const override = process.env.OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (override) return override.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
