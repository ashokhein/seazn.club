import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Regression guard: the Link and Sponsor/CTA toolbar buttons used to call
// window.prompt() directly — a native, unstylable, unlocalizable browser
// dialog inconsistent with the rest of the app's confirm-provider-based
// modals (see ui/confirm-provider.tsx). They now open an in-app EditorDialog
// instead. This asserts the regression can't silently come back — TipTap's
// editor only mounts client-side (immediatelyRender:false), so exercising the
// actual click-through flow needs a real browser; this codebase has no
// jsdom/testing-library setup to do that, so a source-level guard is the
// honest regression test available here.
const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../prose-editor.tsx"),
  "utf8",
);

describe("prose-editor: no native browser dialogs", () => {
  it("never calls window.prompt", () => {
    expect(source).not.toMatch(/window\.prompt\(/);
  });

  it("never calls window.confirm or bare alert", () => {
    expect(source).not.toMatch(/window\.confirm\(/);
    expect(source).not.toMatch(/(?<!\.)\balert\(/);
  });

  it("routes Link and CTA through the in-app EditorDialog instead", () => {
    expect(source).toContain("function EditorDialog(");
    expect(source).toContain("openLinkDialog");
    expect(source).toContain("openCtaDialog");
  });
});
