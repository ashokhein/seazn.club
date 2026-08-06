// Every TypeScript source file in the engine must be TEXT to git.
//
// A single NUL byte anywhere in a file flips git's binary heuristic for it, and
// the consequences are all silent: `git show --stat` reports `Bin 0 -> 18258
// bytes` instead of a line count, every later diff of that file renders as
// "Binary files a/… and b/… differ" so no reviewer ever sees the change, and
// `grep` / `git grep` answer "Binary file … matches" with the matching lines
// suppressed — which is the repo-wide trap AGENTS.md already warns about,
// arriving from inside our own source tree.
//
// This landed for real: `src/testkit/schema-snapshot.ts` used a literal NUL as
// a cache-key separator and shipped as a binary blob in f08b7750. A control
// character is a perfectly good separator; it just has to be written as an
// ESCAPE (`\x1f`) so the file on disk stays printable. Hence a byte-level gate
// rather than a note.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src", import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** A file git would treat as binary, by git's own rule: a NUL byte in the first
 *  8000. Scanning the whole file is strictly stricter and just as cheap. */
export function nulBytesIn(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) if (byte === 0) count++;
  return count;
}

describe("engine sources are text, not binary blobs", () => {
  const files = sourceFiles(SRC);

  it("scans a non-trivial number of files — the gate is aimed at something", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("contains no NUL byte in any .ts file under src/", () => {
    const offenders = files
      .map((path) => [path.slice(SRC.length + 1), nulBytesIn(readFileSync(path))] as const)
      .filter(([, count]) => count > 0)
      .map(([rel, count]) => `${rel} (${count} NUL byte${count === 1 ? "" : "s"})`);
    expect(
      offenders,
      "a NUL byte makes the file binary to git: diffs render as \"Binary files differ\" and " +
        "grep hides every match. Write the separator as an escape (e.g. `\\x1f`) instead.",
    ).toEqual([]);
  });

  it("detects one when there is one — the scanner is not answering constantly", () => {
    expect(nulBytesIn(Buffer.from("a\0b\0c", "utf8"))).toBe(2);
    expect(nulBytesIn(Buffer.from("a\x1fb", "utf8"))).toBe(0);
  });
});
