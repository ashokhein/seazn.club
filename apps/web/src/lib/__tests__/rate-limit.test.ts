// Unit coverage for the Upstash-only rate limiter (lib/rate-limit.ts): under
// the cap passes, over the cap throws 429, and when Redis is unavailable
// (incrWindow → null) the failClosed policy decides deny-vs-allow. No DB: the
// Postgres fallback was removed, so incrWindow is the only backend and we mock
// it directly.
import { afterEach, describe, expect, it, vi } from "vitest";

const cacheMock = vi.hoisted(() => ({ incrWindow: vi.fn(), cacheEnabled: vi.fn(() => true) }));
vi.mock("@/lib/cache", () => ({
  incrWindow: cacheMock.incrWindow,
  cacheEnabled: cacheMock.cacheEnabled,
}));

import { HttpError } from "@/lib/errors";
import {
  rateLimit,
  AUTH_LIMIT,
  EMAIL_LIMIT,
  WEBHOOK_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/rate-limit";

const CFG = { max: 3, windowSeconds: 60 };

afterEach(() => {
  cacheMock.incrWindow.mockReset();
  cacheMock.cacheEnabled.mockReset();
  cacheMock.cacheEnabled.mockReturnValue(true); // Redis configured by default
});

describe("rateLimit (Upstash-only)", () => {
  it("passes when the count is within the cap", async () => {
    cacheMock.incrWindow.mockResolvedValue(3);
    await expect(rateLimit("login:1.2.3.4", CFG)).resolves.toBeUndefined();
  });

  it("throws 429 once the count exceeds the cap", async () => {
    cacheMock.incrWindow.mockResolvedValue(4);
    await expect(rateLimit("login:1.2.3.4", CFG)).rejects.toMatchObject(
      new HttpError(429, "Too many requests — slow down and try again."),
    );
  });

  it("prefixes the key with rl: and forwards the window", async () => {
    cacheMock.incrWindow.mockResolvedValue(1);
    await rateLimit("login:1.2.3.4", CFG);
    expect(cacheMock.incrWindow).toHaveBeenCalledWith("rl:login:1.2.3.4", 60);
  });

  describe("when Redis is configured but unreachable (incrWindow → null)", () => {
    it("fails open by default — allows the request", async () => {
      cacheMock.incrWindow.mockResolvedValue(null);
      await expect(rateLimit("pub:1.2.3.4", CFG)).resolves.toBeUndefined();
    });

    it("fails closed when configured — throws 429", async () => {
      cacheMock.incrWindow.mockResolvedValue(null);
      cacheMock.cacheEnabled.mockReturnValue(true);
      await expect(
        rateLimit("login:1.2.3.4", { ...CFG, failClosed: true }),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("when Redis is not configured at all (local dev / e2e)", () => {
    it("is inert — allows even a failClosed limit so auth flows work", async () => {
      cacheMock.incrWindow.mockResolvedValue(null);
      cacheMock.cacheEnabled.mockReturnValue(false);
      await expect(
        rateLimit("login:1.2.3.4", { ...CFG, failClosed: true }),
      ).resolves.toBeUndefined();
    });
  });

  describe("preset policies", () => {
    it("auth + email fail closed (abuse-sensitive)", () => {
      expect(AUTH_LIMIT.failClosed).toBe(true);
      expect(EMAIL_LIMIT.failClosed).toBe(true);
    });

    it("webhook + mutation fail open (availability first)", () => {
      expect(WEBHOOK_LIMIT.failClosed).toBeUndefined();
      expect(MUTATION_LIMIT.failClosed).toBeUndefined();
    });
  });
});
