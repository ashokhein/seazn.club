import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Regression guard: the Abandon and Forfeit buttons used to call
// window.prompt() directly for the reason text — a native, unstylable,
// unlocalizable browser dialog inconsistent with the rest of the app's
// confirm-provider-based modals. They now open an in-app TextPromptDialog
// instead (same pattern as prose-editor.tsx's EditorDialog). No jsdom/
// testing-library setup exists in this codebase to drive the actual
// click-through flow (the scoring UI needs a real browser), so a
// source-level guard is the honest regression test available here.
const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixture-console.tsx"),
  "utf8",
);

describe("fixture-console: no native browser dialogs", () => {
  it("never calls window.prompt", () => {
    expect(source).not.toMatch(/window\.prompt\(/);
  });

  it("never calls window.confirm or bare alert", () => {
    expect(source).not.toMatch(/window\.confirm\(/);
    expect(source).not.toMatch(/(?<!\.)\balert\(/);
  });

  it("routes abandon/forfeit reasons through the in-app TextPromptDialog instead", () => {
    expect(source).toContain("function TextPromptDialog(");
    expect(source).toContain("setAbandonPrompt");
    expect(source).toContain("setForfeitPrompt");
  });
});
