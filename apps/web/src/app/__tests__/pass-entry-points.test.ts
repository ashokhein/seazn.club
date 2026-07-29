// Standing guard for the four Event Pass entry points (task 19, spec D3).
//
// Before this change `routes.competitionUpgrade` had EXACTLY ONE inbound link
// in the entire app — `components/upgrade-gate.tsx`, the paywall. The pass was
// therefore only discoverable to someone a limit had already blocked. The four
// surfaces below are the fix.
//
// Two of them (the competition list and the billing page) are server pages that
// cannot be unit-rendered: they need cookies, an authenticated session and a
// tenant-scoped database. So what is asserted here is what is actually at risk
// on those pages — that the link exists at all, and that the decision to OFFER
// the pass is taken with the ONE shared predicate.
//
// ===========================================================================
// If you found this red, an entry point lost its link or grew a second notion
// of "is this org on a paid plan". Do NOT relax the assertion. Every boolean the
// pass lifts is already true on a paid plan, and Pro's caps sit above the M
// rung's — so a surface that gets paid-ness wrong sells a paying customer a
// DOWNGRADE. That defect shipped once already (fixed in f70b8e52) and a new
// surface is exactly where it comes back.
//
// ("Strict superset", which this said until v17 #294, is no longer true in one
// direction: the L rung takes the entrant cap off entirely, above Pro's 256.
// That is why the paid-plan copy claims FEATURES rather than everything, and
// whether a paid org may buy L at all is #327.)
// ===========================================================================
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");

/**
 * Every .ts/.tsx file under src/, as a path relative to SRC with posix
 * separators — so a guard can define its own scope by asking a question of the
 * tree rather than by naming files it happens to remember.
 *
 * Skips __tests__ (a test may legitimately import anything) and the generated
 * dictionaries.
 */
