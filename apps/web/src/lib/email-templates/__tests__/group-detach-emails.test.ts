import { describe, expect, it } from "vitest";
import { groupOrgRemovedTemplate } from "../group-org-removed";
import { groupOrgLeftTemplate } from "../group-org-left";
import type { Dict } from "@/lib/i18n";
import enEmails from "@/dictionaries/en/emails.json";
import frEmails from "@/dictionaries/fr/emails.json";
import esEmails from "@/dictionaries/es/emails.json";
import nlEmails from "@/dictionaries/nl/emails.json";

const dicts: Record<string, Dict> = {
  en: enEmails as unknown as Dict,
  fr: frEmails as unknown as Dict,
  es: esEmails as unknown as Dict,
  nl: nlEmails as unknown as Dict,
};

const LINK = "https://x/o/northside/settings/billing";

describe("group-detach emails", () => {
  it("removed (ride_out): names the org, payer and the ride-out date, no raw placeholders", () => {
    const m = groupOrgRemovedTemplate("Dana", "Northside", "12 August 2026", LINK, dicts.en);
    expect(m.subject).toContain("Northside");
    expect(m.html).toContain("Dana");
    expect(m.html).toContain("Northside");
    expect(m.html).toContain("12 August 2026");
    expect(m.text).toContain(LINK);
    // Every {placeholder} must have been substituted.
    expect(m.html).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(m.text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("removed (community): uses the Community body and no ride-out date token", () => {
    const m = groupOrgRemovedTemplate("Dana", "Northside", null, LINK, dicts.en);
    expect(m.html).toContain("Community");
    expect(m.html).not.toContain("{until}");
    expect(m.html).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("left (freed): tells the payer the seat is reusable", () => {
    const m = groupOrgLeftTemplate("Northside", true, LINK, dicts.en);
    expect(m.subject).toContain("Northside");
    expect(m.html.toLowerCase()).toContain("free");
    expect(m.html).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("left (spent): tells the payer the next invoice is smaller", () => {
    const m = groupOrgLeftTemplate("Northside", false, LINK, dicts.en);
    expect(m.html.toLowerCase()).toContain("smaller");
    expect(m.html).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("localises: fr renders French copy with placeholders resolved", () => {
    const removed = groupOrgRemovedTemplate("Dana", "Northside", "12 août 2026", LINK, dicts.fr);
    expect(removed.html).toContain("Northside");
    expect(removed.html).toContain("groupe de facturation");
    expect(removed.html).not.toMatch(/\{[a-zA-Z]+\}/);

    const left = groupOrgLeftTemplate("Northside", true, LINK, dicts.nl);
    expect(left.html).toContain("factuurgroep");
    expect(left.html).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
