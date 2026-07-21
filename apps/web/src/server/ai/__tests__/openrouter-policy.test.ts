import { describe, it, expect } from "vitest";
import { applyPolicy, ALLOWED_PROVIDERS } from "../openrouter-policy";

describe("openrouter data policy", () => {
  it("denies data collection and pins zero retention", () => {
    const body = applyPolicy({ model: "vendor/model" });
    expect(body.provider.data_collection).toBe("deny");
    expect(body.zdr).toBe(true);
  });

  it("restricts routing to the allowlist and forbids fallbacks", () => {
    // allow_fallbacks defaults true upstream; without this, routing can leave
    // the allowlist and the customer promise silently stops holding.
    const body = applyPolicy({ model: "vendor/model" });
    expect(body.provider.only).toEqual(ALLOWED_PROVIDERS);
    expect(body.provider.allow_fallbacks).toBe(false);
  });

  it("cannot be overridden by the caller", () => {
    const body = applyPolicy({
      model: "vendor/model",
      provider: { data_collection: "allow", allow_fallbacks: true },
      zdr: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(body.provider.data_collection).toBe("deny");
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.zdr).toBe(true);
  });

  it("keeps a non-empty allowlist", () => {
    expect(ALLOWED_PROVIDERS.length).toBeGreaterThan(0);
  });
});
