import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

/**
 * The Node floor is stated in four places that have no way to check each other:
 * the root `engines` field, every `setup-node` step, the Dockerfile base images,
 * and `@types/node`. They drifted before this test existed — the dev machine ran
 * v26.4.0 while CI and prod ran 22, so every local verification executed on a
 * runtime nothing else used.
 */
const NODE_MAJOR = 26;

describe("toolchain: node floor", () => {
  it("root package.json declares the engines floor", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(`>=${NODE_MAJOR}`);
  });

  it("every setup-node step pins the same major", () => {
    const dir = join(REPO_ROOT, ".github/workflows");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const m = /^\s*node-version:\s*(\S+)\s*$/.exec(line);
        if (m && m[1] !== String(NODE_MAJOR)) {
          offenders.push(`${file}:${i + 1} -> ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("both Dockerfile stages use the same major", () => {
    const text = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
    const bases = [...text.matchAll(/^FROM\s+node:(\S+?)-alpine/gm)].map(
      (m) => m[1],
    );
    expect(bases.length).toBe(2);
    expect(bases).toEqual([String(NODE_MAJOR), String(NODE_MAJOR)]);
  });

  it("@types/node tracks the runtime major in both workspaces", () => {
    for (const ws of ["apps/web", "packages/engine"]) {
      const pkg = JSON.parse(
        readFileSync(join(REPO_ROOT, ws, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string> };
      expect(
        pkg.devDependencies?.["@types/node"],
        `${ws} @types/node`,
      ).toBe(`^${NODE_MAJOR}`);
    }
  });
});

describe("toolchain: compile target", () => {
  it("apps/web targets ES2022, matching the engine", () => {
    const stripJsonComments = (s: string) =>
      s.replace(/^\s*\/\/.*$/gm, "");
    const web = JSON.parse(
      stripJsonComments(
        readFileSync(join(REPO_ROOT, "apps/web/tsconfig.json"), "utf8"),
      ),
    ) as { compilerOptions: { target: string } };
    const engine = JSON.parse(
      stripJsonComments(
        readFileSync(join(REPO_ROOT, "packages/engine/tsconfig.json"), "utf8"),
      ),
    ) as { compilerOptions: { target: string } };
    expect(web.compilerOptions.target).toBe("ES2022");
    expect(web.compilerOptions.target).toBe(engine.compilerOptions.target);
  });
});

describe("toolchain: suppression policy", () => {
  it("both lint configs ban @ts-ignore", () => {
    for (const cfg of [
      "apps/web/eslint.config.mjs",
      "packages/engine/eslint.config.mjs",
    ]) {
      const text = readFileSync(join(REPO_ROOT, cfg), "utf8");
      expect(text, cfg).toContain("@typescript-eslint/ban-ts-comment");
      expect(text, cfg).toMatch(/["']ts-ignore["']\s*:\s*true/);
    }
  });
});
