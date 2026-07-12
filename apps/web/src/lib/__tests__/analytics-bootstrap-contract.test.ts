// Source contract for task-8 R2: the root layout's RSC tree must not read
// cookies()/getCurrentUser for analytics identity. The OLD AnalyticsBootstrap
// was a server component that called getCurrentUser() (-> cookies()) from
// the ROOT layout, forcing every route rendered through it (/, /clubs,
// /people, /players, /_not-found, and — once R1's generateStaticParams
// fix lands — /shared too) to render dynamically whenever
// NEXT_PUBLIC_POSTHOG_KEY was set (task-7-report.md's audited finding). The
// replacement resolves the same identity client-side via a fetch to
// GET /api/users/me instead — anchored here on the real identifiers so a
// regression (someone adding cookies()/getCurrentUser back to this file, or
// to the root layout) fails loudly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOTSTRAP = join(__dirname, "..", "..", "components/analytics-bootstrap.tsx");
const LAYOUT = join(__dirname, "..", "..", "app/layout.tsx");
const ME_ROUTE = join(__dirname, "..", "..", "app/api/users/me/route.ts");

/** Strip comments before checking for real imports/usages — this file's own
 *  explanatory comments legitimately mention "getCurrentUser"/"cookies()" by
 *  name (describing what the OLD version did), which must not trip the
 *  contract meant to catch a real reintroduced dependency. */
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

  it("analytics-bootstrap.tsx resolves identity via a fetch to /api/users/me", () => {
    const source = readFileSync(BOOTSTRAP, "utf8");
    expect(source).toMatch(/fetch\(\s*["']\/api\/users\/me["']/);
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
