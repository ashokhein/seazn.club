// Integration coverage against a REAL Redis (Upstash-compatible protocol) —
// proves the parts the mocked unit test can't: the atomic INCR+EXPIRE Lua runs
// on a live server, the TTL actually expires the window, and rateLimit throws a
// 429 once the cap is crossed. Skipped when REDIS_URL is unset (local dev); CI
// provides a redis:7 service container.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { incrWindow } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { HttpError } from "@/lib/errors";

const HAS_REDIS = !!process.env.REDIS_URL;

// Unique per run so parallel/rerun executions never collide on a key.
const uniq = () => `test:${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_REDIS)("rate limiter (real Redis)", () => {
  // The client uses enableOfflineQueue:false, so a command fired before the
  // socket is 'ready' rejects → incrWindow returns null. A long-lived server
  // warms the singleton once; here we warm it explicitly before asserting.
  beforeAll(async () => {
    for (let i = 0; i < 50; i++) {
      if ((await incrWindow(`warmup:${randomUUID()}`, 5)) !== null) return;
      await sleep(100);
    }
    throw new Error("Redis did not become ready");
  });

  afterAll(async () => {
    // Release the shared ioredis handle so vitest can exit cleanly.
    const g = globalThis as unknown as { _redis?: { quit?: () => Promise<unknown> } };
    await g._redis?.quit?.().catch(() => {});
  });

  it("incrWindow counts up within a window", async () => {
    const key = uniq();
    expect(await incrWindow(key, 60)).toBe(1);
    expect(await incrWindow(key, 60)).toBe(2);
    expect(await incrWindow(key, 60)).toBe(3);
  });

  it("sets a TTL on the first hit so the window self-resets", async () => {
    const key = uniq();
    expect(await incrWindow(key, 1)).toBe(1);
    expect(await incrWindow(key, 1)).toBe(2);
    // Wait past the 1s window — the key should expire and the counter restart.
    await sleep(1200);
    expect(await incrWindow(key, 1)).toBe(1);
  });

  it("rateLimit passes up to max then throws 429", async () => {
    const key = uniq();
    const cfg = { max: 3, windowSeconds: 60 };
    await expect(rateLimit(key, cfg)).resolves.toBeUndefined(); // 1
    await expect(rateLimit(key, cfg)).resolves.toBeUndefined(); // 2
    await expect(rateLimit(key, cfg)).resolves.toBeUndefined(); // 3
    await expect(rateLimit(key, cfg)).rejects.toBeInstanceOf(HttpError); // 4 → 429
  });
});
