import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/",
}));

import { RulesEditor, defaultRulesFor, serializeRules } from "@/components/discipline/rules-editor";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const dict = uiEn as unknown as Dict;
const FOOTBALL = [
  { key: "yellow", label: "Yellow card" },
  { key: "second_yellow", label: "Second yellow" },
  { key: "red", label: "Red card" },
];

describe("defaultRulesFor", () => {
  it("prefills the FA football shape from yellow + red colours", () => {
    expect(defaultRulesFor(FOOTBALL)).toEqual({
      accumulation: [
        { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
        { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
      ],
      dismissal: [
        { key: "second_yellow", color: "second_yellow", ban_matches: 1 },
        { key: "red", color: "red", ban_matches: 1 },
      ],
    });
  });

  it("is dismissal-only for a sport with no yellow (hockey)", () => {
    const hockey = [{ key: "red", label: "Red" }];
    expect(defaultRulesFor(hockey)).toEqual({
      accumulation: [],
      dismissal: [{ key: "red", color: "red", ban_matches: 1 }],
    });
  });
});

describe("serializeRules", () => {
  it("posts the edited doc verbatim, deriving keys from colour + count", () => {
    const doc = serializeRules(
      [{ color: "yellow", count: 3, ban_matches: 2 }],
      [{ color: "red", ban_matches: 1 }],
    );
    expect(doc).toEqual({
      accumulation: [{ key: "yellow_3", color: "yellow", count: 3, ban_matches: 2 }],
      dismissal: [{ key: "red", color: "red", ban_matches: 1 }],
    });
  });
});

describe("RulesEditor render", () => {
  it("renders rows reflecting the incoming rules doc", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        <RulesEditor
          divisionId="d1"
          enabled
          rules={{
            accumulation: [{ key: "yellow_7", color: "yellow", count: 7, ban_matches: 3 }],
            dismissal: [{ key: "red", color: "red", ban_matches: 1 }],
          }}
          sportColors={FOOTBALL}
          canEdit
        />
      </DictProvider>,
    );
    // count value 7 and ban 3 surfaced in inputs; summary reflects the doc.
    expect(html).toContain('value="7"');
    expect(html).toContain("Yellow card 7/3");
    expect(html).toContain("Red card/1");
  });

  it("seeds the sport defaults when the incoming rules are empty", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        <RulesEditor
          divisionId="d1"
          enabled={false}
          rules={{ accumulation: [], dismissal: [] }}
          sportColors={FOOTBALL}
          canEdit
        />
      </DictProvider>,
    );
    expect(html).toContain("Yellow card 5/1");
    expect(html).toContain("Yellow card 10/2");
  });
});
