import "server-only";
// Fixture check-in QR tokens (PROMPT-53): stateless HS256 JWTs signed with
// AUTH_SECRET — the QR stays valid until local midnight (device-links day-of
// policy) without a table row. A distinct `typ` keeps a stolen session JWT
// from opening this door and vice versa.
import { SignJWT, jwtVerify } from "jose";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { endOfLocalDay } from "./device-links";

const TYP = "seazn-checkin";

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error("AUTH_SECRET environment variable is required in production");
    return new TextEncoder().encode("dev-insecure-secret-change-me");
  }
  return new TextEncoder().encode(secret);
}

/** Mint a check-in token for a fixture. Caller supplies the expiry (end of
 *  the fixture's local day — reuse endOfLocalDay from device-links). */
export async function mintCheckinToken(fixtureId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ fid: fixtureId })
    .setProtectedHeader({ alg: "HS256", typ: TYP })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey());
}

/**
 * Organiser mint (editor session only, device-links rule): sign a check-in
 * token for the fixture, valid until the end of the fixture's local day
 * (schedule_settings.tz of its division, UTC fallback).
 */
export async function createCheckinLink(
  auth: AuthCtx,
  fixtureId: string,
): Promise<{ token: string; expires_at: string }> {
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Check-in codes can only be managed with a session login");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<{ id: string; division_id: string; status: string }[]>`
      select id, division_id, status from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    if (fixture.status === "finalized" || fixture.status === "cancelled") {
      throw new HttpError(422, `fixture is ${fixture.status} — check-in is closed`);
    }
    const [settings] = await tx<{ tz: string }[]>`
      select tz from schedule_settings where division_id = ${fixture.division_id}`;
    const expiresAt = endOfLocalDay(new Date(), settings?.tz ?? "UTC");
    const token = await mintCheckinToken(fixtureId, expiresAt);
    return { token, expires_at: expiresAt.toISOString() };
  });
}

/** Verify a check-in token → fixture id. Distinct codes: CHECKIN_EXPIRED for
 *  a stale QR (print from yesterday), CHECKIN_INVALID for everything else. */
export async function verifyCheckinToken(token: string): Promise<string> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, secretKey(), {
      typ: TYP,
    });
    if (protectedHeader.typ !== TYP || typeof payload.fid !== "string") {
      throw new Error("wrong token type");
    }
    return payload.fid;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWT_EXPIRED") {
      throw new HttpError(401, "This check-in code has expired — ask the organiser for today's", "CHECKIN_EXPIRED");
    }
    throw new HttpError(401, "This check-in code is not valid", "CHECKIN_INVALID");
  }
}
