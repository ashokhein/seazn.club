// Spec ⇄ implementation drift gate (PROMPT-11 acceptance: "OpenAPI spec
// validates and matches implemented routes"). Walks src/app/api/v1/**/route.ts
// and asserts an exact 1:1 with the ROUTES registry the spec is built from.
// Combined with CI's openapi:gen diff check, neither the spec file nor the
// route tree can drift from the other.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildOpenApiDocument, ROUTES } from "../openapi";

const API_ROOT = join(__dirname, "..", "..", "..", "app", "api", "v1");
const METHOD_RE = /export async function (GET|POST|PUT|PATCH|DELETE)/g;

function walk(dir: string, segments: string[] = []): { path: string; method: string }[] {
  const found: { path: string; method: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, [...segments, entry]));
    } else if (entry === "route.ts") {
      const path = "/" + segments.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(METHOD_RE)) {
        found.push({ path, method: (match[1] as string).toLowerCase() });
      }
    }
  }
  return found;
}

describe("openapi coverage", () => {
  it("ROUTES registry matches the route files on disk exactly", () => {
    const implemented = walk(API_ROOT)
      .filter((r) => r.path !== "/openapi.json") // the spec endpoint itself
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const declared = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(implemented).toEqual(declared);
  });

  it("builds a structurally sound 3.1 document", () => {
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
    for (const [path, ops] of Object.entries(doc.paths)) {
      expect(path.startsWith("/api/v1/")).toBe(true);
      for (const op of Object.values(ops)) {
        expect(Object.keys(op.responses).length).toBeGreaterThan(0);
      }
    }
    // Serialisable (what the route + gen script emit).
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
