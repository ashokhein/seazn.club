// Route→scope allowlist (v3/08 §2). Two guarantees under test:
//  1. default-deny — an unlisted (method, path) is null, whatever the scope;
//  2. total classification — every route file under app/api/v1 is either in
//     the allowlist, the never-key list, or the public surface, so a new
//     route cannot ship without declaring what keys may do to it.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEY_ROUTE_RULES,
  NEVER_KEY_ROUTES,
  matchKeyRoute,
  scopeSatisfies,
  keyRank,
  v1Path,
} from "../key-scopes";

describe("scope ranking", () => {
  it("read < score < manage, legacy write ⇒ manage", () => {
    expect(scopeSatisfies(["read"], "read")).toBe(true);
    expect(scopeSatisfies(["read"], "score")).toBe(false);
    expect(scopeSatisfies(["read"], "manage")).toBe(false);
    expect(scopeSatisfies(["score"], "read")).toBe(true);
    expect(scopeSatisfies(["score"], "manage")).toBe(false);
    expect(scopeSatisfies(["manage"], "score")).toBe(true);
    expect(scopeSatisfies(["write"], "manage")).toBe(true); // legacy
    expect(keyRank(["bogus"])).toBe(0);
  });
});

describe("matchKeyRoute", () => {
  it("default-denies a route that is not in the map", () => {
    // A plausible-looking future route — MUST stay null until declared.
    expect(matchKeyRoute("POST", "/api/v1/divisions/abc/frobnicate")).toBeNull();
    expect(matchKeyRoute("DELETE", "/api/v1/fixtures/abc")).toBeNull(); // method not offered
  });

  it("denies the structurally excluded surfaces", () => {
    expect(matchKeyRoute("POST", "/api/v1/orgs/o1/api-keys")).toBeNull();
    expect(matchKeyRoute("POST", "/api/v1/registrations/r1/refund")).toBeNull();
    expect(matchKeyRoute("POST", "/api/v1/fixtures/f1/device-links")).toBeNull();
    expect(matchKeyRoute("GET", "/api/v1/me/assigned-fixtures")).toBeNull();
    expect(matchKeyRoute("POST", "/api/v1/orgs/o1/connect")).toBeNull();
  });

  it("maps the scoring doors to the score scope with a pin", () => {
    const events = matchKeyRoute("POST", "/api/v1/fixtures/11111111-1111-1111-1111-111111111111/events");
    expect(events).toMatchObject({ scope: "score", pin: "fixture" });
    expect(events?.resourceId).toBe("11111111-1111-1111-1111-111111111111");
    const start = matchKeyRoute("POST", "/api/v1/divisions/d1/start");
    expect(start).toMatchObject({ scope: "score", pin: "division", resourceId: "d1" });
  });

  it("keeps reads at read and mutations at manage", () => {
    expect(matchKeyRoute("GET", "/api/v1/competitions")?.scope).toBe("read");
    expect(matchKeyRoute("POST", "/api/v1/competitions")?.scope).toBe("manage");
    expect(matchKeyRoute("POST", "/api/v1/format-preview")?.scope).toBe("read"); // pure compute
    expect(matchKeyRoute("POST", "/api/v1/stages/s1/generate")?.scope).toBe("manage");
  });

  it("accepts full URLs and bare paths", () => {
    expect(v1Path("https://seazn.club/api/v1/teams")).toBe("/teams");
    expect(matchKeyRoute("GET", "https://seazn.club/api/v1/teams")?.scope).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// Total classification: enumerate app/api/v1/**/route.ts and their exported
// methods; every (method, route) must be allowlisted, never-listed or public.
// ---------------------------------------------------------------------------

const V1_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "app", "api", "v1",
);

function routeFiles(dir: string, prefix = ""): { path: string; file: string }[] {
  const out: { path: string; file: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...routeFiles(join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name === "route.ts") {
      out.push({ path: prefix || "/", file: join(dir, entry.name) });
    }
  }
  return out;
}

/** `[divisionSlug]` → `:x` — same shape the rules use. */
function templatePath(fsPath: string): string {
  return fsPath.replace(/\[[^\]]+\]/g, ":x");
}

function exportedMethods(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/export (?:async )?function (GET|POST|PATCH|PUT|DELETE)/g)].map(
    (m) => m[1]!,
  );
}

function ruleMatches(method: string, path: string): boolean {
  return matchKeyRoute(method, `/api/v1${path}`) !== null;
}

const NEVER = new Set(
  NEVER_KEY_ROUTES.map((r) => {
    const [m, p] = r.split(" ") as [string, string];
    return `${m} ${p.replace(/:[^/]+/g, ":x")}`;
  }),
);

describe("every v1 route is consciously classified for keys", () => {
  const files = routeFiles(V1_DIR);
  it("found the v1 route tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { path, file } of files) {
    const template = templatePath(path);
    const isPublic = template.startsWith("/public/") || template === "/openapi.json";
    for (const method of exportedMethods(file)) {
      it(`${method} ${template}`, () => {
        if (isPublic) return; // no auth surface at all
        const allowlisted = ruleMatches(method, template.replace(/:x/g, "seg"));
        const neverListed = NEVER.has(`${method} ${template}`);
        expect(
          allowlisted || neverListed,
          `${method} ${path} is neither allowlisted in KEY_ROUTE_RULES nor in NEVER_KEY_ROUTES — declare a scope (or exclusion) in key-scopes.ts`,
        ).toBe(true);
        expect(allowlisted && neverListed).toBe(false); // not both
      });
    }
  }

  it("rules do not point at files that no longer exist", () => {
    const templates = new Set(files.map((f) => templatePath(f.path)));
    for (const rule of KEY_ROUTE_RULES) {
      const t = rule.path.replace(/:[^/]+/g, ":x");
      expect(templates.has(t), `rule ${rule.method} ${rule.path} has no route file`).toBe(true);
    }
  });
});
