// The picker's closed state, pinned in all four locales. The open listbox is
// interaction-only and the vitest env is `node` with no DOM, so the list itself
// is covered by lib/__tests__/tz-options.test.ts (the grouping and ranking) and
// by e2e/user-account.spec.ts (the typing and clicking).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TimezoneCombobox } from "@/components/ui/timezone-combobox";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";

const DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];

function render(locale: Locale, dict: Dict, props: Partial<Parameters<typeof TimezoneCombobox>[0]> = {}) {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <TimezoneCombobox
        value="Asia/Dubai"
        onChange={() => {}}
        ariaLabel="Organisation scheduling timezone"
        {...props}
      />
    </DictProvider>,
  );
}

describe("TimezoneCombobox closed state", () => {
  it("shows city, country and offset rather than the raw IANA id", () => {
    const html = render("en", enUi as Dict);
    expect(html).toContain("Dubai");
    expect(html).toContain("United Arab Emirates");
    expect(html).toContain("GMT+4");
    // The raw path is what the old <select> displayed; it should not survive.
    expect(html).not.toContain("Asia/Dubai");
  });

  it("localises the country name from the active locale", () => {
    expect(render("fr", frUi as Dict, { value: "Europe/Berlin" })).toContain("Allemagne");
    expect(render("es", esUi as Dict, { value: "Europe/Berlin" })).toContain("Alemania");
  });

  it("is a labelled, collapsed combobox in every locale", () => {
    for (const [locale, dict] of DICTS) {
      const html = render(locale, dict);
      expect(html, locale).toContain('role="combobox"');
      expect(html, locale).toContain('aria-expanded="false"');
      expect(html, locale).toContain('aria-label="Organisation scheduling timezone"');
      // Closed means closed: no listbox in the initial markup.
      expect(html, locale).not.toContain('role="listbox"');
    }
  });

  it("shows the caller's empty label when nothing is set", () => {
    const html = render("en", enUi as Dict, { value: "", emptyLabel: "Not set — schedules use UTC", allowEmpty: true });
    expect(html).toContain("Not set — schedules use UTC");
  });

  it("renders a stored zone the table does not know rather than blanking it", () => {
    // A value written before this table existed, or by a newer tzdata.
    const html = render("en", enUi as Dict, { value: "Mars/Olympus_Mons" });
    expect(html).toContain("Olympus Mons");
  });

  it("canonicalises a legacy stored spelling for display", () => {
    // users.timezone may still hold Asia/Calcutta; it stays valid input, but
    // the picker shows the modern city.
    expect(render("en", enUi as Dict, { value: "Asia/Calcutta" })).toContain("Kolkata");
  });
});
