// Console chrome localization (v5 i18n cycle 46). The shared authed-app chrome
// (Nav + its client islands) now reads all copy from the `console` dict; these
// tests fail against the pre-i18n hardcoded strings. Nav itself is an async
// server component with DB deps (covered by smoke); here we pin the islands and
// the STEPS↔dict contract, plus an en-XA pseudo pass proving nothing is hardcoded.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LogoutButton } from "@/components/logout-button";
import { HelpMenu, type HelpMenuLabels } from "@/components/help-menu";
import { STEPS } from "@/components/product-tour";
import { buildPseudoDictionary } from "@/lib/pseudo";
import consoleEn from "@/dictionaries/en/console.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/o/riverside",
}));

const en = consoleEn as Record<string, string>;

const helpLabels: HelpMenuLabels = {
  menu: "Help",
  centre: "Help centre",
  developerDocs: "Developer docs",
  contactSupport: "Contact support",
};

describe("console chrome i18n", () => {
  it("LogoutButton renders the label it is given (not a hardcoded string)", () => {
    const html = renderToStaticMarkup(<LogoutButton label="Se déconnecter" />);
    expect(html).toContain("Se déconnecter");
    expect(html).toContain('title="Se déconnecter"');
    expect(html).not.toContain("Sign out");
  });

  it("HelpMenu labels its trigger from the provided labels slice", () => {
    const html = renderToStaticMarkup(<HelpMenu labels={{ ...helpLabels, menu: "Aide" }} />);
    expect(html).toContain('aria-label="Aide"');
    expect(html).not.toContain('aria-label="Help"');
  });

  it("every tour STEP has matching title+body keys in the console dict", () => {
    // Guards the STEPS(structure) ↔ dict(copy) split: renaming a step id or
    // dropping a key would surface here rather than as a blank tour card.
    for (const s of STEPS) {
      expect(en[`tour.${s.id}.title`], `missing tour.${s.id}.title`).toBeTruthy();
      expect(en[`tour.${s.id}.body`], `missing tour.${s.id}.body`).toBeTruthy();
    }
    // Tour UI labels the client island reads directly off the dict.
    for (const k of ["tour.dialogLabel", "tour.skip", "tour.back", "tour.finish", "tour.next"]) {
      expect(en[k], `missing ${k}`).toBeTruthy();
    }
  });

  it("pseudolocale: island copy comes from the dict, nothing hardcoded", () => {
    const pseudo = buildPseudoDictionary(en) as Record<string, string>;
    const logout = renderToStaticMarkup(<LogoutButton label={pseudo["nav.signOut"]} />);
    expect(logout).toContain("⟦");
    expect(logout).not.toMatch(/>Sign out</);
    const help = renderToStaticMarkup(
      <HelpMenu
        labels={{
          menu: pseudo["help.menu"],
          centre: pseudo["help.centre"],
          developerDocs: pseudo["help.developerDocs"],
          contactSupport: pseudo["help.contactSupport"],
        }}
      />,
    );
    expect(help).toContain("⟦");
  });
});
