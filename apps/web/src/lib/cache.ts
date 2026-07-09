import "server-only";
import Redis from "ioredis";

/**
 * Redis (Upstash) client + cache-aside helpers (doc 02 §5.3, doc 05 §8).
 *
 * Everything here is **fail-open**: if REDIS_URL is unset or Redis is
 * unreachable, cache reads miss and writes no-op, so the app falls back to
 * Postgres. Redis is a latency optimisation, never a correctness dependency.
 */
const globalForRedis = globalThis as unknown as { _redis?: Redis | null };

function client(): Redis | null {
  if (globalForRedis._redis !== undefined) return globalForRedis._redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    globalForRedis._redis = null;
    return null;
  }
  const redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // Don't let a Redis outage crash the process; we fail open per call.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on("error", () => {
    /* swallow — callers handle null/misses */
  });
  globalForRedis._redis = redis;
  return redis;
}

/** True when a Redis URL is configured (cache is active). */
export function cacheEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/** Get + JSON-parse a cached value, or null on miss/error. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const c = client();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** JSON-serialise + set with a TTL (seconds). No-op on error. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* fail open */
  }
}

/** Delete keys matching a glob pattern (e.g. "ent:{org}:*"). No-op on error. */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    const stream = c.scanStream({ match: pattern, count: 100 });
    const pipeline = c.pipeline();
    let any = false;
    for await (const keys of stream as AsyncIterable<string[]>) {
      for (const k of keys) {
        pipeline.del(k);
        any = true;
      }
    }
    if (any) await pipeline.exec();
  } catch {
    /* fail open */
  }
}

// INCR + set-TTL-on-first-hit as one atomic server-side step. Done as a single
// Lua EVAL rather than INCR then EXPIRE so (a) a crash/error can't strand a key
// with no TTL — which would lock that identifier out forever — and (b) it bills
// as one Upstash command instead of two on pay-as-you-go.
const INCR_WINDOW_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * Fixed-window counter. Returns the new count for `key` within the window, or
 * null if Redis is unavailable (caller decides the fallback policy). The TTL is
 * set atomically on the first increment of a window.
 */
export async function incrWindow(key: string, windowSeconds: number): Promise<number | null> {
  const c = client();
  if (!c) return null;
  try {
    const n = await c.eval(INCR_WINDOW_LUA, 1, key, String(windowSeconds));
    return Number(n);
  } catch {
    return null;
  }
}
