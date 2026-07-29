// The Add-ons tab's rendered surface (v17 gap #293, SPEC-6 §A5).
//
// WHY THIS FILE EXISTS. `getAddOnsTab` is thoroughly tested and the page's
// every branch was, until now, tested by nothing — no module imported it, so
// each conditional could be replaced by a literal and the whole suite stayed
// green. Three of the four holes that proves are customer-visible mis-sales:
//
//   `{view.capReduced && (`  -> `{true && (`    every healthy payer is told
//                                               their bill needs attention
//   `) : !view.isPayer ? (`  -> `) : false ? (`  every non-payer member is
//                                               handed the purchase control
//   `min={view.minExtraOrgs}` -> `min={0}`       the server's floor stops
//                                               bounding the stepper
//
// Rendered as a server component: it is an async function returning an element
// tree, so it can simply be awaited and walked. Its dependencies are mocked at
// the module boundary; the DICTIONARY is real, so a key that was never added to
// en/ui.json renders as itself and fails these assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { walk, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import { ExtraOrgsControl } from "@/components/extra-orgs-control";
import { BackLink } from "@/components/back-link";
import type { AddOnsTabView } from "@/server/usecases/add-ons-tab";

// `requireBillingPage`, not `requireOrgPage`: the billing tabs admit the
// group's PAYER alongside the org's members (v17 gap #333), and `viaPayer` is
// what tells the page which of the two it is rendering for.
const pageAuthState = vi.hoisted(() => ({ viaPayer: false }));
vi.mock("@/server/page-auth", () => ({
  requireBillingPage: vi.fn(async () => ({
    org: { id: "org-1", slug: "acme", role: pageAuthState.viaPayer ? null : "owner" },
    user: { id: "user-1" },
    auth: { orgId: "org-1", userId: "user-1" },
    canEdit: !pageAuthState.viaPayer,
    viaPayer: pageAuthState.viaPayer,
  })),
}));
vi.mock("@/server/usecases/add-ons-tab", () => ({ getAddOnsTab: vi.fn() }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "usd") }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", async () => {
  // The real `t`, so interpolation and misses behave exactly as they do in
  // production; only the server-only dictionary LOADER is stubbed. It HONOURS
  // the locale it is handed — a loader that always answered English would make
  // the locale test below vacuous, since the page could ignore `locale`
  // entirely and still be handed the right dictionary.
  const runtime = await vi.importActual<typeof import("@/lib/i18n-runtime")>(
    "@/lib/i18n-runtime",
  );
  const en = (await import("@/dictionaries/en/ui.json")).default;
  const fr = (await import("@/dictionaries/fr/ui.json")).default;
  return {
    getDictionary: async (locale: string) => (locale === "fr" ? fr : en),
    t: runtime.t,
  };
});

import { getAddOnsTab } from "@/server/usecases/add-ons-tab";
import { resolveLocale } from "@/lib/resolve-locale";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import AddOnsSettingsPage from "../page";

const view = vi.mocked(getAddOnsTab);

/** A healthy Pro payer; each test overrides only what it is about. */
function makeView(overrides: Partial<AddOnsTabView> = {}): AddOnsTabView {
  return {
    planKey: "pro",
    isPayer: true,
    hasLiveSubscription: true,
    addonAvailable: true,
    orgCap: 7,
    capReduced: false,
    liveOrgCount: 5,
    extraOrgCount: 2,
    minExtraOrgs: 0,
    maxExtraOrgs: 50,
    priceMinor: 900,
    ...overrides,
  };
}

async function render(overrides: Partial<AddOnsTabView> = {}) {
  view.mockResolvedValue(makeView(overrides));
  const tree = await AddOnsSettingsPage({ params: Promise.resolve({ orgSlug: "acme" }) });
  const elements = walk(tree);
  return {
    text: textOf(tree),
    control: elements.find((el) => el.type === ExtraOrgsControl),
  };
}

const GUEST = "Only the person who pays for this billing group can buy add-ons.";
const COMMUNITY = "Add-ons are available on Pro and Pro Plus.";
const NO_LIVE = "Extra organisations need an active paid subscription.";
const PAUSED =
  "Adding organisations is paused right now — either this bill needs attention or an organisation on it is suspended.";

beforeEach(() => {
  view.mockReset();
  // English unless a test says otherwise — `mockResolvedValue` persists.
  vi.mocked(resolveLocale).mockResolvedValue("en");
});

