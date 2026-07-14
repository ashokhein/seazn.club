import { describe, it, expect } from "vitest";
import { flattenKeys, diffKeys, changedKeys } from "@/lib/i18n-dict-utils";

describe("i18n dict utils", () => {
  it("flattens nested keys with dot paths", () => {
    expect(flattenKeys({ a: { b: "x" }, c: "y" }).sort()).toEqual(["a.b", "c"]);
  });
  it("reports missing and extra keys against en", () => {
    const { missing, extra } = diffKeys(["a", "b"], ["a", "z"]);
    expect(missing).toEqual(["b"]); // in en, absent in locale
    expect(extra).toEqual(["z"]); //  in locale, absent in en
  });
  it("selects only keys whose source hash changed", () => {
    const en = { "a.b": "New", c: "Same" };
    const manifest = { "a.b": "oldhash", c: "hash(Same)" };
    const hash = (s: string) => (s === "Same" ? "hash(Same)" : "x");
    expect(changedKeys(en, manifest, hash)).toEqual(["a.b"]);
  });
});
