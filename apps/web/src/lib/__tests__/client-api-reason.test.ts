// A 402 upgrade error carries a human `reason` (feature-copy) next to the raw
// `error`, which is the developer string leaking the internal feature key. The
// client `api()` helper must surface the reason, so a form shows the sentence
// ("Your current plan covers the most organisations it allows…"), not
// "Plan upgrade required: orgs.max_owned".
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

function mockResponse(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("api() error message", () => {
  it("throws the human reason on a 402, not the raw feature-key message", async () => {
    mockResponse(402, {
      ok: false,
      error: "Plan upgrade required: orgs.max_owned",
      feature_key: "orgs.max_owned",
      reason: "Your current plan covers the most organisations it allows.",
    });
    await expect(api("/api/orgs", { method: "POST", json: { name: "X" } })).rejects.toThrow(
      "Your current plan covers the most organisations it allows.",
    );
  });

  it("falls back to `error` when there is no reason", async () => {
    mockResponse(409, { ok: false, error: "already exists" });
    await expect(api("/x", { method: "POST" })).rejects.toThrow("already exists");
  });

  it("returns data on success", async () => {
    mockResponse(200, { ok: true, data: { id: "org_1" } });
    await expect(api<{ id: string }>("/x")).resolves.toEqual({ id: "org_1" });
  });
});
