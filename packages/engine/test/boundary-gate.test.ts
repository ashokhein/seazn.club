// The gate itself must demonstrably fail on seeded violations (PROMPT-01
// acceptance). Fixtures are written to a temp dir shaped like an engine src/.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkEngineBoundary } from "../../../scripts/engine-boundary.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "engine-boundary-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("engine boundary gate", () => {
  it("passes on the real packages/engine/src", () => {
    dir = mkdtempSync(join(tmpdir(), "engine-boundary-")); // for afterEach
    const real = new URL("../src", import.meta.url).pathname;
    expect(checkEngineBoundary(real)).toEqual([]);
  });

  it.each([
    ["postgres", 'import postgres from "postgres";'],
    ["next", 'import { headers } from "next/headers";'],
    ["react", 'import { useState } from "react";'],
    ["ioredis", 'import Redis from "ioredis";'],
    ["server-only", 'import "server-only";'],
    ["node:crypto", 'import { randomUUID } from "node:crypto";'],
    ["apps/", 'import { db } from "../../apps/web/src/lib/db";'],
  ])("fails on forbidden import: %s", (_name, line) => {
    const violations = checkEngineBoundary(seed({ "core/bad.ts": `${line}\nexport {};\n` }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain("forbidden import");
  });

  it.each([
    ["Date.now(", "export const t = Date.now();"],
    ["Math.random(", "export const r = Math.random();"],
    ["new Date()", "export const d = new Date();"],
  ])("fails on ambient call outside core/clock.ts: %s", (_name, line) => {
    const violations = checkEngineBoundary(seed({ "competition/bad.ts": `${line}\n` }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain("forbidden call");
  });

  it("allows ambient time in core/clock.ts and its test", () => {
    const violations = checkEngineBoundary(
      seed({
        "core/clock.ts": "export const now = () => Date.now();\n",
        "core/clock.test.ts": "const t = Date.now();\nexport {};\n",
      }),
    );
    expect(violations).toEqual([]);
  });

  it("ignores banned tokens inside comments", () => {
    const violations = checkEngineBoundary(
      seed({ "core/ok.ts": "// never call Date.now() here\n/* Math.random( banned */\nexport {};\n" }),
    );
    expect(violations).toEqual([]);
  });

  it("reports file and line for each violation", () => {
    const violations = checkEngineBoundary(
      seed({ "scheduling/bad.ts": "export {};\nconst t = Date.now();\n" }),
    );
    expect(violations).toEqual([
      { file: "scheduling/bad.ts", line: 2, rule: expect.stringContaining("Date.now(") },
    ]);
  });
});
