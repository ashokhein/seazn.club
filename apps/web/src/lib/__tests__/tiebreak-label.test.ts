// The standings tie-break cascade caption used to join raw engine rule keys
// ("h2h_points", "diff", ...) verbatim — English regardless of locale, inside
// an otherwise fully translated caption (design/fix-ui/03-console-division.md).
// localizedTieBreakLabel routes each rule name through the real `ui`
// dictionaries instead.
import { describe, expect, it } from "vitest";
import { localizedTieBreakLabel } from "@/lib/tiebreak-label";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

describe("localizedTieBreakLabel", () => {
  it("translates known engine rule keys via the ui catalog", () => {
    expect(localizedTieBreakLabel(en, "h2h_points")).toBe("head-to-head");
    expect(localizedTieBreakLabel(fr, "h2h_points")).toBe("confrontation directe");
    expect(localizedTieBreakLabel(fr, "lots")).toBe("tirage au sort");
    expect(localizedTieBreakLabel(fr, "diff")).not.toBe("goal/run difference");
  });

  it("falls back to the raw key for a rule not yet in the catalog, instead of throwing or leaking a dotted message key", () => {
    expect(localizedTieBreakLabel(fr, "some_future_rule")).toBe("some_future_rule");
  });
});
