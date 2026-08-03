// W5 (#400) Task 6 — the receipt for a compiled instruction.
//
// The organiser typed a sentence; this card is what the machine will actually
// enforce, shown before a credit moves. The assertions that matter most are the
// negative ones: a soft preference must not read as a rule, a failed compile
// must not offer a confirm, and an empty compile must not render as a success.
//
// Every probe anchors on `="`. React serialises an omitted prop as
// `"$undefined"`, so a bare `data-preview-state` probe passes in both states.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { AiParsePreviewResponse } from "@/server/api-v1/schemas";
import { AiInstructionPreview } from "../ai-instruction-preview";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

const enDict = en as Record<string, string>;
const frDict = fr as Record<string, string>;

const noop = () => {};

const UNPARSED = "keep the good courts for the grown-ups";

const PREVIEW: AiParsePreviewResponse = {
  preview_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  failed: false,
  compiled: {
    hard: [
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } },
      {
        type: "fixture_on_weekday",
        selector: { kind: "terminal" },
        weekday: "FRI",
        scope: { kind: "competition" },
      },
    ],
    soft: [],
    unparsed: [UNPARSED],
    assumptions: ["Read the end of the window as the following week."],
  },
  window: { start: "2026-08-03", end: "2026-08-09", tz: "Europe/London" },
  expires_at: "2026-08-10T12:00:00.000Z",
};

const withSoft: AiParsePreviewResponse = {
  ...PREVIEW,
  compiled: {
    ...PREVIEW.compiled,
    soft: [{ note: "Put the juniors on early", weight: 2 }],
  },
};

const emptyCompile: AiParsePreviewResponse = {
  ...PREVIEW,
  compiled: { hard: [], soft: [], unparsed: [UNPARSED], assumptions: [] },
};

const failed: AiParsePreviewResponse = {
  ...PREVIEW,
  failed: true,
  preview_id: undefined,
  compiled: { hard: [], soft: [], unparsed: [UNPARSED], assumptions: [] },
};

function render(
  node: React.ReactElement,
  dict: Record<string, string> = enDict,
  locale: Locale = "en",
): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      {node}
    </DictProvider>,
  );
}

const card = (
  preview: AiParsePreviewResponse,
  extra: Partial<React.ComponentProps<typeof AiInstructionPreview>> = {},
) => (
  <AiInstructionPreview
    preview={preview}
    credits={2}
    onConfirm={noop}
    onDismiss={noop}
    onAsPreference={noop}
    {...extra}
  />
);

