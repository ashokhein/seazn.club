// Youth privacy (v3/11 gap 8): public surfaces render "Arun K." instead of
// the full name when a division's player_name_display resolves first_initial.
import { describe, expect, it } from "vitest";
import { maskDisplayName, resolveNameDisplay } from "@/lib/name-display";

describe("resolveNameDisplay", () => {
  it("explicit setting wins", () => {
    expect(resolveNameDisplay("full", true)).toBe("full");
    expect(resolveNameDisplay("first_initial", false)).toBe("first_initial");
  });

  it("defaults by youth flag when unset", () => {
    expect(resolveNameDisplay(null, true)).toBe("first_initial");
    expect(resolveNameDisplay(null, false)).toBe("full");
  });
});

describe("maskDisplayName", () => {
  it("keeps full names in full mode", () => {
    expect(maskDisplayName("Arun Kumar", "full")).toBe("Arun Kumar");
  });

  it("renders first name + last initial in first_initial mode", () => {
    expect(maskDisplayName("Arun Kumar", "first_initial")).toBe("Arun K.");
    expect(maskDisplayName("Mary Jane Watson", "first_initial")).toBe("Mary W.");
  });

  it("leaves single-word names alone (nothing to initialise)", () => {
    expect(maskDisplayName("Arun", "first_initial")).toBe("Arun");
  });

  it("handles pair names joined with & or /", () => {
    expect(maskDisplayName("Arun Kumar & Dev Patel", "first_initial")).toBe("Arun K. & Dev P.");
    expect(maskDisplayName("Arun Kumar / Dev Patel", "first_initial")).toBe("Arun K. / Dev P.");
  });

  it("tolerates whitespace junk", () => {
    expect(maskDisplayName("  Arun   Kumar  ", "first_initial")).toBe("Arun K.");
  });
});
