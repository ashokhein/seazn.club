import "server-only";
import { SignJWT } from "jose";

export type RealtimeReason = "result" | "undo" | "reset" | "start" | "checkin" | "players";

export interface RealtimeTournamentEvent {
  v: number;   // Date.now() — monotonic enough without DB column
  reason: RealtimeReason;
  at: string;
}

/**
 * Broadcast a lightweight state_changed event after a tournament mutation.
 * Fire-and-forget — never throws; a failed broadcast does not roll back results.
 */
export async function publishTournamentUpdate(
  tournamentId: string,
  reason: RealtimeReason,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return; // env not configured → skip silently

  const payload: RealtimeTournamentEvent = {
    v: Date.now(),
    reason,
    at: new Date().toISOString(),
  };

  try {
    // Supabase Realtime broadcast via REST API (no WS connection on serverless)
    const res = await fetch(
      `${url}/realtime/v1/api/broadcast`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          apikey: key,
        },
        body: JSON.stringify({
          messages: [
            {
              topic: `tournament:${tournamentId}`,
              event: "state_changed",
              payload,
            },
          ],
        }),
      },
    );
    if (!res.ok) {
      console.warn(`[realtime] broadcast failed (${res.status}) for ${tournamentId}`);
    }
  } catch (err) {
    console.warn("[realtime] broadcast error:", err);
  }
}

/**
 * Broadcast a state_changed event on `fixture:{id}` after a v2 scoring write
 * (doc 08 §4 — publish after commit). Same transport as tournaments; fire-and-
 * forget, never throws.
 */
export async function publishFixtureUpdate(
  fixtureId: string,
  reason: "event" | "finalize" | "schedule",
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `fixture:${fixtureId}`,
            event: "state_changed",
            payload: { v: Date.now(), reason, at: new Date().toISOString() },
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[realtime] fixture broadcast failed (${res.status}) for ${fixtureId}`);
    }
  } catch (err) {
    console.warn("[realtime] fixture broadcast error:", err);
  }
}

/**
 * Mint a short-lived JWT for Supabase Realtime subscriber auth.
 * Signed with SUPABASE_JWT_SECRET (same secret Supabase uses for its own JWTs).
 */
/**
 * Mint a subscriber JWT for a PUBLIC fixture channel (doc 09 §4). No user —
 * spectators are anonymous; entitlement (org `realtime` feature) is checked by
 * the route before minting. Short TTL: a spectator page re-requests freely.
 */
export async function mintPublicFixtureToken(
  fixtureId: string,
  ttlSeconds = 3600,
): Promise<string> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET not set");
  return new SignJWT({
    role: "authenticated",
    sub: `public:${fixtureId}`,
    fixture_id: fixtureId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setAudience("authenticated")
    .sign(new TextEncoder().encode(secret));
}

export async function mintRealtimeToken(
  userId: string,
  tournamentId: string,
  ttlSeconds = 3600,
): Promise<string> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET not set");

  return new SignJWT({
    role: "authenticated",
    sub: userId,
    tournament_id: tournamentId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setAudience("authenticated")
    .sign(new TextEncoder().encode(secret));
}
