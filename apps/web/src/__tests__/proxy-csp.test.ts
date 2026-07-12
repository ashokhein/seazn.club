import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isCacheablePublicPath } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

const page = (path: string) => new NextRequest(`http://localhost:3000${path}`);

describe("CSP vs cacheable public routes", () => {
  it("classifies the cacheable public tree", () => {
    expect(isCacheablePublicPath("/shared/riverside/summer-league")).toBe(true);
    expect(isCacheablePublicPath("/embed/divisions/x/standings")).toBe(true);
    expect(isCacheablePublicPath("/r/AB12CD")).toBe(true);
    expect(isCacheablePublicPath("/dashboard")).toBe(false);
    expect(isCacheablePublicPath("/register")).toBe(false); // /r prefix must not over-match
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
});
