import { describe, expect, it } from "vitest";
import { pinFilesToClub } from "../teams-tab";

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
