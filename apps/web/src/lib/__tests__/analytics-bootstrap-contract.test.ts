// Source contract for task-8 R2 (+ review fix): the root layout's RSC tree
// must not read cookies()/getCurrentUser for analytics identity. The OLD
// AnalyticsBootstrap was a server component that called getCurrentUser() (->
// cookies()) from the ROOT layout, forcing every route rendered through it
// (/, /clubs, /people, /players, /_not-found, and — once R1's
// generateStaticParams fix lands — /shared too) to render dynamically
// whenever NEXT_PUBLIC_POSTHOG_KEY was set (task-7-report.md's audited
// finding). The replacement resolves the same identity client-side via
// lib/analytics-identity (which owns the GET /api/users/me fetch),
// re-resolving per navigation (usePathname) so an in-tab login identifies,
// and logout-button clears the cache + resets posthog so an in-tab logout
// can't misattribute — anchored here on the real identifiers so a regression
// (someone adding cookies()/getCurrentUser back, or dropping the logout
// clear) fails loudly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOTSTRAP = join(__dirname, "..", "..", "components/analytics-bootstrap.tsx");
const IDENTITY = join(__dirname, "..", "analytics-identity.ts");
const LOGOUT = join(__dirname, "..", "..", "components/logout-button.tsx");
const LAYOUT = join(__dirname, "..", "..", "app/layout.tsx");
const ME_ROUTE = join(__dirname, "..", "..", "app/api/users/me/route.ts");

/** Strip comments before checking for real imports/usages — this file's own
 *  explanatory comments legitimately mention "getCurrentUser"/"cookies()" by
 *  name (describing what the OLD version did), which must not trip the
 *  contract meant to catch a real reintroduced dependency.
 *  Known limitation (task-8 review F4): not string-literal-aware — a comment
 *  opener INSIDE a string (e.g. the "//" in "https://…") eats the rest of
 *  that line, which could hide a banned identifier appearing after it.
 *  Accepted for these small, string-light source files. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("analytics-bootstrap contract (task-8): root layout stays cookie-free", () => {
  it("analytics-bootstrap.tsx is a client component, not a server component", () => {
    const source = readFileSync(BOOTSTRAP, "utf8");
    expect(source).toMatch(/^"use client";/m);
  });

  it("analytics-bootstrap.tsx does not import server-only, next/headers, or getCurrentUser", () => {
    const source = stripComments(readFileSync(BOOTSTRAP, "utf8"));
    expect(source).not.toMatch(/import\s+["']server-only["']/);
    expect(source).not.toMatch(/next\/headers/);
    expect(source).not.toMatch(/getCurrentUser/);
  });

  it("analytics-bootstrap.tsx resolves via lib/analytics-identity, re-keyed per navigation (usePathname)", () => {
    const source = stripComments(readFileSync(BOOTSTRAP, "utf8"));
    expect(source).toMatch(/@\/lib\/analytics-identity/);
    expect(source).toMatch(/usePathname/);
  });

  it("lib/analytics-identity.ts owns the /api/users/me fetch and stays client-safe", () => {
    const raw = readFileSync(IDENTITY, "utf8");
    expect(raw).toMatch(/["']\/api\/users\/me["']/);
    const source = stripComments(raw);
    expect(source).not.toMatch(/import\s+["']server-only["']/);
    expect(source).not.toMatch(/next\/headers/);
    expect(source).not.toMatch(/getCurrentUser/);
  });

  it("logout-button clears the cached identity and resets posthog before navigating (review Critical)", () => {
    const source = stripComments(readFileSync(LOGOUT, "utf8"));
    expect(source).toMatch(/clearAnalyticsIdentity\s*\(/);
    expect(source).toMatch(/posthog\.reset\s*\(/);
  });

  it("root layout mounts AnalyticsBootstrap without reading cookies/getCurrentUser itself", () => {
    const raw = readFileSync(LAYOUT, "utf8");
    expect(raw).toMatch(/<AnalyticsBootstrap\s*\/>/);
    const source = stripComments(raw);
    expect(source).not.toMatch(/getCurrentUser/);
    expect(source).not.toMatch(/next\/headers/);
    expect(source).not.toMatch(/cookies\(\)/);
  });

  it("GET /api/users/me exists and requires auth", () => {
    const source = readFileSync(ME_ROUTE, "utf8");
    expect(source).toMatch(/export\s+async function\s+GET\s*\(/);
    expect(source).toMatch(/requireUser\s*\(/);
  });
});
