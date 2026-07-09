import "server-only";
import { HttpError } from "@/lib/errors";
import { incrWindow } from "@/lib/cache";

export interface RateLimitConfig {
  /** Max requests allowed within `windowSeconds`. */
  max: number;
  /** Window size in seconds. */
  windowSeconds: number;
  /**
   * Behaviour when Redis is unavailable (an Upstash blip). Redis is the sole
   * backend — there is no Postgres fallback — so this decides the tradeoff:
   * `true` → deny with 429 (abuse-protection first), `false`/omitted → allow
   * (availability first). Default is fail-open.
   */
  failClosed?: boolean;
}

const TOO_MANY = "Too many requests — slow down and try again.";

/**
 * Fixed-window rate limiter backed solely by Upstash (managed Redis).
 * Each `key` gets up to `max` requests per `windowSeconds`; excess requests get
 * a 429 HttpError thrown.
 *
 * Key format convention: `"route:identifier"` — e.g. `"login:1.2.3.4"`.
 *
 * There is deliberately no Postgres fallback: the old DB bucket serialised on a
 * single hot row under load. Upstash owns the counter (one atomic INCR+EXPIRE,
 * self-expiring keys). When Redis is momentarily unreachable `incrWindow`
 * returns null and we apply the `failClosed` policy.
 */
export async function rateLimit(
  key: string,
  { max, windowSeconds, failClosed = false }: RateLimitConfig,
): Promise<void> {
  const count = await incrWindow(`rl:${key}`, windowSeconds);

  if (count === null) {
    // Redis unavailable — no fallback backend. Apply the per-limit policy.
    if (failClosed) throw new HttpError(429, TOO_MANY);
    return;
  }

  if (count > max) {
    throw new HttpError(429, TOO_MANY);
  }
}

// ─── Pre-configured limits ────────────────────────────────────────────────────

/**
 * Auth endpoints: login, signup, forgot-password. Fail-closed — a limiter
 * outage must not open a credential-stuffing window.
 */
export const AUTH_LIMIT: RateLimitConfig = { max: 10, windowSeconds: 60, failClosed: true };

/**
 * Email-sending endpoints: verify, change-email, invite. Fail-closed — protects
 * against mail-bombing while Redis is down.
 */
export const EMAIL_LIMIT: RateLimitConfig = { max: 5, windowSeconds: 300, failClosed: true };

/** Webhook endpoints (Stripe, Resend) — generous since legitimate traffic is high volume. */
export const WEBHOOK_LIMIT: RateLimitConfig = { max: 500, windowSeconds: 60 };

/** General mutation endpoints: tournament result writes. */
export const MUTATION_LIMIT: RateLimitConfig = { max: 60, windowSeconds: 60 };
