// PROMPT-53 check-in token lifecycle: round-trip, expiry, tamper resistance,
// and the typ gate (a session JWT must never open the check-in door). Pure —
// no DB needed.
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { mintCheckinToken, verifyCheckinToken } from "../checkin-token";

const FIXTURE = "3b1a8dc4-9f10-4d5e-b0c7-0e6f6a2f9a11";

describe("check-in tokens (PROMPT-53)", () => {
  it("round-trips the fixture id", async () => {
    const token = await mintCheckinToken(FIXTURE, new Date(Date.now() + 60_000));
    await expect(verifyCheckinToken(token)).resolves.toBe(FIXTURE);
  });

  it("expired → 401 CHECKIN_EXPIRED", async () => {
    const token = await mintCheckinToken(FIXTURE, new Date(Date.now() - 1_000));
    await expect(verifyCheckinToken(token)).rejects.toMatchObject({
      status: 401,
      code: "CHECKIN_EXPIRED",
    });
  });

  it("tampered or garbage → CHECKIN_INVALID", async () => {
    const token = await mintCheckinToken(FIXTURE, new Date(Date.now() + 60_000));
    await expect(verifyCheckinToken(token.slice(0, -4) + "AAAA")).rejects.toMatchObject({
      code: "CHECKIN_INVALID",
    });
    await expect(verifyCheckinToken("not-a-jwt")).rejects.toMatchObject({
      code: "CHECKIN_INVALID",
    });
  });

  it("a session-shaped JWT (no typ) is rejected", async () => {
    const key = new TextEncoder().encode("dev-insecure-secret-change-me");
    const sessionish = await new SignJWT({ uid: "someone", fid: FIXTURE })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(key);
    await expect(verifyCheckinToken(sessionish)).rejects.toMatchObject({
      code: "CHECKIN_INVALID",
    });
  });
});
