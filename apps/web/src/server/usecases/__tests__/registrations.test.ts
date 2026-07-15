// PROMPT-20a acceptance (doc 16 §1.1): fee math asserted, full paid
// registration flow (Stripe mocked — the checkout/webhook contract is
// exercised, the network is not), capacity → waitlist → auto-promotion on
// withdrawal, idempotent entrant materialisation, auto/manual refund policy,
// eligibility + guardian-consent validation, Community fee gate (402).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const refundCreate = vi.fn();
  const chargeRetrieve = vi.fn();
  const reversalCreate = vi.fn();
  const reversalList = vi.fn();
  return {
    checkoutCreate,
    checkoutRetrieve,
    refundCreate,
    chargeRetrieve,
    reversalCreate,
    reversalList,
    stripe: {
      checkout: { sessions: { create: checkoutCreate, retrieve: checkoutRetrieve } },
      refunds: { create: refundCreate },
      charges: { retrieve: chargeRetrieve },
      transfers: { createReversal: reversalCreate, listReversals: reversalList },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// Observe the dispute-lost organiser email without touching the rest of the
// email module (send() is a no-op without RESEND_API_KEY either way).
const emailMock = vi.hoisted(() => ({ disputeLost: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendDisputeLostEmail: emailMock.disputeLost,
}));

import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  ageAt,
  applicationFeeCents,
  eligibilityIssues,
  isMinor,
  validateAnswers,
  putRegistrationSettings,
  getRegistrationSettings,
  publicRegistrationInfo,
  submitRegistration,
  publicRegistrationStatus,
  publicRegistrationStatusByRef,
  withdrawRegistrationByRef,
  handleRegistrationCheckoutCompleted,
  handleRegistrationDispute,
  syncRegistrationRefund,
  reconcileRegistrationBySession,
  sweepRegistrations,
  withdrawRegistrationPublic,
  confirmRegistration,
  confirmRegistrationWaived,
  markRegistrationPaidOffline,
  waitlistRegistration,
  refundRegistration,
  listRegistrations,
  exportRegistrationsCsv,
  registrationIcs,
  type RegistrationRow,
} from "../registrations";
import { isValidRefCode } from "@/lib/ref-code";
import { LEGAL_VERSION } from "@/lib/legal";
import { resolveNameDisplay } from "@/lib/name-display";

const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Pure: fee math & eligibility (no DB)
// ---------------------------------------------------------------------------

describe("fee math (pure)", () => {
  it("takes the platform % of the fee, rounded to the cent", () => {
    expect(applicationFeeCents(2000, 5)).toBe(100); // £20 → £1.00
    expect(applicationFeeCents(999, 5)).toBe(50); // 49.95 → 50
    expect(applicationFeeCents(101, 5)).toBe(5); // 5.05 → 5
    expect(applicationFeeCents(0, 5)).toBe(0);
  });

  it("never exceeds the fee itself", () => {
    expect(applicationFeeCents(100, 100)).toBe(100);
    expect(applicationFeeCents(1, 100)).toBe(1);
  });

});

describe("age & eligibility (pure, doc 06 §2)", () => {
  it("ageAt counts whole years against the exact date", () => {
    expect(ageAt("2010-06-05", new Date("2026-06-04T00:00:00Z"))).toBe(15);
    expect(ageAt("2010-06-05", new Date("2026-06-05T00:00:00Z"))).toBe(16);
  });

  it("isMinor flips at 18", () => {
    const now = new Date("2026-07-06T00:00:00Z");
    expect(isMinor("2008-07-07", now)).toBe(true); // 17
    expect(isMinor("2008-07-06", now)).toBe(false); // 18 today
  });

  const U16 = [
    { kind: "age", maxAgeAt: 15, cutoff: { month: 9, day: 1, yearOf: "season_start" } },
  ];

  it("U16 cutoff rule: 15-or-younger on Sep 1 of the season-start year", () => {
    // Season starts 2026 → cutoff 2026-09-01.
    expect(eligibilityIssues(U16, { dob: "2011-08-31" }, 2026)).toEqual([]); // 15 on cutoff
    expect(eligibilityIssues(U16, { dob: "2010-09-01" }, 2026)).not.toEqual([]); // 16 on cutoff
  });

  it("age rule without a DOB is an issue (form must collect it)", () => {
    expect(eligibilityIssues(U16, { dob: null }, 2026)).not.toEqual([]);
  });

  it("gender rule checks the allowed list", () => {
    const rules = [{ kind: "gender", allowed: ["f", "x"] }];
    expect(eligibilityIssues(rules, { dob: null, gender: "f" }, 2026)).toEqual([]);
    expect(eligibilityIssues(rules, { dob: null, gender: "m" }, 2026)).not.toEqual([]);
    expect(eligibilityIssues(rules, { dob: null, gender: null }, 2026)).not.toEqual([]);
  });
});

describe("validateAnswers (pure)", () => {
  const fields = [
    { key: "size", label: "Shirt size", kind: "select" as const, options: ["S", "M"], required: true },
    { key: "notes", label: "Notes", kind: "text" as const, required: false },
    { key: "photo_ok", label: "Photo consent", kind: "checkbox" as const, required: false },
  ];

  it("keeps declared fields, drops unknown keys", () => {
    expect(
      validateAnswers(fields, { size: "M", notes: "hi", photo_ok: true, evil: "x" }),
    ).toEqual({ size: "M", notes: "hi", photo_ok: true });
  });

  it("rejects a missing required field and an off-list select value", () => {
    expect(() => validateAnswers(fields, {})).toThrow(HttpError);
    expect(() => validateAnswers(fields, { size: "XXL" })).toThrow(HttpError);
  });
});

// ---------------------------------------------------------------------------
// DB-backed flows
// ---------------------------------------------------------------------------

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{
  orgId: string;
  orgSlug: string;
  ownerId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "reg-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Reg Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  if (plan !== "community") {
    await sql`insert into subscriptions (org_id, plan_key, status)
              values (${orgId}, ${plan}, 'active')
              on conflict (org_id) do update set plan_key = ${plan}, status = 'active'`;
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(
  owner: AuthCtx,
  opts: { eligibility?: Record<string, unknown>[]; startsOn?: string } = {},
) {
  const competition = await createCompetition(owner, {
    name: "Reg Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: opts.startsOn ?? "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: opts.eligibility ?? [],
  });
  return { competition, division };
}

const SUBMIT_BASE = {
  display_name: "Alex Test",
  contact_email: "alex@test.local",
  dob: null,
  gender: null,
  guardian_name: null,
  guardian_consent: false,
  privacy_consent: true,
  answers: {},
  players: [],
};

function fakeSession(regId: string, amount: number): Stripe.Checkout.Session {
  return {
    id: "cs_test_" + regId.slice(0, 8),
    payment_intent: "pi_test_" + regId.slice(0, 8),
    payment_status: "paid",
    amount_total: amount,
    metadata: { kind: "registration", registration_id: regId },
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_" + randomUUID().slice(0, 8),
    url: "https://checkout.stripe.test/session",
  }));
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test_1" });
  stripeMock.checkoutRetrieve.mockReset();
  stripeMock.chargeRetrieve.mockReset();
  stripeMock.reversalCreate.mockReset().mockResolvedValue({ id: "trr_test_1" });
  stripeMock.reversalList.mockReset().mockResolvedValue({ data: [] });
  emailMock.disputeLost.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("registration flows (doc 16 §1.1, PROMPT-20a)", () => {
  it("free flow: submit → pending → organiser confirm → entrant materialised once", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });

    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id, dob: "1995-04-01",
    }, "http://test.local");
    expect(res.registration.status).toBe("pending");
    expect(res.checkout_url).toBeNull();
    expect(res.access_token.startsWith("rg_")).toBe(true);

    // GDPR (spec 2026-07-14): consent is demonstrable — timestamp + version stored.
    const [stored] = await sql<{ privacy_consent_at: Date | null; privacy_consent_version: string | null }[]>`
      select privacy_consent_at, privacy_consent_version from registrations where id = ${res.registration.id}`;
    expect(stored.privacy_consent_at).toBeInstanceOf(Date);
    expect(stored.privacy_consent_version).toBe(LEGAL_VERSION);

    const confirmed = await confirmRegistration(owner, res.registration.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.entrant_id).not.toBeNull();

    // Idempotent: a second confirm returns the same entrant.
    const again = await confirmRegistration(owner, res.registration.id);
    expect(again.entrant_id).toBe(confirmed.entrant_id);

    // Individual materialisation created a person carrying the DOB.
    const [person] = await sql<{ dob: string }[]>`
      select p.dob from persons p
      join entrant_members em on em.person_id = p.id
      where em.entrant_id = ${confirmed.entrant_id as string}`;
    expect(person.dob).toBe("1995-04-01");
  });

  it("team flow: roster supplied at registration materialises into squad members on confirm", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "team", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });

    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id, display_name: "Riverside FC",
      players: [
        { name: "Jordan Blake", dob: "2005-04-12", squad_number: 7 },
        { name: "Sam Ortiz", squad_number: 10 },
        { name: "Alex Kim" },
      ],
    }, "http://test.local");
    expect(res.registration.status).toBe("pending");

    const confirmed = await confirmRegistration(owner, res.registration.id);
    expect(confirmed.entrant_id).not.toBeNull();

    const members = await sql<{ full_name: string; dob: string | null; squad_number: number | null }[]>`
      select p.full_name, p.dob, em.squad_number
      from entrant_members em join persons p on p.id = em.person_id
      where em.entrant_id = ${confirmed.entrant_id as string}
      order by p.full_name`;
    expect(members.map((m) => m.full_name)).toEqual(["Alex Kim", "Jordan Blake", "Sam Ortiz"]);
    const jordan = members.find((m) => m.full_name === "Jordan Blake")!;
    expect(jordan.dob).toBe("2005-04-12");
    expect(jordan.squad_number).toBe(7);

    // Re-confirm is idempotent — no duplicate members.
    await confirmRegistration(owner, res.registration.id);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(n).toBe(3);
  });

  it("paid flow (offline): no Stripe checkout; bank/cash instructions surfaced; dormant webhook still confirms", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    // Stripe Connect is disabled — entry fees are collected offline. The org's
    // payment_instructions carry the bank/cash details shown to registrants.
    const instructions = "Bank transfer to Riverside FC · sort 00-00-00 · acc 12345678";
    await sql`update organizations
              set payment_instructions = ${instructions}
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 2000, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });

    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    // Paid entry is accepted immediately as pending — no online checkout.
    expect(res.registration.status).toBe("pending");
    expect(res.checkout_url).toBeNull();
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();

    // The status page (registrant's receipt) exposes the offline instructions.
    const status = await publicRegistrationStatus(res.registration.id, res.access_token);
    expect(status.payment_due).toBe(true);
    expect(status.payment_instructions).toBe(instructions);

    // The Stripe webhook path stays wired (dormant) — if a payment ever lands,
    // it still confirms + materialises the entrant idempotently.
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 2000));
    let [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.status).toBe("confirmed");
    expect(row.payment_intent_id).toContain("pi_test_");
    expect(row.entrant_id).not.toBeNull();
    const entrantId = row.entrant_id;

    // Webhook replay (billing_events would normally dedupe; the handler is
    // ALSO idempotent on its own).
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 2000));
    [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.entrant_id).toBe(entrantId);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${division.id}`;
    expect(n).toBe(1);
  });

  it("capacity: overflow waitlists; withdrawal auto-promotes the oldest; auto-refund pre-lock", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 1000, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: 1, refund_lock_at: null,
    });

    const first = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id, display_name: "First In",
    }, "http://test.local");
    expect(first.registration.status).toBe("pending");

    const second = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id, display_name: "Wait Lister",
      contact_email: "wait@test.local",
    }, "http://test.local");
    expect(second.registration.status).toBe("waitlisted");
    expect(second.checkout_url).toBeNull(); // no money taken on the waitlist

    // First pays, then withdraws → refund (pre-lock) + promotion.
    await handleRegistrationCheckoutCompleted(fakeSession(first.registration.id, 1000));
    const view = await withdrawRegistrationPublic(first.registration.id, first.access_token);
    expect(view.status).toBe("withdrawn");
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: expect.stringContaining("pi_test_"),
        reverse_transfer: true,
        refund_application_fee: true,
      }),
    );
    const [firstRow] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${first.registration.id}`;
    expect(firstRow.refunded_cents).toBe(firstRow.amount_cents);
    // The materialised entrant is marked withdrawn, not deleted.
    const [entrant] = await sql<{ status: string }[]>`
      select status from entrants where id = ${firstRow.entrant_id as string}`;
    expect(entrant.status).toBe("withdrawn");

    const [promoted] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${second.registration.id}`;
    expect(promoted.status).toBe("pending");
    expect(promoted.promoted_at).not.toBeNull();
  });

  it("post-lock withdrawal does NOT auto-refund; manual partial refund works and over-refund 422s", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 1000, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null,
      refund_lock_at: "2020-01-01T00:00:00Z", // lock long past
    });

    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 1000));
    stripeMock.refundCreate.mockClear();

    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled(); // organiser discretion now

    const refunded = await refundRegistration(owner, res.registration.id, 400);
    expect(refunded.refunded_cents).toBe(400);
    await expect(refundRegistration(owner, res.registration.id, 700)).rejects.toThrow(HttpError);
    const fullRest = await refundRegistration(owner, res.registration.id, undefined);
    expect(fullRest.refunded_cents).toBe(1000);
  });

  it("eligibility gate: U16 rejects an adult; a minor needs guardian consent", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, {
      eligibility: [
        { kind: "age", maxAgeAt: 15, cutoff: { month: 9, day: 1, yearOf: "season_start" } },
      ],
    });
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });

    const base = { ...SUBMIT_BASE, division_id: division.id };
    // No DOB → 422 (age-restricted division).
    await expect(
      submitRegistration(orgSlug, competition.slug, base, "http://t.local"),
    ).rejects.toThrow(HttpError);
    // Adult → 422.
    await expect(
      submitRegistration(orgSlug, competition.slug, { ...base, dob: "1990-01-01" }, "http://t.local"),
    ).rejects.toThrow(/Too old/);
    // Eligible minor without guardian consent → 422.
    await expect(
      submitRegistration(orgSlug, competition.slug, { ...base, dob: "2012-05-01" }, "http://t.local"),
    ).rejects.toThrow(/guardian/);
    // With consent → in.
    const ok = await submitRegistration(orgSlug, competition.slug, {
      ...base, dob: "2012-05-01", guardian_name: "Pat Parent", guardian_consent: true,
    }, "http://t.local");
    expect(ok.registration.status).toBe("pending");
  });

  it("rejects submissions without privacy consent (GDPR, spec 2026-07-14)", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });

    await expect(
      submitRegistration(orgSlug, competition.slug, {
        ...SUBMIT_BASE, division_id: division.id, privacy_consent: false,
      }, "http://t.local"),
    ).rejects.toThrow(/privacy/i);
  });

  it("custom form answers validate against the bounded builder", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "team", fee_cents: 0, currency: "usd",
      form_fields: [
        { key: "size", label: "Shirt size", kind: "select", options: ["S", "M"], required: true },
      ],
      opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    const base = { ...SUBMIT_BASE, division_id: division.id };
    await expect(
      submitRegistration(orgSlug, competition.slug, base, "http://t.local"),
    ).rejects.toThrow(/Shirt size/);
    const ok = await submitRegistration(orgSlug, competition.slug, {
      ...base, answers: { size: "M", sneaky: "dropped" },
    }, "http://t.local");
    expect(ok.registration.answers).toEqual({ size: "M" });
    // Team kind: entrant materialises WITHOUT a person.
    const confirmed = await confirmRegistration(owner, ok.registration.id);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members
      where entrant_id = ${confirmed.entrant_id as string}`;
    expect(n).toBe(0);
  });

  it("window + organiser tools: closed window 422s; waitlist/list/export/ics/info", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: "2020-01-01T00:00:00Z",
      capacity: null, refund_lock_at: null,
    });
    await expect(
      submitRegistration(orgSlug, competition.slug, { ...SUBMIT_BASE, division_id: division.id }, "http://t.local"),
    ).rejects.toThrow(/not open/);

    // Reopen; the public info panel reflects it.
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: 8, refund_lock_at: null,
    });
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions).toHaveLength(1);
    expect(info.divisions[0].open).toBe(true);
    expect(info.divisions[0].remaining).toBe(8);

    const reg = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://t.local");
    const waitlisted = await waitlistRegistration(owner, reg.registration.id);
    expect(waitlisted.status).toBe("waitlisted");

    const listed = await listRegistrations(owner, division.id, "waitlisted");
    expect(listed.map((r) => r.id)).toContain(reg.registration.id);

    const csv = await exportRegistrationsCsv(owner, division.id);
    expect(csv.split("\n")[0]).toContain("display_name");
    expect(csv).toContain("Alex Test");

    const ics = await registrationIcs(reg.registration.id, reg.access_token);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260915");

    // Settings read-back includes charges_enabled for the console banner.
    const settings = await getRegistrationSettings(owner, division.id);
    expect(settings.charges_enabled).toBe(false);
    expect(settings.capacity).toBe(8);
  });

  it("Community org: offline entry fee is allowed; only online (Stripe) fees need Pro", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    // Offline (no Stripe Connect) — a fee saves fine on Community.
    const saved = await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    expect(saved.fee_cents).toBe(500);

    // Free registration still works.
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://t.local");
    expect(res.registration.status).toBe("pending");

    // Since spec 2026-07-12 the Pro gate rides the chosen METHOD, not the
    // Connect flag: an offline fee stays allowed even with charges enabled
    // (the org may take cards elsewhere but run this division in cash)…
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const offlineStill = await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    expect(offlineStill.fee_cents).toBe(500);

    // …while explicitly choosing the card method still needs Pro.
    await expect(
      putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "usd",
        form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
        payment_method: "stripe",
      }),
    ).rejects.toThrow(PaymentRequiredError);
  });

  it("capacity above the plan's entrant quota is rejected at save", async () => {
    const { orgId, ownerId } = await seedOrg("community"); // entrants.per_division.max = 16
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    await expect(
      putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
        form_fields: [], opens_at: null, closes_at: null, capacity: 64, refund_lock_at: null,
      }),
    ).rejects.toThrow(/entrant limit/);
  });

  // ── Reference numbers + /r/[ref] (v3/05 §3, PROMPT-34) ──

  it("submit issues a checksummed SZ ref; /r/[ref] resolves it, dashes/case optional", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    const { registration } = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");

    expect(registration.ref_code).toMatch(/^SZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(isValidRefCode(registration.ref_code!)).toBe(true);

    const view = await publicRegistrationStatusByRef(registration.ref_code!);
    expect(view.status).toBe("pending");
    expect(view.display_name).toBe("Alex Test");
    expect(view.division_slug).toBe(division.slug);
    expect(view.can_withdraw).toBe(false); // no token presented

    // Quoted over the phone: lowercase, no dashes — still resolves.
    const sloppy = registration.ref_code!.toLowerCase().replace(/-/g, "");
    const view2 = await publicRegistrationStatusByRef(sloppy);
    expect(view2.ref_code).toBe(registration.ref_code);

    // A typo'd ref fails the checksum → 404, before touching the table.
    const chars = registration.ref_code!.replace("SZ-", "").replace(/-/g, "").split("");
    chars[0] = chars[0] === "A" ? "B" : "A";
    await expect(
      publicRegistrationStatusByRef(`SZ-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`),
    ).rejects.toThrow(/not found/);
  });

  it("self-withdraw by ref requires the email token — the ref alone is a lookup, not auth", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    const { registration, access_token } = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    const ref = registration.ref_code!;

    await expect(withdrawRegistrationByRef(ref, "rg_wrong-token")).rejects.toThrow(/not found/);
    const [still] = await sql<{ status: string }[]>`
      select status from registrations where id = ${registration.id}`;
    expect(still!.status).toBe("pending");

    const view = await withdrawRegistrationByRef(ref, access_token);
    expect(view.status).toBe("withdrawn");
  });

  // ── Youth privacy (v3/11 gap 8, PROMPT-34) ──

  it("U16 eligibility auto-sets divisions.youth; /r/[ref] masks the name to first-initial", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, {
      eligibility: [{ kind: "age", maxAgeAt: 15, cutoff: { month: 9, day: 1, yearOf: "season_start" } }],
    });
    expect(division.youth).toBe(true);
    expect(resolveNameDisplay(division.player_name_display, division.youth)).toBe("first_initial");

    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    const { registration } = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE,
      display_name: "Arun Kumar",
      division_id: division.id,
      dob: "2012-05-01",
      guardian_name: "Priya Kumar",
      guardian_consent: true,
    }, "http://test.local");

    const view = await publicRegistrationStatusByRef(registration.ref_code!);
    expect(view.display_name).toBe("Arun K.");

    // Organiser-side stays full-fidelity (exports/check-in need real names).
    const rows = await listRegistrations(owner, division.id, null);
    expect(rows.find((r) => r.id === registration.id)?.display_name).toBe("Arun Kumar");
    expect(rows.find((r) => r.id === registration.id)?.ref_code).toBe(registration.ref_code);
  });

  it("open (non-youth) divisions default to full names and no auto guardian gate", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    expect(division.youth).toBe(false);
    expect(resolveNameDisplay(division.player_name_display, division.youth)).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// Payment method settings (spec 2026-07-12 §3)
// ---------------------------------------------------------------------------

const SETTINGS_BASE = {
  enabled: true,
  entrant_kind: "individual" as const,
  opens_at: null,
  closes_at: null,
  capacity: null,
  currency: "gbp",
  refund_lock_at: null,
  form_fields: [],
};

describe.skipIf(!HAS_DB)("payment method settings (spec §3)", () => {
  it("stripe method requires charges_enabled and a viable minimum fee", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    // No Connect account yet → card method rejected outright.
    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 500,
      }),
    ).rejects.toMatchObject({ status: 422 });

    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;

    // Below Stripe's minimum charge (100 minor units) — rejected.
    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 50,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const ok = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 500,
    });
    expect(ok.payment_method).toBe("stripe");
    expect(ok.charges_enabled).toBe(true);
  });

  it("community org cannot pick the card method (registration.paid gate)", async () => {
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 500,
      }),
    ).rejects.toThrow(PaymentRequiredError);
  });

  it("offline fees stay plan-free and store a per-division instructions override", async () => {
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    const s = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, payment_method: "offline", fee_cents: 1500,
      payment_instructions: "Cash to the front desk before round 1",
    });
    expect(s.payment_method).toBe("offline");
    expect(s.payment_instructions).toBe("Cash to the front desk before round 1");

    // GET returns the org fallback + default method for the settings UI.
    await sql`update organizations
              set payment_instructions = 'Org-wide bank details',
                  default_payment_method = 'stripe'
              where id = ${orgId}`;
    const got = await getRegistrationSettings(owner, division.id);
    expect(got.org_payment_instructions).toBe("Org-wide bank details");
    expect(got.org_default_payment_method).toBe("stripe");
    expect(got.payment_instructions).toBe("Cash to the front desk before round 1");
  });
});

// ---------------------------------------------------------------------------
// Organiser payment actions (spec T7): mark paid (offline) + waive
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("organiser payment actions (spec T7)", () => {
  async function offlinePaidRig() {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, payment_method: "offline", fee_cents: 1500,
    });
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    return { owner, ownerId, division, reg: res.registration };
  }

  it("mark-paid confirms an offline registrant and records the actor", async () => {
    const { owner, ownerId, reg } = await offlinePaidRig();
    // Plain confirm still refuses while unpaid…
    await expect(confirmRegistration(owner, reg.id)).rejects.toMatchObject({ status: 422 });
    // …mark-paid is the money-received path.
    const row = await markRegistrationPaidOffline(owner, reg.id);
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id).not.toBeNull();
    expect(row.offline_marked_paid_at).not.toBeNull();
    const [audited] = await sql<{ actor_id: string }[]>`
      select actor_id from competition_events
      where type = 'registration.offline_paid'
        and payload->>'registration_id' = ${reg.id}`;
    expect(audited.actor_id).toBe(ownerId);
    // Idempotence guard: a second mark-paid 422s (no longer pending).
    await expect(markRegistrationPaidOffline(owner, reg.id)).rejects.toMatchObject({ status: 422 });
  });

  it("mark-paid rejects card-paid and free registrations", async () => {
    const { orgSlug, competition, division, owner } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    await expect(markRegistrationPaidOffline(owner, res.registration.id))
      .rejects.toMatchObject({ status: 422 });
  });

  it("waive confirms without payment and audits the waiver", async () => {
    const { owner, reg } = await offlinePaidRig();
    const row = await confirmRegistrationWaived(owner, reg.id);
    expect(row.status).toBe("confirmed");
    expect(row.offline_marked_paid_at).toBeNull();
    const [audited] = await sql<{ id: string }[]>`
      select id from competition_events
      where type = 'registration.fee_waived'
        and payload->>'registration_id' = ${reg.id}`;
    expect(audited).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Card submit path (spec §3): checkout at submit + 48h pay window
// ---------------------------------------------------------------------------

async function stripeRig(opts: { capacity?: number | null; feeCents?: number } = {}) {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  await sql`update organizations
            set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
            where id = ${orgId}`;
  const { competition, division } = await rig(owner);
  await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE, payment_method: "stripe",
    fee_cents: opts.feeCents ?? 500, capacity: opts.capacity ?? null,
  });
  return { orgId, orgSlug, ownerId, owner, competition, division };
}

describe.skipIf(!HAS_DB)("card submit path (spec §3)", () => {
  it("snapshots the method, opens a 48h window, returns a checkout URL", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    expect(res.checkout_url).toBe("https://checkout.stripe.test/session");
    expect(res.registration.payment_method).toBe("stripe");
    expect(res.registration.expires_at).not.toBeNull();
    expect(res.registration.amount_cents).toBe(500);
    // The line item charges the snapshot, and the fee rides the chain (pro 2%).
    const args = stripeMock.checkoutCreate.mock.calls[0][0];
    expect(args.line_items[0].price_data.unit_amount).toBe(500);
    expect(args.payment_intent_data.application_fee_amount).toBe(10);
  });

  it("a failed checkout mint keeps the registration (pay from status page)", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    stripeMock.checkoutCreate.mockRejectedValueOnce(new Error("stripe down"));
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    expect(res.checkout_url).toBeNull();
    expect(res.registration.status).toBe("pending");
  });

  it("offline submits keep no expiry and no checkout", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, payment_method: "offline", fee_cents: 500,
    });
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    expect(res.checkout_url).toBeNull();
    expect(res.registration.expires_at).toBeNull();
    expect(res.registration.payment_method).toBe("offline");
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("blocks card submits when Connect breaks, and the public panel says why", async () => {
    const { orgId, orgSlug, competition, division } = await stripeRig();
    await sql`update organizations set stripe_charges_enabled = false where id = ${orgId}`;
    await expect(
      submitRegistration(orgSlug, competition.slug, {
        ...SUBMIT_BASE, division_id: division.id,
      }, "http://test.local"),
    ).rejects.toMatchObject({ status: 503 });
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const div = info.divisions.find((d) => d.division_id === division.id)!;
    expect(div.open).toBe(false);
    expect(div.closed_reason).toBe("payments_unavailable");
    expect(div.payment_method).toBe("stripe");
  });

  it("late payment on a withdrawn registration is auto-refunded", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    await withdrawRegistrationPublic(res.registration.id, res.access_token);

    // The abandoned checkout completes AFTER the withdrawal.
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.status).toBe("withdrawn");
    expect(row.entrant_id).toBeNull();
    expect(row.refunded_cents).toBe(500);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_test_" + res.registration.id.slice(0, 8),
        reverse_transfer: true,
        refund_application_fee: true,
      }),
    );
  });

  it("a second completed session refunds the duplicate intent, state untouched", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");

    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const [confirmed] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.expires_at).toBeNull(); // pay window cleared on confirm

    // Second tab pays with a DIFFERENT intent → refund the duplicate.
    const dup = {
      ...fakeSession(res.registration.id, 500),
      payment_intent: "pi_dup_1",
    } as unknown as Stripe.Checkout.Session;
    await handleRegistrationCheckoutCompleted(dup);
    const [after] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(after.status).toBe("confirmed");
    expect(after.payment_intent_id).toBe(confirmed.payment_intent_id); // original kept
    expect(after.refunded_cents).toBe(0); // the CONFIRMED payment is untouched
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_dup_1" }),
    );

    // Pure replay of the SAME session refunds nothing.
    stripeMock.refundCreate.mockClear();
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
  });

  it("promotion snapshots the current fee and opens a 48h window for card divisions", async () => {
    const { orgSlug, owner, competition, division } = await stripeRig({ capacity: 1 });
    const a = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    const b = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id, contact_email: "b@test.local",
    }, "http://test.local");
    expect(b.registration.status).toBe("waitlisted");
    expect(b.registration.amount_cents).toBe(0);

    // Organiser raises the fee while B waits — promotion charges the NEW fee.
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 700, capacity: 1,
    });
    await withdrawRegistrationPublic(a.registration.id, a.access_token);

    const [bRow] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${b.registration.id}`;
    expect(bRow.status).toBe("pending");
    expect(bRow.amount_cents).toBe(700);
    expect(bRow.payment_method).toBe("stripe");
    expect(bRow.expires_at).not.toBeNull();
  });

  it("sweep reminds once inside the last 24h, then expires and promotes", async () => {
    const { orgSlug, competition, division } = await stripeRig({ capacity: 1 });
    const a = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    const b = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id, contact_email: "b@test.local",
    }, "http://test.local");
    expect(b.registration.status).toBe("waitlisted");

    // Inside the last 24h → one reminder, exactly once.
    await sql`update registrations set expires_at = now() + interval '10 hours'
              where id = ${a.registration.id}`;
    stripeMock.checkoutCreate.mockClear();
    const first = await sweepRegistrations("http://test.local");
    expect(first.reminded).toBe(1);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // fresh session for the email
    const second = await sweepRegistrations("http://test.local");
    expect(second.reminded).toBe(0); // reminded_at guard

    // Past the deadline → expired + waitlist promoted with a fresh window.
    await sql`update registrations set expires_at = now() - interval '1 hour'
              where id = ${a.registration.id}`;
    const res = await sweepRegistrations("http://test.local");
    expect(res.expired).toBe(1);
    expect(res.promoted).toBe(1);
    const [aRow] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${a.registration.id}`;
    expect(aRow.status).toBe("expired");
    const [bRow] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${b.registration.id}`;
    expect(bRow.status).toBe("pending");
    expect(bRow.amount_cents).toBe(500);
    expect(bRow.expires_at).not.toBeNull();

    // A sweep with nothing due is a no-op.
    const idle = await sweepRegistrations("http://test.local");
    expect(idle).toEqual({ reminded: 0, expired: 0, promoted: 0 });
  });

  it("reconciles by session from /r/[ref] (token-free return)", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    const ref = res.registration.ref_code as string;
    const session = fakeSession(res.registration.id, 500);

    // Mismatched session (different registration) → no-op.
    stripeMock.checkoutRetrieve.mockResolvedValueOnce({
      ...session, metadata: { kind: "registration", registration_id: randomUUID() },
    });
    expect(await reconcileRegistrationBySession(ref, session.id)).toBe(false);

    stripeMock.checkoutRetrieve.mockResolvedValueOnce(session);
    expect(await reconcileRegistrationBySession(ref, session.id)).toBe(true);
    const [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.status).toBe("confirmed");
  });

  it("status view drives the pay CTA: card pendings can pay, offline sees instructions", async () => {
    const { orgId, orgSlug, competition, division } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    let view = await publicRegistrationStatus(res.registration.id, res.access_token);
    expect(view.can_pay_online).toBe(true);
    expect(view.payment_method).toBe("stripe");
    expect(view.expires_at).not.toBeNull();
    expect(view.payment_instructions).toBeNull(); // card entries never show bank details

    // Connect breaks → CTA hides (resume would 503 anyway).
    await sql`update organizations set stripe_charges_enabled = false where id = ${orgId}`;
    view = await publicRegistrationStatus(res.registration.id, res.access_token);
    expect(view.can_pay_online).toBe(false);
  });

  it("dispute lifecycle: created flags + audits, lost writes the money off", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const intent = "pi_test_" + res.registration.id.slice(0, 8);

    await handleRegistrationDispute(
      { id: "dp_1", payment_intent: intent, amount: 500, status: "needs_response" } as unknown as Stripe.Dispute,
      "created",
    );
    let [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.disputed_at).not.toBeNull();
    expect(row.dispute_id).toBe("dp_1");

    // Won → flag clears, id stays for the audit trail.
    await handleRegistrationDispute(
      { id: "dp_1", payment_intent: intent, amount: 500, status: "won" } as unknown as Stripe.Dispute,
      "closed",
    );
    [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.disputed_at).toBeNull();
    expect(row.dispute_id).toBe("dp_1");

    // Lost → money is gone: refunded_cents mirrors the full amount.
    await handleRegistrationDispute(
      { id: "dp_1", payment_intent: intent, amount: 500, status: "needs_response" } as unknown as Stripe.Dispute,
      "created",
    );
    await handleRegistrationDispute(
      { id: "dp_1", payment_intent: intent, amount: 500, status: "lost" } as unknown as Stripe.Dispute,
      "closed",
    );
    [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.refunded_cents).toBe(500);
  });

  it("charge.refunded from the Stripe dashboard syncs refunded_cents", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const intent = "pi_test_" + res.registration.id.slice(0, 8);

    await syncRegistrationRefund(
      { payment_intent: intent, amount_refunded: 300 } as unknown as Stripe.Charge,
    );
    const [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(row.refunded_cents).toBe(300);

    // Never regresses below what we already recorded.
    await syncRegistrationRefund(
      { payment_intent: intent, amount_refunded: 100 } as unknown as Stripe.Charge,
    );
    const [after] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${res.registration.id}`;
    expect(after.refunded_cents).toBe(300);
  });

  it("waitlisted card submits take no window and no payment", async () => {
    const { orgSlug, competition, division } = await stripeRig({ capacity: 1 });
    await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://test.local");
    stripeMock.checkoutCreate.mockClear();
    const second = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id, contact_email: "second@test.local",
    }, "http://test.local");
    expect(second.registration.status).toBe("waitlisted");
    expect(second.checkout_url).toBeNull();
    expect(second.registration.expires_at).toBeNull();
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dispute loss recovery (PROMPT-55): lost card disputes reverse the club's
// transfer so the platform only eats Stripe's dispute fee.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("dispute loss recovery (PROMPT-55)", () => {
  /** Paid card registration + the Stripe objects a lost dispute resolves. */
  async function disputedRig(feeCents = 2000) {
    const rigged = await stripeRig({ feeCents });
    const res = await submitRegistration(rigged.orgSlug, rigged.competition.slug, {
      ...SUBMIT_BASE, division_id: rigged.division.id,
    }, "http://test.local");
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, feeCents));
    const intent = "pi_test_" + res.registration.id.slice(0, 8);
    const chargeId = "ch_" + res.registration.id.slice(0, 8);
    const transferId = "tr_" + res.registration.id.slice(0, 8);
    // Verified against the live API in test mode (2026-07-14): destination
    // charges transfer the FULL amount; the application fee is collected from
    // the connected account separately — so the club's net is
    // transfer.amount − application_fee_amount.
    stripeMock.chargeRetrieve.mockResolvedValue({
      id: chargeId, amount: feeCents, application_fee_amount: 100,
      transfer: { id: transferId, amount: feeCents, amount_reversed: 0 },
    });
    return { ...rigged, regId: res.registration.id, intent, chargeId, transferId };
  }

  const disputeObj = (over: Record<string, unknown>) =>
    ({ status: "lost", ...over }) as unknown as Stripe.Dispute;

  async function auditRows(type: string, regId: string) {
    return sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = ${type} and payload->>'registration_id' = ${regId}`;
  }

  it("lost dispute reverses the club's net share with a dispute-scoped idempotency key", async () => {
    const { regId, orgId, intent, chargeId, transferId } = await disputedRig();
    await handleRegistrationDispute(disputeObj({
      id: "dp_r1", payment_intent: intent, charge: chargeId, amount: 2000,
      status: "needs_response",
    }), "created");
    await handleRegistrationDispute(disputeObj({
      id: "dp_r1", payment_intent: intent, charge: chargeId, amount: 2000,
    }), "closed");

    const [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${regId}`;
    expect(row.refunded_cents).toBe(2000);

    expect(stripeMock.chargeRetrieve).toHaveBeenCalledWith(chargeId, { expand: ["transfer"] });
    expect(stripeMock.reversalCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.reversalCreate).toHaveBeenCalledWith(
      transferId,
      {
        amount: 1900, // 2000 transfer − 100 app fee: the net the club received
        metadata: { dispute_id: "dp_r1", registration_id: regId },
      },
      { idempotencyKey: "dispute-reversal-dp_r1" },
    );

    const recovered = await auditRows("registration.dispute_recovered", regId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].payload).toMatchObject({
      dispute_id: "dp_r1", transfer_id: transferId, reversed_cents: 1900,
    });

    // Organiser hears about the loss + recovery — addressed to the current
    // owner (org_members), not organizations.created_by.
    const [owner] = await sql<{ email: string }[]>`
      select u.email from org_members m join users u on u.id = m.user_id
      where m.org_id = ${orgId} and m.role = 'owner'`;
    expect(emailMock.disputeLost).toHaveBeenCalledTimes(1);
    expect(emailMock.disputeLost).toHaveBeenCalledWith(
      expect.objectContaining({ to: owner.email, amountCents: 2000, recoveredCents: 1900 }),
    );
  });

  it("write-off lands even when the reversal throws (recovery_failed audited)", async () => {
    const { regId, intent, chargeId } = await disputedRig();
    stripeMock.reversalCreate.mockRejectedValue(new Error("stripe down"));
    await handleRegistrationDispute(disputeObj({
      id: "dp_r2", payment_intent: intent, charge: chargeId, amount: 2000,
    }), "closed");

    const [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${regId}`;
    expect(row.refunded_cents).toBe(2000); // the write-off never depends on Stripe

    expect(await auditRows("registration.dispute_recovered", regId)).toHaveLength(0);
    const failed = await auditRows("registration.dispute_recovery_failed", regId);
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.error).toContain("stripe down");
    expect(emailMock.disputeLost).toHaveBeenCalledWith(
      expect.objectContaining({ recoveredCents: 0 }),
    );
  });

  it("replayed lost event short-circuits on the metadata guard — one reversal, one email", async () => {
    const { regId, intent, chargeId, transferId } = await disputedRig();
    stripeMock.reversalList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        data: [{ id: "trr_prior", amount: 1900, metadata: { dispute_id: "dp_r3" } }],
      });
    const lost = disputeObj({
      id: "dp_r3", payment_intent: intent, charge: chargeId, amount: 2000,
    });
    await handleRegistrationDispute(lost, "closed");
    await handleRegistrationDispute(lost, "closed"); // /admin/billing-events replay

    expect(stripeMock.reversalCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.reversalList).toHaveBeenCalledWith(transferId, { limit: 100 });
    expect(await auditRows("registration.dispute_recovered", regId)).toHaveLength(1);
    expect(emailMock.disputeLost).toHaveBeenCalledTimes(1);
  });

  it("partial dispute reverses the proportional net share, capped by the unreversed remainder", async () => {
    const a = await disputedRig();
    await handleRegistrationDispute(disputeObj({
      id: "dp_r4", payment_intent: a.intent, charge: a.chargeId, amount: 500,
    }), "closed");
    // 500 of 2000 disputed → club's net share = 500 × 1900/2000 = 475.
    expect(stripeMock.reversalCreate).toHaveBeenCalledWith(
      a.transferId, expect.objectContaining({ amount: 475 }), expect.anything(),
    );

    // Mostly-reversed transfer: never exceed what's left.
    const b = await disputedRig();
    stripeMock.chargeRetrieve.mockResolvedValue({
      id: b.chargeId, amount: 2000, application_fee_amount: 100,
      transfer: { id: b.transferId, amount: 2000, amount_reversed: 1800 },
    });
    await handleRegistrationDispute(disputeObj({
      id: "dp_r5", payment_intent: b.intent, charge: b.chargeId, amount: 500,
    }), "closed");
    expect(stripeMock.reversalCreate).toHaveBeenLastCalledWith(
      b.transferId, expect.objectContaining({ amount: 200 }), expect.anything(),
    );
  });

  it("no transfer on the charge → skip with an audit note, no reversal call", async () => {
    const { regId, intent, chargeId } = await disputedRig();
    stripeMock.chargeRetrieve.mockResolvedValue({
      id: chargeId, amount: 2000, application_fee_amount: null, transfer: null,
    });
    await handleRegistrationDispute(disputeObj({
      id: "dp_r6", payment_intent: intent, charge: chargeId, amount: 2000,
    }), "closed");

    expect(stripeMock.reversalCreate).not.toHaveBeenCalled();
    const skipped = await auditRows("registration.dispute_recovery_skipped", regId);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe("no_transfer");
    const [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${regId}`;
    expect(row.refunded_cents).toBe(2000);
  });

  it("won dispute never touches transfers", async () => {
    const { regId, intent, chargeId } = await disputedRig();
    await handleRegistrationDispute(disputeObj({
      id: "dp_r7", payment_intent: intent, charge: chargeId, amount: 2000,
      status: "needs_response",
    }), "created");
    await handleRegistrationDispute(disputeObj({
      id: "dp_r7", payment_intent: intent, charge: chargeId, amount: 2000, status: "won",
    }), "closed");

    expect(stripeMock.chargeRetrieve).not.toHaveBeenCalled();
    expect(stripeMock.reversalCreate).not.toHaveBeenCalled();
    expect(emailMock.disputeLost).not.toHaveBeenCalled();
    const [row] = await sql<RegistrationRow[]>`
      select * from registrations where id = ${regId}`;
    expect(row.refunded_cents).toBe(0);
    expect(row.disputed_at).toBeNull();
  });

  it("dispute-lost email goes to the CURRENT owner after a transfer-owner flip", async () => {
    const { regId, orgId, intent, chargeId } = await disputedRig();
    const newOwnerId = await makeUser("newowner");
    await sql`update org_members set role = 'admin'
              where org_id = ${orgId} and role = 'owner'`;
    await sql`insert into org_members (org_id, user_id, role)
              values (${orgId}, ${newOwnerId}, 'owner')`;
    const [{ email: newOwnerEmail }] = await sql<{ email: string }[]>`
      select email from users where id = ${newOwnerId}`;

    await handleRegistrationDispute(disputeObj({
      id: "dp_r8", payment_intent: intent, charge: chargeId, amount: 2000,
    }), "closed");

    expect(emailMock.disputeLost).toHaveBeenCalledTimes(1);
    expect(emailMock.disputeLost).toHaveBeenCalledWith(
      expect.objectContaining({ to: newOwnerEmail }),
    );
    expect(await auditRows("registration.dispute_recovered", regId)).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("per-registrant email locale (cycle 47)", () => {
  async function openDivision(owner: AuthCtx, divisionId: string) {
    await putRegistrationSettings(owner, divisionId, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: 8, refund_lock_at: null,
    });
  }

  it("freezes the registrant's explicit locale pick on the row", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await openDivision(owner, division.id);
    const res = await submitRegistration(
      orgSlug, competition.slug,
      { ...SUBMIT_BASE, division_id: division.id },
      "http://t.local",
      { locale: "fr" },
    );
    expect(res.registration.locale).toBe("fr");
  });

  it("falls back to the org's default locale when the registrant made no pick", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await openDivision(owner, division.id);
    const res = await submitRegistration(
      orgSlug, competition.slug,
      { ...SUBMIT_BASE, division_id: division.id },
      "http://t.local",
    );
    expect(res.registration.locale).toBe("en"); // fresh org default_locale
  });
});
