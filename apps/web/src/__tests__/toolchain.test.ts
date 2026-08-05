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
        // YAML permits `node-version: 26` and `node-version: "26"` alike. Compare
        // the value, not the quoting — otherwise this drifts into policing a
        // formatting convention and fails on a correct edit.
        const pinned = m?.[1].replace(/^["']|["']$/g, "");
        if (pinned !== undefined && pinned !== String(NODE_MAJOR)) {
          offenders.push(`${file}:${i + 1} -> ${pinned}`);
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
  /**
   * Both halves of the rule are load-bearing and they fail differently.
   *
   * `"ts-ignore": true` is the ban itself. `"ts-expect-error":
   * "allow-with-description"` is what keeps the escape hatch usable — set it to
   * `true` as well and every suppression is illegal, which does not make the
   * codebase safer, it makes people delete the rule. Asserting only the first
   * half lets the second be weakened or dropped in silence.
   */
  for (const cfg of [
    "apps/web/eslint.config.mjs",
    "packages/engine/eslint.config.mjs",
  ]) {
    it(`${cfg} bans @ts-ignore and keeps @ts-expect-error described`, () => {
      const text = readFileSync(join(REPO_ROOT, cfg), "utf8");
      const rule =
        /["']@typescript-eslint\/ban-ts-comment["']\s*:\s*\[\s*["']error["']\s*,\s*(\{[\s\S]*?\})/.exec(
          text,
        );
      expect(rule, `${cfg}: no ban-ts-comment rule found`).not.toBeNull();
      const options = rule![1];
      expect(options, cfg).toMatch(/["']ts-ignore["']\s*:\s*true/);
      expect(options, cfg).toMatch(
        /["']ts-expect-error["']\s*:\s*["']allow-with-description["']/,
      );
    });
  }
});

import { execFileSync } from "node:child_process";

describe("toolchain: which compiler gates types", () => {
  /**
   * Both packages declare `bin.tsc`, so `node_modules/.bin/tsc` resolves to
   * whichever installed last. Verified real: in a scratch install v7 won
   * `.bin/tsc` while v6 won `.bin/tsserver`. Every typecheck script therefore
   * names an explicit path, and this test is what stops a silent swap back.
   */
  const NATIVE = join(REPO_ROOT, "node_modules/typescript-native/bin/tsc");

  it("the aliased binary is TypeScript 7", () => {
    const out = execFileSync(process.execPath, [NATIVE, "--version"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/Version 7\./);
  });

  it("the bare specifier is still TypeScript 6, for lint and the editor", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules/typescript/package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version.startsWith("6.")).toBe(true);
  });

  it("no typecheck script invokes bare tsc", () => {
    const offenders: string[] = [];
    for (const p of ["package.json", "apps/web/package.json", "packages/engine/package.json"]) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
        if (!name.startsWith("typecheck")) continue;
        if (/(^|[^-\w/])tsc(\s|$)/.test(body)) offenders.push(`${p} :: ${name} -> ${body}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("toolchain: no V8 heap ceiling for typecheck", () => {
  /**
   * The 6 GB ceiling existed only because apps/web's tsc peaked ~2.8 GB against
   * the runner's ~2 GB default V8 heap. TS 7 is a Go binary — the flag has no
   * effect on it — so carrying the ceiling forward would be cargo cult, and
   * worse, would mask a regression back to a V8 compiler.
   */
  /**
   * Assert the flag is not SET — not that the string never appears anywhere.
   * The first version matched the whole file, which forbade *documenting* the
   * flag: the CI comment explaining why never to reintroduce it had to refer to
   * it obliquely, so the warning most likely to prevent the regression was the
   * one thing the test outlawed. A test that suppresses its own rationale is
   * too broad.
   */
  /**
   * The container job exists to catch one specific failure: the TypeScript 7 Go
   * binary building cleanly into the alpine image and then being unable to
   * execute, which `docker build` alone cannot detect because SKIP_TYPECHECK=1
   * means it never invokes tsc. A job that catches that but is wired into
   * nothing blocks nothing — it was originally absent from deploy-staging's
   * `needs`, so a musl failure would have shipped.
   */
  it("the container job is wired into the deploy gate", () => {
    const ci = readFileSync(
      join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const needs = /^\s*needs:\s*\[([^\]]+)\]/m.exec(ci);
    expect(needs, "deploy-staging has no needs: list").not.toBeNull();
    expect(needs![1].split(",").map((s) => s.trim())).toContain("container");
    // …and it runs on the same trigger as the other gates, or it would be
    // skipped on PRs and gate nothing there either.
    const job = ci.slice(ci.indexOf("\n  container:"));
    const header = job.slice(0, job.indexOf("steps:"));
    expect(header).toContain("github.event_name == 'pull_request'");
  });

  it("ci.yml sets no V8 heap ceiling on any active step", () => {
    const active = readFileSync(
      join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    )
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /max-old-space-size/.test(line));
    expect(active).toEqual([]);
  });
});
