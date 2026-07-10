// Guards the email HTML token contract: every {{TOKEN}} in the template
// files must be a documented placeholder, and composing a full email from the
// blocks must leave no token unresolved. Fails if a template is renamed, a
// token drifts from the README contract, or a comment leaks token syntax.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HTML_DIR = join(__dirname, "..", "email-templates", "html");

const read = (rel: string) => readFileSync(join(HTML_DIR, rel), "utf8");

const tokensIn = (s: string) => [...new Set(s.match(/\{\{[A-Z_]+\}\}/g) ?? [])].sort();

const t = (...names: string[]) => names.map((n) => `{{${n}}}`).sort();

/** The contract: file → exact set of allowed tokens (see html/README.md). */
const CONTRACT: Record<string, string[]> = {
  "base.html": t(
    "SUBJECT",
    "PREHEADER",
    "MASTHEAD_TAG",
    "EYEBROW",
    "TITLE",
    "CONTENT",
    "FOOTER_NOTE",
    "YEAR",
  ),
  "blocks/paragraph.html": t("TEXT"),
  "blocks/button.html": t("CTA_LABEL", "CTA_URL"),
  "blocks/panel.html": t("PANEL_TITLE", "PANEL_BODY"),
  "blocks/link-fallback.html": t("FALLBACK_URL"),
  "blocks/standings.html": t("STANDINGS_TITLE", "STANDINGS_META", "NAME_HEADER", "STANDINGS_ROWS"),
  "blocks/standings-row.html": t("ROW_BG", "RANK", "NAME", "PLAYED", "WON", "LOST", "POINTS"),
  "blocks/standings-row-leader.html": t("RANK", "NAME", "PLAYED", "WON", "LOST", "POINTS"),
};

const fill = (tpl: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), tpl);

describe("email html templates", () => {
  for (const [file, expected] of Object.entries(CONTRACT)) {
    it(`${file} exposes exactly its documented tokens`, () => {
      expect(tokensIn(read(file))).toEqual(expected);
    });
  }

  it("composes a full email with no unresolved tokens", () => {
    const rows =
      fill(read("blocks/standings-row-leader.html"), {
        RANK: "1",
        NAME: "Leaders",
        PLAYED: "6",
        WON: "6",
        LOST: "0",
        POINTS: "18",
      }) +
      fill(read("blocks/standings-row.html"), {
        ROW_BG: "#ffffff",
        RANK: "2",
        NAME: "Chasers",
        PLAYED: "6",
        WON: "4",
        LOST: "2",
        POINTS: "12",
      });

    const content =
      fill(read("blocks/paragraph.html"), { TEXT: "Hello" }) +
      fill(read("blocks/panel.html"), { PANEL_TITLE: "Fee", PANEL_BODY: "Pay here" }) +
      fill(read("blocks/standings.html"), {
        STANDINGS_TITLE: "Division 1",
        STANDINGS_META: "After week 6",
        NAME_HEADER: "Team",
        STANDINGS_ROWS: rows,
      }) +
      fill(read("blocks/button.html"), { CTA_LABEL: "View", CTA_URL: "https://x" }) +
      fill(read("blocks/link-fallback.html"), { FALLBACK_URL: "https://x" });

    const html = fill(read("base.html"), {
      SUBJECT: "s",
      PREHEADER: "p",
      MASTHEAD_TAG: "Org",
      EYEBROW: "e",
      TITLE: "t",
      CONTENT: content,
      FOOTER_NOTE: "f",
      YEAR: "2026",
    });

    expect(tokensIn(html)).toEqual([]);
  });

  it("panel body token sits flush against its tags (pre-line whitespace)", () => {
    expect(read("blocks/panel.html")).toContain(">{{PANEL_BODY}}</p>");
  });

  it("committed preview is in sync with the templates", () => {
    const preview = read("previews/registration-standings.html");
    expect(tokensIn(preview)).toEqual([]);
    // Spot-check that the preview was rebuilt after template edits.
    expect(preview).toContain(">Bank transfer to Riverside Racquets CC");
  });
});