describe("AiInstructionPreview", () => {
  it("renders the enforced rules, the verbatim unparsed text and the assumptions", () => {
    const html = render(card(PREVIEW));
    expect(html).toContain('data-preview-state="ready"');
    expect(html).toContain("at most 2 matches a day");
    expect(html).toContain("the final on Friday");
    expect(html).toContain(UNPARSED);
    expect(html).toContain("Read the end of the window as the following week.");
    // One ledger row per compiled rule — not a summary, the actual list.
    expect(html.match(/data-preview-rule="hard"/g) ?? []).toHaveLength(2);
  });

  it("puts the engine's own token on every enforced row", () => {
    const html = render(card(PREVIEW));
    expect(html).toContain(">MAX/DAY<");
    expect(html).toContain(">DAY<");
    // Locale-neutral, not English prose: the token is the one string on this
    // card that is never translated (#400 Task 6b).
    expect(html).not.toContain(">PER DAY<");
    expect(html).not.toContain(">WEEKDAY<");
    // Never a rule code: every compiled instruction rule verifies as H8, so an
    // H8 chip on every row would say nothing at all.
    expect(html).not.toContain(">H8<");
  });

  it("shows soft preferences as not enforced, and never on the enforced spine", () => {
    const html = render(card(withSoft));
    expect(html).toContain(enDict["board.ai.preview.soft.title"]!);
    expect(html).toContain("Preferred, not enforced");
    expect(html).toContain("Put the juniors on early");
    expect(html).toContain(enDict["board.ai.preview.soft.hint"]!);
    expect(html.match(/data-preview-rule="soft"/g) ?? []).toHaveLength(1);
    // The note must not be counted among the rules that bind.
    expect(html.match(/data-preview-rule="hard"/g) ?? []).toHaveLength(2);
  });

  it("omits a section entirely rather than drawing an empty one", () => {
    const html = render(card(PREVIEW));
    // PREVIEW has no soft rows: the heading must be absent, not present over
    // an empty list, which would read as "we found preferences" and mislead.
    expect(html).not.toContain(enDict["board.ai.preview.soft.title"]!);
    expect(html).not.toContain('data-preview-rule="soft"');
  });

  it("says so when nothing in the sentence could be enforced", () => {
    const html = render(card(emptyCompile));
    expect(html).toContain("Nothing in this instruction can be enforced");
    // An empty list would look like a success. There must be no ledger at all.
    expect(html).not.toContain('data-preview-rule="hard"');
    // …and what we could not use is still on screen.
    expect(html).toContain(UNPARSED);
  });

  it("offers the preference fallback on a failed compile and never auto-takes it", () => {
    const html = render(card(failed));
    expect(html).toContain('data-preview-state="failed"');
    expect(html).toContain("Run it as a preference instead");
    expect(html).toContain(enDict["board.ai.preview.failed.hint"]!);
    // No confirm path out of a failure — the only way forward is the explicit
    // fallback or editing the brief.
    expect(html).not.toContain('data-preview-confirm="');
    expect(html).toContain('data-preview-as-preference="1"');
    expect(html).toContain('data-preview-dismiss="1"');
  });

  it("names the price at the confirm", () => {
    const html = render(card(PREVIEW));
    expect(html).toContain('data-preview-confirm="1"');
    expect(html).toContain('data-ai-credits="2"');
    expect(html).toContain("2 credits");
  });

  it("prices a one-credit run as one credit", () => {
    const html = render(card(PREVIEW, { credits: 1 }));
    expect(html).toContain('data-ai-credits="1"');
    expect(html).toContain("1 credit");
    expect(html).not.toContain("1 credits");
  });

  it("never offers the preference fallback on a compile that succeeded", () => {
    const html = render(card(PREVIEW));
    expect(html).not.toContain('data-preview-as-preference="');
    expect(html).not.toContain("Run it as a preference instead");
  });

  it("states the window the instruction claimed, with the zone it is read in", () => {
    const html = render(card(PREVIEW));
    expect(html).toContain("2026-08-03");
    expect(html).toContain("2026-08-09");
    expect(html).toContain("Europe/London");
  });

  it("omits the window strip when the instruction stated none", () => {
    const html = render(card({ ...PREVIEW, window: null }));
    expect(html).not.toContain('data-preview-window="');
    expect(html).not.toContain(enDict["board.ai.preview.windowTitle"]!);
  });

  it("names a division-scoped rule through the lookup it is given", () => {
    const scoped: AiParsePreviewResponse = {
      ...PREVIEW,
      compiled: {
        ...PREVIEW.compiled,
        hard: [
          {
            type: "max_fixtures_per_day",
            count: 2,
            scope: { kind: "division", divisionId: "d1" },
          },
        ],
      },
    };
    const html = render(
      card(scoped, {
        names: (s) => (s.kind === "division" && s.divisionId === "d1" ? "Under 16s Singles" : null),
      }),
    );
    expect(html).toContain("Under 16s Singles");
  });

  it("localizes every line, including the compiled readings", () => {
    const html = render(card(PREVIEW), frDict, "fr");
    expect(html).toContain(frDict["board.ai.preview.readAs"]!);
    expect(html).toContain(frDict["board.ai.preview.dismiss"]!);
    // The reading itself, not just the chrome — an in-code sentence would leak
    // English here and pass every en-only assertion above.
    expect(html).not.toContain("at most 2 matches a day");
    expect(html).toContain("au plus 2 matchs par jour");
    // The unparsed text is the ORGANISER's own words and stays verbatim.
    expect(html).toContain(UNPARSED);
  });

  // 375px: nothing fixed-width, the confirm bar wraps to two full-width
  // buttons, and the ledger rows wrap under their token rather than pushing the
  // dock sideways.
  it("keeps every row and the confirm bar shrinkable at 375px", () => {
    const html = render(card(withSoft));
    expect(html).not.toContain("<table");
    expect(html).not.toMatch(/\bw-\[\d/);
    expect(html).not.toMatch(/\bmin-w-\[\d\d\d/);
    const items = html.match(/<li[^>]*class="([^"]*)"/g) ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) expect(li).toContain("flex-wrap");
    expect(html).toMatch(/data-preview-actions="1"[^>]*class="[^"]*flex-wrap/);
    // The long unparsed quote must be allowed to break rather than scroll.
    expect(html).toMatch(/data-preview-unparsed="1"[^>]*class="[^"]*break-words/);
  });
});
