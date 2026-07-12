import { describe, expect, it } from "vitest";
// next.config.js is wrapped in withSentryConfig for the default export; the
// pre-wrap object is re-exported by name so this test (and anything else that
// needs the raw Next config) doesn't depend on Sentry's wrapper shape.
import { nextConfig } from "../../../next.config.js";

describe("next/image remotePatterns", () => {
  it("allows the Supabase storage public-object path and nothing broader", () => {
    const patterns =
      (nextConfig as { images?: { remotePatterns?: unknown[] } }).images?.remotePatterns ?? [];
    // Exactly one entry — "nothing broader" only holds if broadening (a second
    // pattern, or widening this one) can't sneak in unnoticed (review finding 2).
    expect(patterns).toHaveLength(1);
    expect(patterns).toContainEqual(
      expect.objectContaining({
        protocol: "https",
        hostname: expect.stringContaining("supabase.co"),
        pathname: "/storage/v1/object/public/**",
      }),
    );
  });
});
