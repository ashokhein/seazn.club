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
 * Mint a short-lived JWT for Supabase Realtime subscriber auth.
 * Signed with SUPABASE_JWT_SECRET (same secret Supabase uses for its own JWTs).
 */
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
