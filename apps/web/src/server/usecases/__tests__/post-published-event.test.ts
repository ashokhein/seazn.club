import { describe, expect, it } from "vitest";
import { shouldFirePostPublished } from "../org-posts";

// Pure decision-helper regression (SPEC-2 analytics, mirrors L6
// shouldFireMadePublic). post_published fires ONLY on the transition INTO
// published — never on a body edit of an already-published post, and never on an
// archive action.
describe("shouldFirePostPublished", () => {
  it("fires draft -> publish", () => {
    expect(shouldFirePostPublished("draft", "publish")).toBe(true);
  });

  it("fires archived -> publish (re-publish)", () => {
    expect(shouldFirePostPublished("archived", "publish")).toBe(true);
  });

  it("does not fire published -> publish (idempotent re-publish is a no-op)", () => {
    expect(shouldFirePostPublished("published", "publish")).toBe(false);
  });

  it("does not fire on a plain body edit (no action)", () => {
    expect(shouldFirePostPublished("published", undefined)).toBe(false);
    expect(shouldFirePostPublished("draft", undefined)).toBe(false);
  });

  it("does not fire on archive", () => {
    expect(shouldFirePostPublished("published", "archive")).toBe(false);
  });
});
