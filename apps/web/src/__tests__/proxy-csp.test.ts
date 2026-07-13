import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isCacheablePublicPath } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

const page = (path: string) => new NextRequest(`http://localhost:3000${path}`);

describe("CSP vs cacheable public routes", () => {
  it("classifies the cacheable public tree", () => {
    expect(isCacheablePublicPath("/shared/riverside/summer-league")).toBe(true);
    expect(isCacheablePublicPath("/shared")).toBe(true);
    expect(isCacheablePublicPath("/embed/divisions/x/standings")).toBe(true);
    expect(isCacheablePublicPath("/dashboard")).toBe(false);
    expect(isCacheablePublicPath("/r/AB12CD")).toBe(false); // force-dynamic registration-ref tree excluded
    expect(isCacheablePublicPath("/register")).toBe(false);
    expect(isCacheablePublicPath("/reset-password")).toBe(false);
  });

  it("keeps report-only CSP on cacheable public pages even in enforce mode", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/shared/riverside/summer-league"));
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toContain("default-src 'self'");
  });

  it("enforces on app pages when CSP_MODE=enforce", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/dashboard"));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("skips nonce request headers on cacheable public paths to preserve ISR", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/shared/riverside/summer-league"));
    // x-middleware-override-headers should be null or not contain x-nonce
    const overrideHeaders = res.headers.get("x-middleware-override-headers");
    if (overrideHeaders) {
      expect(overrideHeaders).not.toContain("x-nonce");
    }
    // x-middleware-request-x-nonce should not be forwarded
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
  });

  it("forwards nonce request headers on app pages for per-request CSP stamping", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/dashboard"));
    // x-middleware-request-x-nonce should be forwarded (non-empty string)
    const nonceHeader = res.headers.get("x-middleware-request-x-nonce");
    expect(nonceHeader).toBeTruthy();
    expect(typeof nonceHeader).toBe("string");
  });
});