describe("Add-ons page — who is offered the purchase", () => {
  it("gives the PAYER of a live paid group the control", async () => {
    const { control, text } = await render();
    expect(control).toBeDefined();
    // The three refusal notices are the positive discriminators: without them
    // "control is defined" would pass on a page that also shouted at the payer.
    expect(text).not.toContain(GUEST);
    expect(text).not.toContain(COMMUNITY);
    expect(text).not.toContain(NO_LIVE);
  });

  it("does NOT give a non-payer member the control", async () => {
    const { control, text } = await render({ isPayer: false });
    expect(control).toBeUndefined();
    expect(text).toContain(GUEST);
  });

  it("does NOT offer a community group anything to buy", async () => {
    const { control, text } = await render({
      planKey: "community",
      addonAvailable: false,
      priceMinor: null,
      orgCap: 1,
      extraOrgCount: 0,
    });
    expect(control).toBeUndefined();
    expect(text).toContain(COMMUNITY);
  });

  it("does NOT offer a group with no live subscription anything to buy", async () => {
    const { control, text } = await render({ hasLiveSubscription: false });
    expect(control).toBeUndefined();
    expect(text).toContain(NO_LIVE);
  });

  it("refuses to render a control with no price, even if the plan says it can buy", async () => {
    // Defensive: `addonAvailable` and `priceMinor` are computed from the same
    // catalog, so this is unreachable today — but a control quoting `null` is
    // an offer we cannot honour, and the page must not depend on that coupling
    // holding for ever.
    const { control } = await render({ addonAvailable: true, priceMinor: null });
    expect(control).toBeUndefined();
  });
});

describe("Add-ons page — the cap-reduced notice", () => {
  it("warns when the resolver's cap is reduced, and STILL shows the control", async () => {
    const { control, text } = await render({ capReduced: true, minExtraOrgs: 2 });
    expect(text).toContain(PAUSED);
    // The rule the whole feature turns on: cancelling a rider they can no
    // longer afford is exactly what this customer is here to do.
    expect(control).toBeDefined();
  });

  it("does not warn a healthy group", async () => {
    // The negative half. `{true && (` in place of `{view.capReduced && (`
    // tells every paying customer their bill is in arrears.
    expect((await render({ capReduced: false })).text).not.toContain(PAUSED);
  });

  it("still warns a non-payer, who cannot fix it but should know", async () => {
    const { text } = await render({ capReduced: true, isPayer: false });
    expect(text).toContain(PAUSED);
    expect(text).toContain(GUEST);
  });
});

// ONE boolean, MORE THAN ONE state — and they do not share a remedy:
//
//   · a resolver degradation the payer can act on: dunning past its 14-day
//     grace, a never-paid first invoice, an expired trial. Reachable and
//     MEASURED — add-ons-tab.test.ts pins a past_due Pro group at admission 3
//     against a purchased 7.
//   · every organisation suspended while the group holds an unlimited staff
//     comp (`groupOrgLimit`'s degenerate branch drops per-org overrides).
//     Moderation, on a bill that is perfectly up to date. Also pinned there.
//
// The shipped sentence named only the first — "until this bill is up to date,
// sort that out on the Billing tab" — which told the second group to fix a bill
// that was fine and sent them to a tab with nothing to do on it. Until the arm
// is SPLIT (which needs the usecase to report a cause, not just a boolean), the
// sentence has to be true for both, and that is a property of all four shipped
// locales rather than of the one the page renders above.
const DICTS: Record<string, Record<string, string>> = {
  en: enUi,
  es: esUi,
  fr: frUi,
  nl: nlUi,
};
// The VOCABULARY of each cause, not a table of the phrasings we happen to ship
// — a denylist of sentences is defeated by the next reword.
const NAMES_SUSPENSION: Record<string, RegExp> = {
  en: /\bsuspended\b/i,
  es: /suspendid/i,
  fr: /suspendue/i,
  nl: /geschorst/i,
};
const NAMES_BILLING_TAB: Record<string, RegExp> = {
  en: /\bBilling\b/,
  es: /Facturación/,
  fr: /Facturation/,
  nl: /Facturering/,
};
// The SECOND remedy, pinned separately because it is the ONLY actionable one
// for half the states that reach this notice: a group suspended by moderation
// has a bill in perfect order, so "check the Billing tab" sends it to a tab
// with nothing on it and contacting us is all that is left. A reword that
// tightened the sentence by dropping this clause would have kept both pins
// above green while leaving that group told to do nothing that helps.
//
// Vocabulary again, not a sentence — and NOT a cognate guess: Spanish ships
// "soporte" where French and Dutch ship the English "support", so a single
// shared regex would have been wrong for exactly one locale. The alternates
// are the words a rewrite would plausibly reach for instead.
const NAMES_SUPPORT: Record<string, RegExp> = {
  en: /\b(support|help ?desk)\b/i,
  es: /\b(soporte|asistencia)\b/i,
  fr: /\b(support|assistance)\b/i,
  nl: /\b(support|ondersteuning|klantenservice)\b/i,
};

