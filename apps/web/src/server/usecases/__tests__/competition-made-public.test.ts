import { describe, expect, it } from "vitest";
import { shouldFireMadePublic } from "../competitions";

// Pure decision-helper regression test (Task 5, PLG activation funnel).
// COMPETITION_MADE_PUBLIC must fire only on the transition INTO "public" —
// never on create-already-public-from-nothing double counting, and never
// when an already-public competition is patched without a visibility change.
describe("shouldFireMadePublic", () => {
  it("fires private -> public", () => {
    expect(shouldFireMadePublic("private", "public")).toBe(true);
  });

  it("fires undefined -> public (create directly public)", () => {
    expect(shouldFireMadePublic(undefined, "public")).toBe(true);
  });

  it("fires unlisted -> public", () => {
    expect(shouldFireMadePublic("unlisted", "public")).toBe(true);
  });

  it("does not fire public -> public (no re-fire on unrelated patch)", () => {
    expect(shouldFireMadePublic("public", "public")).toBe(false);
  });

  it("does not fire private -> unlisted", () => {
    expect(shouldFireMadePublic("private", "unlisted")).toBe(false);
  });

  it("does not fire private -> undefined (no visibility change in patch)", () => {
    expect(shouldFireMadePublic("private", undefined)).toBe(false);
  });
});
