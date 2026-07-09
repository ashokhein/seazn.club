// Regression: the public fixture endpoints respond `{ ok, data: ... }` and
// api() unwraps `.data` once. The old LiveScore code unwrapped twice, so
// polling replaced the scoreboard with `undefined` and the realtime-token
// flow threw "Cannot read properties of undefined (reading 'token')".
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLiveFixture, fetchPublicRealtimeToken } from "../live-score-data";

function stubFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => payload,
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchLiveFixture", () => {
  it("returns the fixture itself, not a wrapper with a .data property", async () => {
    const fixture = { status: "in_play", summary: { headline: "1 — 0" }, outcome: null };
    stubFetch({ ok: true, data: fixture });
    const res = await fetchLiveFixture("fx-1");
    expect(res.status).toBe("in_play");
    expect(res).not.toHaveProperty("data");
  });

  it("throws on error payloads instead of resolving undefined", async () => {
    stubFetch({ ok: false, error: "not found" }, false, 404);
    await expect(fetchLiveFixture("fx-1")).rejects.toThrow("not found");
  });
});

describe("fetchPublicRealtimeToken", () => {
  it("returns token + channel directly", async () => {
    stubFetch({ ok: true, data: { token: "jwt", channel: "fixture:fx-1" } });
    const res = await fetchPublicRealtimeToken("fx-1");
    expect(res.token).toBe("jwt");
    expect(res.channel).toBe("fixture:fx-1");
  });

  it("throws when the org is not entitled (403)", async () => {
    stubFetch({ ok: false, error: "payment required" }, false, 403);
    await expect(fetchPublicRealtimeToken("fx-1")).rejects.toThrow("payment required");
  });
});
