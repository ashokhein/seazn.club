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
  return {
    checkoutCreate,
    checkoutRetrieve,
    refundCreate,
    stripe: {
      checkout: { sessions: { create: checkoutCreate, retrieve: checkoutRetrieve } },
      refunds: { create: refundCreate },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

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
  platformFeePercent,
  validateAnswers,
  putRegistrationSettings,
  getRegistrationSettings,
  publicRegistrationInfo,
  submitRegistration,
  publicRegistrationStatus,
  handleRegistrationCheckoutCompleted,
  withdrawRegistrationPublic,
  confirmRegistration,
  waitlistRegistration,
  refundRegistration,
  listRegistrations,
  exportRegistrationsCsv,
  registrationIcs,
  type RegistrationRow,
} from "../registrations";

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

  it("defaults to 5% when PLATFORM_FEE_PERCENT is unset/garbage", () => {
    const prev = process.env.PLATFORM_FEE_PERCENT;
    delete process.env.PLATFORM_FEE_PERCENT;
    expect(platformFeePercent()).toBe(5);
    process.env.PLATFORM_FEE_PERCENT = "nonsense";
    expect(platformFeePercent()).toBe(5);
    process.env.PLATFORM_FEE_PERCENT = "12";
    expect(platformFeePercent()).toBe(12);
    if (prev === undefined) delete process.env.PLATFORM_FEE_PERCENT;
    else process.env.PLATFORM_FEE_PERCENT = prev;
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

  it("Community org: saving an entry fee → 402 registration.paid; free registration still works", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await expect(
      putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "usd",
        form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      }),
    ).rejects.toThrow(PaymentRequiredError);

    await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
    });
    const res = await submitRegistration(orgSlug, competition.slug, {
      ...SUBMIT_BASE, division_id: division.id,
    }, "http://t.local");
    expect(res.registration.status).toBe("pending");
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
});
