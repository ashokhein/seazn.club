// Guards the upgrade flow's failure path: a non-ok /api/billing/checkout
// response must yield a display error (which the button shows) rather than a
// resolved secret — otherwise <EmbeddedCheckout> hangs on its loading spinner
// forever, the "checkout is loading" bug.
import { describe, expect, it, vi } from "vitest";
import {
  fetchCheckoutClientSecret,
  fetchPassCheckoutClientSecret,
} from "@/lib/billing-checkout-client";

function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe("fetchCheckoutClientSecret", () => {
  it("returns the client_secret on a successful checkout", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { client_secret: "cs_test_123" } }),
    );
    const r = await fetchCheckoutClientSecret("pro", "monthly", fetchFn as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, clientSecret: "cs_test_123" });
    expect(fetchFn).toHaveBeenCalledWith("/api/billing/checkout", expect.objectContaining({ method: "POST" }));
  });

  it("surfaces the server error (e.g. billing not configured) instead of hanging", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        { ok: false, error: "Billing is not yet configured. Please contact support." },
        503,
      ),
    );
    const r = await fetchCheckoutClientSecret("pro", "monthly", fetchFn as unknown as typeof fetch);
    expect(r).toEqual({
      ok: false,
      error: "Billing is not yet configured. Please contact support.",
      status: 503,
    });
  });

  it("falls back to a generic error when the body has no client_secret", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: {} }));
    const r = await fetchCheckoutClientSecret("pro", "annual", fetchFn as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unavailable/i);
  });

  it("does not throw when fetch rejects — returns a display error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network"));
    const r = await fetchCheckoutClientSecret("pro", "monthly", fetchFn as unknown as typeof fetch);
    expect(r.ok).toBe(false);
  });

  it("posts plan_key \"pro_plus\" when told to check out into Pro Plus", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { client_secret: "cs_test_plus" } }),
    );
    const r = await fetchCheckoutClientSecret("pro_plus", "annual", fetchFn as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, clientSecret: "cs_test_plus" });
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ plan_key: "pro_plus", interval: "annual" });
  });
});

// v17 #294 — the Event Pass ships at two rungs (M 'event_pass', L
// 'event_pass_l'). The rung the buyer picked has to survive the trip to
// /api/billing/pass-checkout, because the server prices the session from
// `plans.stripe_price_id_onetime` looked up by exactly this key: a dropped
// pass_key silently sells L's caps at M's price.
describe("fetchPassCheckoutClientSecret", () => {
  it("posts pass_key \"event_pass_l\" when told to check out into the L rung", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { client_secret: "cs_test_l" } }),
    );
    const r = await fetchPassCheckoutClientSecret(
      "comp-1",
      "event_pass_l",
      fetchFn as unknown as typeof fetch,
    );
    expect(r).toEqual({ ok: true, clientSecret: "cs_test_l" });
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/billing/pass-checkout",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    // Scalar first, deliberately: `toEqual` on the whole object serialises to
    // "expected { competition_id: 'comp-1', …(1) } to deeply equal { … }" and
    // ELIDES the rung — the one value this test exists to protect. The scalar
    // assertion fires first and prints "expected 'event_pass' to be
    // 'event_pass_l'", i.e. names the mis-sale.
    expect(body.pass_key).toBe("event_pass_l");
    // Whole-body guard kept for the other direction: the route's schema is
    // `.strict()`, so an extra key added here would 400 every purchase.
    expect(body).toEqual({ competition_id: "comp-1", pass_key: "event_pass_l" });
  });

  // The M half of the same claim. `passKey` is REQUIRED (no default), so
  // "forgot to say which rung" is a COMPILE error and has no runtime test to
  // write — naming M gets M, which is what makes the L case above proof of a
  // ROUTED value rather than of a constant.
  it("posts pass_key \"event_pass\" when M is the rung named", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { client_secret: "cs_test_m" } }),
    );
    await fetchPassCheckoutClientSecret(
      "comp-1",
      "event_pass",
      fetchFn as unknown as typeof fetch,
    );
    // Guarded before the destructure below so a helper that ignores the
    // third-position fetchFn reds as "called 0 times", not as a TypeError.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.pass_key).toBe("event_pass");
    expect(body).toEqual({ competition_id: "comp-1", pass_key: "event_pass" });
  });

  // 503 is the EXPECTED state of a rung whose price id has not been written back
  // by `stripe:sync` in this environment — not a bug, and not the same thing as
  // "checkout is broken". Both halves of that distinction have to survive this
  // helper: the STATUS, which is what the localised picker renders from, and
  // the server's own words, which are what an operator reads in a log. The
  // generic FALLBACK_ERROR would tell them to retry forever instead of to run
  // the sync.
  it("surfaces the server's 503 when a rung has no synced price, not the generic error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        { ok: false, error: "Billing is not yet configured. Please contact support." },
        503,
      ),
    );
    const r = await fetchPassCheckoutClientSecret(
      "comp-1",
      "event_pass_l",
      fetchFn as unknown as typeof fetch,
    );
    // Same reason as the scalar assertion above: comparing the whole result
    // object prints "{ ok: false, …(1) } to deeply equal { ok: false, …(1) }"
    // and hides WHICH error came back — which is the entire distinction being
    // made here. `expect(r.ok)` first so the narrowing below can never be
    // skipped silently.
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Billing is not yet configured. Please contact support.");
      // The STATUS is what a localised surface renders from — the message above
      // is English-only, so a buyer never sees it (lib/pass-ladder.ts's
      // passCheckoutErrorKey). Losing the status downgrades a precise "try the
      // other size" into "something went wrong".
      expect(r.status).toBe(503);
    }
  });

  // A rung this build knows but the SERVER does not (stale deploy, renamed key)
  // is the route's zod `.strict()` 400 — a distinct outcome from the 503 above,
  // and equally the server's words rather than ours.
  it("surfaces the server's 400 for a pass_key the route rejects", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: "Invalid input", issues: [] }, 400),
    );
    const r = await fetchPassCheckoutClientSecret(
      "comp-1",
      "event_pass_l",
      fetchFn as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Invalid input");
      expect(r.status).toBe(400);
    }
  });

  it("reports no status at all when the request never got a response", async () => {
    // A rejected fetch is not a 500: nothing was refused, nothing was reached.
    // `null` is what keeps that distinguishable from a server error.
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    const r = await fetchPassCheckoutClientSecret(
      "comp-1",
      "event_pass_l",
      fetchFn as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBeNull();
  });
});
