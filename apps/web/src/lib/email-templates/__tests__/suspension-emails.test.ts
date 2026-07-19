import { describe, expect, it } from "vitest";
import { suspensionConfirmedTemplate } from "../suspension-confirmed";
import { suspensionServedTemplate } from "../suspension-served";
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

const confirmArgs = {
  orgName: "Riverside",
  divisionName: "Division 1",
  reason: "5th yellow card",
  matchesTotal: 2,
  meUrl: "https://x/me",
};
const servedArgs = {
  orgName: "Riverside",
  divisionName: "Division 1",
  reason: "Red card",
  meUrl: "https://x/me",
};

describe("suspension emails", () => {
  it("confirm: pins subject + core strings and singular/plural matches (en)", () => {
    const one = suspensionConfirmedTemplate({ ...confirmArgs, matchesTotal: 1 }, dicts.en);
    expect(one.text).toContain("1 match");
    expect(one.text).not.toContain("1 matches");

    const many = suspensionConfirmedTemplate(confirmArgs, dicts.en);
    expect(many.subject).toBe("Suspension confirmed — Division 1");
    expect(many.html).toContain("Riverside");
    expect(many.html).toContain("5th yellow card");
    expect(many.text).toContain("2 matches");
  });

  it("served: subject + division + reason (en)", () => {
    const built = suspensionServedTemplate(servedArgs, dicts.en);
    expect(built.subject).toBe("Suspension served — Division 1");
    expect(built.html).toContain("Division 1");
    expect(built.html).toContain("Red card");
  });

  it("renders in every locale with the system font stack and no unresolved tokens", () => {
    for (const [locale, dict] of Object.entries(dicts)) {
      for (const built of [
        suspensionConfirmedTemplate(confirmArgs, dict),
        suspensionServedTemplate(servedArgs, dict),
      ]) {
        expect(built.subject, locale).not.toBe("");
        expect(built.html, locale).toContain(SYSTEM_STACK);
        expect(built.html.includes("{{"), `${locale} unresolved token`).toBe(false);
      }
    }
  });

  it("localizes the subject line per locale", () => {
    expect(suspensionConfirmedTemplate(confirmArgs, dicts.fr).subject).toContain("Suspension confirmée");
    expect(suspensionConfirmedTemplate(confirmArgs, dicts.es).subject).toContain("Sanción confirmada");
    expect(suspensionConfirmedTemplate(confirmArgs, dicts.nl).subject).toContain("Schorsing bevestigd");
  });
});