function walkSrc(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "dictionaries" || entry.name === "node_modules") continue;
      out.push(...walkSrc(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(relative(SRC, full).split(sep).join("/"));
    }
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * The negative assertions below are about what the CODE does, and these files
 * explain themselves at length — a comment saying "we deliberately do not
 * filter on stripe_payment_intent" would otherwise fail the very check it
 * documents. Crude but sufficient: no file here puts `//` or `/*` inside a
 * string literal.
 */
const code = (...parts: string[]) =>
  read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const COMPETITION_HEADER = ["app", "o", "[orgSlug]", "c", "[compSlug]", "page.tsx"];
const COMPETITION_SETTINGS = ["app", "o", "[orgSlug]", "c", "[compSlug]", "settings", "page.tsx"];
const COMPETITION_LIST = ["app", "o", "[orgSlug]", "page.tsx"];
const BILLING_PAGE = ["app", "o", "[orgSlug]", "settings", "billing", "page.tsx"];
const PRICING_PAGE = ["app", "[lang]", "(marketing)", "pricing", "page.tsx"];

describe("Event Pass entry points", () => {
  it("the competition header links to the competition's upgrade page", () => {
    const src = read(...COMPETITION_HEADER);
    expect(src).toContain("CompetitionPassEntry");
    expect(src).toContain("routes.competitionUpgrade(orgSlug, compSlug)");
  });

  it("competition settings links to the competition's upgrade page", () => {
    const src = read(...COMPETITION_SETTINGS);
    expect(src).toContain("CompetitionPassEntry");
    expect(src).toContain("routes.competitionUpgrade(orgSlug, compSlug)");
  });

  it("the competition list links each un-passed competition to its upgrade page", () => {
    const src = read(...COMPETITION_LIST);
    expect(src).toContain("routes.competitionUpgrade(orgSlug, c.slug)");
  });

  it("the billing page mounts the pass offer, which owns the per-competition links", () => {
    expect(read(...BILLING_PAGE)).toContain("BillingPassOffer");
    expect(read("components", "billing-pass-offer.tsx")).toContain(
      "routes.competitionUpgrade(orgSlug, row.slug)",
    );
  });

  it("the /pricing pass column routes its CTA by who is reading", () => {
    const src = read(...PRICING_PAGE);
    expect(src).toContain("passCtaVariant");
    // The signed-in hand-off. Without it a signed-in organiser clicking the
    // Event Pass column lands on a signup form they do not need.
    expect(src).toContain('"/dashboard"');
  });
});

describe("no entry point re-derives 'is this org on a paid plan'", () => {
  // lib/entitlements.ts exports isPaidPlan + orgPlanKey precisely so this
  // question has one answer. `subscriptions.plan_key` raw is NOT that answer:
  // a lapsed staff comp and a past_due org 14 days into dunning both still
  // carry plan_key = 'pro' while resolving as community — and for those orgs
  // the pass genuinely lifts entitlements and must still be offered.
  it.each([
    ["the competition list", COMPETITION_LIST],
    ["the billing page", BILLING_PAGE],
    ["the /pricing column", PRICING_PAGE],
  ])("%s asks the resolver", (_name, parts) => {
    const src = read(...parts);
    // The resolver's verdict may be read inline (`isPaidPlan(await orgPlanKey(…))`)
    // or resolved ONCE into a local (`const effectivePlanKey = await orgPlanKey(…)`,
    // then `isPaidPlan(effectivePlanKey)`). Both feed isPaidPlan from orgPlanKey,
    // never from raw plan_key — which is the invariant this guards.
    expect(src).toMatch(/isPaidPlan\(\s*(await\s+orgPlanKey\(|effectivePlanKey\b)/);
  });

  it("the billing page's pass offer does not reuse its raw-plan_key `isPaid`", () => {
    // `isPaid` on that page is computed from sub.plan_key for the Pro upgrade
    // section and is deliberately left alone; the pass offer must not borrow it.
    // The page resolves once into `effectivePlanKey = await orgPlanKey(…)`; the
    // pass offer reads THAT, not the raw `isPaid`.
    const src = read(...BILLING_PAGE);
    expect(src).toMatch(/effectivePlanKey\s*=\s*await\s+orgPlanKey\(/);
    expect(src).toMatch(/passOfferable[\s\S]{0,200}isPaidPlan\(effectivePlanKey\b/);
  });

  it("the in-competition entry point reads the layout's one signal", () => {
    // A client island cannot query Postgres; usePassGateState is where the
    // precedence (paid plan beats held pass) is written down once.
    const src = read("components", "competition-pass-entry.tsx");
    expect(src).toContain("usePassGateState");
  });
});

describe("no entry point can re-sell a pass the org already holds", () => {
  it("the competition list drops the offer for a competition with a pass", () => {
    const src = code(...COMPETITION_LIST);
    expect(src).toContain("competition_passes");
    // Presence, never payment: a staff-granted pass has a null
    // stripe_payment_intent and is fully active (V271), so a query that
    // filtered on the intent would re-offer a pass the org already holds.
    expect(src).not.toContain("stripe_payment_intent");
  });

  it("the billing page offers only competitions with no pass row", () => {
    const src = code(...BILLING_PAGE);
    expect(src).toMatch(/not exists[\s\S]{0,200}competition_passes/);
    expect(src).not.toContain("stripe_payment_intent");
  });

  it("the competition list reads status/ends_on to tell an ended pass from an active one", () => {
    // v17 gap #301: the dashboard seal read row EXISTENCE only, so it kept
    // saying "Event Pass active" on a competition that finished months ago —
    // long after the resolver stopped honouring that row. It now joins
    // `competitions` and asks `passLockReason`: the SAME predicate, not a
    // second copy of the terminal-status list.
    const src = code(...COMPETITION_LIST);
    // The CALL, with the row's own columns — not the bare identifier. Asserting
    // `toContain("passLockReason")` is satisfied by the IMPORT LINE alone, so
    // replacing the whole call with `null` shipped green (found by mutation,
    // not by reading). This is the same shape of hole as the two the task 3
    // review found, and it survives an unused import only if you ask for the
    // arguments too.
    //
    // `\w+` for the lambda parameter, not a literal `r` (task 6 review): a
    // rename to `row` is behaviour-identical and arguably cleaner, and pinning
    // the identifier redded on it while adding no teeth — the teeth are the
    // `.status`/`.ends_on` arguments.
    expect(src).toMatch(/passLockReason\(\s*\w+\.status\s*,\s*\w+\.ends_on\s*\)/);
    expect(src).toMatch(/join competitions/i);
    // …and the verdict has to reach the seal, or it is derived and discarded.
    //
    // WHAT the seal then does with it is pinned by a RENDER test
    // (`components/__tests__/pass-seal.test.tsx`), not here. That split is the
    // task 6 review's I-1: while the decision sat inline in this page, a source
    // scan was the only tool available, and a source scan pins syntax rather
    // than meaning — `passLock.get(c.id) === "terminal"` satisfied every
    // assertion in this block while re-shipping #301 for the whole
    // `past_ends_on` arm. Moving the decision into a component moved it
    // somewhere a test can watch it behave.
    expect(src).toMatch(/lockReason=\{\s*passLock\.get\(/);
  });

  it("the billing purchase list RENDERS the ended flag it is already given", () => {
    // `getPassPurchases` has set `row.ended` correctly since SPEC-4; for two
    // waves nothing read it. A computed-but-unrendered field is invisible to
    // every other guard here, because the data layer looks perfectly correct.
    const src = code("components", "billing-pass-purchases.tsx");
    expect(src).toContain("row.ended");
    expect(src).toContain("data-pass-status");
  });
});

// ===========================================================================
// v17 #294 — two rungs, and five surfaces that invite a purchase without
// offering the choice between them.
//
// The paywall, the billing-page offer, the dashboard card menu, the competition
// header and competition settings each passed the literal "event_pass" to
// `passPrice`. That is honest only while M is the CHEAPEST rung, and nothing
// held that assumption: `passPrice`'s required key made tsc enumerate these
// call sites exactly once, and after that they read as deliberate choices.
// `lowestPassRung` derives the floor instead — a discount on L, or a rung added
// underneath, moves every one of these numbers with it.
// ===========================================================================
describe("a surface that offers no rung quotes the ladder's floor", () => {
  const PAYWALL = ["components", "upgrade-gate.tsx"];
  const OFFER = ["app", "o", "[orgSlug]", "settings", "billing", "page.tsx"];
  // The SIXTH surface, and the one that made the five-file list a claim rather
  // than a guarantee: `ticketTiers` (the home page's Event Pass stub) went on
  // passing the literal "event_pass" while the branch reported that no
  // production file passed a literal rung. A list that does not include every
  // such surface cannot detect the next one.
  const HOME_STUB = ["lib", "pricing-cards.ts"];

  it.each([
    ["the paywall", PAYWALL],
    ["the billing-page offer", OFFER],
    ["the dashboard card menu", COMPETITION_LIST],
    ["the competition header", COMPETITION_HEADER],
    ["competition settings", COMPETITION_SETTINGS],
    ["the home-page ticket stub", HOME_STUB],
  ])("%s derives its price, and names no rung", (_name, parts) => {
    const src = code(...parts);
    expect(src).toContain("lowestPassRung(");
    // The literal is what made this wrong. A surface that quotes ONE rung is
    // stating that rung's price as the product's price.
    expect(src).not.toMatch(/passPrice\(/);
  });
});

describe("the competition layout resolves what its islands cannot", () => {
  const LAYOUT = ["app", "o", "[orgSlug]", "c", "[compSlug]", "layout.tsx"];

  it("reads the pass ROW's rung, not just its existence", () => {
    // `select 1` was enough while one rung existed. The held signals under this
    // layout have nothing else on screen naming the size, so an L holder read
    // "Event Pass active" — M's product.
    const src = code(...LAYOUT);
    expect(src).toMatch(/select\s+cp\.pass_key\b/);
    expect(src).toMatch(/from\s+competition_passes\b/);
    // The literal that made it wrong, pinned negatively: `select 1` is the
    // shape a future edit falls back to, and the assertions above would still
    // pass beside it if the query grew a second statement.
    expect(src).not.toMatch(/select\s+1\b/);
    // Guarded, never cast: the column is `not null default 'event_pass'`, so a
    // row written by a rung this build predates must degrade to a real label.
    expect(src).toContain("isPassKey(");
  });

  // v17 gap #301. The same read has to answer whether the pass STILL APPLIES,
  // and it has to answer it HERE: `lib/entitlements.ts` is a server module (it
  // imports lib/db and lib/cache), so a client island cannot call
  // `passLockReason` even if it wanted to — a VALUE import of it from anything
  // marked "use client" drags postgres and ioredis into the browser graph.
  it("resolves the pass's lock reason on the server and hands it down as a prop", () => {
    const src = code(...LAYOUT);
    // Joined, not a second query: the two columns the rule needs come back
    // with the pass row itself.
    expect(src).toMatch(/join\s+competitions\b/);
    expect(src).toMatch(/c\.status/);
    expect(src).toMatch(/c\.ends_on/);
    expect(src).toContain("passLockReason(");
    expect(src).toMatch(/lockReason=\{lockReason\}/);
  });

  // THE WHOLE POINT OF THE WAVE: one place decides whether a pass still
  // applies. Six surfaces inherited #301 because the layout answered a question
  // it had not actually asked; six copies of the answer would be the same defect
  // wearing a different hat. The TS resolver, the `org_has_feature` SQL (V338)
  // and the UI must agree exactly, and they can only do that by not each holding
  // an opinion.
  //
  // SCANNED PER FILE, and that list is the fix to this guard's own first draft
  // (W8 task 2 review): it read `code(...LAYOUT)` alone while advertising
  // "provider, layout or any component", so planting
  // `const TERMINAL_STATUSES = ["archived", "completed"]` into
  // competition-pass-provider.tsx left all three cases GREEN. The files below are
  // every one this wave puts the lock reason through — the ones actually at risk
  // of growing a second copy, because they are the ones that now have to branch
  // on it.
  const LOCK_AWARE_FILES: Array<[string, string[]]> = [
    ["the competition layout", LAYOUT],
    ["the pass provider", ["components", "competition-pass-provider.tsx"]],
    ["the in-competition entry point", ["components", "competition-pass-entry.tsx"]],
    ["the paywall", ["components", "upgrade-gate.tsx"]],
    ["the upgrade page's state", ["lib", "upgrade-page-state.ts"]],
    ["the billing purchase list", ["components", "billing-pass-purchases.tsx"]],
    // The second widening (W8 task 3 review, I-2). The six above were the files
    // that BRANCH on the reason; these four sit on the same lock path and were
    // all blocklist-clean at the time they were added, which is exactly when a
    // guard should acquire a file — adding one only after it has grown a copy
    // is closing the stable door. The upgrade page and the checkout route reach
    // for `passLockReason` directly, and the two list surfaces render a pass
    // state per competition.
    ["the upgrade page", ["app", "o", "[orgSlug]", "c", "[compSlug]", "upgrade", "page.tsx"]],
    ["the pass checkout route", ["app", "api", "billing", "pass-checkout", "route.ts"]],
    ["the competition list", COMPETITION_LIST],
    ["the competition header", COMPETITION_HEADER],
    // The third widening (W8 task 4/5 review, M-2, and task 6 review). Two more
    // files on the lock path, both blocklist-clean the day they were added —
    // which, per the note above, is exactly when a guard should acquire a file.
    // `billing-manage.ts` was the ONE remaining `isPassLocked` call site outside
    // this list (`:425`, the `ended` field the billing list renders), and
    // `pass-seal.tsx` now holds the dashboard seal's whole decision.
    ["the billing pass purchases read", ["server", "usecases", "billing-manage.ts"]],
    ["the dashboard seal", ["components", "pass-seal.tsx"]],
  ];

  // The blocklist, named once so the anti-vacuity case below scans the SAME
  // patterns the files are scanned with.
  const RE_DERIVATION: Array<[string, RegExp]> = [
    ["a terminal-status literal", /["'](?:archived|completed)["']/],
    ["the grace constant", /PASS_END_GRACE_DAYS/],
    ["grace arithmetic in ms", /86_?400_?000/],
  ];

  it.each(LOCK_AWARE_FILES)(
    "%s never re-derives the lock rule — no status list, no grace arithmetic",
    (_name, parts) => {
      const src = code(...parts);
      for (const [what, pattern] of RE_DERIVATION) {
        expect(src, `${parts.join("/")} carries ${what}`).not.toMatch(pattern);
      }
    },
  );

  // …and the blocklist can actually fire. Every case above is a NEGATIVE
  // assertion, which a typo in a pattern would satisfy on every file forever.
  it("the re-derivation patterns match the code they exist to forbid", () => {
    const planted = `const TERMINAL_STATUSES = ["archived", "completed"];
      const graceEnd = endsOn.getTime() + PASS_END_GRACE_DAYS * 86_400_000;`;
    for (const [what, pattern] of RE_DERIVATION) {
      expect(pattern.test(planted), `${what} is not detected`).toBe(true);
    }
    // Known limits, recorded rather than papered over: this is a LITERAL
    // blocklist, so `7 * 24 * 3600 * 1000` evades it, and so does an arm added
    // in FRONT of a surviving `passLockReason(` call. It narrows the ways the
    // rule gets copied; it is not proof that it has not been.
    expect(RE_DERIVATION.length).toBeGreaterThanOrEqual(3);
    expect(LOCK_AWARE_FILES.length).toBeGreaterThanOrEqual(12);
  });

  // The entry point does not merely avoid re-deriving — it has to RENDER the
  // verdict. Between task 2 and task 3 this file knew only paid_plan/held/none,
  // so an ended pass fell through to the BUY link: a $29 offer the checkout
  // route refuses outright (an existing `competition_passes` row is a total
  // refusal — the PK is competition_id alone). Neither of the two states it did
  // handle was wrong; the missing third was.
  it("the in-competition entry point renders the ended state, not a fall-through", () => {
    const src = code("components", "competition-pass-entry.tsx");
    expect(src).toContain('gate === "ended"');
    expect(src).toContain("usePassLockReason");
  });

  it("keeps every client island free of a VALUE import from lib/entitlements", () => {
    // A type-only import is erased at compile time and is the correct shape; a
    // plain import of the same symbol is not, and it fails at build time as an
    // unresolvable node builtin — loud, but a long way from the line that
    // caused it.
    //
    // DISCOVERED, not listed (W8 task 3 review, M-1). The first draft scanned
    // `competition-pass-provider.tsx` alone, and by task 3 two more files were
    // importing the module — one of them a `"use client"` island. A list of
    // client files that touch the resolver is a list that goes stale the moment
    // someone adds the next one, which is the same failure this guard's sibling
    // above has now had twice. So walk the tree instead and let the set define
    // itself.
    const clientImporters = walkSrc().filter((rel) => {
      const src = code(rel);
      return src.includes('"use client"') && src.includes('from "@/lib/entitlements"');
    });

    // Guards the premise. If this ever finds nothing, the walk or the module
    // path is wrong and every assertion below would pass vacuously — which is
    // precisely how a guard ends up examining nothing while staying green.
    expect(clientImporters.length).toBeGreaterThan(0);
    expect(clientImporters).toContain("components/competition-pass-provider.tsx");

    for (const rel of clientImporters) {
      const imports = code(rel).match(/^import\s+(?:type\s+)?[^;]*from "@\/lib\/entitlements";$/gm) ?? [];
      expect(imports.length, `${rel} matched no import line`).toBeGreaterThan(0);
      for (const line of imports) expect(line, `${rel}: ${line}`).toMatch(/^import type /);
    }
  });

  it("keeps lib/pass-ladder free of one too — two islands import it", () => {
    // Not a `"use client"` file itself, so the walk above cannot see it, but
    // `upgrade-gate.tsx` and `competition-pass-entry.tsx` both import it: a
    // value import here reaches the client bundle transitively, by the same
    // route and with the same build failure.
    const imports =
      code("lib", "pass-ladder.ts").match(/^import\s+(?:type\s+)?[^;]*from "@\/lib\/entitlements";$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type /);
  });

  it("resolves the org's currency on the server and hands it to the client", () => {
    // A client island cannot read cookies, the org's subscription currency or
    // Accept-Language — which is why <UpgradeGate> priced every reader on earth
    // in hardcoded usd. This layout is the only provider mount, so it is the
    // only place that can fix it.
    const src = code(...LAYOUT);
    expect(src).toContain("preferredCurrency(org.id)");
    expect(src).toMatch(/currency=\{currency\}/);
  });
});

describe("the paywall is no longer the only way in", () => {
  it("routes.competitionUpgrade has more than one call site", () => {
    // The literal regression: one inbound link, reachable only after a refusal.
    const files = [
      read("components", "upgrade-gate.tsx"),
      read("components", "billing-pass-offer.tsx"),
      read(...COMPETITION_HEADER),
      read(...COMPETITION_SETTINGS),
      read(...COMPETITION_LIST),
    ];
    const callSites = files.filter((s) => s.includes("routes.competitionUpgrade(")).length;
    expect(callSites).toBeGreaterThan(1);
  });
});
