import { describe, it, expect } from "vitest";
import { foldSuggest } from "../team-squad-editor";

describe("foldSuggest", () => {
  const persons = [
    { id: "1", full_name: "José Álvarez" },
    { id: "2", full_name: "Amy Lee" },
  ];
  it("matches ignoring case and diacritics", () => {
    expect(foldSuggest("jose alvarez", persons)?.id).toBe("1");
  });
  it("returns null on no match", () => {
    expect(foldSuggest("New Person", persons)).toBeNull();
  });
  it("collapses runs of whitespace before comparing", () => {
    expect(foldSuggest("  Amy   Lee ", persons)?.id).toBe("2");
  });
});
