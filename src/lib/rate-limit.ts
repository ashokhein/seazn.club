import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";

export interface RateLimitConfig {
  /** Max requests allowed within `windowSeconds`. */
  max: number;
  /** Window size in seconds. */
  windowSeconds: number;
}

/**
 * Sliding fixed-window rate limiter backed by Postgres.
 * Each `key` gets up to `max` requests per `windowSeconds`.
 * Excess requests get a 429 HttpError thrown.
 *
 * Key format convention: `"route:identifier"` — e.g. `"login:1.2.3.4"`.
 *
 * This is intentionally simple — no Redis required. Under high load the DB
 * write contention on a single key is the bottleneck; upgrade to Upstash when
 * p95 latency becomes a concern.
 */
export async function rateLimit(
  key: string,
  { max, windowSeconds }: RateLimitConfig,
): Promise<void> {
  const now = new Date();
  const windowStart = new Date(
    Math.floor(now.getTime() / (windowSeconds * 1000)) * (windowSeconds * 1000),
  );
  const windowStartIso = windowStart.toISOString();

  // Upsert + fetch count atomically
  const [row] = await sql<{ count: number }[]>`
    insert into rate_limit_buckets (key, window_start, count)
    values (${key}, ${windowStartIso}, 1)
    on conflict (key, window_start)
    do update set count = rate_limit_buckets.count + 1
    returning count`;

  // Amortised cleanup: delete rows older than 2 windows (no separate cron needed)
  const cutoff = new Date(now.getTime() - windowSeconds * 2 * 1000).toISOString();
  void sql`delete from rate_limit_buckets where key = ${key} and window_start < ${cutoff}`.catch(
    () => null,
  );

  if (row && row.count > max) {
    throw new HttpError(429, "Too many requests — slow down and try again.");
  }
}

// ─── Pre-configured limits ────────────────────────────────────────────────────

/** Auth endpoints: login, signup, forgot-password. */
export const AUTH_LIMIT: RateLimitConfig = { max: 10, windowSeconds: 60 };

/** Email-sending endpoints: verify, change-email, invite. */
export const EMAIL_LIMIT: RateLimitConfig = { max: 5, windowSeconds: 300 };

/** Webhook endpoints (Stripe, Resend) — generous since legitimate traffic is high volume. */
export const WEBHOOK_LIMIT: RateLimitConfig = { max: 500, windowSeconds: 60 };

/** General mutation endpoints: tournament result writes. */
export const MUTATION_LIMIT: RateLimitConfig = { max: 60, windowSeconds: 60 };
