// Guards the upgrade flow's failure path: a non-ok /api/billing/checkout
// response must yield a display error (which the button shows) rather than a
// resolved secret — otherwise <EmbeddedCheckout> hangs on its loading spinner
// forever, the "checkout is loading" bug.
import { describe, expect, it, vi } from "vitest";
import { fetchCheckoutClientSecret } from "@/lib/billing-checkout-client";

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe("fetchCheckoutClientSecret", () => {
  it("returns the client_secret on a successful checkout", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { client_secret: "cs_test_123" } }),
    );
    const r = await fetchCheckoutClientSecret("monthly", fetchFn as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, clientSecret: "cs_test_123" });
    expect(fetchFn).toHaveBeenCalledWith("/api/billing/checkout", expect.objectContaining({ method: "POST" }));
  });

  it("surfaces the server error (e.g. billing not configured) instead of hanging", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: "Billing is not yet configured. Please contact support." }),
    );
    const r = await fetchCheckoutClientSecret("monthly", fetchFn as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, error: "Billing is not yet configured. Please contact support." });
  });

  it("falls back to a generic error when the body has no client_secret", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: {} }));
    const r = await fetchCheckoutClientSecret("annual", fetchFn as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unavailable/i);
  });

  it("does not throw when fetch rejects — returns a display error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network"));
    const r = await fetchCheckoutClientSecret("monthly", fetchFn as unknown as typeof fetch);
    expect(r.ok).toBe(false);
  });
});
