// The Stripe fixture server used by the billing-group suites (#313): three of
// those suites used to hard-code the SAME literal port, so a full parallel run
// collided with EADDRINUSE / hook timeouts that read like real product
// failures. This proves the fix at the source: two servers started with no
// port argument bind DIFFERENT ephemeral ports and can run side by side.
import { describe, expect, it } from "vitest";
import { startStripeFixtureServer } from "../../../../e2e/stripe-fixture-server";

describe("startStripeFixtureServer", () => {
  it("binds an ephemeral port and reports it, so two servers can coexist (#313)", async () => {
    const a = await startStripeFixtureServer();
    const b = await startStripeFixtureServer();
    try {
      expect(a.port).toBeGreaterThan(0);
      expect(b.port).toBeGreaterThan(0);
      expect(a.port).not.toBe(b.port);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
