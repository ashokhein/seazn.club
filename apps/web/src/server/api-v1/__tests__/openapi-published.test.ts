// Published-spec curation (v3/08 §3): the developer spec is exactly the
// key-scoped surface + the public tag. Session-only operations must never
// leak into it, and every published operation carries its scope and at least
// one example.
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi";

type Op = Record<string, unknown> & {
  "x-required-scope"?: string;
  tags?: string[];
  requestBody?: { content: { "application/json": { example?: unknown } } };
  responses: Record<string, { content?: { "application/json": { example?: unknown } } }>;
};

function ops(doc: Record<string, unknown>): [string, string, Op][] {
  const out: [string, string, Op][] = [];
  for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, Op>>)) {
    for (const [method, op] of Object.entries(methods)) out.push([method, path, op]);
  }
  return out;
}

describe("published OpenAPI document", () => {
  const published = buildOpenApiDocument({ published: true });
  const full = buildOpenApiDocument();

  it("is a strict subset of the full spec", () => {
    const fullKeys = new Set(ops(full).map(([m, p]) => `${m} ${p}`));
    for (const [m, p] of ops(published)) expect(fullKeys.has(`${m} ${p}`)).toBe(true);
    expect(ops(published).length).toBeLessThan(ops(full).length);
  });

  it("excludes the never-key surfaces (keys, connect, device links, refunds, /me)", () => {
    const keys = ops(published).map(([m, p]) => `${m} ${p}`);
    for (const banned of [
      "/api-keys",
      "/connect",
      "/device-links",
      "/refund",
      "/me/assigned-fixtures",
    ]) {
      expect(keys.some((k) => k.includes(banned)), `${banned} leaked`).toBe(false);
    }
  });

  it("every non-public operation declares x-required-scope, never 'none'", () => {
    for (const [m, p, op] of ops(published)) {
      if (op.tags?.includes("public")) continue;
      expect(
        ["read", "score", "manage"].includes(op["x-required-scope"] ?? ""),
        `${m} ${p} has scope '${op["x-required-scope"]}'`,
      ).toBe(true);
    }
  });

  it("every operation ships a success example (and a request example when it has a body)", () => {
    for (const [m, p, op] of ops(published)) {
      const success = Object.entries(op.responses).find(([s]) => s.startsWith("2"))?.[1];
      // 204s carry no body; everything else must show what success looks like.
      if (success?.content) {
        expect(
          success.content["application/json"].example,
          `${m} ${p} lacks a response example`,
        ).toBeDefined();
      }
      if (op.requestBody) {
        expect(
          op.requestBody.content["application/json"].example,
          `${m} ${p} lacks a request example`,
        ).toBeDefined();
      }
    }
  });
});
