import "server-only";
// Per-request context for the /api/v1 kernel. AsyncLocalStorage lets the auth
// layer (deep in the call tree) hand the rate-limit counters back to the HTTP
// wrapper so every response — success or 429 — carries X-RateLimit-* headers
// (v3/08 §2) without threading a response object through the use-cases.
import { AsyncLocalStorage } from "node:async_hooks";

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  /** Unix epoch seconds when the current window resets. */
  reset: number;
}

interface V1Store {
  rateLimit?: RateLimitInfo;
}

const als = new AsyncLocalStorage<V1Store>();

export function runV1Context<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({}, fn);
}

export function setRateLimitInfo(info: RateLimitInfo): void {
  const store = als.getStore();
  if (store) store.rateLimit = info;
}

export function rateLimitHeaders(): Record<string, string> | undefined {
  const info = als.getStore()?.rateLimit;
  if (!info) return undefined;
  return {
    "X-RateLimit-Limit": String(info.limit),
    "X-RateLimit-Remaining": String(Math.max(0, info.remaining)),
    "X-RateLimit-Reset": String(info.reset),
  };
}
