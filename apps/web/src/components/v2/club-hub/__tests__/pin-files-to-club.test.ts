import { describe, expect, it } from "vitest";
import { finalizeMapping, pinFilesToClub } from "../teams-tab";

describe("pinFilesToClub", () => {
  const HUB = "club-hub-id";

  it("maps every dropped file to the hub club id", () => {
    const map = pinFilesToClub(["a.png", "b.jpg", "c.webp"], HUB);
    expect(map).toEqual({ "a.png": HUB, "b.jpg": HUB, "c.webp": HUB });
  });

  it("pins to the hub even when a filename stem matches another club's name", () => {
    // "rivals-fc.png" would stem-match a sibling org club named "Rivals FC"
    // server-side; manual mapping must win and keep it on the hub club.
    const map = pinFilesToClub(["rivals-fc.png", "acme-sc.png"], HUB);
    expect(map["rivals-fc.png"]).toBe(HUB);
    expect(map["acme-sc.png"]).toBe(HUB);
    // no file is left unmapped (which is what lets the server stem-match)
    expect(Object.values(map).every((v) => v === HUB)).toBe(true);
  });

  it("returns an empty mapping for no files", () => {
    expect(pinFilesToClub([], HUB)).toEqual({});
  });
});

describe("finalizeMapping", () => {
  const HUB = "club-hub-id";

  it("coerces empty-string and missing mapping values to the hub club", () => {
    // Regression: a stale "" (from a former "Unmatched" selection) or a file with
    // no entry at all would be falsy server-side and fall back to stem-matching
    // across ALL org clubs — silently cresting a fold-matching sibling. Every
    // file must resolve to the hub club before posting.
    const mapping = { "a.png": "", "b.jpg": "other-club-id" };
    const finalized = finalizeMapping(mapping, ["a.png", "b.jpg", "c.webp"], HUB);
    expect(finalized).toEqual({ "a.png": HUB, "b.jpg": "other-club-id", "c.webp": HUB });
    // no file is left with an empty value the server would treat as unmatched
    expect(Object.values(finalized).every((v) => v !== "")).toBe(true);
  });

  it("leaves the org-wide mapping untouched when no club is pinned", () => {
    const mapping = { "a.png": "", "b.jpg": "some-club" };
    expect(finalizeMapping(mapping, ["a.png", "b.jpg", "c.webp"], undefined)).toBe(mapping);
  });

  it("does not mutate the input mapping", () => {
    const mapping = { "a.png": "" };
    finalizeMapping(mapping, ["a.png"], HUB);
    expect(mapping).toEqual({ "a.png": "" });
  });
});