describe("addOns.capReduced — true for EVERY state that reaches it", () => {
  for (const [locale, dict] of Object.entries(DICTS)) {
    it(`${locale} names the suspension cause as well as the bill`, () => {
      const sentence = dict["addOns.capReduced"];
      expect(sentence).toBeTruthy();
      // The billing half is what the OLD copy already said, so it is the
      // discriminator: it proves the string is the notice and not an empty
      // lookup, and it stops a fix for one cause deleting the other.
      expect(sentence).toMatch(NAMES_BILLING_TAB[locale]);
      // The half nothing pinned. Every locale shipped a sentence that denied
      // this state existed.
      expect(sentence).toMatch(NAMES_SUSPENSION[locale]);
    });

    it(`${locale} still offers the contact-support remedy`, () => {
      // Its OWN test rather than a fourth assertion above: vitest stops a test
      // at its first failing expect, so a reword that dropped the support
      // clause would be reported as whichever earlier assertion happened to
      // break first, or not at all.
      const sentence = dict["addOns.capReduced"];
      expect(sentence).toBeTruthy();
      // Discriminator: the notice really is the string we looked up (the
      // suspension half is the one this wave added, so it cannot be inherited
      // from an older copy) — without it an empty or renamed key would make
      // the support assertion fail for the wrong reason.
      expect(sentence).toMatch(NAMES_SUSPENSION[locale]);
      expect(sentence).toMatch(NAMES_SUPPORT[locale]);
    });
  }
});

describe("Add-ons page — the numbers it hands the control", () => {
  it("passes the server's floor, ceiling, price and current count straight through", async () => {
    const { control } = await render({
      extraOrgCount: 3,
      minExtraOrgs: 2,
      maxExtraOrgs: 50,
      priceMinor: 1900,
    });
    const p = propsOf(control!);
    // `min={0}` here would silently un-bound the stepper and turn the route's
    // 423 back into the first thing the customer meets.
    expect(p.min).toBe(2);
    expect(p.initialCount).toBe(3);
    expect(p.max).toBe(50);
    expect(p.priceMinor).toBe(1900);
    expect(p.currency).toBe("usd");
  });

  it("hands the island the VIEWER's locale and dictionary, not English", async () => {
    // `dict` and `locale` were passed and asserted nowhere. `locale` is what
    // formats the money INSIDE the island (`formatMinor(…, locale)`), so a
    // hardcoded "en" quotes a French buyer en-US currency with every other
    // assertion in this file still green — the same class as the price-source
    // bug this page already shipped once.
    vi.mocked(resolveLocale).mockResolvedValue("fr");
    const { control, text } = await render();
    const p = propsOf(control!);

    expect(p.locale).toBe("fr");
    // And the dictionary has to be that locale's too, or the island renders
    // French-formatted money under English labels.
    expect((p.dict as Dict)["addOns.extraOrg.label"]).toBe(frUi["addOns.extraOrg.label"]);
    // Discriminator: the PAGE around it is French as well, so this is a locale
    // that really was resolved rather than one prop set in isolation.
    expect(text).toContain(frUi["addOns.intro"]);
  });

  it("states the capacity the customer BOUGHT", async () => {
    expect((await render({ liveOrgCount: 5, orgCap: 7 })).text).toContain(
      "Using 5 of 7 organisations on this bill.",
    );
  });

  it("says so plainly when the plan sets no limit, rather than printing null", async () => {
    const { text } = await render({ orgCap: null, liveOrgCount: 4 });
    expect(text).toContain("Using 4 organisations on this bill");
    expect(text).not.toContain("null");
  });
});

describe("Add-ons page — a payer who is not a member of this club (v17 gap #333)", () => {
  beforeEach(() => {
    pageAuthState.viaPayer = true;
  });
  afterEach(() => {
    pageAuthState.viaPayer = false;
  });

  it("still gets the purchase control — it is their bill", async () => {
    const { control } = await render();
    expect(control).toBeDefined();
  });

  it("is not offered a back link into a Settings index that would 404 on them", async () => {
    view.mockResolvedValue(makeView());
    const tree = await AddOnsSettingsPage({ params: Promise.resolve({ orgSlug: "acme" }) });
    expect(walk(tree).some((el) => el.type === BackLink)).toBe(false);
  });

  it("keeps that back link for a member, who can open it", async () => {
    pageAuthState.viaPayer = false;
    view.mockResolvedValue(makeView());
    const tree = await AddOnsSettingsPage({ params: Promise.resolve({ orgSlug: "acme" }) });
    expect(walk(tree).some((el) => el.type === BackLink)).toBe(true);
  });
});
