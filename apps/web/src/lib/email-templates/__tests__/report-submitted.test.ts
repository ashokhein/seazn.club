import { describe, expect, it } from "vitest";
import { reportSubmittedTemplate } from "../report-submitted";
import type { Dict } from "@/lib/i18n";
import enEmails from "@/dictionaries/en/emails.json";
import frEmails from "@/dictionaries/fr/emails.json";
import esEmails from "@/dictionaries/es/emails.json";
import nlEmails from "@/dictionaries/nl/emails.json";

const SYSTEM_STACK = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const dicts: Record<string, Dict> = {
  en: enEmails as unknown as Dict,
  fr: frEmails as unknown as Dict,
  es: esEmails as unknown as Dict,
  nl: nlEmails as unknown as Dict,
};

const args = {
  orgName: "Riverside",
  fixtureLine: "Rovers vs City",
  officialName: "A. Referee",
  incidentCount: 2,
  url: "https://x/o/riverside/c/summer/d/u11/schedule?tab=officials",
};

describe("report_submitted email", () => {
  it("pins subject + core strings and singular/plural incidents (en)", () => {
    const one = reportSubmittedTemplate({ ...args, incidentCount: 1 }, dicts.en);
    expect(one.text).toContain("1 incident");
    expect(one.text).not.toContain("1 incidents");

    const many = reportSubmittedTemplate(args, dicts.en);
    expect(many.subject).toBe("Match report filed — Rovers vs City");
    expect(many.html).toContain("A. Referee");
    expect(many.html).toContain("Rovers vs City");
    expect(many.text).toContain("2 incidents");
    expect(many.html).toContain(args.url);
  });

  it("renders in every locale with the system font stack and no unresolved tokens", () => {
    for (const [locale, dict] of Object.entries(dicts)) {
      const built = reportSubmittedTemplate(args, dict);
      expect(built.subject, locale).not.toBe("");
      expect(built.html, locale).toContain(SYSTEM_STACK);
      for (const tok of ["{fixture}", "{official}", "{incidents}", "{url}"]) {
        expect(built.html.includes(tok), `${locale} unresolved ${tok}`).toBe(false);
        expect(built.text.includes(tok), `${locale} unresolved ${tok} (text)`).toBe(false);
      }
    }
  });

  it("localizes the subject line per locale", () => {
    expect(reportSubmittedTemplate(args, dicts.fr).subject).toContain("Rapport de match déposé");
    expect(reportSubmittedTemplate(args, dicts.es).subject).toContain("Informe del partido presentado");
    expect(reportSubmittedTemplate(args, dicts.nl).subject).toContain("Wedstrijdrapport ingediend");
  });
});
