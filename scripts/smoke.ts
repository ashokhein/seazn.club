// End-to-end smoke test against the running dev server (http://localhost:3000).
// Run with: node --experimental-strip-types scripts/smoke.ts
//
// Teardown: when DATABASE_URL is set (CI, or `node --env-file=.env.local`), the
// run's own test users + their orgs are purged afterwards (see cleanup). The DB
// must be the same one the target server uses.
import { createHmac } from "node:crypto";
import postgres from "postgres";
import {
  startAiFixtureServer,
  FIXTURE_COMPILE_BRIEF,
  type AiFixtureServer,
} from "../apps/web/e2e/ai-fixture-server.ts";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

/**
 * A REAL Stripe test-mode connected account id (`acct_…`) with charges enabled.
 *
 * Holding a secret key is NOT the same as having a usable Connect destination:
 * `setConnect` fabricates an `acct_smoke_*` id, which satisfies every
 * "is this org onboarded?" gate in the app but exists in no Stripe account, so
 * any destination charge against it is rejected with `resource_missing`.
 * Creating one headlessly does not help either — a fresh Express account has
 * `charges_enabled: false` until a human finishes onboarding.
 *
 * Supply this to exercise the real Connect checkout; without it, smoke skips
 * (rather than fails) the destination-charge assertion — the check still
 * counts either way. `organizations.stripe_account_id` is UNIQUE, so it is
 * handed to exactly one org per run (sponsorSuite's pro org). See `setConnect`.
 */
const CONNECT_TEST_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT;

interface Session {
  cookies: Record<string, string>;
}
const newSession = (): Session => ({ cookies: {} });
const cookieHeader = (s: Session) =>
  Object.entries(s.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

async function raw(
  s: Session,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{
  status: number;
  // `issues` is the ZodError detail lib/http.ts attaches to a schema rejection.
  // Carried so a check can assert WHICH field was rejected: "Invalid input" is
  // zod's blanket message, so on its own it cannot tell a rejected `pass_key`
  // from a rejected anything-else.
  json: { ok: boolean; data?: unknown; error?: string; issues?: { path?: unknown[] }[] };
}> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (!m) continue;
    if (m[2] === "") delete s.cookies[m[1]];
    else s.cookies[m[1]] = m[2];
  }
  const json = await res.json().catch(() => ({ ok: false, error: "no json" }));
  return { status: res.status, json };
}

async function call(s: Session, path: string, method = "GET", body?: unknown) {
  const { json } = await raw(s, path, method, body);
  if (json.ok === false) throw new Error(`${path}: ${json.error}`);
  return json.data;
}

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  cond ? pass++ : fail++;
};
async function expectFail(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false);
  } catch {
    check(label, true);
  }
}

/**
 * Passwordless sign-in: request a magic link, then consume the dev-exposed
 * token (dev returns `login_url` so the flow is testable without email). An
 * unknown email creates the account. Returns the consume payload and leaves the
 * session cookie on `s`.
 */
async function signIn(s: Session, email: string) {
  const req = (await call(s, "/api/auth/magic-link", "POST", { email })) as {
    login_url?: string;
  };
  const token = new URL(req.login_url ?? "").searchParams.get("token");
  return (await call(s, "/api/auth/magic-link/consume", "POST", { token })) as {
    has_org: boolean;
    org_id: string;
    redirect: string;
  };
}

const tag = Date.now().toString(36);

async function main() {
  const admin = newSession();

  // --- Auth: passwordless sign-in for a fresh owner (link -> consume) ---
  const ver = await signIn(admin, `admin_${tag}@example.com`);
  check("admin signed in (passwordless)", !!admin.cookies["seazn_session"]);
  // A default org is auto-provisioned on first sign-in (no forced form).
  check("default org auto-provisioned", !!ver.org_id && ver.has_org === true);
  check("active org cookie set", admin.cookies["seazn_org"] === ver.org_id);
  // A brand-new account (no onboarding completed) lands on the first-run wizard.
  check("new user routed to onboarding", ver.redirect === "/onboarding");
  // GDPR (spec 2026-07-14): requesting the magic link under the clickwrap
  // notice stamps terms acceptance on the account.
  await checkTermsStamp(`admin_${tag}@example.com`);
  const org = { id: ver.org_id };

  // --- Competition lifecycle guards (v2 service layer) ---
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Perm Probe ${tag}`,
  });
  check("owner creates competition", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;

  const del = await v1(admin, `/api/v1/competitions/${compId}`, "DELETE");
  check("unscored competition deletable", del.status === 200 || del.status === 204);
  const gone = await v1(admin, `/api/v1/competitions/${compId}`);
  check("deleted competition gone", gone.status === 404);

  // A competition to probe viewer permissions against.
  const probe = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Viewer Probe ${tag}`,
  });
  const probeId = v1data<{ id: string }>(probe).id;

  // =====================================================================
  // Team management: invites + role enforcement
  // =====================================================================

  // Create a viewer invite and a second user that joins with it.
  const viewerInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "viewer",
    max_uses: 1,
  })) as { token: string };
  check("viewer invite created", !!viewerInvite.token);

  const viewer = newSession();
  const viewerEmail = `viewer_${tag}@example.com`;
  // Requesting a link creates the account but grants no session until consumed.
  const vlink = (await call(viewer, "/api/auth/magic-link", "POST", {
    email: viewerEmail,
  })) as { login_url?: string };
  check("no session before consuming link", !viewer.cookies["seazn_session"]);
  await expectFail("bogus magic token rejected", () =>
    call(newSession(), "/api/auth/magic-link/consume", "POST", {
      token: "not-a-real-token-000000000000",
    }),
  );
  const vtoken = new URL(vlink.login_url ?? "").searchParams.get("token");
  await call(viewer, "/api/auth/magic-link/consume", "POST", { token: vtoken });
  check("session created after consuming link", !!viewer.cookies["seazn_session"]);
  await expectFail("magic link is single-use", () =>
    call(newSession(), "/api/auth/magic-link/consume", "POST", {
      token: vtoken,
    }),
  );

  const accept = (await call(viewer, `/api/invites/${viewerInvite.token}/accept`, "POST")) as {
    role: string;
  };
  check("viewer joined as viewer", accept.role === "viewer");
  check("viewer active org set", viewer.cookies["seazn_org"] === org.id);

  // Viewer can read but cannot write (doc 08 §2: write needs an editor role).
  const viewerRead = await v1(viewer, `/api/v1/competitions/${probeId}`);
  check("viewer can read competitions", viewerRead.status === 200);
  const viewerWrite = await v1(viewer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: "Nope",
  });
  check(
    "viewer cannot create competition",
    viewerWrite.status === 401 || viewerWrite.status === 403,
  );
  const viewerPatch = await v1(viewer, `/api/v1/competitions/${probeId}`, "PATCH", {
    name: "Nope",
  });
  check("viewer cannot edit competition", viewerPatch.status === 401 || viewerPatch.status === 403);
  // The single-use invite is now spent.
  await expectFail("single-use invite is spent", () =>
    call(newSession(), `/api/invites/${viewerInvite.token}/accept`, "POST"),
  );

  // Invite-by-email (team settings): personal invite, single-use forced,
  // address stored; email_sent reports the Resend outcome (false with a blank
  // key — the UI then offers the personal link for manual sharing).
  const emailInvitee = `emailinvitee_${tag}@example.com`;
  const emailInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "viewer",
    email: emailInvitee,
  })) as {
    token: string;
    email: string | null;
    max_uses: number;
    email_sent?: boolean;
  };
  check("email invite stores address", emailInvite.email === emailInvitee);
  check("email invite forced single-use", emailInvite.max_uses === 1);
  check("email invite reports send status", typeof emailInvite.email_sent === "boolean");
  // Personal: only the invited address may accept — anyone else holding the
  // link (here: the admin who minted it) is turned away with a 403.
  await expectFail("email invite rejects a different account", () =>
    call(admin, `/api/invites/${emailInvite.token}/accept`, "POST", {}),
  );

  // One-click claim (auto-login + join) for a brand-new email invitee: the
  // emailed link proves the inbox, so no separate sign-in round-trip is needed.
  // A fresh session that has never authenticated posts the claim and comes back
  // both signed in and a member.
  const claimer = newSession();
  const claimed = (await call(
    claimer,
    `/api/invites/${emailInvite.token}/claim`,
    "POST",
  )) as { needs_signin?: boolean; role?: string };
  check("email invite claim signs the new invitee in", !!claimer.cookies["seazn_session"]);
  check("email invite claim joins with the invite role", claimed.role === "viewer");
  check("email invite claim sets the active org", claimer.cookies["seazn_org"] === org.id);
  // Single-use: the now-spent invite refuses a second claim.
  await expectFail("email invite claim is single-use", () =>
    call(newSession(), `/api/invites/${emailInvite.token}/claim`, "POST"),
  );
  // The claim just joined the invitee as a real member of `org`, consuming a
  // member seat the rest of this suite budgets for: free-plan members.max is 3
  // (owner + the viewer above + the admin invited below), so leaving the invitee
  // in would 402 that admin's accept on members.max and abort the whole run. The
  // auto-join is already asserted — release the seat so the downstream member
  // arithmetic (and "org has 3 members") is exactly as it was before this block.
  const seatDb = smokeDb();
  try {
    await seatDb`
      delete from org_members
      where org_id = ${org.id}
        and user_id in (select id from users where email = ${emailInvitee})`;
  } finally {
    await seatDb.end();
  }

  // Invite-by-link (team settings): multi-use with a 24-hour expiry — it must
  // outlive the tab that created it and stay listed for later copying.
  const linkInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "viewer",
    max_uses: 0,
    expires_in_days: 1,
  })) as { token: string; expires_at: string | null };
  const linkTtlMs = new Date(linkInvite.expires_at ?? 0).getTime() - Date.now();
  check("link invite lives ~24 hours", linkTtlMs > 0.9 * 864e5 && linkTtlMs < 1.1 * 864e5);
  const teamInvites = (await call(admin, `/api/orgs/${org.id}/invites`)) as {
    token: string;
    email: string | null;
  }[];
  check(
    "team panel lists both pending invites",
    teamInvites.some((i) => i.token === emailInvite.token && i.email === emailInvitee) &&
      teamInvites.some((i) => i.token === linkInvite.token && i.email === null),
  );

  // Admin invite -> a second user joins and CAN create a competition. Retire
  // the viewer probe first: the check is about the ROLE, and the v3 free cap
  // (1 active competition) would 402 the create on quota instead.
  await v1(admin, `/api/v1/competitions/${probeId}`, "PATCH", {
    status: "archived",
  });
  const adminInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "admin",
    max_uses: 0,
  })) as { token: string };
  const member = newSession();
  await signIn(member, `member_${tag}@example.com`);
  await call(member, `/api/invites/${adminInvite.token}/accept`, "POST");
  const memberComp = await v1(member, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Member Made ${tag}`,
  });
  check("invited admin can create competition", memberComp.status === 201);

  // Members listing reflects 3 people (owner + viewer + admin).
  const members = (await call(admin, `/api/orgs/${org.id}/members`)) as {
    role: string;
  }[];
  check("org has 3 members", members.length === 3);
  check("exactly one owner", members.filter((m) => m.role === "owner").length === 1);

  // --- Multi-org quota (doc 13 §5, PROMPT-18): a community owner is capped
  // at one owned org; upgrading the owned org lifts the cap (creation is
  // judged against the creating user's best owned-org plan).
  await expectFail("second org blocked on community (orgs.max_owned)", () =>
    call(admin, "/api/orgs", "POST", { name: `Blocked Org ${tag}` }),
  );
  await setPlan(org.id, "pro", admin);

  // --- Multi-org: a Pro owner may create additional orgs; slug is auto-assigned ---
  const org2 = (await call(admin, "/api/orgs", "POST", {
    name: `Second Org ${tag}`,
  })) as { id: string; slug: string };
  check("can create additional org", !!org2.id);
  check("org slug readable (PROMPT-30)", org2.slug.startsWith("second-org"));
  check("creating org switches active", admin.cookies["seazn_org"] === org2.id);
  const myOrgs = (await call(admin, "/api/orgs")) as { id: string }[];
  check("admin now belongs to 2 orgs", myOrgs.length === 2);
  // Rename the active org; the slug regenerates and the old one redirects
  // (PROMPT-30, v3/01 §2).
  const renamed = (await call(admin, `/api/orgs/${org2.id}`, "PATCH", {
    name: `Renamed Org ${tag}`,
  })) as { name: string; slug: string };
  check("org renamed", renamed.name === `Renamed Org ${tag}`);
  check(
    "rename regenerates slug",
    renamed.slug !== org2.slug && renamed.slug.startsWith("renamed-org"),
  );
  const oldConsole = await pageRedirect(admin, `/o/${org2.slug}`);
  check(
    "old org slug 301s on the console",
    oldConsole.status >= 301 &&
      oldConsole.status <= 308 &&
      (oldConsole.location ?? "").includes(`/o/${renamed.slug}`),
  );

  // --- Billing groups (#212): individual-by-default, sharing is opt-in. Before
  // #212 (V309/V310) a Pro owner's second org was silently dropped onto the
  // payer's EXISTING group and inherited Pro for the $9 tier the moment it was
  // born. That auto-join is GONE: `createOrgForUser` now mints every new org its
  // OWN community group, and joining a payer's group is a deliberate attach.
  //
  // This block proves the whole round trip in the NEW order — born individual,
  // opt-in attached, detached back to individual — because nothing else in smoke
  // would notice if the default regressed. Every other org here has its plan
  // forced by setPlan, so a second org quietly auto-joining (or quietly failing
  // to attach) would still pass every downstream assertion. Step 1 is exactly
  // the #212 regression check the old block was missing: it used to assert org2
  // was Pro straight after creation, which was the auto-join behaviour itself.
  {
    // 1. THE DEFAULT (#212). A brand-new org is born on its OWN community bill,
    // not the payer's Pro group. Its status is 'active' — a community group is a
    // real, active subscription row that simply resolves to the free plan.
    const org2Sub = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
      status: string;
    };
    check(
      "billing-group: a brand-new org starts on its own community bill, not the payer's group (#212)",
      org2Sub.plan_key === "community" && org2Sub.status === "active",
    );

    // 2. The payer's group, and proof org2 is on a DIFFERENT one. `GET
    // /api/billing/groups` is payer-gated and lists every group admin pays for,
    // so both the Pro payer group (org) and org2's fresh community group appear
    // here. It is also the only endpoint that returns the internal
    // `subscription_id` the attach below needs — `/api/orgs/[id]/subscription`
    // deliberately does not (it is member-gated and drops the payer's handles).
    // Smoke sets plans by SQL and never calls Stripe, so the payer group carries
    // no live subscription.
    type GroupListing = {
      id: string;
      quantity_paid: number;
      has_live_subscription: boolean;
      orgs: { id: string }[];
    };
    const beforeAttach = (await call(admin, "/api/billing/groups")) as GroupListing[];
    const payerGroup = beforeAttach.find((g) => g.orgs.some((o) => o.id === org.id));
    const org2Group = beforeAttach.find((g) => g.orgs.some((o) => o.id === org2.id));
    check("billing-group: GET /api/billing/groups lists the payer's group", !!payerGroup);
    check(
      "billing-group: the payer's group has no live Stripe subscription in smoke",
      payerGroup?.has_live_subscription === false,
    );
    // The #212 default, at the group level: org2's subscription_id is a group of
    // its own, distinct from the one the payer bills through.
    check(
      "billing-group: a brand-new org is on its own group, distinct from the payer's (#212)",
      !!org2Group && !!payerGroup && org2Group.id !== payerGroup.id,
    );

    // v17 gap #285: the group wallet a joining org leaves behind must not be
    // stranded — its balance has to land in the group's shared wallet, not
    // vanish on a subscription row nothing can resolve to any more.
    // The +7 is a deliberate top-up on TOP of the community grant org2 was
    // born with, so the balance under test is not a round plan number that
    // could coincide with a re-grant: the merge has to carry the org's WHOLE
    // wallet, grant included, not just the part smoke put there.
    await topUpWallet(org2.id, 7);
    const org2OldWalletId = org2Group!.id;
    const org2BalanceBeforeAttach = await walletBalance(org2.id);
    const groupBalanceBeforeAttach = await walletBalance(org.id);
    // Pin the linkage BEFORE the move: org2's balance really does live on the
    // wallet id we are about to assert is emptied. Without this, the post-attach
    // "old wallet holds nothing" check passes for the wrong reasons — a wallet
    // that was always empty, or one whose row was deleted rather than drained.
    check(
      "billing-group: the joining org's balance sits on the old group's wallet before the attach (#285)",
      (await walletBalanceByWalletId(org2OldWalletId)) === org2BalanceBeforeAttach &&
        org2BalanceBeforeAttach > 0,
    );

    // 3. OPT-IN ATTACH. The payer pulls org2 into their Pro group explicitly —
    // the deliberate step that used to happen automatically. No live Stripe
    // subscription here, so nothing is charged: `charged` is always false, and
    // whether a re-add into a freed slot is BILLED only exists on a group with a
    // live subscription — that is the DB-backed unit suite's job
    // (billing-group-move.test.ts), not smoke's. Smoke's job is that the HTTP
    // round trip itself works and actually moves the org.
    const attached = (await call(admin, "/api/billing/group/attach", "POST", {
      org_id: org2.id,
      subscription_id: payerGroup!.id,
    })) as { subscription_id: string; quantity: number; charged: boolean };
    check(
      "billing-group: attach moves the org into the payer's group",
      attached.subscription_id === payerGroup!.id && attached.charged === false,
    );
    check(
      "billing-group: attach merges the joining org's wallet balance into the group's (#285)",
      (await walletBalance(org.id)) ===
        groupBalanceBeforeAttach + org2BalanceBeforeAttach,
    );
    check(
      "billing-group: the joining org's OLD wallet is left holding nothing, not stranded (#285)",
      (await walletBalanceByWalletId(org2OldWalletId)) === 0,
    );

    // 4. ONLY NOW does org2 inherit the group's plan — and through the RESOLVER,
    // not merely the same plan NAME. A per-org plan column set to 'pro' would
    // satisfy the subscription check; only the entitlements resolver proves the
    // org is billing through the group. Quotas stay PER ORG — that headroom is
    // what the extra half-price seat buys, and confusing shared-vs-per-org would
    // make grouping look like a downgrade.
    const attachedSub = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
      status: string;
    };
    check(
      "billing-group: an attached org inherits the payer's plan, not community",
      attachedSub.plan_key === "pro" && attachedSub.status === "active",
    );
    const org2Ent = (await call(admin, `/api/orgs/${org2.id}/entitlements`)) as {
      plan_key: string;
      entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
    };
    check(
      "billing-group: the attached org resolves the group's entitlements",
      org2Ent.plan_key === "pro" && org2Ent.entitlements["exports.branded"]?.enabled === true,
    );
    check(
      "billing-group: quotas are per org, not shared across the group",
      org2Ent.entitlements["members.max"]?.limit === 15,
    );

    // 5. The listing now shows BOTH orgs on the group, and quantity_paid is
    // untouched (a relationship, not a magic number — see the AGENTS brief). It
    // is only ever written once Stripe confirms the item, and this group has no
    // live subscription, so an attach must leave it exactly where it was rather
    // than inflate it to match the new (larger) org count.
    const afterAttach = (await call(admin, "/api/billing/groups")) as GroupListing[];
    const regrouped = afterAttach.find((g) => g.id === payerGroup!.id);
    check(
      "billing-group: the listing now shows both orgs on the group",
      !!regrouped &&
        regrouped.orgs.some((o) => o.id === org.id) &&
        regrouped.orgs.some((o) => o.id === org2.id),
    );
    check(
      "billing-group: quantity_paid is untouched by an attach with no live subscription",
      regrouped?.quantity_paid === payerGroup!.quantity_paid,
    );

    // 6. DETACH back out, onto a billing group of its own. The old group is
    // still paying for org1, so it must NOT be cancelled. And with no
    // current_period_end and no comped_until on a SQL-set plan there is no
    // paid-through date to inherit, so Community is the only safe landing —
    // detach must never mint a paid plan that nothing can ever expire.
    // `mode: "release"` exercises the removal-mode param end to end; on a group
    // with no live subscription both modes land the org in Community and leave
    // the payer's freed slot reusable, which the re-attach below then proves.
    const detached = (await call(admin, "/api/billing/group/detach", "POST", {
      org_id: org2.id,
      mode: "release",
    })) as { subscription_id: string; cancelled_group: string | null };
    check("billing-group: detach gives the org a group of its own", !!detached.subscription_id);
    check(
      "billing-group: detaching one org leaves the payer's group alive",
      detached.cancelled_group === null,
    );
    const afterDetach = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
    };
    check(
      "billing-group: a detached org with no paid-through date lands on community",
      afterDetach.plan_key === "community",
    );

    // 7. FREED-SLOT re-attach idempotency. A detach frees the slot org2 held;
    // the endpoint is idempotent-safe on its cap and ownership checks and must
    // not refuse a repeat move just because the org has already been through
    // this group. No live subscription, so the freed-slot re-add still charges
    // nothing.
    const reAttached = (await call(admin, "/api/billing/group/attach", "POST", {
      org_id: org2.id,
      subscription_id: payerGroup!.id,
    })) as { subscription_id: string; quantity: number; charged: boolean };
    check(
      "billing-group: re-attaching a previously-detached org succeeds again",
      reAttached.subscription_id === payerGroup!.id,
    );
    check(
      "billing-group: the freed slot re-attach charges nothing (no live subscription)",
      reAttached.charged === false,
    );
    const backOnGroup = (await call(admin, "/api/billing/groups")) as GroupListing[];
    const regrouped2 = backOnGroup.find((g) => g.id === payerGroup!.id);
    check(
      "billing-group: the re-attached org is back on the payer's group",
      !!regrouped2 && regrouped2.orgs.some((o) => o.id === org2.id),
    );

    // Restore the invariant everything below this point depends on: org2 back on
    // a plain Community group of its own, exactly where the FIRST detach left it.
    // Every suite AFTER this block runs org2 as the FREE org — the v1 API 402
    // gate, the community theme checks, the division cap, the 'Powered by'
    // attribution — right up until the explicit setPlan(org2, "pro") further down
    // promotes it for jul3Suite onward. Leaving it attached would turn eight
    // paid-vs-free checks into assertions that silently prove nothing.
    const finalDetach = (await call(admin, "/api/billing/group/detach", "POST", {
      org_id: org2.id,
    })) as { subscription_id: string; cancelled_group: string | null };
    check(
      "billing-group: detaching again still leaves the payer's group alive",
      finalDetach.cancelled_group === null,
    );
    check(
      "billing-group: the round trip leaves org2 detached again for the suites below",
      !!finalDetach.subscription_id,
    );
    const finalOrg2Sub = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
    };
    check(
      "billing-group: org2 is back on community after the round trip",
      finalOrg2Sub.plan_key === "community",
    );
  }

  // --- CRON: the daily quantity reconcile (spec 2026-07-21 §Operations). Stripe
  // cuts every renewal invoice from the subscription item's own quantity and
  // reads nothing of ours at cycle time, so a drift nothing corrects bills wrong
  // for ever. Same secret gate as /api/cron/billing-events.
  {
    const wrongQty = await fetch(`${BASE}/api/cron/billing-quantity`, {
      method: "POST",
      headers: { "x-cron-secret": "definitely-wrong" },
    });
    check(
      "billing-group: cron billing-quantity rejects a wrong secret (401, or 503 unconfigured)",
      wrongQty.status === 401 || wrongQty.status === 503,
    );
    const qtySecret = process.env.CRON_SECRET;
    if (qtySecret) {
      const rightQty = await fetch(`${BASE}/api/cron/billing-quantity`, {
        method: "POST",
        headers: { "x-cron-secret": qtySecret },
      });
      const body = (await rightQty.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: { checked?: number; corrected?: number; failed?: number };
      };
      // No group here has a Stripe subscription (smoke sets plans by SQL), so
      // the sweep must find nothing to correct and nothing to fail. A non-zero
      // `failed` means it reached Stripe, which it should never do from smoke.
      check(
        "billing-group: cron billing-quantity sweeps and corrects nothing",
        rightQty.status === 200 &&
          body.ok === true &&
          body.data?.corrected === 0 &&
          body.data?.failed === 0,
      );
    }
  }

  // --- User timezone preference (spec 2026-07-14) — account-level, all plans ---
  {
    const saved = (await call(admin, "/api/users/me", "PATCH", {
      timezone: "Asia/Kolkata",
    })) as { timezone: string | null };
    check("pro: timezone saved", saved.timezone === "Asia/Kolkata");
    const cleared = (await call(admin, "/api/users/me", "PATCH", {
      timezone: null,
    })) as { timezone: string | null };
    check("pro: timezone clears to browser default", cleared.timezone === null);
    await expectFail("bogus timezone rejected", () =>
      call(admin, "/api/users/me", "PATCH", { timezone: "Mars/Phobos" }),
    );
    // The picker only ever writes canonical spellings now (lib/tz-data.ts
    // TZ_ALIAS), but rows written before it existed hold legacy ones — the API
    // must keep accepting them or those accounts break on their next save.
    const legacy = (await call(admin, "/api/users/me", "PATCH", {
      timezone: "Asia/Calcutta",
    })) as { timezone: string | null };
    check("pro: legacy zone spelling still accepted", legacy.timezone === "Asia/Calcutta");
    await call(admin, "/api/users/me", "PATCH", { timezone: null });
    // Free path: the viewer session is plan-agnostic for account settings.
    const vSaved = (await call(viewer, "/api/users/me", "PATCH", {
      timezone: "Europe/London",
    })) as { timezone: string | null };
    check("free: timezone saved", vSaved.timezone === "Europe/London");
    await call(viewer, "/api/users/me", "PATCH", { timezone: null });
  }

  // --- Platform API /api/v1 (PROMPT-11) — the full engine v2 lifecycle ---
  await v1Suite(admin, org2.id, renamed.slug);

  // --- Jul3 feature wave (PROMPT-21..28) over real HTTP ---
  // The advanced features are entitlement-gated — org2 must be Pro (and it
  // needs headroom past competitions.max_active for the extra competitions).
  // Since V310 org2 is already Pro through the group it was created into, and
  // the assertions above prove it. Kept anyway, deliberately: setPlan reprices
  // the GROUP, so this is a no-op that documents the requirement rather than a
  // second source of truth for it. If it ever starts mattering again, the
  // billing-group checks above have regressed first.
  await setPlan(org2.id, "pro", admin);
  await jul3Suite(admin, org2.id, renamed.slug);

  // --- Division delete/archive lifecycle (PROMPT-38, v3/09 §4): delete on a
  // free org lifts the divisions quota; archive/restore on the Pro org.
  await divisionLifecycleSuite(admin, org2.id);

  // --- v3 UI system (PROMPT-32): card grid render + visibility flip on both
  // plans — pro on org2, free on a fresh community owner.
  await uiSystemSuite(admin, renamed.slug);

  // --- v3 scheduling board + registration v2 (PROMPT-33/34): board render,
  // seq-tokened reschedule + stale 409, SZ refs + /r/[ref] on pro AND free.
  await schedRegV3Suite(admin, renamed.slug, org2.id);

  // --- #452 scheduling CONSTRAINT surface: a durable `constraints.hard` rule
  // on a real bracket and a pool-targeted `restByGroup` on a `group` stage,
  // asserted on auto / apply / board report / drag. Keyless (no model), own Pro
  // org, so it runs on every smoke invocation.
  await schedulingConstraintsSuite();

  // --- v10 sponsor CRM: tiers + placement + tracked clicks + Connect rail
  // on the pro org; flat free strip + 402 gates on a fresh community owner.
  await sponsorsSuite(admin, org2.id, renamed.slug);

  // --- v13 real-competition fidelity: badge + inline members, ad-hoc match,
  // knockout draw guard, bracket poster, signed audit (pro 200 / free 402),
  // public presentation mode.
  await v13Suite(admin, org2.id, renamed.slug);

  // --- v4 AI Schedule Architect (Task 18): two-phase happy path on a fresh Pro
  // Plus org (schedule ai-plan → apply+ledger → ai-last → officials draft) plus
  // the AI credit wallet 402 and a wallet top-up lift on a fresh community org
  // (v17 Phase 2, V320+ — replaced the old graded per-division run cap).
  // The T17 fixture server stands in for the model (needs the server booted with
  // SCHEDULING_AI_BASE_URL); the wallet 402 is keyless-safe and always runs.
  await v4AiSuite(admin, org2.id, renamed.slug);

  // --- #350 multi-division JOINT AI scheduling: the batch-discount price
  // (rungs 2+3 → 4 credits, budget sized from the undiscounted 5) and the
  // atomic apply on a fresh Pro Plus org, plus the two refusals that must
  // happen before any model call — a one-division request (400) and a wallet
  // that cannot cover the quote (402). The refusals are keyless-safe; the
  // priced run needs the T17 fixture server.
  await jointAiSuite();

  await pagePlayoffSuite(admin);

  // --- v16 SPEC-1 discipline: 5-yellow auto ban → confirm → public strip on
  // the Pro org; 402 + PlusReveal on a fresh community owner.
  await disciplineSuite(admin, org2.id, renamed.slug);

  // --- v16 SPEC-3 marks & reports: rate an accepted, decided official (Pro
  // 204 + summary avg) and file/submit a report (free) on org2; mark PUT 402
  // on a fresh community org while the report still files. Runs while org2 is
  // still Pro (the destructive downgrade is gapSuite, last).
  await marksReportsSuite(admin, org2.id, renamed.slug);

  // --- v16 SPEC-2 news: opt-in division auto-drafts a result on the decided
  // seam → publish → public feed/post/story.png on the Pro org; manual post
  // publishes free on a fresh community org, whose auto toggle is gated 402.
  await newsSuite(admin, org2.id, renamed.slug);

  // --- v3 content + API wave (PROMPT-35/37/39): markdown editor render,
  // /help + /developers, scoped keys, OG/poster/embed/sponsors — pro + free.
  await v3ContentApiSuite(admin, org2.id, renamed.slug);

  // --- pro-plus-tier (Task 11): community per-fixture-official + save-point
  // caps, api.write re-armed above Pro, Pro Plus lifting both — own fresh
  // org, restores its own plan before returning (shared-DB poison trap).
  await proPlusSuite();

  // --- PROMPT-36 pricing v3: free caps, Event Pass lift + scope isolation,
  // pro interplay, pass survival after downgrade — and the /start funnel
  // end-to-end (draft → claim link → inside the created competition).
  await pricingV3Suite();
  await funnelSuite();

  // --- PROMPT-40 marketing redesign (design/v3/12).
  await marketingSuite();

  // --- v5 i18n: marketing [lang] routing + translated copy.
  await i18nSuite();

  // --- Growth-wave gaps (device links, scorer seats, discovery, registration,
  // ownership transfer, downgrade freeze) — pro paths on org2, free paths on a
  // fresh community owner. Destructive downgrade runs last.
  // --- v8: division settings — format lock + logo upload URL.
  await divisionSettingsSuite(admin);

  // --- design/v6 PROMPT-48..50: tennis rally set (nested kernel), icehockey
  // OT points in standings, PP goal + release with the public strength chip.
  // Before gapSuite — needs the org's pro entitlements for tier-3 scoring.
  await v6SportsSuite(admin);

  // --- W4a (#425): the core time model over HTTP — icehockey penalty expiry
  // and the cross-period carry, football sin bins + Law 3 sub windows, ITTF
  // expedite, tennis Rule 30 interruptions, and the Pro gate on all four.
  // After v6SportsSuite (it seeds tennis/icehockey), before gapSuite (its
  // downgrade ends the org's pro entitlements, which Tier-2 scoring needs).
  await w4aTimeModelSuite(admin);

  // --- #451: DLS converts a division's own overs/wickets onto the published
  // table's fixed 6-ball/10-wicket scales. Its own Pro org (smoke's shared org
  // is community, and a DLS target needs `cricket.dls`), so placement is free.
  await cricketDlsSuite();

  // --- W4a follow-up (V347): the cfg a fixture is scored under is frozen on
  // its first event, so a later division-config edit can neither lock the
  // scorer out nor rewrite a published result — plus /admin's audited escape
  // hatch. Right after w4aTimeModelSuite (same class of defect), before
  // gapSuite's destructive downgrade.
  await configSnapshotSuite(admin, `admin_${tag}@example.com`);

  // --- design/v7 PROMPT-52: waitlist queue position + public count.
  // Before gapSuite — its destructive downgrade ends the org's pro quota.
  await regQueueSuite(admin);

  // --- PROMPT-53: player accounts — claim → RSVP → grid → QR check-in.
  // BEFORE gapSuite: its downgrade eats org2's competition headroom.
  await playerAccountsSuite(admin, org2.id);
  await officialOnboardingSuite(admin, org2.id, renamed.slug);

  // --- PLG growth loops (design/plg): attribution CTA + fan ShareBar on
  // free AND pro public pages, /me player→organiser nudge, /discover /start.
  await plgGrowthSuite(admin, org2.id, renamed.slug);

  // --- design/v9 PROMPT-55: dispute-loss recovery surfaces.
  await disputeSurfacesSuite();

  // --- #403: the data-protection disclosures that must be LIVE, not merely
  // written. Keyless-safe, no org, no AI spend.
  await dataProtectionCopySuite();

  // --- #404: the duplicate review queue and the reversible, ban-preserving
  // merge behind it. Its own fresh Pro org; keyless-safe, no AI spend.
  await personMergeSuite();

  // --- payments-hardening (PROMPT-72..75): the three delete-money 409 guards,
  // the DELETE-competition NEVER_KEY 403, community card division
  // payments_unavailable vs an Event-Pass comp staying open, and the
  // stuck-webhook sweep cron. Own fresh orgs; keyless-safe.
  await p72Suite();

  // --- payments-hardening (Task 16): the 4-plan user matrix — one fresh owner
  // per plan (community/pro/pro_plus/event_pass) asserting the entitlements that
  // distinguish its tier at the resolution + HTTP-status level. Own fresh orgs;
  // keyless-safe. The HTTP-level plan-truth net for the two e2e tasks that follow.
  await smokePlanMatrix();

  // --- Task 23: every grant an Event Pass actually delivers, asserted as a
  // passed-vs-sibling PAIR inside one fresh community org — allowed here,
  // refused there — so no assertion can be satisfied by a passless org. Own
  // fresh org; keyless-safe and spends no AI tokens.
  await passGrantsSuite();

  // --- v17 #294: the L rung. Proves the LADDER rather than the grants — a paid
  // purchase (driven through the real signed webhook) is filed as the rung that
  // was bought, that rung's ceilings are the ones enforced, the flat +25 credit
  // grant is not keyed by rung, and a pass stays inert on a paid plan. Own
  // fresh orgs; the purchase leg skips cleanly without Stripe secrets.
  await passRungLSuite();

  await gapSuite(admin, org.id, org2.id);

  // --- design/v7 PROMPT-51: staff-console platform revenue report.
  await platformRevenueSuite(admin, `admin_${tag}@example.com`);

  // --- One trial per organisation, ever (V277): both staff stamping rails on
  // the pro path, the comp rail + the upgrade CTA on the free path. Own fresh
  // orgs; keyless-safe.
  await oneTrialSuite();

  // --- Task 11: staff-only default-card removal + the customer-facing
  // refusal it deliberately does not loosen. Needs a real Stripe test-mode
  // card; keyless-safe (see the suite's own doc comment).
  await paymentMethodSuite();

  // --- clubs-w1 (W1): parent clubs group teams — the hub lifecycle (create →
  // profile → contact → standalone team → move under the club → squad with a
  // quick-created person) on Pro, and the tunable clubs.max=2 community cap.
  // Own fresh orgs so it's independent of the destructive downgrades above.
  await clubsSuite();

  // --- #267 (SPEC-5 §2): referral attribution + the referred org's welcome
  // grant, over the real `ref`-cookie flow. Own fresh orgs; keyless-safe.
  await referralSuite();

  // --- v17 gap #293: the extra-organisation recurring add-on. A Pro Plus
  // payer at the 10-org cap gets a 402 CARRYING a purchase offer, buying the
  // rider lifts the cap by one and the same create then succeeds; a community
  // owner and a NON-PAYER inside that same group are refused the same way and
  // offered nothing. Own fresh group; keyless-safe.
  await extraOrgAddonSuite();

  // --- v17 gap W10: the Event Pass lock's `past_ends_on` arm, which the
  // resolver honoured and the ENFORCEMENT sites did not. A pass one day past
  // the grace stops buying its competition out of competitions.max_active
  // (#347), and the checkout route refuses to sell a pass for a competition
  // that is already over (#353) — each paired with the same competition ON the
  // boundary, which must still be honoured. Own fresh orgs; keyless-safe.
  await passLockEnforcementSuite();

  // --- v17 gap W10: purchased add-on capacity dies with the money that rented
  // it. A churned subscription (#330) and a lost dispute (#331) each cancel the
  // extra-org rider AND the seat block while sparing an admin-granted comp,
  // driven through the real signed-webhook route. Own fresh groups; needs
  // STRIPE_WEBHOOK_SECRET and skips cleanly without it.
  await addonChurnWebhookSuite();
}

/** design/v9 PROMPT-55: the chargeback-liability copy is live on the public
 *  surfaces (same pages on free and pro — both plans' organisers are bound
 *  by the same clause), and connecting Stripe refuses without accepting it.
 *  The reversal itself is webhook-driven and covered by the DB-backed vitest
 *  suite; smoke pins what organisers actually read and click. Runs on its
 *  own org — the shared pro org already carries a smoke-flipped Connect
 *  account, which skips the first-connect gate by design. */
async function disputeSurfacesSuite() {
  const terms = await html(newSession(), "/legal/terms");
  check(
    "p55: ToS carries the entry-fee chargeback clause",
    terms.status === 200 &&
      terms.body.includes("Entry-fee chargebacks") &&
      terms.body.includes("recovered from your connected Stripe balance"),
  );
  const helpCards = await html(newSession(), "/help/registration/card-payments");
  check(
    "p55: card-payments help states the lost-dispute outcome",
    helpCards.status === 200 && helpCards.body.includes("recovered from your Stripe balance"),
  );
  // First connect without accepting the terms is refused before any Stripe
  // call — asserts the server-side gate, not just the disabled checkbox
  // (keyless-safe: the 422 answers before getStripe()).
  const owner = newSession();
  const who = await signIn(owner, `tos_${tag}@example.com`);
  await setPlan(who.org_id, "pro", owner);
  const refused = await v1(owner, `/api/v1/orgs/${who.org_id}/connect`, "POST", {
    return_path: "/settings/connect",
  });
  check("p55: connect refuses without ToS agreement (422)", refused.status === 422);
}

/** #403 data protection review — the two disclosures that only count if they
 *  are actually served. A vitest render proves the component renders them; this
 *  proves the deployed page does, which is the form the claim takes in a DPA.
 *
 *  1. The scheduling name guard (#396) infers that two `persons` rows are one
 *     human from normalised-name equality. Non-persisted and scheduling-scoped,
 *     but a data subject has no other way to learn it happens.
 *  2. `ai_parse_previews` stores the organiser's raw instruction, which can
 *     carry personal data, so the privacy page states a retention period — and
 *     /api/cron/ai-previews is what enforces it. Asserting the endpoint EXISTS
 *     (401 on a bad secret, not 404) is the difference between a policy and a
 *     sentence: a stated retention period with no sweep behind it is worse than
 *     no statement at all.
 *
 *  Keyless-safe; no org, no Stripe, no AI spend. */
async function dataProtectionCopySuite() {
  const privacy = await html(newSession(), "/legal/privacy");
  check(
    "#403: privacy page discloses the scheduling-only same-name grouping",
    privacy.status === 200 &&
      privacy.body.includes("treated as one player while a timetable is built") &&
      privacy.body.includes("No records are merged"),
  );
  check(
    "#403: privacy page states a retention period for stored instructions",
    privacy.status === 200 &&
      privacy.body.includes("deleted within the hour") &&
      privacy.body.includes("kept for 30 days"),
  );
  const subs = await html(newSession(), "/legal/sub-processors");
  check(
    "#403: every AI-scheduling sub-processor is disclosed",
    subs.status === 200 &&
      ["Anthropic", "OpenRouter", "Vertex AI", "xAI"].every((n) => subs.body.includes(n)),
  );
  // The sweep endpoint must exist and must be secret-gated. A 404 here means the
  // retention sentence above is unenforced.
  const sweep = await fetch(`${BASE}/api/cron/ai-previews`, {
    method: "POST",
    headers: { "x-cron-secret": "definitely-not-the-secret" },
  });
  check(
    "#403: the preview retention sweep exists and refuses a bad cron secret",
    sweep.status === 401 || sweep.status === 503,
  );
}

/** #404: the duplicate-review queue and the reversible merge behind it, over
 *  real HTTP — the four claims the DB-backed suites cannot make from outside:
 *   • `GET /persons/duplicates` ranks a same-name pair and says WHY it did;
 *   • a merge body without `confirmed` is refused 422 MERGE_NOT_CONFIRMED —
 *     the gate that makes every merge a named human decision;
 *   • a merge PRESERVES a suspension, repointed to the survivor. This is the
 *     shipped defect the wave exists to end: the old merge DELETED the absorbed
 *     row, so a ban recorded against it vanished with it. Asserted as a pair
 *     (before: on the absorbed person / after: on the survivor) so it cannot be
 *     satisfied by a suspension that never existed;
 *   • the merge is durable in `GET /persons/merges`, one reversal puts BOTH
 *     records back on the roster, and a second reversal is 409.
 *  Own fresh Pro org (`discipline.enforced` is Pro-gated, and the suspension is
 *  the load-bearing assertion); keyless-safe and spends no AI tokens. */
async function personMergeSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `dupmerge_${tag}@example.com`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner);

  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Dupe Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  // Two records for one human. `keep` is inserted first, so the queue offers it
  // as the survivor (`a` is the older row). The names are identical because a
  // shared normalised name is the queue's entry ticket.
  const NAME = `Priya Raman ${tag}`;
  const mkPerson = async (consent: Record<string, boolean>) =>
    v1data<{ id: string; full_name: string }>(
      await v1(owner, "/api/v1/persons", "POST", { full_name: NAME, consent }),
    );
  const keep = await mkPerson({ public_name: true, public_photo: true });
  const dupe = await mkPerson({ public_name: false, public_photo: true });

  // The ban goes on the record that is about to be ABSORBED — the direction
  // that used to lose it.
  const REASON = `smoke ${tag}: dissent`;
  const banned = await v1(owner, `/api/v1/divisions/${div.id}/suspensions`, "POST", {
    person_id: dupe.id,
    matches_total: 2,
    reason: REASON,
  });
  type SuspensionOut = { id: string; personId: string; reason: string; matchesTotal: number };
  const suspensions = async () =>
    v1data<SuspensionOut[]>(await v1(owner, `/api/v1/divisions/${div.id}/suspensions`));
  const before = await suspensions();
  check(
    "#404: the absorbed person carries a live suspension before the merge",
    banned.status === 201 &&
      before.length === 1 &&
      before[0]!.personId === dupe.id &&
      before[0]!.reason === REASON,
  );

  // --- The queue ranks the pair and shows its working.
  type Candidate = {
    a: { id: string };
    b: { id: string };
    score: number;
    evidence: { kind: string; detail: string }[];
  };
  const queue = v1data<{ items: Candidate[] }>(await v1(owner, "/api/v1/persons/duplicates"));
  const pair = queue.items.find(
    (c) =>
      (c.a.id === keep.id && c.b.id === dupe.id) || (c.a.id === dupe.id && c.b.id === keep.id),
  );
  check(
    "#404: the duplicate queue offers the same-name pair, with name evidence",
    !!pair && pair.score >= 1 && pair.evidence.some((e) => e.kind === "name"),
  );

  // --- A merge nobody confirmed is a refused ACTION (422), not a bad request.
  const unconfirmed = await v1(owner, `/api/v1/persons/${keep.id}/merge`, "POST", {
    duplicate_id: dupe.id,
  });
  check(
    "#404: a merge without `confirmed` is refused 422 MERGE_NOT_CONFIRMED",
    unconfirmed.status === 422 && unconfirmed.json.error?.code === "MERGE_NOT_CONFIRMED",
  );

  // --- The confirmed merge.
  const merged = await v1(owner, `/api/v1/persons/${keep.id}/merge`, "POST", {
    duplicate_id: dupe.id,
    confirmed: true,
  });
  const result = v1data<{ merge_id: string; survivor: { id: string; consent: unknown } }>(merged);
  check(
    "#404: a confirmed merge keeps the named survivor",
    merged.status === 200 && result.survivor.id === keep.id && !!result.merge_id,
  );

  const roster = async () =>
    v1data<{ items: { id: string }[] }>(await v1(owner, "/api/v1/persons?limit=100")).items.map(
      (p) => p.id,
    );
  const afterIds = await roster();
  check(
    "#404: the merged-away record leaves the roster, the survivor stays",
    afterIds.includes(keep.id) && !afterIds.includes(dupe.id),
  );

  // --- THE REGRESSION: the ban survived, and now belongs to the survivor.
  const after = await suspensions();
  check(
    "#404: the merge preserves the suspension, repointed to the survivor",
    after.length === 1 &&
      after[0]!.personId === keep.id &&
      after[0]!.reason === REASON &&
      after[0]!.matchesTotal === 2,
  );

  // --- The merge is durable, not a toast the panel forgets on reload.
  type LogEntry = {
    merge_id: string;
    survivor_id: string;
    absorbed_id: string;
    reversed_at: string | null;
  };
  const log = v1data<{ items: LogEntry[] }>(await v1(owner, "/api/v1/persons/merges"));
  const entry = log.items.find((m) => m.merge_id === result.merge_id);
  check(
    "#404: the merge is in the org's durable merge log, not yet reversed",
    !!entry &&
      entry.survivor_id === keep.id &&
      entry.absorbed_id === dupe.id &&
      entry.reversed_at === null,
  );

  // --- Undo restores BOTH records and leaves the ban where it started.
  const undo = await v1(owner, `/api/v1/persons/merges/${result.merge_id}/reverse`, "POST", {
    confirmed: true,
  });
  const restoredIds = await roster();
  const restoredBans = await suspensions();
  check(
    "#404: reversing the merge puts both records back and returns the ban",
    undo.status === 200 &&
      restoredIds.includes(keep.id) &&
      restoredIds.includes(dupe.id) &&
      restoredBans.length === 1 &&
      restoredBans[0]!.personId === dupe.id,
  );

  const undoTwice = await v1(owner, `/api/v1/persons/merges/${result.merge_id}/reverse`, "POST", {
    confirmed: true,
  });
  check(
    "#404: a second reversal is refused 409 MERGE_ALREADY_REVERSED",
    undoTwice.status === 409 && undoTwice.json.error?.code === "MERGE_ALREADY_REVERSED",
  );
}

/** payments-hardening wave (PROMPT-72..75) over real HTTP — the surfaces the
 *  DB-backed vitest suites can't reach from the outside:
 *   • the THREE competition-delete money guards, each 409 with its own copy
 *     (Task 1, spec P0-1) — a CASCADE delete would erase the only record of
 *     live money (Event Pass, unrefunded card registration, paid sponsorship);
 *   • DELETE /competitions/:id is structurally key-excluded → 403 for a
 *     manage-scope key (Task 1 NEVER_KEY_ROUTES);
 *   • a community org's card division reads `payments_unavailable` on the
 *     public register panel even with Connect live (P2-10: registration.paid
 *     is Pro-gated), while the SAME setup on an Event-Pass comp stays open;
 *   • the hourly stuck-webhook sweep cron (Task 12/P1-7): wrong secret 401,
 *     right secret returns the {replayed,failed,alerted} shape.
 *  Runs on its own fresh orgs (never touches org/org2 from main()); keyless-
 *  safe, SQL-seeded like setConnect/grantPass. */
async function p72Suite(): Promise<void> {
  // === PRO PATH: the three delete-money guards, each pinned distinctly. ===
  const owner = newSession();
  const who = await signIn(owner, `p72_${tag}@example.com`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner); // sponsor packages + api keys are Pro surfaces

  const makeComp = async (name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `${name} ${tag}`,
        visibility: "public",
      }),
    );
  const makeDiv = async (compId: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(owner, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
  const delMsg = (r: { json: { error?: { message?: string } } }) => r.json.error?.message ?? "";

  // Guard 1 — Event Pass.
  const passComp = await makeComp("P72 Pass Cup");
  await grantPass(orgId, passComp.id, "event_pass");
  const delPass = await v1(owner, `/api/v1/competitions/${passComp.id}`, "DELETE");
  check(
    "p72: delete blocked by an Event Pass (409, 'Event Pass')",
    delPass.status === 409 && delMsg(delPass).includes("Event Pass"),
  );

  // Guard 2 — a card registration with unrefunded money.
  const regComp = await makeComp("P72 Reg Cup");
  const regDiv = await makeDiv(regComp.id);
  await seedPaidRegistration(orgId, regDiv.id);
  const delReg = await v1(owner, `/api/v1/competitions/${regComp.id}`, "DELETE");
  check(
    "p72: delete blocked by unrefunded card money (409, 'card payments')",
    delReg.status === 409 && delMsg(delReg).includes("card payments"),
  );

  // Guard 3 — a paid sponsorship scoped to the comp via its package.
  const sponComp = await makeComp("P72 Sponsor Cup");
  await seedPaidSponsorOrder(orgId, sponComp.id);
  const delSpon = await v1(owner, `/api/v1/competitions/${sponComp.id}`, "DELETE");
  check(
    "p72: delete blocked by a paid sponsorship (409, 'sponsorship payment records')",
    delSpon.status === 409 && delMsg(delSpon).includes("sponsorship payment records"),
  );

  // === KEY AUTH: DELETE /competitions/:id is never key-accessible → 403 for
  // ANY scope (the route is absent from the allowlist, so it default-denies).
  // A read key is enough to prove the door, and — unlike a write-capable key,
  // which V290 made Pro Plus only — it mints on a plain Pro org. ===
  const mkKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "p72 probe",
    scopes: ["read"],
  });
  check("p72: read key minted for the NEVER_KEY probe", mkKey.status === 201);
  const keyAuth = {
    Authorization: `Bearer ${v1data<{ secret: string }>(mkKey).secret}`,
  };
  const cleanComp = await makeComp("P72 Key Delete Cup"); // no money — would otherwise delete
  const keyDelete = await v1(
    newSession(),
    `/api/v1/competitions/${cleanComp.id}`,
    "DELETE",
    undefined,
    keyAuth,
  );
  check("p72: a key cannot DELETE a competition (403 NEVER_KEY)", keyDelete.status === 403);
  // Prove the door, not the data: the same delete over the session succeeds.
  const sessionDelete = await v1(owner, `/api/v1/competitions/${cleanComp.id}`, "DELETE");
  check(
    "p72: the owner session still deletes a money-free comp",
    sessionDelete.status === 200 || sessionDelete.status === 204,
  );

  // === COMMUNITY PATH: since V310 freed registration.paid to every plan, a
  // card division's availability turns on CONNECT, not on plan. Both sides are
  // proved below. registration.paid is no longer a pass differentiator, so the
  // old "an Event Pass reopens a community card division" scenario is obsolete —
  // the pass's real grants (entrants 64, 5% fee, branded exports, realtime, …)
  // are covered by the pass-scope suites and the entrants/fee checks above. ===
  const comm = newSession();
  const commWho = await signIn(comm, `p72comm_${tag}@example.com`);
  const commOrgId = commWho.org_id;
  const commOrgs = (await call(comm, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const commSlug = commOrgs.find((o) => o.id === commOrgId)!.slug;

  // Connect NOT enabled → a Stripe-fee division cannot take money and closes
  // with an honest reason. Unlisted sidesteps the community dashboard.public.max
  // quota; the active-competition cap is 5 (V311) so both probe comps coexist.
  await setConnect(commOrgId, false);
  const brokeComp = v1data<{ id: string; slug: string }>(
    await v1(comm, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `P72 Card Cup ${tag}`,
      visibility: "unlisted",
    }),
  );
  const brokeDiv = v1data<{ id: string }>(
    await v1(comm, `/api/v1/competitions/${brokeComp.id}/divisions`, "POST", {
      name: "Card",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await seedStripeFeeDivision(brokeDiv.id);
  const brokeInfo = await v1(
    newSession(),
    `/api/v1/public/orgs/${commSlug}/competitions/${brokeComp.slug}/registration`,
  );
  const brokeDivs = v1data<{
    divisions: { open: boolean; closed_reason: string | null }[];
  }>(brokeInfo).divisions;
  // V310 freed the PLAN gate (community can charge), but a card division still
  // needs a Connect account to pay into. Connect is OFF here, so the division is
  // closed for payments_unavailable — the Connect dimension, isolated from the
  // now-gone entitlement dimension the "Connect live is OPEN" check below pairs
  // with.
  check(
    "p72: a community card division with Connect OFF reads payments_unavailable",
    brokeInfo.status === 200 &&
      brokeDivs.length === 1 &&
      brokeDivs[0]!.open === false &&
      brokeDivs[0]!.closed_reason === "payments_unavailable",
  );

  // Connect LIVE → the same free-plan org's card division is OPEN: paid intake
  // is free-tier now (V310), monetised through the community fee, not gated.
  await setConnect(commOrgId, true);
  const okComp = v1data<{ id: string; slug: string }>(
    await v1(comm, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `P72 Open Card Cup ${tag}`, visibility: "unlisted" }),
  );
  const okDiv = v1data<{ id: string }>(
    await v1(comm, `/api/v1/competitions/${okComp.id}/divisions`, "POST", {
      name: "Card", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await seedStripeFeeDivision(okDiv.id);
  const okInfo = await v1(
    newSession(),
    `/api/v1/public/orgs/${commSlug}/competitions/${okComp.slug}/registration`,
  );
  const okDivs = v1data<{ divisions: { open: boolean; closed_reason: string | null }[] }>(okInfo).divisions;
  check(
    "p72: with Connect live a community card division is OPEN (registration.paid is free-tier)",
    okInfo.status === 200 &&
      okDivs.length === 1 &&
      okDivs[0]!.open === true &&
      okDivs[0]!.closed_reason === null,
  );

  // === CRON: the hourly stuck-webhook sweep (Task 12/P1-7). ===
  const cronSecret = process.env.CRON_SECRET;
  const wrongCron = await fetch(`${BASE}/api/cron/billing-events`, {
    method: "POST",
    headers: { "x-cron-secret": "definitely-wrong" },
  });
  // 401 when the server has a secret; 503 when it isn't configured (CI) —
  // either way the sweep never ran on a bad/absent secret.
  check(
    "p72: cron billing-events rejects a wrong secret (401, or 503 unconfigured)",
    wrongCron.status === 401 || wrongCron.status === 503,
  );
  if (cronSecret) {
    const rightCron = await fetch(`${BASE}/api/cron/billing-events`, {
      method: "POST",
      headers: { "x-cron-secret": cronSecret },
    });
    const body = (await rightCron.json().catch(() => ({}))) as {
      ok?: boolean;
      data?: { replayed?: number; failed?: number; alerted?: number };
    };
    if (rightCron.status === 200) {
      check(
        "p72: cron billing-events runs the sweep and returns {replayed:0,…}",
        body.ok === true &&
          body.data?.replayed === 0 &&
          typeof body.data?.failed === "number" &&
          typeof body.data?.alerted === "number",
      );
    } else {
      // Server CRON_SECRET differs from the smoke env's — still a proven guard.
      check(
        "p72: cron right-secret path skipped (server secret differs)",
        rightCron.status === 401 || rightCron.status === 503,
      );
    }
  } else {
    check("p72: cron right-secret shape skipped (no CRON_SECRET in smoke env)", true);
  }
}

/** payments-hardening Task 16 — the 4-plan user matrix. Four fresh owners, one
 *  per plan, created through the same HTTP surface the rest of smoke uses; each
 *  asserts the entitlements that distinguish its tier at the resolution + HTTP-
 *  status level. Keyless-safe: every check resolves entitlements or 402s BEFORE
 *  any Stripe/LLM call, and each check runs AFTER its data is seeded. Own fresh
 *  orgs (never touches org/org2 from main()); the pass persona stays community.
 *
 *  V291 truths this pins: Pro AI cap 5/division, Pro Plus unlimited (null); a
 *  pass overlays comp-scoped Pro features INSIDE the passed comp only; the dead
 *  Event-Pass members.max row is gone → org-wide keys resolve community for a
 *  passed org. */
async function smokePlanMatrix(): Promise<void> {
  const genericDiv = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  // Resolved entitlements + plan for an org (any member may read) — the same
  // endpoint /admin/entitlements and the settings billing tab consume. It reads
  // plan_entitlements live for the KEY LIST only; every VALUE now comes from the
  // cache-aside resolver (300s TTL), so a read here CAN serve pre-flip answers.
  // What keeps it honest is setPlan: it busts `ent:{org}:*` after its raw-SQL
  // write, so the flip is visible to the very next read. The rule is broader
  // than plans — EVERY raw-SQL write that changes what the resolver would
  // answer must bust. Never reintroduce a plan flip that writes subscriptions
  // directly and skips setPlan, nor an override write that touches
  // org_entitlement_overrides directly and skips insertEntitlementOverride.
  const readEnt = async (s: Session, orgId: string) =>
    (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
      plan_key: string;
      entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
    };
  const featureKey = (r: V1Res) =>
    (r.json.error as { feature_key?: string; reason?: string } | undefined) ?? {};

  // Task 20 — the four-users-per-org, full-data-feed, populated-competition
  // pass. For a plan org's owner + host competition, seed a division that
  // covers all three entrant shapes (individual + team + pair), generate and
  // start it, provision the org's OTHER three users (member/scorer, official,
  // player), record real results, then run the five tier-gated assertions
  // against the now-POPULATED competition (not an empty shell). Plan-generic:
  // the branded-vs-plain export outcome is driven by `expectBranded`, never a
  // hardcoded plan. `hostComp` is the persona's existing competition (reused so
  // no new competition trips the community active-comp cap; for event_pass it
  // MUST be the PASSED comp so the comp-scoped `exports` grant is in force).
  const seedFeedAndAssert = async (
    owner: Session,
    orgId: string,
    hostCompId: string,
    key: string, // email suffix + label: community | pro | proplus | pass
    expectBranded: boolean,
  ): Promise<void> => {
    // --- Full data feed: one division, all three entrant shapes. Entrant #1
    // carries a person so the player (below) can claim into a real fixture.
    const feedDiv = v1data<{ id: string }>(
      await v1(owner, `/api/v1/competitions/${hostCompId}/divisions`, "POST", {
        name: `Matrix Feed ${key}`,
        ...genericDiv,
      }),
    );
    const person = v1data<{ id: string }>(
      await v1(owner, "/api/v1/persons", "POST", {
        full_name: `Feed Player ${key} ${tag}`,
        consent: {},
      }),
    );
    await v1(owner, `/api/v1/divisions/${feedDiv.id}/entrants`, "POST", [
      {
        kind: "individual",
        display_name: `Feed Solo ${key}`,
        seed: 1,
        members: [{ person_id: person.id }],
      },
      { kind: "individual", display_name: `Feed Solo2 ${key}`, seed: 2 },
      { kind: "team", display_name: `Feed Team ${key}`, seed: 3 },
      { kind: "pair", display_name: `Feed Pair ${key}`, seed: 4 },
    ]);
    const feedStage = v1data<{ id: string }>(
      await v1(owner, `/api/v1/divisions/${feedDiv.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    const feedFixtures = v1data<{ fixtures: { id: string }[] }>(
      await v1(owner, `/api/v1/stages/${feedStage.id}/generate`, "POST"),
    ).fixtures;
    await v1(owner, `/api/v1/divisions/${feedDiv.id}/start`, "POST");
    check(
      `matrix/${key}: full feed built — individual+team+pair entrants, fixtures generated`,
      feedFixtures.length >= 4,
    );

    // --- User 2 (official): assigned to fixture[0], invited through the shared
    // person-claim rail, claims + accepts, sees the duty and scores it exactly
    // like a scorer (acceptedOfficialCovers). Officials are non-members — no
    // members.max seat consumed, so this holds on community too.
    const officialEmail = `official_${key}_${tag}@example.com`;
    const officialSession = newSession();
    await signIn(officialSession, officialEmail);
    const official = v1data<{ id: string }>(
      await v1(owner, "/api/v1/officials", "POST", {
        display_name: `Feed Ref ${key} ${tag}`,
        role_keys: ["referee"],
      }),
    );
    await v1(owner, `/api/v1/fixtures/${feedFixtures[0]!.id}/officials`, "PATCH", {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });
    const offInvite = await v1(owner, `/api/v1/officials/${official.id}/invite`, "POST", {
      email: officialEmail,
    });
    const offToken =
      (v1data<{ claim_url: string }>(offInvite).claim_url ?? "").split("/claim/")[1] ?? "";
    await call(officialSession, `/api/claims/${offToken}/accept`, "POST");
    const offAccept = await v1(
      officialSession,
      `/api/v1/me/assigned-fixtures/${feedFixtures[0]!.id}/response`,
      "PATCH",
      {
        response: "accepted",
      },
    );
    const offDuties = v1data<unknown[]>(await v1(officialSession, "/api/v1/me/assigned-fixtures"));
    check(
      `matrix/${key}: the official sees their duty in the officiating lane`,
      offAccept.status === 200 && Array.isArray(offDuties) && offDuties.length > 0,
    );
    const offState = await v1(officialSession, `/api/v1/fixtures/${feedFixtures[0]!.id}/state`);
    const offScore = await v1(
      officialSession,
      `/api/v1/fixtures/${feedFixtures[0]!.id}/events`,
      "POST",
      {
        expected_seq: v1data<{ last_seq: number }>(offState).last_seq,
        type: "generic.result",
        payload: { p1Score: 2, p2Score: 1 },
      },
    );
    check(`matrix/${key}: the accepted official records a result`, offScore.status === 201);

    // --- User 3 (member/scorer): a division-scoped scorer invite seats a
    // member (scorers.max = 1 on community, so exactly one fits) who scores a
    // DIFFERENT fixture via the assignment path (scoresViaAssignment).
    const scorerEmail = `scorer_${key}_${tag}@example.com`;
    const scorerSession = newSession();
    await signIn(scorerSession, scorerEmail);
    const scorerInvite = (await call(owner, `/api/orgs/${orgId}/invites`, "POST", {
      role: "scorer",
      max_uses: 1,
      default_scope: { type: "division", id: feedDiv.id },
    })) as { token: string };
    await call(scorerSession, `/api/invites/${scorerInvite.token}/accept`, "POST", {});
    const scorerAssigned = v1data<unknown[]>(
      await v1(scorerSession, "/api/v1/me/assigned-fixtures"),
    );
    const scorerState = await v1(scorerSession, `/api/v1/fixtures/${feedFixtures[1]!.id}/state`);
    const scorerScore = await v1(
      scorerSession,
      `/api/v1/fixtures/${feedFixtures[1]!.id}/events`,
      "POST",
      {
        expected_seq: v1data<{ last_seq: number }>(scorerState).last_seq,
        type: "generic.result",
        payload: { p1Score: 1, p2Score: 3 },
      },
    );
    check(
      `matrix/${key}: the scorer seats via invite and scores via assignment`,
      Array.isArray(scorerAssigned) && scorerAssigned.length > 0 && scorerScore.status === 201,
    );

    // --- User 4 (player): claims the person on entrant #1 and reads their own
    // fixtures. Only two fixtures were decided above; the player's entrant is
    // in three, so at least one stays upcoming — the self-view is never empty.
    const playerEmail = `player_${key}_${tag}@example.com`;
    const playerSession = newSession();
    await signIn(playerSession, playerEmail);
    const claimInvite = await v1(owner, `/api/v1/persons/${person.id}/claim-invites`, "POST", {
      email: playerEmail,
    });
    const claimToken =
      (v1data<{ claim_url: string }>(claimInvite).claim_url ?? "").split("/claim/")[1] ?? "";
    await call(playerSession, `/api/claims/${claimToken}/accept`, "POST");
    const upcoming =
      v1data<{ upcoming: { id: string }[] }>(await v1(playerSession, "/api/v1/me/fixtures"))
        .upcoming ?? [];
    check(`matrix/${key}: the claimed player sees their own fixtures`, upcoming.length > 0);

    // --- Populated standings: the two results above make the snapshot
    // non-empty (was the empty shell before).
    const feedStandings = await v1(owner, `/api/v1/stages/${feedStage.id}/standings`);
    check(
      `matrix/${key}: standings render non-empty after recorded results`,
      feedStandings.status === 200 && v1data<{ rows: unknown[] }>(feedStandings).rows.length > 0,
    );

    // --- Export WITH DATA: the standings export 404s without a snapshot, so a
    // 200 here proves it is content-bearing (empty-doc false-green avoided).
    // community.exports=true (V285) → every tier renders; exports.branded is
    // the exact gate orgBranding() keys off to switch chrome on.
    //
    // `readEnt` asks the ORG-WIDE question (the route passes no competition id
    // on purpose — see api/orgs/[id]/entitlements/route.ts), so for event_pass
    // `expectBranded: false` is NOT a claim that the passed competition renders
    // plain. It is the opposite claim, and the load-bearing one here: a
    // competition-scoped pass must not lift `exports.branded` for the ORG. The
    // pass DOES grant it (V306) and the passed competition really does render
    // branded chrome — passGrantsSuite proves that half, competition-scoped,
    // by reading the org name out of the exported workbook.
    const feedExport = await fetch(
      `${BASE}/api/v1/divisions/${feedDiv.id}/exports/standings?format=pdf`,
      { headers: { cookie: cookieHeader(owner) } },
    );
    const feedBytes = Buffer.from(await feedExport.arrayBuffer());
    check(
      `matrix/${key}: standings export renders a content-bearing PDF`,
      feedExport.status === 200 && feedBytes.subarray(0, 5).toString() === "%PDF-",
    );
    const feedEnt = await readEnt(owner, orgId);
    check(
      `matrix/${key}: ORG-WIDE exports.branded resolves ${expectBranded} (a pass must not lift it org-wide)`,
      (feedEnt.entitlements["exports.branded"]?.enabled ?? false) === expectBranded,
    );
  };

  // === PERSONA 1 — community (default plan, no flip) =====================
  const comm = newSession();
  const commOrg = (await signIn(comm, `smoke-community-${tag}@example.com`)).org_id;
  const commEnt = await readEnt(comm, commOrg);
  check("matrix/community: org resolves the community plan", commEnt.plan_key === "community");
  check(
    "matrix/community: exports.branded denies",
    commEnt.entitlements["exports.branded"]?.enabled === false,
  );
  // V302: the AI Schedule Architect is granted on EVERY plan; the graded axis
  // is no longer a per-division run count (retired V322) but the monthly AI
  // credit wallet allowance (community 10, V320).
  check(
    "matrix/community: scheduling.ai is granted on every plan (V302)",
    commEnt.entitlements["scheduling.ai"]?.enabled === true,
  );
  check(
    "matrix/community: ai.credits.monthly resolves 10 (V320)",
    commEnt.entitlements["ai.credits.monthly"]?.limit === 10,
  );
  // The bootstrap grant (createOrgForUser) synchronously seeds this period's
  // allowance at org creation, so a brand-new Community org's wallet already
  // holds it — no up-to-24h wait on the daily billing-grant cron.
  check(
    "matrix/community: a freshly-created org's AI credit wallet is bootstrap-granted 10 credits",
    (await walletBalance(commOrg)) === 10,
  );

  // A scored-through division so a real export renders.
  const cComp = v1data<{ id: string; slug: string }>(
    await v1(comm, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Community ${tag}`,
      visibility: "unlisted",
    }),
  );
  const cDiv = v1data<{ id: string }>(
    await v1(comm, `/api/v1/competitions/${cComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await v1(comm, `/api/v1/divisions/${cDiv.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
  ]);
  const cStage = v1data<{ id: string }>(
    await v1(comm, `/api/v1/divisions/${cDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  await v1(comm, `/api/v1/stages/${cStage.id}/generate`, "POST");
  await v1(comm, `/api/v1/divisions/${cDiv.id}/start`, "POST");

  // Plain export path is OPEN on community (V285) — branding is silently dropped,
  // not the whole export blocked. Proves the free export path still works.
  const plainExport = await fetch(
    `${BASE}/api/v1/divisions/${cDiv.id}/exports/timetable?format=pdf`,
    { headers: { cookie: cookieHeader(comm) } },
  );
  const plainBytes = Buffer.from(await plainExport.arrayBuffer());
  check(
    "matrix/community: the plain export path renders a PDF (branding dropped, not blocked)",
    plainExport.status === 200 && plainBytes.subarray(0, 5).toString() === "%PDF-",
  );

  // The prepaid credit wallet is the paid boundary now (not the feature
  // itself, and no longer a per-division count): drain the org's wallet to 0
  // → the next ai-plan 402s at `ai.credits` BEFORE any model call
  // (keyless-safe), and the 402 carries the contextual upgrade prompt the
  // UpgradeGate renders.
  await drainWallet(commOrg, 0);
  const commAi = await v1(comm, `/api/v1/divisions/${cDiv.id}/schedule/ai-plan`, "POST", {
    instruction: "two courts, weekday evenings only",
  });
  const commAiErr = featureKey(commAi);
  check(
    "matrix/community: an AI run 402s once the wallet is exhausted (ai.credits)",
    commAi.status === 402 && commAiErr.feature_key === "ai.credits",
  );
  check(
    "matrix/community: the cap 402 carries the upgrade prompt (reason)",
    typeof commAiErr.reason === "string" && commAiErr.reason.length > 0,
  );

  // === PERSONA 2 — pro ==================================================
  const pro = newSession();
  const proOrg = (await signIn(pro, `smoke-pro-${tag}@example.com`)).org_id;
  await setPlan(proOrg, "pro", pro);
  const proEnt = await readEnt(pro, proOrg);
  check("matrix/pro: org resolves the pro plan", proEnt.plan_key === "pro");
  check(
    "matrix/pro: exports.branded allowed",
    proEnt.entitlements["exports.branded"]?.enabled === true,
  );
  check(
    "matrix/pro: scheduling.ai allowed",
    proEnt.entitlements["scheduling.ai"]?.enabled === true,
  );
  check(
    "matrix/pro: ai.credits.monthly resolves 60 (V320)",
    proEnt.entitlements["ai.credits.monthly"]?.limit === 60,
  );
  check(
    "matrix/pro: officials.per_fixture.max is unlimited (null)",
    proEnt.entitlements["officials.per_fixture.max"]?.limit === null,
  );

  // Behavioural proof of the wallet gate: setPlan is a raw plan_key flip (it
  // does not itself grant the pro-tier monthly allowance — that only happens
  // through a real checkout/sync or the daily cron), so this org's wallet
  // still holds whatever the community bootstrap grant left it. Drain it to 0
  // and the same `ai.credits` 402 fires — the gate is plan-independent, it
  // only reads the balance.
  const proComp = v1data<{ id: string }>(
    await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Pro ${tag}`,
    }),
  );
  const proDiv = v1data<{ id: string }>(
    await v1(pro, `/api/v1/competitions/${proComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await drainWallet(proOrg, 0);
  const proCapped = await v1(pro, `/api/v1/divisions/${proDiv.id}/schedule/ai-plan`, "POST", {
    instruction: "spread evenly across both courts",
  });
  check(
    "matrix/pro: an AI run 402s once the wallet is exhausted (ai.credits)",
    proCapped.status === 402 && featureKey(proCapped).feature_key === "ai.credits",
  );

  // === PERSONA 3 — pro_plus ============================================
  const plus = newSession();
  const plusOrg = (await signIn(plus, `smoke-proplus-${tag}@example.com`)).org_id;
  await setPlan(plusOrg, "pro_plus", plus);
  const plusEnt = await readEnt(plus, plusOrg);
  check("matrix/pro_plus: org resolves the pro_plus plan", plusEnt.plan_key === "pro_plus");
  check(
    "matrix/pro_plus: ai.credits.monthly resolves 200 (V320)",
    plusEnt.entitlements["ai.credits.monthly"]?.limit === 200,
  );
  check(
    "matrix/pro_plus: registration.fee_percent resolves 1",
    plusEnt.entitlements["registration.fee_percent"]?.limit === 1,
  );

  // api.write grants: a write-capable (manage) key mints on Pro Plus — the same
  // key 402s on a plain Pro org (proPlusSuite covers the negative).
  const plusKey = await v1(plus, `/api/v1/orgs/${plusOrg}/api-keys`, "POST", {
    name: `matrix plus ${tag}`,
    scopes: ["manage"],
  });
  check("matrix/pro_plus: api.write grants a manage-scope key (201)", plusKey.status === 201);

  // officials.auto grant (Task 16 amendment): the auto-propose path a plain Pro
  // org now 402s on (see jul3Suite) succeeds on Pro Plus — coverage of the
  // feature moves to the right tier instead of vanishing.
  const plusComp = v1data<{ id: string }>(
    await v1(plus, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Plus ${tag}`,
    }),
  );
  const plusDiv = v1data<{ id: string }>(
    await v1(plus, `/api/v1/competitions/${plusComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await v1(
    plus,
    `/api/v1/divisions/${plusDiv.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const plusStage = v1data<{ id: string }>(
    await v1(plus, `/api/v1/divisions/${plusDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const plusFixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(plus, `/api/v1/stages/${plusStage.id}/generate`, "POST"),
  ).fixtures;
  await v1(plus, `/api/v1/divisions/${plusDiv.id}/start`, "POST");
  await v1(plus, "/api/v1/officials", "POST", {
    display_name: `Matrix Ref ${tag}`,
    role_keys: ["referee"],
  });
  const plusAuto = await v1(plus, `/api/v1/divisions/${plusDiv.id}/officials/auto`, "POST", {
    policy: { roles: ["referee"] },
  });
  check(
    "matrix/pro_plus: officials.auto is allowed (200, assignments proposed)",
    plusAuto.status === 200 &&
      Array.isArray(v1data<{ assignments: unknown[] }>(plusAuto).assignments),
  );

  // #448 — maxPerDay is capped on the ORG's calendar day, not the UTC day. Put
  // the org west of Greenwich and lay four fixtures across one LOCAL Saturday
  // whose evening half is already Sunday in UTC: a UTC bucket sees 2 + 2 and
  // fills all four, the org's own day allows only 2.
  // `call` returns json.data and THROWS on ok:false — it has no .status, so
  // assert the value actually landed. The two checks below are meaningless if
  // this org is still on UTC, so this must fail loudly rather than silently.
  const tzOrg = (await call(plus, `/api/orgs/${plusOrg}`, "PATCH", {
    timezone: "America/Los_Angeles",
  })) as { timezone: string };
  check(
    "matrix/pro_plus #448: org timezone set to America/Los_Angeles",
    tzOrg.timezone === "America/Los_Angeles",
  );

  // 2026-07-11 in Los Angeles (PDT, UTC-7): 10:00 & 12:00 local are still
  // Saturday UTC; 18:00 & 20:00 local are already Sunday UTC.
  const localSaturday = [
    "2026-07-11T17:00:00.000Z",
    "2026-07-11T19:00:00.000Z",
    "2026-07-12T01:00:00.000Z",
    "2026-07-12T03:00:00.000Z",
  ];
  const capIds = plusFixtures.slice(0, 4).map((f) => f.id);
  for (const [i, id] of capIds.entries()) {
    await v1(plus, `/api/v1/fixtures/${id}`, "PATCH", {
      scheduled_at: localSaturday[i],
      court_label: "Court 1",
    });
  }
  // Park every other fixture far away so it cannot compete for the capped ref.
  for (const [i, f] of plusFixtures.slice(4).entries()) {
    await v1(plus, `/api/v1/fixtures/${f.id}`, "PATCH", {
      scheduled_at: `2026-09-${String(i + 1).padStart(2, "0")}T18:00:00.000Z`,
      court_label: "Court 1",
    });
  }

  // The cap only binds if NO other official can absorb the overflow, so give
  // this one a role nobody else on the roster holds ("Matrix Ref" is referee).
  const cappedRef = v1data<{ id: string }>(
    await v1(plus, "/api/v1/officials", "POST", {
      display_name: `Capped Judge ${tag}`,
      role_keys: ["judge"],
      max_per_day: 2,
    }),
  );
  const capAuto = await v1(plus, `/api/v1/divisions/${plusDiv.id}/officials/auto`, "POST", {
    policy: { roles: ["judge"] },
    rng_seed: "tz448",
  });
  const capBody = v1data<{
    assignments: { fixtureId: string; officialId: string; roleKey: string }[];
    conflicts: { kind: string; fixtureId?: string }[];
  }>(capAuto);
  const capSet = new Set(capIds);
  const cappedOnSaturday = capBody.assignments.filter(
    (a) => capSet.has(a.fixtureId) && a.officialId === cappedRef.id,
  );
  check(
    "matrix/pro_plus #448: maxPerDay caps on the ORG day across a UTC midnight",
    capAuto.status === 200 && cappedOnSaturday.length === 2,
  );
  check(
    "matrix/pro_plus #448: the two over-cap local-Saturday slots report role_unfilled",
    capBody.conflicts.filter(
      (c) => c.kind === "role_unfilled" && capSet.has(c.fixtureId ?? ""),
    ).length === 2,
  );

  // === PERSONA 4 — event_pass (community org + a single-comp pass) ======
  const passer = newSession();
  const passOrg = (await signIn(passer, `smoke-pass-${tag}@example.com`)).org_id;

  // Passed comp: create, then grant its pass. Unlisted sidesteps the public
  // dashboard cap; the pass frees the active-comp slot for the sibling below.
  const passedComp = v1data<{ id: string; slug: string }>(
    await v1(passer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Passed ${tag}`,
      visibility: "unlisted",
    }),
  );
  const passedDiv = v1data<{ id: string }>(
    await v1(passer, `/api/v1/competitions/${passedComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await grantPass(passOrg, passedComp.id, "event_pass");

  // A comp-scoped Pro feature (formats.advanced) resolves TRUE inside the passed
  // comp — an advanced (americano) stage is accepted.
  const passedAdv = await v1(passer, `/api/v1/divisions/${passedDiv.id}/stages`, "POST", {
    seq: 1,
    kind: "americano",
    name: "Padel",
    config: { mode: "americano", courtCount: 2, rounds: 3 },
  });
  check(
    "matrix/event_pass: formats.advanced is granted INSIDE the passed comp (201)",
    passedAdv.status === 201,
  );

  // A second, unpassed comp in the SAME org denies the same feature (the pass is
  // strictly comp-scoped).
  const siblingComp = v1data<{ id: string }>(
    await v1(passer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Sibling ${tag}`,
      visibility: "unlisted",
    }),
  );
  const siblingDiv = v1data<{ id: string }>(
    await v1(passer, `/api/v1/competitions/${siblingComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  const siblingAdv = await v1(passer, `/api/v1/divisions/${siblingDiv.id}/stages`, "POST", {
    seq: 1,
    kind: "americano",
    name: "Padel",
    config: { mode: "americano", courtCount: 2, rounds: 3 },
  });
  check(
    "matrix/event_pass: the sibling (unpassed) comp denies formats.advanced (402)",
    siblingAdv.status === 402 && featureKey(siblingAdv).feature_key === "formats.advanced",
  );

  // Org-wide key still resolves community (V291 dead-row fix): the pass overlays
  // only comp-scoped features — the org's plan and members.max stay community.
  const passEnt = await readEnt(passer, passOrg);
  check(
    "matrix/event_pass: the org still resolves the community plan (pass is comp-scoped)",
    passEnt.plan_key === "community",
  );
  check(
    "matrix/event_pass: org-wide members.max resolves the community value (5)",
    passEnt.entitlements["members.max"]?.limit === 5,
  );

  // === Task 20 — populated-competition assertions per plan org ===========
  // Each plan org now gets four users (owner + member/scorer + official +
  // player) and a full data feed (individual + team + pair entrants, fixtures,
  // recorded results), then the five tier-gated assertions run against the
  // populated competition. Reuses each persona's existing competition; for
  // event_pass the PASSED comp hosts the feed so the comp-scoped exports grant
  // applies. The last argument is the ORG-WIDE `exports.branded` answer: true
  // for the paid plans, false for community AND for the pass (whose grant is
  // competition-scoped and must never leak to the org — see the note above).
  await seedFeedAndAssert(comm, commOrg, cComp.id, "community", false);
  await seedFeedAndAssert(pro, proOrg, proComp.id, "pro", true);
  await seedFeedAndAssert(plus, plusOrg, plusComp.id, "proplus", true);
  await seedFeedAndAssert(passer, passOrg, passedComp.id, "pass", false);
}

/**
 * Task 23 — every grant an Event Pass actually delivers, end to end.
 *
 * ── The shape, and why it is the only honest one ────────────────────────────
 * ONE fresh community org, TWO competitions, a pass on exactly one of them.
 * Every grant is asserted as a PAIR against that same org in the same run:
 * the passed competition is ALLOWED, the sibling competition is REFUSED. A
 * check that a passless community org would also satisfy proves nothing about
 * the pass, and where a grant is a CEILING the pair is the only shape that can
 * fail for the right reason — "allowed at 128" alone passes on a plan with no
 * ceiling at all, and "refused at 129" alone passes on Community's 64.
 *
 * The sibling competition is also the leak detector: `competition_passes` is
 * joined into the resolver per competition (lib/entitlements.ts resolveFromDb),
 * so a grant that shows up on the SIBLING is a pass escaping its scope.
 *
 * ── Two numbers the plan brief got wrong, deliberately not asserted ─────────
 *  • `branding` — V310 made it true on EVERY plan, so "the pass delivers
 *    branding" is a test that cannot fail. Dropped. It is NOT the same key as
 *    `dashboard.branding` (the brand-colour gate), which stays Pro-only and
 *    which the pass does not grant, so neither is substituted for the other.
 *  • "the entrant cap" — V319 raised Community to 64 and the pass to 128.
 *    Asserting 64 asserts what a passless community org already gets.
 * The live matrix (`set search_path = seazn_club`; the `public` schema holds a
 * stale pre-v3 copy) is the authority for every figure below.
 *
 * ── Keyless- and model-safe ────────────────────────────────────────────────
 * Nothing here needs Stripe, and nothing spends an Anthropic token.
 *
 * ── AI credits are no longer part of this pair pattern (v17 Phase 2) ────────
 * The old graded per-division AI run cap (community 5, pass 10 — a
 * per-division count, seeded via fake competition_events and read with
 * `mode: "repair"` against an empty-scope division to stay keyless-safe) was
 * retired (V322): AI runs are now metered by a prepaid, ORG-WIDE credit wallet
 * (`ai_credit_ledger`, V320+), and Event Pass carries no `ai.credits.monthly`
 * row at all — it never touches the wallet, so there is no pass-vs-sibling
 * pair to assert here. The wallet's plan-matrix figure (community 10) staying
 * put org-wide, regardless of a competition-scoped pass, is covered by the
 * org-wide entitlements check further down in this suite instead.
 */
async function passGrantsSuite(): Promise<void> {
  const genericDiv = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  const featureKey = (r: V1Res) => (r.json.error as { feature_key?: string } | undefined)?.feature_key;

  const s = newSession();
  const orgId = (await signIn(s, `passgrant_${tag}@example.com`)).org_id;
  const orgs = (await call(s, "/api/orgs")) as { id: string; slug: string; name: string }[];
  const org = orgs.find((o) => o.id === orgId)!;

  // Unlisted, not public: `dashboard.public.max` is 1 on community, and both
  // competitions still resolve through the public read model (only `private`
  // is excluded from public_competitions_v), so the public player card and the
  // public register panel both stay reachable.
  const mkComp = async (name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${name} ${tag}`, visibility: "unlisted" }),
    );
  const mkDiv = async (compId: string, name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(s, `/api/v1/competitions/${compId}/divisions`, "POST", { name, ...genericDiv }),
    );
  const entrants = (n: number, from: number, label: string) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "individual",
      display_name: `${label}${from + i}`,
      seed: from + i,
    }));

  const passComp = await mkComp("Grants Passed");
  const plainComp = await mkComp("Grants Plain");
  await grantPass(orgId, passComp.id, "event_pass");
  check(
    "pass grants: fixture built — one community org, two competitions, one passed",
    !!passComp.id && !!plainComp.id && passComp.id !== plainComp.id,
  );

  // A person consented to a public card, seated as an entrant member in BOTH
  // competitions. public_players_v filters on consent + entrant membership and
  // is NOT competition-scoped, so seating them twice removes the only other
  // reason the card could 404 — whichever side 404s, it 404s on the
  // entitlement and nothing else.
  const person = v1data<{ id: string }>(
    await v1(s, "/api/v1/persons", "POST", {
      full_name: `Grants Player ${tag}`,
      consent: { public_name: true },
    }),
  );

  // Per competition: a board division carrying real fixtures (realtime, the
  // branded export and the player card all read it) plus the ceiling probes.
  const board: Record<"pass" | "plain", { divId: string; fixtureId: string }> = {} as never;
  for (const [key, comp] of [["pass", passComp], ["plain", plainComp]] as const) {
    const div = await mkDiv(comp.id, "Board");
    await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "individual", display_name: `Board One ${key}`, seed: 1, members: [{ person_id: person.id }] },
      { kind: "individual", display_name: `Board Two ${key}`, seed: 2 },
    ]);
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
    );
    const fixtures = v1data<{ fixtures: { id: string }[] }>(
      await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
    ).fixtures;
    await v1(s, `/api/v1/divisions/${div.id}/start`, "POST");
    board[key] = { divId: div.id, fixtureId: fixtures[0]!.id };
  }

  // === entrants.per_division.max — community 64, pass 128 (V319) ==========
  const passCap = await mkDiv(passComp.id, "Entrant Cap");
  const plainCap = await mkDiv(plainComp.id, "Entrant Cap");
  const passTo128 = await v1(s, `/api/v1/divisions/${passCap.id}/entrants`, "POST", entrants(128, 1, "P"));
  const pass129 = await v1(s, `/api/v1/divisions/${passCap.id}/entrants`, "POST", entrants(1, 129, "P"));
  const plainTo64 = await v1(s, `/api/v1/divisions/${plainCap.id}/entrants`, "POST", entrants(64, 1, "C"));
  const plain65 = await v1(s, `/api/v1/divisions/${plainCap.id}/entrants`, "POST", entrants(1, 65, "C"));
  check(
    "pass grants/entrants: the passed competition seats 128 — past community's 64",
    passTo128.status === 201,
  );
  check(
    "pass grants/entrants: the 129th is refused (the pass ceiling is 128, not unlimited)",
    pass129.status === 402 && featureKey(pass129) === "entrants.per_division.max",
  );
  check(
    "pass grants/entrants: the sibling competition seats 64 (community's own cap)",
    plainTo64.status === 201,
  );
  check(
    "pass grants/entrants: the sibling is refused at 65 — the 128 did not leak org-wide",
    plain65.status === 402 && featureKey(plain65) === "entrants.per_division.max",
  );

  // === AI credits (V320+) — no longer a per-division/per-competition cap ===
  // The old graded per-division AI run cap (community 5, pass 10) was retired
  // (V322): AI runs are metered by a prepaid, ORG-WIDE credit wallet
  // (ai_credit_ledger), not a per-division count, and Event Pass grants
  // no ai.credits.monthly row at all (it is a competition-scoped entrant/
  // division bump only, SPEC-2 §4a) — a pass neither raises nor otherwise
  // touches the org's AI wallet. `passAiDiv` still exists purely as the
  // passed competition's THIRD division, which the divisions.per_competition.
  // max probe just below needs. The "AI credits stay at the community figure
  // org-wide, unaffected by the pass" half of this story is covered by the
  // org-wide entitlements check further down (`ai.credits.monthly === 10`).
  const passAiDiv = await mkDiv(passComp.id, "AI Five");

  // === divisions.per_competition.max — community 4, pass 10 (V319) =========
  // The sibling (no pass) already holds two divisions (Board, Entrant Cap);
  // community's cap is 4, so a 3rd and 4th still land, and the 5th is refused —
  // proving the pass did not lift the sibling's per-competition division cap.
  await v1(s, `/api/v1/competitions/${plainComp.id}/divisions`, "POST", { name: "Third", ...genericDiv });
  await v1(s, `/api/v1/competitions/${plainComp.id}/divisions`, "POST", { name: "Fourth", ...genericDiv });
  const plainFifth = await v1(s, `/api/v1/competitions/${plainComp.id}/divisions`, "POST", {
    name: "Fifth",
    ...genericDiv,
  });
  check(
    "pass grants/divisions: the sibling competition is refused a 5th division (community's cap is 4)",
    plainFifth.status === 402 && featureKey(plainFifth) === "divisions.per_competition.max",
  );
  let passDivisionsOk = true;
  for (let i = 4; i <= 10; i++) {
    const r = await v1(s, `/api/v1/competitions/${passComp.id}/divisions`, "POST", {
      name: `Filler ${i}`,
      ...genericDiv,
    });
    if (r.status !== 201) passDivisionsOk = false;
  }
  const pass11th = await v1(s, `/api/v1/competitions/${passComp.id}/divisions`, "POST", {
    name: "Eleventh",
    ...genericDiv,
  });
  check(
    "pass grants/divisions: the passed competition takes all 10 (past community's 4)",
    passDivisionsOk,
  );
  check(
    "pass grants/divisions: the 11th is refused (the pass ceiling is 10)",
    pass11th.status === 402 && featureKey(pass11th) === "divisions.per_competition.max",
  );

  // === realtime — community false, pass true ==============================
  // The noticeboard is the surface that resolves `realtime` WITH a competition
  // in hand (app/slideshow/divisions/[id]/page.tsx). The flag reaches the
  // client island as a prop, so it lands in the RSC payload embedded in the
  // page; the backslashes are the payload's own string escaping.
  const flightFlag = (body: string, want: boolean) =>
    body.replace(/\\/g, "").includes(`"realtime":${want}`);
  const passBoard = await html(s, `/slideshow/divisions/${board.pass.divId}`);
  const plainBoard = await html(s, `/slideshow/divisions/${board.plain.divId}`);
  check(
    "pass grants/realtime: the passed competition's noticeboard is live",
    passBoard.status === 200 && flightFlag(passBoard.body, true),
  );
  check(
    "pass grants/realtime: the sibling's noticeboard stays static — realtime did not leak",
    plainBoard.status === 200 && flightFlag(plainBoard.body, false),
  );

  // === exports.branded — community false, pass true =======================
  // Read the document, not the entitlement: docModelToXlsx writes the org name
  // as its own row ONLY when orgBranding() resolved (usecases/exports.ts keys
  // that on `exports.branded` with the competition id). XLSX rather than PDF
  // because pdfkit compresses its content streams, so byte-scanning a PDF for
  // the same string is unreliable.
  const ExcelJS = (await import("exceljs")).default;
  const exportColumnA = async (divisionId: string): Promise<string[]> => {
    const res = await fetch(`${BASE}/api/v1/divisions/${divisionId}/exports/timetable?format=xlsx`, {
      headers: { cookie: cookieHeader(s) },
    });
    if (res.status !== 200) return [`HTTP ${res.status}`];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const cells: string[] = [];
    wb.worksheets[0]?.eachRow((row) => cells.push(String(row.getCell(1).value ?? "")));
    return cells;
  };
  const passExport = await exportColumnA(board.pass.divId);
  const plainExport = await exportColumnA(board.plain.divId);
  check(
    "pass grants/exports: the passed competition's export carries branded chrome (org name row)",
    passExport[1] === org.name,
  );
  check(
    "pass grants/exports: the sibling's export renders plain — branding did not leak",
    plainExport.length > 1 && !plainExport.includes(org.name),
  );

  // === dashboard.player_profiles — community false, pass true =============
  // Same person, same consent, same entrant membership on both sides: the only
  // difference between a 200 and a 404 here is the pass.
  const passCard = await fetch(`${BASE}/shared/${org.slug}/${passComp.slug}/players/${person.id}`);
  const plainCard = await fetch(`${BASE}/shared/${org.slug}/${plainComp.slug}/players/${person.id}`);
  check(
    "pass grants/profiles: the public player card renders on the passed competition (200)",
    passCard.status === 200,
  );
  check(
    "pass grants/profiles: the same person has no card on the sibling (404) — no leak",
    plainCard.status === 404,
  );

  // === sponsors.tiers + sponsors.monetize — community false, pass true ====
  const tierOn = async (competitionId: string, label: string) =>
    v1(s, `/api/v1/orgs/${orgId}/sponsors`, "POST", {
      name: `Grants Sponsor ${label} ${tag}`,
      tier: "gold",
      competition_id: competitionId,
    });
  const packageOn = async (competitionId: string, label: string) =>
    v1(s, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", {
      name: `Grants Package ${label}`,
      price_cents: 25000,
      currency: "gbp",
      tier: "gold",
      competition_id: competitionId,
    });
  const passTier = await tierOn(passComp.id, "pass");
  const plainTier = await tierOn(plainComp.id, "plain");
  const passPackage = await packageOn(passComp.id, "pass");
  const plainPackage = await packageOn(plainComp.id, "plain");
  check(
    "pass grants/sponsors: a tiered sponsor saves on the passed competition (201)",
    passTier.status === 201,
  );
  check(
    "pass grants/sponsors: the sibling refuses the same tiered sponsor (402 sponsors.tiers)",
    plainTier.status === 402 && featureKey(plainTier) === "sponsors.tiers",
  );
  check(
    "pass grants/sponsors: a priced package saves on the passed competition (201)",
    passPackage.status === 201,
  );
  check(
    "pass grants/sponsors: the sibling refuses the same package (402 sponsors.monetize)",
    plainPackage.status === 402 && featureKey(plainPackage) === "sponsors.monetize",
  );

  // === registration.fee_percent — community 8, pass 5 =====================
  // Stated plainly, because this one is weaker than the rest and the reason
  // matters: the rate has NO competition-scoped read surface. `feePercentFor`
  // is consumed in exactly two places (the registration checkout and the
  // sponsor checkout), and both feed it straight into a Stripe
  // `application_fee_amount` that never comes back out — so there is nothing
  // keyless to observe. What IS assertable is split in two:
  //   • the matrix itself — the pass row must still say 5 against community's
  //     8, which fails the moment a migration regresses the grant;
  //   • the org-wide resolution — a competition-scoped 5% must not become the
  //     org's rate, which is the leak this suite exists to catch.
  // If a competition-scoped fee ever surfaces (a quote endpoint, or the
  // application fee echoed on the registration read), replace the first half
  // with the behavioural pair the other grants get.
  const feeDb = smokeDb();
  let feeMatrix: { plan_key: string; int_value: number | null }[] = [];
  try {
    feeMatrix = await feeDb<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
      where feature_key = 'registration.fee_percent'
        and plan_key in ('community', 'event_pass')`;
  } finally {
    await feeDb.end();
  }
  const feeFor = (planKey: string) => feeMatrix.find((r) => r.plan_key === planKey)?.int_value;
  check(
    "pass grants/fee: the pass still cuts the platform rate to 5% (community 8%)",
    feeFor("event_pass") === 5 && feeFor("community") === 8,
  );

  // === The org itself is untouched — every grant above is competition-scoped
  const ent = (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
    plan_key: string;
    entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
  };
  const flagOff = (key: string) => ent.entitlements[key]?.enabled === false;
  check(
    "pass grants/scope: the org still resolves the community plan",
    ent.plan_key === "community",
  );
  check(
    "pass grants/scope: every boolean grant stays OFF org-wide (realtime, exports.branded, profiles, sponsors)",
    flagOff("realtime") &&
      flagOff("exports.branded") &&
      flagOff("dashboard.player_profiles") &&
      flagOff("sponsors.tiers") &&
      flagOff("sponsors.monetize"),
  );
  check(
    "pass grants/scope: every quota stays at the community figure org-wide (64/4/10 entrants/divisions/AI credits, fee 8%)",
    ent.entitlements["entrants.per_division.max"]?.limit === 64 &&
      ent.entitlements["divisions.per_competition.max"]?.limit === 4 &&
      ent.entitlements["ai.credits.monthly"]?.limit === 10 &&
      ent.entitlements["registration.fee_percent"]?.limit === 8,
  );

  // === lock (archived) — a pass stops lifting once its competition is
  // terminal (SPEC-4 §7/§13.5, isPassLocked). Every grant above held while
  // `passComp` ran; retire it to `archived` and the SAME create that a moment
  // ago succeeded under the pass — a tiered sponsor (sponsors.tiers, 201 as
  // passTier) — must now 402. sponsors.tiers is boolean and state-free, so it
  // flips cleanly, where the entrant cap (already at 128) would 402 either
  // way. v17 #287: the status write DOES invalidate the resolver's
  // (org, competition, feature) cache now — patchCompetition busts it inside
  // the same call — so, unlike every raw-SQL write elsewhere in this suite,
  // there is deliberately NO bustOrgEntitlements call below. If that
  // invalidation ever regresses, this 402 goes stale on any Redis-backed
  // target (staging, a prod smoke run) for up to the 300s TTL; locally/CI
  // REDIS_URL is normally unset so the cache is inert and this only proves
  // the resolver logic, not the invalidation itself (see the dedicated
  // Redis-gated suite, entitlements-cache-invalidation.redis.test.ts).
  const retire = await v1(s, `/api/v1/competitions/${passComp.id}`, "PATCH", { status: "archived" });
  check("pass grants/lock: the passed competition retires to archived (200)", retire.status === 200);
  const lockedTier = await tierOn(passComp.id, "locked");
  check(
    "pass grants/lock: once archived the pass no longer lifts sponsors.tiers — the create that held under the pass now 402s",
    lockedTier.status === 402 && featureKey(lockedTier) === "sponsors.tiers",
  );

  // === lock (completed) — the OTHER terminal status (isPassLocked's set is
  // {archived, completed}), on a fresh comp so it's independent of the
  // archived case above. Also proves the pass was genuinely lifting the
  // ENTRANT cap (not just a boolean flag): 65 seats past community's 64
  // while live, then the 66th 402s the instant the completing PATCH commits.
  const lockComp = await mkComp("Grants Lock Completed");
  await grantPass(orgId, lockComp.id, "event_pass");
  const lockDiv = await mkDiv(lockComp.id, "Lock Cap");
  const lockPast64 = await v1(s, `/api/v1/divisions/${lockDiv.id}/entrants`, "POST", entrants(65, 1, "L"));
  check(
    "pass grants/lock(completed): the pass seats 65 — past community's 64 — while the competition is live",
    lockPast64.status === 201,
  );
  const complete = await v1(s, `/api/v1/competitions/${lockComp.id}`, "PATCH", { status: "completed" });
  check("pass grants/lock(completed): the competition completes (200)", complete.status === 200);
  const overCap = await v1(s, `/api/v1/divisions/${lockDiv.id}/entrants`, "POST", entrants(1, 66, "L"));
  check(
    "pass grants/lock(completed): once completed the pass stops lifting entrants.per_division.max — the 66th create 402s with no stale-cache window",
    overCap.status === 402 && featureKey(overCap) === "entrants.per_division.max",
  );
}

/**
 * v17 #294 — the Event Pass **L** rung, over real HTTP.
 *
 * `passGrantsSuite` above proves WHAT an Event Pass delivers. This proves the
 * LADDER: that the rung a buyer pays for is the rung the platform stores, and
 * the rung it then enforces. Three legs, in the order the money travels.
 *
 * 1. **A paid purchase is filed as the rung that was bought.** Driven through
 *    the app's REAL webhook route with a synthetic, correctly-signed
 *    `checkout.session.completed`, because that handler is the only production
 *    writer of `competition_passes` and an embedded Stripe checkout cannot be
 *    completed headlessly. So this leg exercises `recordPassPurchase` itself —
 *    the pass row, the flat +25 credit grant and the cache bust — rather than
 *    seeding the effects and admiring them. BOTH rungs are bought, on two
 *    competitions of one org: "L was stored as L" proves nothing against a
 *    writer that hardcodes L, and the M arm is what kills that mutation.
 *    Credits are asserted as a DELTA per purchase, so the grant being flat
 *    (`PASS_CREDIT_GRANT`, never keyed by rung — L buys a bigger competition,
 *    not more credits) fails loudly if anyone parametrises it.
 *
 * 2. **The stored rung is the enforced rung.** L is unlimited entrants / 20
 *    divisions where M is 128 / 10, asserted in the same passed-vs-sibling PAIR
 *    shape `passGrantsSuite` uses — except the sibling is doubled: a PASSLESS
 *    competition (community's 4) and an M-PASSED one (M's 128/10). A ceiling
 *    that leaks in either direction therefore fails for the right reason, and
 *    "seats 200" cannot be satisfied by a plan that simply has no ceiling.
 *
 * 3. **The buy route refuses what it cannot honour** — an unrecognised rung
 *    (400 from the zod enum, before any Stripe call) and a competition that
 *    already holds a pass (400, ahead of the price lookup). Both keyless.
 *
 * Plus the PRO path, which is not a formality here: `resolveFromDb` skips the
 * Event Pass overlay entirely for a paid plan, so an L pass on a Pro org must
 * neither CAP Pro's unlimited divisions at L's 20 nor LIFT Pro's 256-entrant
 * ceiling to L's unlimited. Both directions are wrong and both are asserted.
 * That org's pass is seeded with `grantPass` — the buy route refuses a paid
 * plan outright — which also gives the rung column's `not null default
 * 'event_pass'` landmine a live witness on every run.
 *
 * Own fresh orgs. Leg 1 needs the server's `STRIPE_WEBHOOK_SECRET` (and a
 * `STRIPE_SECRET_KEY`, which the route's verifier constructs a client from) and
 * skips cleanly without them — the same convention as `paymentMethodSuite`,
 * with the rungs seeded directly so legs 2 and 3 still run. Everything else is
 * keyless and spends no AI tokens.
 */
async function passRungLSuite(): Promise<void> {
  const genericDiv = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  const featureKey = (r: V1Res) =>
    (r.json.error as { feature_key?: string } | undefined)?.feature_key;
  const entrants = (n: number, from: number, label: string) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "individual",
      display_name: `${label}${from + i}`,
      seed: from + i,
    }));

  // === the ladder itself ==================================================
  // Everything below reasons about "the OTHER rung", so smoke's hand-kept
  // PASS_RUNGS copy has to still be the whole truth. A third rung seeded
  // without touching this file would leave every pair assertion quietly
  // incomplete; this is the one check that notices.
  const rungsInDb = await passRungsInDb();
  check(
    `pass L/ladder: plans carries exactly the rungs smoke knows about (${PASS_RUNGS.join(", ")})`,
    rungsInDb.join(",") === [...PASS_RUNGS].sort().join(","),
  );

  const s = newSession();
  const orgId = (await signIn(s, `passl_${tag}@example.com`)).org_id;
  const mkComp = async (name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `${name} ${tag}`,
        visibility: "unlisted",
      }),
    );
  const mkDiv = (compId: string, name: string) =>
    v1(s, `/api/v1/competitions/${compId}/divisions`, "POST", { name, ...genericDiv });

  const lComp = await mkComp("Rung L");
  const mComp = await mkComp("Rung M");
  const plainComp = await mkComp("Rung Plain");
  check(
    "pass L: fixture built — one community org, three competitions (L, M, passless)",
    !!lComp.id && !!mComp.id && !!plainComp.id,
  );

  // === Leg 1 — the money path ==============================================
  const canSignWebhooks = !!process.env.STRIPE_WEBHOOK_SECRET && !!process.env.STRIPE_SECRET_KEY;
  if (canSignWebhooks) {
    const startBalance = await walletBalance(orgId);

    const lIntent = `pi_smoke_${tag}_l`;
    const lAck = await postPaidPassWebhook({
      orgId,
      competitionId: lComp.id,
      passKey: "event_pass_l",
      paymentIntent: lIntent,
    });
    check("pass L/paid: the signed L checkout.session.completed is accepted (200)", lAck === 200);
    const lRow = await passRowFor(lComp.id);
    check(
      "pass L/paid: the purchase is FILED as the rung that was bought (pass_key event_pass_l, carrying its intent) — the $59 sale is not recorded as the $29 product",
      lRow?.pass_key === "event_pass_l" && lRow?.stripe_payment_intent === lIntent,
    );
    const afterL = await walletBalance(orgId);
    check(
      "pass L/paid: the one-time +25 AI credit grant fires on an L purchase",
      afterL - startBalance === 25,
    );

    const mIntent = `pi_smoke_${tag}_m`;
    const mAck = await postPaidPassWebhook({
      orgId,
      competitionId: mComp.id,
      passKey: "event_pass",
      paymentIntent: mIntent,
    });
    const mRow = await passRowFor(mComp.id);
    check(
      "pass L/paid: the same writer files an M purchase as event_pass — the rung is read from the session, not hardcoded",
      mAck === 200 && mRow?.pass_key === "event_pass" && mRow?.stripe_payment_intent === mIntent,
    );
    check(
      "pass L/paid: M grants the same 25 — PASS_CREDIT_GRANT is flat across rungs, never parametrised by one",
      (await walletBalance(orgId)) - afterL === 25,
    );
  } else {
    await grantPass(orgId, lComp.id, "event_pass_l");
    await grantPass(orgId, mComp.id, "event_pass");
    check(
      "pass L/paid: skipped (no STRIPE_WEBHOOK_SECRET + STRIPE_SECRET_KEY — cannot sign a webhook this server will accept); both rungs seeded directly instead",
      true,
    );
  }

  // === Leg 2 — the stored rung is the enforced rung ========================
  // entrants.per_division.max — L unlimited, M 128 (V319/V341), community 64.
  const lCapDiv = v1data<{ id: string }>(await mkDiv(lComp.id, "L Entrant Cap"));
  const lSeats = await v1(
    s,
    `/api/v1/divisions/${lCapDiv.id}/entrants`,
    "POST",
    entrants(200, 1, "L"),
  );
  check(
    "pass L/entrants: the L-passed competition seats 200 in one division — past M's 128 (L is unlimited)",
    lSeats.status === 201,
  );
  const mCapDiv = v1data<{ id: string }>(await mkDiv(mComp.id, "M Entrant Cap"));
  const mSeats = await v1(
    s,
    `/api/v1/divisions/${mCapDiv.id}/entrants`,
    "POST",
    entrants(128, 1, "M"),
  );
  const m129 = await v1(
    s,
    `/api/v1/divisions/${mCapDiv.id}/entrants`,
    "POST",
    entrants(1, 129, "M"),
  );
  check(
    "pass L/entrants: the M-passed competition still stops at 128 — L's unlimited did not leak to the other rung",
    mSeats.status === 201 &&
      m129.status === 402 &&
      featureKey(m129) === "entrants.per_division.max",
  );

  // divisions.per_competition.max — L 20, M 10, community 4. Each competition
  // already holds its entrant-cap division, so the fillers start at 2.
  let lDivisionsOk = true;
  for (let i = 2; i <= 20; i++) {
    if ((await mkDiv(lComp.id, `L Filler ${i}`)).status !== 201) lDivisionsOk = false;
  }
  const l21st = await mkDiv(lComp.id, "L Twenty-first");
  check("pass L/divisions: the L-passed competition takes all 20 (past M's 10)", lDivisionsOk);
  check(
    "pass L/divisions: the 21st is refused — the L ceiling is 20, not unlimited",
    l21st.status === 402 && featureKey(l21st) === "divisions.per_competition.max",
  );

  let mDivisionsOk = true;
  for (let i = 2; i <= 10; i++) {
    if ((await mkDiv(mComp.id, `M Filler ${i}`)).status !== 201) mDivisionsOk = false;
  }
  const m11th = await mkDiv(mComp.id, "M Eleventh");
  check(
    "pass L/divisions: the M-passed competition still stops at 10 — L's 20 did not leak to the other rung",
    mDivisionsOk &&
      m11th.status === 402 &&
      featureKey(m11th) === "divisions.per_competition.max",
  );

  let siblingOk = true;
  for (let i = 1; i <= 4; i++) {
    if ((await mkDiv(plainComp.id, `Sibling ${i}`)).status !== 201) siblingOk = false;
  }
  const sibling5th = await mkDiv(plainComp.id, "Sibling Fifth");
  check(
    "pass L/divisions: the passless sibling stays on community's 4 — neither rung leaked org-wide",
    siblingOk &&
      sibling5th.status === 402 &&
      featureKey(sibling5th) === "divisions.per_competition.max",
  );

  const ent = (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
    plan_key: string;
    entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
  };
  check(
    "pass L/scope: two passes bought and the org still resolves community org-wide (64 entrants, 4 divisions) — a pass is not a plan",
    ent.plan_key === "community" &&
      ent.entitlements["entrants.per_division.max"]?.limit === 64 &&
      ent.entitlements["divisions.per_competition.max"]?.limit === 4,
  );

  // === Leg 3 — what the buy route refuses (keyless: both answer before Stripe)
  const badRung = await raw(s, "/api/billing/pass-checkout", "POST", {
    competition_id: plainComp.id,
    pass_key: "event_pass_xl",
  });
  // Both checks assert the REASON as well as the status. A 400 alone is the
  // route's answer to half a dozen unrelated refusals and to any body-schema
  // change — a renamed field would 400 on "competition_id is required" and keep
  // both of these green while proving nothing about the rung enum or the
  // one-pass rule. The reasons themselves are pinned in
  // lib/__tests__/pass-checkout-plan-gate.test.ts; this is the wire version.
  check(
    "pass L/checkout: an unrecognised rung is refused (400) by the SCHEMA, naming pass_key — the enum is built from PASS_KEYS, not a hardcoded list",
    badRung.status === 400 &&
      badRung.json.error === "Invalid input" &&
      (badRung.json.issues ?? []).some((i) => (i.path ?? []).includes("pass_key")),
  );
  const alreadyPassed = await raw(s, "/api/billing/pass-checkout", "POST", {
    competition_id: lComp.id,
    pass_key: "event_pass_l",
  });
  check(
    "pass L/checkout: a competition that already holds a pass refuses a second one (400), and says so",
    alreadyPassed.status === 400 &&
      (alreadyPassed.json.error ?? "").includes("already has an Event Pass"),
  );

  // === The pro path — a pass and a paid plan are read TOGETHER (v17 #327/#337)
  // Until V344 the overlay was skipped entirely under a paid plan, so an L
  // holder who subscribed to Pro silently lost unlimited entrants on the
  // competition they had already paid to unlock. Now the BETTER of the two
  // applies per axis, and both directions of that are checked below: the plan
  // wins on divisions, the pass wins on entrants. ===
  const pro = newSession();
  const proOrgId = (await signIn(pro, `passlpro_${tag}@example.com`)).org_id;
  await setPlan(proOrgId, "pro", pro);
  const proComp = v1data<{ id: string }>(
    await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Rung L Pro ${tag}`,
      visibility: "unlisted",
    }),
  );
  await grantPass(proOrgId, proComp.id, "event_pass_l");
  const proPass = await passRowFor(proComp.id);
  check(
    "pass L/pro: a directly-seeded L pass is STORED as event_pass_l — an omitted rung is filed as M by the column default (V271) with nothing red",
    proPass?.pass_key === "event_pass_l",
  );

  const proDivIds: string[] = [];
  let proDivisionsOk = true;
  for (let i = 1; i <= 21; i++) {
    const r = await v1(pro, `/api/v1/competitions/${proComp.id}/divisions`, "POST", {
      name: `Pro Div ${i}`,
      ...genericDiv,
    });
    if (r.status !== 201) proDivisionsOk = false;
    else proDivIds.push(v1data<{ id: string }>(r).id);
  }
  check(
    "pass L/pro: an L pass does not CAP a Pro competition at L's 20 divisions — the 21st still lands, because the PLAN wins on the axis where it is better (#327)",
    proDivisionsOk,
  );

  const proDivId = proDivIds[0]!;
  const pro256 = await v1(
    pro,
    `/api/v1/divisions/${proDivId}/entrants`,
    "POST",
    entrants(256, 1, "R"),
  );
  const pro257 = await v1(
    pro,
    `/api/v1/divisions/${proDivId}/entrants`,
    "POST",
    entrants(1, 257, "R"),
  );
  const pro300 = await v1(
    pro,
    `/api/v1/divisions/${proDivId}/entrants`,
    "POST",
    entrants(43, 258, "R"),
  );
  check(
    "pass L/pro: L's unlimited entrants LIFT Pro's 256 ceiling on the passed competition — the 257th lands, and so does the 300th (#337)",
    pro256.status === 201 && pro257.status === 201 && pro300.status === 201,
  );

  // The SELLING half of the same decision (#327): a paid org may buy a rung
  // that beats its plan, and only that rung. On a competition with no pass yet,
  // because a competition that holds one refuses any second purchase first.
  const proGateComp = v1data<{ id: string }>(
    await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Rung L Pro Gate ${tag}`,
      visibility: "unlisted",
    }),
  );
  const proBuyM = await raw(pro, "/api/billing/pass-checkout", "POST", {
    competition_id: proGateComp.id,
    pass_key: "event_pass",
  });
  const proBuyL = await raw(pro, "/api/billing/pass-checkout", "POST", {
    competition_id: proGateComp.id,
    pass_key: "event_pass_l",
  });
  const coverageRefusal = (r: { status: number; json: { error?: string } }) =>
    r.status === 400 && (r.json.error ?? "").includes("already includes everything");
  check(
    "pass L/pro: the M rung is refused to a Pro org — its plan already covers everything M adds (#327)",
    coverageRefusal(proBuyM),
  );
  // NOT asserted as 200: the one-time price may be unsynced in this environment,
  // which 503s. What must be true is that the COVERAGE gate did not fire — the
  // sale is allowed to reach Stripe.
  check(
    "pass L/pro: the L rung is not refused on coverage — L beats Pro on entrants, so the sale is allowed through (#327)",
    !coverageRefusal(proBuyL),
  );
}

/** clubs-w1 (W1 §5): parent clubs group teams across divisions. The Pro path
 *  walks the whole /clubs/[id] hub lifecycle over HTTP — create a club, PATCH
 *  its profile (home ground), add a committee contact, create a *standalone*
 *  team, move it under the club, then replace its squad with a person created
 *  inline (the squad editor's quick-add). The free path proves the V319
 *  community cap: clubs.max = 5, so five clubs succeed and the sixth 402s with
 *  the `feature_key` the contextual <UpgradeGate> reads. Both run on their own
 *  fresh orgs (Pro flipped via setPlan, free stays community) so the suite is
 *  order-independent — the earlier suites downgrade the shared org2. */
async function clubsSuite(): Promise<void> {
  // --- Pro path: the full club-hub lifecycle.
  const pro = newSession();
  const proVer = await signIn(pro, `clubpro_${tag}@example.com`);
  await setPlan(proVer.org_id, "pro", pro);

  const club = await v1(pro, "/api/v1/clubs", "POST", {
    name: `Riverside SC ${tag}`,
  });
  check("clubs pro: club created (201)", club.status === 201);
  const clubId = v1data<{ id: string }>(club).id;

  const patched = await v1(pro, `/api/v1/clubs/${clubId}`, "PATCH", {
    home_ground: "Riverside Park",
    website: "https://riverside.example",
  });
  check(
    "clubs pro: profile PATCH persists the home ground",
    patched.status === 200 &&
      v1data<{ home_ground: string | null }>(patched).home_ground === "Riverside Park",
  );

  const contact = await v1(pro, `/api/v1/clubs/${clubId}/contacts`, "POST", {
    role_key: "secretary",
    full_name: `Sam Secretary ${tag}`,
    email: `sam_${tag}@example.com`,
    is_primary: true,
  });
  check("clubs pro: committee contact added (201)", contact.status === 201);
  // The contact surfaces on the hub read (getClub feeds the Overview tab).
  const detail = await v1(pro, `/api/v1/clubs/${clubId}`);
  const contacts =
    v1data<{ contacts: { full_name: string; is_primary: boolean }[] }>(detail).contacts ?? [];
  check(
    "clubs pro: contact is primary on the hub read",
    contacts.some((c) => c.full_name === `Sam Secretary ${tag}` && c.is_primary),
  );

  // Standalone team (club_id omitted) — the directory ladder step 2 — then move
  // it under the club, exactly as the hub Teams-tab detach/attach does.
  const team = await v1(pro, "/api/v1/teams", "POST", {
    name: `Riverside U12 ${tag}`,
  });
  check(
    "clubs pro: standalone team created (no club)",
    team.status === 201 && v1data<{ club_id: string | null }>(team).club_id === null,
  );
  const teamId = v1data<{ id: string }>(team).id;
  const moved = await v1(pro, `/api/v1/teams/${teamId}`, "PATCH", {
    club_id: clubId,
  });
  check(
    "clubs pro: team moved under the club",
    moved.status === 200 && v1data<{ club_id: string | null }>(moved).club_id === clubId,
  );

  // Quick-add a person (squad editor inline create), then full-replace the squad.
  const person = await v1(pro, "/api/v1/persons", "POST", {
    full_name: `Quinn Quickadd ${tag}`,
  });
  check("clubs pro: quick-add person created (201)", person.status === 201);
  const personId = v1data<{ id: string }>(person).id;
  const squad = await v1(pro, `/api/v1/teams/${teamId}/squad`, "PUT", {
    members: [{ person_id: personId, squad_number: 7, is_captain: true }],
  });
  const members =
    v1data<{
      members: {
        person_id: string;
        is_captain: boolean;
        squad_number: number | null;
      }[];
    }>(squad).members ?? [];
  check(
    "clubs pro: squad saved with the quick-added captain (#7)",
    squad.status === 200 &&
      members.length === 1 &&
      members[0]!.person_id === personId &&
      members[0]!.is_captain === true &&
      members[0]!.squad_number === 7,
  );

  // Enroll the team → the entrant roster is a ONE-TIME snapshot of the squad;
  // later squad edits stay off the entry until the explicit roster/sync.
  const syncComp = await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Sync Cup ${tag}`,
    visibility: "private",
  });
  const syncDiv = await v1(
    pro,
    `/api/v1/competitions/${v1data<{ id: string }>(syncComp).id}/divisions`,
    "POST",
    {
      name: "Sync Div",
      sport_key: "generic",
      variant_key: "score",
      config: {
        resultMode: "score",
        allowDraws: true,
        points: { w: 3, d: 1, l: 0 },
        progressScore: false,
      },
      eligibility: [],
    },
  );
  const syncDivId = v1data<{ id: string }>(syncDiv).id;
  const enrolled = await v1(pro, `/api/v1/divisions/${syncDivId}/entrants`, "POST", [
    { kind: "team", team_id: teamId, members: [] },
  ]);
  const entrantId = v1data<{ id: string }[]>(enrolled)[0]!.id;
  const seeded = await v1(pro, `/api/v1/entrants/${entrantId}`);
  check(
    "clubs pro: enrollment seeded the roster from the squad (snapshot of 1)",
    enrolled.status === 201 && (v1data<{ members: unknown[] }>(seeded).members ?? []).length === 1,
  );

  const late = await v1(pro, "/api/v1/persons", "POST", {
    full_name: `Lena Late ${tag}`,
  });
  const lateId = v1data<{ id: string }>(late).id;
  await v1(pro, `/api/v1/teams/${teamId}/squad`, "PUT", {
    members: [
      { person_id: personId, squad_number: 7, is_captain: true },
      { person_id: lateId, squad_number: 9 },
    ],
  });
  const stale = await v1(pro, `/api/v1/entrants/${entrantId}`);
  check(
    "clubs pro: squad edit does NOT touch the enrolled roster (still 1)",
    (v1data<{ members: unknown[] }>(stale).members ?? []).length === 1,
  );
  const synced = await v1(pro, `/api/v1/entrants/${entrantId}/roster/sync`, "POST", {});
  check(
    "clubs pro: roster/sync replaces the entry roster with the current squad (2)",
    synced.status === 200 && (v1data<{ members: unknown[] }>(synced).members ?? []).length === 2,
  );
  const solo = await v1(pro, `/api/v1/divisions/${syncDivId}/entrants`, "POST", [
    { kind: "individual", display_name: `Solo ${tag}`, members: [] },
  ]);
  const soloSync = await v1(
    pro,
    `/api/v1/entrants/${v1data<{ id: string }[]>(solo)[0]!.id}/roster/sync`,
    "POST",
    {},
  );
  check("clubs pro: roster/sync on a team-less entrant 422s", soloSync.status === 422);

  // --- Free path: the tunable community clubs.max = 5 (V319 "free runs big").
  // Five clubs land, the sixth 402s with the feature key that drives the paywall.
  const free = newSession();
  await signIn(free, `clubfree_${tag}@example.com`);
  const freeClubs = [];
  for (let i = 1; i <= 5; i++) {
    freeClubs.push(await v1(free, "/api/v1/clubs", "POST", { name: `Free Club ${i} ${tag}` }));
  }
  check("clubs free: first five clubs allowed on community", freeClubs.every((r) => r.status === 201));
  const c6 = await v1(free, "/api/v1/clubs", "POST", {
    name: `Free Club Six ${tag}`,
  });
  check(
    "clubs free: sixth club 402s with the clubs.max feature key",
    c6.status === 402 &&
      (c6.json.error as { feature_key?: string } | undefined)?.feature_key === "clubs.max",
  );
}

/** #267 (SPEC-5 §2) + v17 gap #296: referral attribution + the new org's
 *  welcome grant — the part live traffic actually exercises through
 *  `/refer/<code>` (cookie set → a fresh signup's org creation stamps
 *  `referred_by_org_id`). Since #296 the welcome (+10) and onboarding (+10)
 *  earn grants no longer fire at signup — a scripted signup could farm 20
 *  credits per email — they pay out only once the org PUBLISHES a competition
 *  with a division, so this suite proves both halves: nothing at signup, both
 *  grants after publish. The referrer's own
 *  +20-on-the-referred-org's-first-paid-competition side needs a full Stripe
 *  checkout fixture and is already covered by `registrations.ts`'s unit tests
 *  — not re-proven here. Own fresh orgs; keyless-safe, no AI tokens spent. */
async function referralSuite(): Promise<void> {
  const referrerEmail = `referrer_${tag}@example.com`;
  const referredEmail = `referred_${tag}@example.com`;

  const referrer = newSession();
  const referrerAuth = await signIn(referrer, referrerEmail);

  // Mint the referrer's shareable code with the same once-only,
  // never-overwrite UPDATE `getOrCreateReferralCode` uses — the mint race
  // itself is unit-tested; smoke only needs a live code to attribute against.
  const code = `SMK${tag}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const mint = smokeDb();
  try {
    await mint`
      update organizations set referral_code = ${code}
       where id = ${referrerAuth.org_id} and referral_code is null`;
  } finally {
    await mint.end();
  }

  // A fresh signup landing with the referrer's code in the `ref` cookie (as
  // the `/refer/<code>` route would set it) — attribution happens inside
  // `createOrgForUser` at account-creation time, not on this cookie-set step.
  const referred = newSession();
  referred.cookies.ref = code;
  const referredAuth = await signIn(referred, referredEmail);

  const walletId = await walletIdForOrg(referredAuth.org_id);
  const earnRows = async (): Promise<{ delta: number; idempotency_key: string }[]> => {
    const db = smokeDb();
    try {
      return await db<{ delta: number; idempotency_key: string }[]>`
        select delta, idempotency_key from ai_credit_ledger
         where wallet_id = ${walletId} and source = 'earn_grant'`;
    } finally {
      await db.end();
    }
  };

  const db = smokeDb();
  try {
    const [org] = await db<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${referredAuth.org_id}`;
    check(
      "referral: a signup via /refer/<code> stamps referred_by_org_id",
      org?.referred_by_org_id === referrerAuth.org_id,
    );
  } finally {
    await db.end();
  }

  // v17 gap #296: signup alone earns NOTHING — no onboarding, no welcome.
  check("referral/#296: signup alone earns no credits", (await earnRows()).length === 0);

  // The referred org publishes a competition WITH a division — the real-usage
  // signal both growth-loop grants are gated on since #296.
  referred.cookies["seazn_org"] = referredAuth.org_id;
  const comp = await v1(referred, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Referred Cup ${tag}` });
  check("referral/#296: the referred org creates a competition (201)", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;
  const div = await v1(referred, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  check("referral/#296: ...adds a division (201)", div.status === 201);
  const publish = await v1(referred, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "published",
  });
  check("referral/#296: ...and publishes it (200)", publish.status === 200);

  const rows = await earnRows();
  const byKey = new Map(rows.map((r) => [r.idempotency_key, r.delta]));
  check(
    "referral/#296: publish-with-division pays the +10 onboarding earn",
    byKey.get(`earn:onboarding:${referredAuth.org_id}`) === 10,
  );
  check(
    "referral/#296: publish-with-division pays the referred org's +10 welcome grant",
    byKey.get(`earn:referral_welcome:${referredAuth.org_id}`) === 10,
  );
}

/**
 * v17 gap #293 — the extra-organisation recurring add-on, end to end at the
 * wire, on BOTH paths.
 *
 * PRO path (the payer): a Pro Plus payer standing on their plan's 10-org cap is
 * refused a plain "create org #11" with a 402 that CARRIES a purchase offer;
 * buying the rider lifts the cap by exactly one and the SAME create then
 * succeeds. The refusal is asserted BEFORE the purchase deliberately — "the
 * create succeeded" is evidence of a lift only if it was first proven refused.
 *
 * FREE path (community): an owner at the community one-org cap is refused on
 * the same wire path with NO offer. Community has no rider SKU, so the remedy
 * is an upgrade; offering a purchase there would only relocate the dead end to
 * the purchase route's 400 one screen later.
 *
 * NON-PAYER: an owner of organisations INSIDE the Pro Plus group above, at the
 * very same cap, who is not that group's `subscriptions.owner_user_id`. Also
 * refused, also with no offer — the purchase route (setExtraOrgs →
 * requireBillingOwner) 403s anyone but the payer. Reachable in production:
 * transferGroup moves the payer and leaves org owners where they are.
 *
 * The two absences are worth something only because the payer's arm proves the
 * offer DOES reach this wire on the byte-identical request; that arm is their
 * positive discriminator, and the 402 shape asserted is the TOP-LEVEL one
 * (`lib/http.ts` spreads `extra` next to `feature_key`; the /api/v1 serialiser
 * deliberately does not, and this route is not a v1 route).
 *
 * Nine of the ten organisations are seeded straight into the DB, and the
 * "purchase" writes the `org_addons` row the real webhook
 * (billing-events.syncOrgAddonsForSubscription) is the single writer of —
 * smoke has no live Stripe, exactly as setPlan's own doc comment describes for
 * plans. The attach HTTP round trip is already proven end to end by the
 * billing-group block in main(); this suite's job is the cap BOUNDARY, not
 * attach mechanics. No cache bust is needed after the add-on insert:
 * `getLimit` is the CACHED plan base plus an UNCACHED `org_addons` sum
 * (lib/entitlements.ts), unlike a raw `plan_key` write, which is why the plan
 * flip at the end goes through setPlan and the purchase does not.
 *
 * Own fresh group; keyless-safe, no Stripe calls.
 */
async function extraOrgAddonSuite(): Promise<void> {
  // V314: community 1 / pro 5 / pro_plus 10. The two rider RATES ($9 Pro,
  // $19 Pro Plus) are Stripe's business and are pinned by the BILLING_LIVE
  // suite; what smoke owns is the CAPACITY those caps bound.
  const PRO_PLUS_ORG_CAP = 10;
  const PRO_ORG_CAP = 5;

  interface Refusal {
    feature_key?: string;
    reason?: string;
    offer?: string;
  }
  const refusal = (j: unknown) => j as Refusal;

  // Resolved entitlements for an org — the same endpoint the billing tab reads.
  const orgCap = async (s: Session, orgId: string) =>
    (
      (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
        entitlements: Record<string, { limit?: number | null }>;
      }
    ).entitlements["orgs.max_owned"]?.limit;

  const payerEmail = `orgaddon_${tag}@example.com`;
  const payer = newSession();
  const auth = await signIn(payer, payerEmail);
  await setPlan(auth.org_id, "pro_plus", payer); // busts the entitlement cache itself

  const db = smokeDb();
  try {
    const [ownerRow] = await db<{ id: string }[]>`
      select id from users where email = ${payerEmail}`;
    const [orgRow] = await db<{ wallet_id: string }[]>`
      select coalesce(subscription_id::text, id::text) as wallet_id
        from organizations where id = ${auth.org_id}`;
    const payerUserId = ownerRow!.id;
    const walletId = orgRow!.wallet_id;

    // Fill the group to the Pro Plus cap of 10 — nine more organisations on the
    // same subscription, owned by the payer. Both caps must read "at 10": the
    // PERSON cap (assertMayOwnAnotherOrg, which is what a bare create hits) and
    // the GROUP cap (attachOrgToGroup, not exercised here).
    const fillIds: string[] = [];
    for (let i = 0; i < PRO_PLUS_ORG_CAP - 1; i++) {
      const [seeded] = await db<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Org Addon Fill ${tag} ${i}`}, ${`org-addon-fill-${tag}-${i}`},
                ${payerUserId}, ${walletId})
        returning id`;
      await db`insert into org_members (org_id, user_id, role)
               values (${seeded!.id}, ${payerUserId}, 'owner')`;
      fillIds.push(seeded!.id);
    }
    const [groupSize] = await db<{ n: number }[]>`
      select count(*)::int as n from organizations where subscription_id = ${walletId}`;
    check(
      `extra-org: fixture built — one Pro Plus bill carrying ${PRO_PLUS_ORG_CAP} organisations, all owned by its payer`,
      groupSize?.n === PRO_PLUS_ORG_CAP,
    );
    check(
      "extra-org: the resolved cap starts at the Pro Plus base of 10 — nothing bought yet",
      (await orgCap(payer, auth.org_id)) === PRO_PLUS_ORG_CAP,
    );

    // --- the refusal, asserted BEFORE anything is bought -----------------
    const blocked = await raw(payer, "/api/orgs", "POST", { name: `Org 11 ${tag}` });
    check(
      "extra-org: organisation #11 is REFUSED at the Pro Plus cap of 10 (402)",
      blocked.status === 402,
    );
    check(
      "extra-org: the payer's 402 carries the purchase offer at the top level (#293)",
      refusal(blocked.json).feature_key === "orgs.max_owned" &&
        refusal(blocked.json).offer === "extra_org",
    );

    // --- NON-PAYER: same group, same cap, no offer -----------------------
    // Co-owning the nine seeded organisations puts this user at the same
    // PERSON cap (it counts organisations they own, on anyone's bill) while the
    // only group they could actually buy on is their own auto-provisioned
    // community one. Runs BEFORE the purchase on purpose — a bought rider would
    // lift this cap to 11 and the refusal would stop being reachable.
    const nonPayerEmail = `orgaddon_nonpayer_${tag}@example.com`;
    const nonPayer = newSession();
    await signIn(nonPayer, nonPayerEmail);
    const [npRow] = await db<{ id: string }[]>`
      select id from users where email = ${nonPayerEmail}`;
    for (const id of fillIds) {
      await db`insert into org_members (org_id, user_id, role)
               values (${id}, ${npRow!.id}, 'owner')`;
    }
    const npBlocked = await raw(nonPayer, "/api/orgs", "POST", { name: `NP Org ${tag}` });
    check(
      "extra-org/non-payer: an owner inside the same Pro Plus group is refused at the same cap (402)",
      npBlocked.status === 402 && refusal(npBlocked.json).feature_key === "orgs.max_owned",
    );
    check(
      "extra-org/non-payer: ...and is offered NOTHING — only the group's payer may buy the rider (the identical request offered it to the payer above)",
      refusal(npBlocked.json).offer === undefined,
    );
    // WHY the offer is withheld, asserted at the wire rather than argued in a
    // comment. `requireBillingOwner` reads the ACTIVE-ORG cookie, so point it at
    // one of the payer's organisations — the one this user genuinely co-owns —
    // and the route resolves the payer's group and finds someone else's
    // `owner_user_id`. That refusal lands BEFORE `getStripe()`, which is what
    // makes it assertable here with no Stripe key at all.
    nonPayer.cookies["seazn_org"] = fillIds[0]!;
    const npBuy = await raw(nonPayer, "/api/billing/extra-orgs", "POST", { count: 1 });
    check(
      "extra-org/non-payer: the purchase route itself refuses them (403) — the withheld offer is not a dead end, it is the truth",
      npBuy.status === 403,
    );

    // --- FREE path: community sells no rider -----------------------------
    const freeEmail = `orgaddon_free_${tag}@example.com`;
    const free = newSession();
    await signIn(free, freeEmail);
    const freeBlocked = await raw(free, "/api/orgs", "POST", { name: `Free Org ${tag}` });
    check(
      "extra-org/free: a community owner is refused a second organisation (402, orgs.max_owned)",
      freeBlocked.status === 402 && refusal(freeBlocked.json).feature_key === "orgs.max_owned",
    );
    check(
      "extra-org/free: ...and is offered NOTHING — community has no rider SKU, so the remedy is an upgrade rather than a purchase",
      refusal(freeBlocked.json).offer === undefined,
    );
    // Same reasoning as the non-payer arm: the community refusal (409, no live
    // paid subscription to hang an item on) also lands before `getStripe()`, so
    // "the route would refuse them anyway" stops being prose.
    const freeBuy = await raw(free, "/api/billing/extra-orgs", "POST", { count: 1 });
    check(
      "extra-org/free: the purchase route refuses a community group outright (409) — nothing to attach a recurring item to",
      freeBuy.status === 409,
    );

    // --- buy one extra organisation --------------------------------------
    // The webhook is the SINGLE writer of these rows in production; this insert
    // stands in for it exactly as setPlan stands in for a real plan change. The
    // stripe_item_id is tag-unique on purpose: V324's unique index is on
    // stripe_item_id ALONE, so a shared literal would silently move another
    // run's row onto this wallet while every wallet-scoped read still passed.
    await db`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                              stripe_item_id, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 1,
              ${`si_smoke_orgaddon_${tag}`}, 'active')`;
    check(
      "extra-org: the purchased rider lifts the resolved cap by exactly one (10 → 11)",
      (await orgCap(payer, auth.org_id)) === PRO_PLUS_ORG_CAP + 1,
    );

    const created = await raw(payer, "/api/orgs", "POST", { name: `Org 11 ${tag}` });
    check(
      "extra-org: the SAME create that 402'd above now succeeds — organisation #11 exists",
      created.status === 200 && !!(created.json.data as { id?: string } | undefined)?.id,
    );
    const org11Id = (created.json.data as { id?: string } | undefined)?.id;

    // --- the customer's ACTUAL next move: put #11 on the bill they bought for
    // A new organisation is minted on its OWN group, so the story so far ends
    // one step short of what the payer wanted — capacity on THIS bill. The
    // attach is governed by the GROUP cap (assertWithinGroupCap → groupOrgLimit)
    // rather than the PERSON cap the create hit, and that is a second reader of
    // the rider entirely. 10 held + 1 against a cap of 10 + 1 rider is exactly
    // at the line, so this passes only while the rider is being counted.
    const attached11 = await raw(payer, "/api/billing/group/attach", "POST", {
      org_id: org11Id,
      subscription_id: walletId,
    });
    const [groupAfter] = await db<{ n: number }[]>`
      select count(*)::int as n from organizations
       where subscription_id = ${walletId} and deleted_at is null`;
    check(
      "extra-org: organisation #11 ATTACHES to the bill the rider was bought on — the GROUP cap counts it too (11 on one bill)",
      attached11.status === 200 && groupAfter?.n === PRO_PLUS_ORG_CAP + 1,
    );

    // --- a tier change RE-PRICES the rider; it never resizes it -----------
    // The webhook's convergence (customer.subscription.updated moves the rider
    // item onto the new plan's price) is a RATE change and needs live Stripe —
    // it is the BILLING_LIVE suite's job. The half a customer would actually
    // notice is assertable here with no Stripe at all: after the tier moves,
    // the rider they are still paying for must still be worth exactly +1
    // against the NEW plan's base, never the old one and never nothing.
    await setPlan(auth.org_id, "pro", payer);
    check(
      "extra-org: after a Pro Plus → Pro tier change the rider still adds exactly one (5 → 6) — a re-price is never a capacity change",
      (await orgCap(payer, auth.org_id)) === PRO_ORG_CAP + 1,
    );

    // --- CANCELLING the rider gives the capacity back --------------------
    // The direction #293 exists to kill, and the one arm of the loop the rest
    // of this suite does not close: buy, create #11, cancel, keep 11 for ever.
    // Cancellation is a status flip, never a delete and never qty 0 (V323/V324
    // freeze-not-delete, and the CHECK forbids qty 0), so the whole question is
    // whether a 'canceled' row still COUNTS. Widening the counting statuses to
    // include it leaves every other check in this suite green.
    await db`
      update org_addons set status = 'canceled'
       where wallet_id = ${walletId} and stripe_item_id = ${`si_smoke_orgaddon_${tag}`}`;
    check(
      "extra-org: a CANCELED rider stops counting — the cap falls straight back to the plan base (6 → 5)",
      (await orgCap(payer, auth.org_id)) === PRO_ORG_CAP,
    );
  } finally {
    await db.end();
  }
}

/**
 * v17 gap W10 — purchased add-on capacity dies with the money that rented it.
 *
 * Two ways a group stops paying, both driven through the app's REAL webhook
 * route rather than by calling the handler: a `customer.subscription.deleted`
 * (#330) and a lost dispute (#331). Before this wave the plan collapsed to
 * community on both and the recurring add-on rows stayed `active`, so a
 * churned group kept `community base + N` organisations and seats for ever,
 * unpaid — and nothing else swept them, because the reconciling sweep only
 * runs on `customer.subscription.updated`, which neither path emits.
 *
 * Every leg asserts THREE rows, not one: the extra-org rider and the seat
 * rider must both freeze, and an ADMIN-granted comp (`stripe_item_id` null)
 * must survive untouched. The grant is the half that makes this a scoped
 * cancel rather than a truncate — a fix that cancelled everything on the
 * wallet would pass a one-row assertion.
 *
 * Needs the server's `STRIPE_WEBHOOK_SECRET` to sign a payload it will accept;
 * skips cleanly without one, the same convention `paymentMethodSuite` uses.
 * No Stripe key and no network call: the dispute legs carry an EXPANDED charge
 * object, which `disputeCustomerId` reads inline instead of retrieving.
 */
async function addonChurnWebhookSuite(): Promise<void> {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    check(
      "addon churn: skipped (no STRIPE_WEBHOOK_SECRET — cannot sign a webhook this server will accept); the DB-backed vitest suites cover both paths",
      true,
    );
    return;
  }

  const db = smokeDb();
  try {
    /** A fresh paid group carrying all three add-on rows, with Stripe ids the
     *  handlers can match on. Returns the wallet (= subscription) id. */
    const seedGroup = async (label: string, plan: string) => {
      const s = newSession();
      const email = `addonchurn_${label}_${tag}@example.com`;
      const orgId = (await signIn(s, email)).org_id;
      await setPlan(orgId, plan, s);
      const [row] = await db<{ wallet_id: string }[]>`
        select coalesce(subscription_id::text, id::text) as wallet_id
          from organizations where id = ${orgId}`;
      const walletId = row!.wallet_id;
      await db`
        update subscriptions
           set stripe_subscription_id = ${`sub_smoke_${label}_${tag}`},
               stripe_customer_id = ${`cus_smoke_${label}_${tag}`}
         where id = ${walletId}`;
      await db`
        insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                                stripe_item_id, status)
        values (${walletId}, null, 'orgs.max_owned', 1, 1,
                ${`si_smoke_${label}_rider_${tag}`}, 'active'),
               (${walletId}, null, 'members.max', 1, 3,
                ${`si_smoke_${label}_seat_${tag}`}, 'active'),
               (${walletId}, null, 'members.max', 1, 1, null, 'granted')`;
      return { orgId, walletId };
    };

    /** The three rows' statuses, keyed so a check reads as a sentence. */
    const statuses = async (walletId: string) => {
      const rows = await db<{ feature_key: string; stripe_item_id: string | null; status: string }[]>`
        select feature_key, stripe_item_id, status from org_addons
         where wallet_id = ${walletId} order by stripe_item_id nulls last`;
      return {
        rider: rows.find((r) => r.feature_key === "orgs.max_owned")?.status,
        seat: rows.find((r) => r.feature_key === "members.max" && r.stripe_item_id)?.status,
        granted: rows.find((r) => !r.stripe_item_id)?.status,
      };
    };

    // === #330 — churn. The subscription is gone; so is the capacity it billed.
    const churn = await seedGroup("churn", "pro_plus");
    const before = await statuses(churn.walletId);
    check(
      "addon churn: fixture built — a paid group carrying a purchased rider, a purchased seat block and an admin comp, all live",
      before.rider === "active" && before.seat === "active" && before.granted === "granted",
    );
    const churnStatus = await postSignedStripeWebhook("customer.subscription.deleted", {
      id: `sub_smoke_churn_${tag}`,
      object: "subscription",
      customer: `cus_smoke_churn_${tag}`,
      status: "canceled",
      items: { object: "list", data: [] },
    });
    check("addon churn: the app accepts the signed deletion webhook (200)", churnStatus === 200);
    const afterChurn = await statuses(churn.walletId);
    check(
      "addon churn: a deleted subscription cancels BOTH Stripe-billed families — the extra-org rider and the seat block (#330)",
      afterChurn.rider === "canceled" && afterChurn.seat === "canceled",
    );
    check(
      "addon churn: ...and leaves the ADMIN-granted comp alone — a grant is capacity the group was given, never something Stripe was billing",
      afterChurn.granted === "granted",
    );

    // === #331 — a lost dispute. Same outcome by a different route, and the
    // `created` event first because the loss is guarded on the dispute_id it
    // stamps: a loss that matches no stored dispute must strip nothing.
    const disputed = await seedGroup("disp", "pro");
    const disputeId = `dp_smoke_${tag}`;
    const charge = { id: `ch_smoke_${tag}`, object: "charge", customer: `cus_smoke_disp_${tag}` };
    const createdStatus = await postSignedStripeWebhook("charge.dispute.created", {
      id: disputeId,
      object: "dispute",
      charge,
      status: "warning_needs_response",
      payment_intent: null,
    });
    check("addon churn/dispute: the app accepts the signed dispute-opened webhook (200)", createdStatus === 200);

    // A loss under a DIFFERENT dispute id — the stale-loss case. It must move
    // nothing, which is the only thing that makes the guard on the real loss
    // below meaningful rather than decorative.
    await postSignedStripeWebhook("charge.dispute.closed", {
      id: `${disputeId}_other`,
      object: "dispute",
      charge,
      status: "lost",
      payment_intent: null,
    });
    const afterStale = await statuses(disputed.walletId);
    check(
      "addon churn/dispute: a loss whose dispute id matches nothing strips no capacity (#331 guard)",
      afterStale.rider === "active" && afterStale.seat === "active",
    );

    const lostStatus = await postSignedStripeWebhook("charge.dispute.closed", {
      id: disputeId,
      object: "dispute",
      charge,
      status: "lost",
      payment_intent: null,
    });
    check("addon churn/dispute: the app accepts the signed dispute-lost webhook (200)", lostStatus === 200);
    const afterLost = await statuses(disputed.walletId);
    check(
      "addon churn/dispute: losing a dispute cancels the purchased rider and seat block, not just the plan (#331)",
      afterLost.rider === "canceled" && afterLost.seat === "canceled",
    );
    check(
      "addon churn/dispute: ...and the admin comp survives here too",
      afterLost.granted === "granted",
    );
    const [plan] = await db<{ plan_key: string; status: string }[]>`
      select plan_key, status from subscriptions where id = ${disputed.walletId}`;
    check(
      "addon churn/dispute: the plan itself still drops to community/canceled — the add-on cancel is in ADDITION to it, not instead of it",
      plan?.plan_key === "community" && plan?.status === "canceled",
    );
  } finally {
    await db.end();
  }
}

/**
 * v17 gap W10 — the `past_ends_on` arm of the Event Pass lock, over real HTTP.
 *
 * `passGrantsSuite` already covers the lock's TERMINAL arm (archived and
 * completed) against the entitlement resolver. It covers nothing of the other
 * arm, and `ends_on` appears nowhere else in this file — which is exactly how
 * #347 and #353 survived: the lock was correct in `entitlements.ts` and two
 * enforcement sites plus the checkout route never asked it.
 *
 * Both legs are PAIRS. A competition one day past the grace must be refused
 * AND the same competition sitting exactly ON the boundary must still be
 * honoured, because "refuses everything" passes the first half on its own —
 * and a grace boundary that is off by a day is the likeliest way this breaks.
 *
 * Keyless: the quota leg is pure app SQL, and the checkout leg asserts the
 * refusal STATUS rather than a completed purchase, so it never needs Stripe.
 */
async function passLockEnforcementSuite(): Promise<void> {
  // V319: community carries 10 concurrent competitions.
  const COMMUNITY_COMP_CAP = 10;
  const featureKey = (r: V1Res) =>
    (r.json.error as { feature_key?: string } | undefined)?.feature_key;
  // A UTC calendar date `n` days from today, as a string. Written as a string
  // and computed in UTC on purpose: the rule's boundary is the UTC calendar
  // date (V334), so a local-midnight Date races it for part of every day.
  const utcDay = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  const s = newSession();
  const orgId = (await signIn(s, `passlock_${tag}@example.com`)).org_id;
  const mkComp = async (name: string) =>
    v1data<{ id: string }>(
      await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${name} ${tag}`, visibility: "unlisted" }),
    );

  const db = smokeDb();
  try {
    // Fill the org to its cap: ten competitions, the tenth carrying a pass.
    // Creating the tenth is itself legal (nine active + this one = the cap).
    const ids: string[] = [];
    for (let i = 0; i < COMMUNITY_COMP_CAP; i++) ids.push((await mkComp(`Lock Quota ${i}`)).id);
    const passed = ids[COMMUNITY_COMP_CAP - 1]!;
    await grantPass(orgId, passed, "event_pass");
    check(
      `pass lock/quota: fixture built — ${COMMUNITY_COMP_CAP} live competitions on a community org, the last one passed`,
      ids.length === COMMUNITY_COMP_CAP,
    );

    // === PAST the grace: the pass has stopped applying, so the competition it
    // covers is back inside the quota and the org is genuinely full. Nothing
    // retires a `live` competition past its end date, which is what made this
    // state permanent rather than transient.
    await db`update competitions set ends_on = ${utcDay(-(7 + 1))} where id = ${passed}`;
    const overCap = await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Lock Quota Over ${tag}`,
      visibility: "unlisted",
    });
    check(
      "pass lock/quota: a pass one day past the grace stops buying its competition out of competitions.max_active — the next create 402s (#347)",
      overCap.status === 402 && featureKey(overCap) === "competitions.max_active",
    );

    // === ON the grace boundary: still applying (the comparison is strictly
    // less), so the passed competition is still exempt and there is room. This
    // is the half that fails if anyone "fixes" the boundary to `<=`.
    await db`update competitions set ends_on = ${utcDay(-7)} where id = ${passed}`;
    const atBoundary = await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Lock Quota Boundary ${tag}`,
      visibility: "unlisted",
    });
    check(
      "pass lock/quota: a pass EXACTLY on the grace boundary still buys its competition out — the same create succeeds (201)",
      atBoundary.status === 201,
    );

    // === #353 — the checkout route refuses to SELL a pass for a competition
    // the lock rule has already ended. Its own org and its own competition: an
    // org that already holds a pass is refused for a different reason, and a
    // refusal that fires for the wrong reason proves nothing.
    const buyer = newSession();
    await signIn(buyer, `passsell_${tag}@example.com`);
    const buyComp = v1data<{ id: string }>(
      await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `Lock Sell ${tag}`,
        visibility: "unlisted",
      }),
    );
    await db`update competitions set ends_on = ${utcDay(-(7 + 1))} where id = ${buyComp.id}`;
    const sellEnded = await raw(buyer, "/api/billing/pass-checkout", "POST", {
      competition_id: buyComp.id,
    });
    check(
      "pass lock/sell: buying a pass for a competition past the grace is REFUSED with 410 (#353) — the money never lands on a pass that would read 'ended'",
      sellEnded.status === 410,
    );
    const [minted] = await db<{ n: number }[]>`
      select count(*)::int as n from competition_passes where competition_id = ${buyComp.id}`;
    check("pass lock/sell: ...and nothing was minted", minted?.n === 0);

    // The boundary pair again, and deliberately NOT asserted as 200: with no
    // Stripe key this route cannot reach a session, so what is asserted is that
    // it does not reach the LOCK refusal. A gate that 410s everything passes
    // the case above on its own.
    await db`update competitions set ends_on = ${utcDay(-7)} where id = ${buyComp.id}`;
    const sellBoundary = await raw(buyer, "/api/billing/pass-checkout", "POST", {
      competition_id: buyComp.id,
    });
    check(
      "pass lock/sell: a competition exactly on the grace boundary is still sellable — whatever else happens, it is not the 410",
      sellBoundary.status !== 410,
    );
  } finally {
    await db.end();
  }
}

/** PROMPT-53 player accounts over real HTTP: invite → claim → RSVP →
 *  organiser grid chip → QR check-in → clean 409 on a second invite; the
 *  never-invited teammate stays untouched (no public card, "—" chip). The
 *  free path runs on the player's own auto-provisioned COMMUNITY org —
 *  claim invites must mint on every plan. */
async function playerAccountsSuite(admin: Session, orgId: string): Promise<void> {
  const player = newSession();
  const playerVer = await signIn(player, `player_${tag}@example.com`);

  admin.cookies["seazn_org"] = orgId; // active-org cookie targets the v1 calls
  const orgs = (await call(admin, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Claim Cup ${tag}`,
    visibility: "public",
  });
  const compData = v1data<{ id: string; slug: string }>(comp);
  const div = await v1(admin, `/api/v1/competitions/${compData.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divData = v1data<{ id: string; slug: string }>(div);
  const pa = await v1(admin, "/api/v1/persons", "POST", {
    full_name: `Pat Claimer ${tag}`,
    consent: {},
  });
  const pb = await v1(admin, "/api/v1/persons", "POST", {
    full_name: `Uma Unclaimed ${tag}`,
    consent: {},
  });
  const personId = v1data<{ id: string }>(pa).id;
  const unclaimedId = v1data<{ id: string }>(pb).id;
  await v1(admin, `/api/v1/divisions/${divData.id}/entrants`, "POST", [
    {
      kind: "individual",
      display_name: "Pat",
      seed: 1,
      members: [{ person_id: personId }],
    },
    {
      kind: "individual",
      display_name: "Uma",
      seed: 2,
      members: [{ person_id: unclaimedId }],
    },
  ]);
  const stage = await v1(admin, `/api/v1/divisions/${divData.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`,
    "POST",
  );
  const fixture = v1data<{ fixtures: { id: string; fixture_no: number }[] }>(gen).fixtures[0]!;
  await v1(admin, `/api/v1/divisions/${divData.id}/start`, "POST");
  const fixturePath = `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/f/${fixture.fixture_no}`;

  // Invite → claim (the claim_url IS the credential; shown once).
  const invite = await v1(admin, `/api/v1/persons/${personId}/claim-invites`, "POST", {
    email: `player_${tag}@example.com`,
  });
  const claimUrl = v1data<{ claim_url: string }>(invite).claim_url ?? "";
  check("pa claim invite minted", invite.status === 201 && claimUrl.includes("/claim/pc_"));
  const accepted = (await call(
    player,
    `/api/claims/${claimUrl.split("/claim/")[1]}/accept`,
    "POST",
  )) as {
    person_id?: string;
  };
  check("pa player claimed the profile", accepted.person_id === personId);

  // /me carries the fixture; RSVP out with a note.
  const mine = await v1(player, "/api/v1/me/fixtures");
  const upcoming = v1data<{ upcoming: { id: string }[] }>(mine).upcoming ?? [];
  check(
    "pa /me/fixtures lists the claimed fixture",
    upcoming.some((f) => f.id === fixture.id),
  );
  const rsvp = await v1(player, `/api/v1/me/fixtures/${fixture.id}/availability`, "PUT", {
    status: "out",
    note: "smoke note",
  });
  check("pa RSVP saved", rsvp.status === 200);

  // Organiser grid: ✗ chip with the note; unclaimed teammate shows "—".
  const gridRes = await fetch(`${BASE}${fixturePath}`, {
    headers: {
      cookie: Object.entries(admin.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
  const html = await gridRes.text();
  check(
    "pa grid shows the unavailable chip",
    gridRes.status === 200 && html.includes("unavailable — smoke note"),
  );
  check("pa unclaimed teammate shows no-answer chip", html.includes("no availability answer"));

  // QR check-in: organiser mints, player taps; presence keeps the RSVP.
  const link = await v1(admin, `/api/v1/fixtures/${fixture.id}/checkin-link`, "POST");
  const url = v1data<{ url: string }>(link).url ?? "";
  check("pa check-in link minted", link.status === 201 && url.includes("/checkin/"));
  const checkedIn = (await call(player, `/api/checkin/${url.split("/checkin/")[1]}`, "POST")) as {
    checked_in?: boolean;
    status?: string;
  };
  check(
    "pa QR check-in keeps the explicit RSVP",
    checkedIn.checked_in === true && checkedIn.status === "out",
  );

  // Unclaimed person untouched: no public card without consent.
  const card = await fetch(`${BASE}/shared/${orgSlug}/${compData.slug}/players/${unclaimedId}`);
  check("pa unclaimed person has no public card", card.status === 404);

  // Second invite on a claimed person fails clean.
  const again = await v1(admin, `/api/v1/persons/${personId}/claim-invites`, "POST", {
    email: `else_${tag}@example.com`,
  });
  check("pa second invite on a claimed person is a clean 409", again.status === 409);

  // Free path: the player's own org is a fresh COMMUNITY org — claim
  // invites must mint there too (all plans, no requireFeature gate).
  const freePerson = await v1(player, "/api/v1/persons", "POST", {
    full_name: `Free Player ${tag}`,
    consent: {},
  });
  const freeInvite = await v1(
    player,
    `/api/v1/persons/${v1data<{ id: string }>(freePerson).id}/claim-invites`,
    "POST",
    { email: `else_${tag}@example.com` },
  );
  check(
    "pa claim invite mints on a community org (no plan gate)",
    playerVer.has_org === true && freeInvite.status === 201,
  );
}

/** PROMPT-57/officials-unify official onboarding over real HTTP: create
 *  official → assign → invite (shared claim rail, officiating copy) → claim
 *  as a second user → the assignment shows in /me and on My Matches → accept
 *  → decline flags on the organiser read → blackout date set/clear → score
 *  straight through the fixture console, exactly like a scorer (no separate
 *  device-mint — accepted officials pass the score-write gate). The free
 *  path proves the portal has no plan gate: an invite mints on the ref's own
 *  auto-provisioned COMMUNITY org. */
async function officialOnboardingSuite(
  admin: Session,
  orgId: string,
  orgSlug: string,
): Promise<void> {
  const refEmail = `ref_${tag}@example.com`;
  const ref = newSession();
  const refVer = await signIn(ref, refEmail);

  admin.cookies["seazn_org"] = orgId;
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Whistle Cup ${tag}`,
    visibility: "public",
  });
  const compData = v1data<{ id: string; slug: string }>(comp);
  const div = await v1(admin, `/api/v1/competitions/${compData.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divData = v1data<{ id: string; slug: string }>(div);
  await v1(admin, `/api/v1/divisions/${divData.id}/entrants`, "POST", [
    {
      kind: "individual",
      display_name: `Whistle A ${tag}`,
      seed: 1,
      members: [],
    },
    {
      kind: "individual",
      display_name: `Whistle B ${tag}`,
      seed: 2,
      members: [],
    },
    {
      kind: "individual",
      display_name: `Whistle C ${tag}`,
      seed: 3,
      members: [],
    },
    {
      kind: "individual",
      display_name: `Whistle D ${tag}`,
      seed: 4,
      members: [],
    },
  ]);
  const stage = await v1(admin, `/api/v1/divisions/${divData.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`,
    "POST",
  );
  const fixtures = v1data<{ fixtures: { id: string }[] }>(gen).fixtures;
  await v1(admin, `/api/v1/divisions/${divData.id}/start`, "POST");
  // Future kickoff: the /me lane only lists today-or-later fixtures. Pinned
  // to 10:00 UTC so the busy-elsewhere probe's "+3 hours, same calendar day"
  // premise holds at any run time — a run after 21:00 UTC used to push the
  // busy fixture past midnight and silently suppress the warn chip.
  const kickoffDate = new Date(Date.now() + 7 * 86_400_000);
  kickoffDate.setUTCHours(10, 0, 0, 0);
  const kickoff = kickoffDate.toISOString();
  await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}`, "PATCH", {
    scheduled_at: kickoff,
    court_label: "Court 9",
  });

  // Create + assign BEFORE the invite: the fresh assignment must be pending.
  const off = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref ${tag}`,
    role_keys: ["referee"],
  });
  const offId = v1data<{ id: string }>(off).id;
  await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}/officials`, "PATCH", {
    set: [{ official_id: offId, role_key: "referee", locked: false }],
  });

  // Invite through the SHARED person-claim rail (pc_ token, officiating copy).
  const invite = await v1(admin, `/api/v1/officials/${offId}/invite`, "POST", {
    email: refEmail,
  });
  const claimUrl = v1data<{ claim_url: string }>(invite).claim_url ?? "";
  check(
    "off invite mints through the person-claim rail",
    invite.status === 201 && claimUrl.includes("/claim/pc_"),
  );
  const token = claimUrl.split("/claim/")[1]!;
  const claimPage = await fetch(`${BASE}/claim/${token}`);
  const claimHtml = await claimPage.text();
  check(
    "off claim page shows officiating copy",
    claimPage.status === 200 && claimHtml.includes("Claim your officiating profile"),
  );

  const accepted = (await call(ref, `/api/claims/${token}/accept`, "POST")) as {
    person_id?: string;
  };
  check("off claim links the official's login", !!accepted.person_id);

  // /me carries the assignment card (assert on the unique fixture label, not
  // dict copy — the /me DictProvider serialises every ui string into the HTML).
  const meRes = await fetch(`${BASE}/me`, {
    headers: {
      cookie: Object.entries(ref.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
  const meHtml = await meRes.text();
  check(
    "off /me lists the assigned fixture",
    meRes.status === 200 && meHtml.includes(`Whistle A ${tag}`),
  );

  // Accept; then decline a second assignment with a reason → organiser flag.
  const acceptRes = await v1(
    ref,
    `/api/v1/me/assigned-fixtures/${fixtures[0]!.id}/response`,
    "PATCH",
    {
      response: "accepted",
    },
  );
  check(
    "off accept lands",
    acceptRes.status === 200 && v1data<{ response: string }>(acceptRes).response === "accepted",
  );
  await v1(admin, `/api/v1/fixtures/${fixtures[1]!.id}/officials`, "PATCH", {
    set: [{ official_id: offId, role_key: "referee", locked: false }],
  });
  await v1(ref, `/api/v1/me/assigned-fixtures/${fixtures[1]!.id}/response`, "PATCH", {
    response: "declined",
    decline_reason: "smoke clash",
  });
  const flagged = await v1(admin, `/api/v1/fixtures/${fixtures[1]!.id}`);
  const flaggedOfficials =
    v1data<{ officials: { response?: string; decline_reason?: string }[] }>(flagged).officials ??
    [];
  check(
    "off decline flags on the organiser read (no auto-reassign)",
    flaggedOfficials.length === 1 &&
      flaggedOfficials[0]!.response === "declined" &&
      flaggedOfficials[0]!.decline_reason === "smoke clash",
  );
  // accepted → declined is refused (ask the organiser)
  const illegal = await v1(
    ref,
    `/api/v1/me/assigned-fixtures/${fixtures[0]!.id}/response`,
    "PATCH",
    {
      response: "declined",
    },
  );
  check("off accepted assignment cannot be self-declined", illegal.status === 422);

  // Blackout date: set (upsert) then clear.
  const blackout = await v1(ref, "/api/v1/me/availability/officiating", "POST", {
    date: "2027-03-07",
    note: "away",
  });
  check("off blackout date saved", blackout.status === 201);
  const cleared = await v1(ref, "/api/v1/me/availability/officiating?date=2027-03-07", "DELETE");
  check("off blackout date cleared", cleared.status === 200);

  // Score this match: accepted officials score exactly like a scorer, straight
  // through the fixture console — no separate device-mint (design v2 §A3;
  // Tasks 1-4 wire acceptedOfficialCovers through requireFixtureActor). The
  // accepted assignment also surfaces the fixture on My Matches, the scorer
  // console's own landing page, unioned in from fixture_officials.
  const myMatches = await html(ref, "/my-matches");
  check(
    "off accepted fixture reachable via My Matches",
    myMatches.status === 200 && myMatches.body.includes(`Whistle A ${tag}`),
  );
  const offState = await v1(ref, `/api/v1/fixtures/${fixtures[0]!.id}/state`);
  check("off accepted official reads fixture state (non-member door)", offState.status === 200);
  const offScore = await v1(ref, `/api/v1/fixtures/${fixtures[0]!.id}/events`, "POST", {
    expected_seq: v1data<{ last_seq: number }>(offState).last_seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  check("off accepted official scores via the fixture console API", offScore.status === 201);

  // Regression (officials-unify): the accepted official must open the fixture
  // CONSOLE PAGE itself, not just the score API — the /o layout previously
  // 404'd non-members (an accepted official is usually a non-member), so the
  // page-level door stayed shut even though the API passed.
  const offFixNo = v1data<{ fixture_no: number }>(
    await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}`),
  ).fixture_no;
  const offConsole = await html(
    ref,
    `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/f/${offFixNo}`,
  );
  check(
    "off accepted official opens the fixture console PAGE (non-member layout door)",
    offConsole.status === 200 && offConsole.body.includes(`Whistle A ${tag}`),
  );

  // Pending-invite accept-by-id (v11.1 /me "Pending invites" card): officials
  // belong to multiple orgs — a SECOND invite for the same ref, accepted
  // without ever touching the emailed token (the claim id from the invite
  // response is enough; the session's verified email does the rest).
  const off2 = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref Two ${tag}`,
    role_keys: ["referee"],
  });
  const off2Id = v1data<{ id: string }>(off2).id;
  const invite2 = await v1(admin, `/api/v1/officials/${off2Id}/invite`, "POST", {
    email: refEmail,
  });
  const claim2Id = v1data<{ id: string }>(invite2).id ?? "";
  check("off second org invite mints its own claim id", invite2.status === 201 && !!claim2Id);

  // wrong email gets the generic 404 — same as a bogus id, so a non-owner
  // can't even learn the claim exists (review fix 2026-07-17).
  const stranger = newSession();
  await signIn(stranger, `stranger_${tag}@example.com`);
  const wrongAccept = await v1(
    stranger,
    `/api/v1/me/officiating-claims/${claim2Id}/accept`,
    "POST",
  );
  const bogusAccept = await v1(
    stranger,
    `/api/v1/me/officiating-claims/${crypto.randomUUID()}/accept`,
    "POST",
  );
  check(
    "off accept-by-id refuses a non-matching email with the generic 404",
    wrongAccept.status === 404 && bogusAccept.status === 404,
  );

  const accept2 = await v1(ref, `/api/v1/me/officiating-claims/${claim2Id}/accept`, "POST");
  check("off accept-by-id links the second org without the emailed token", accept2.status === 200);
  await checkOfficialClaimed(off2Id, true);

  // Free path: the ref's own org is a fresh COMMUNITY org — the officiating
  // portal must have no plan gate on invite/claim.
  const freeOff = await v1(ref, "/api/v1/officials", "POST", {
    display_name: `Free Ref ${tag}`,
    role_keys: ["referee"],
  });
  const freeInvite = await v1(
    ref,
    `/api/v1/officials/${v1data<{ id: string }>(freeOff).id}/invite`,
    "POST",
    {
      email: `else_${tag}@example.com`,
    },
  );
  check(
    "off invite mints on a community org (portal is free)",
    refVer.has_org === true && freeInvite.status === 201,
  );

  // Cross-org "booked elsewhere" derived read (v11.1 follow-up): the SAME
  // claimed official (offId, this org) also holds a scheduled assignment in
  // a DIFFERENT org (the account's own first org from signup) — the schedule's
  // Officials tab must warn with a time, never the other org's identity.
  const myOrgs = (await call(admin, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const busyOrg = myOrgs.find((o) => o.id !== orgId)!;
  admin.cookies["seazn_org"] = busyOrg.id;
  const busyOff = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref Busy ${tag}`,
    role_keys: ["referee"],
  });
  const busyOffId = v1data<{ id: string }>(busyOff).id;
  const busyInvite = await v1(admin, `/api/v1/officials/${busyOffId}/invite`, "POST", {
    email: refEmail,
  });
  const busyClaimId = v1data<{ id: string }>(busyInvite).id ?? "";
  await v1(ref, `/api/v1/me/officiating-claims/${busyClaimId}/accept`, "POST");

  const busyComp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Busy Cup ${tag}`,
    visibility: "public",
  });
  const busyDiv = await v1(
    admin,
    `/api/v1/competitions/${v1data<{ id: string }>(busyComp).id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const busyDivId = v1data<{ id: string }>(busyDiv).id;
  await v1(admin, `/api/v1/divisions/${busyDivId}/entrants`, "POST", [
    { kind: "individual", display_name: `Busy A ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `Busy B ${tag}`, seed: 2, members: [] },
  ]);
  const busyStage = await v1(admin, `/api/v1/divisions/${busyDivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const busyGen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(busyStage).id}/generate`,
    "POST",
  );
  const busyFixtures = v1data<{ fixtures: { id: string }[] }>(busyGen).fixtures;
  await v1(admin, `/api/v1/divisions/${busyDivId}/start`, "POST");
  // Same calendar day as this org's fixtures[0] kickoff, a few hours later —
  // the warning is a same-day match, not an exact-instant one.
  const busyKickoff = new Date(new Date(kickoff).getTime() + 3 * 3_600_000).toISOString();
  await v1(admin, `/api/v1/fixtures/${busyFixtures[0]!.id}`, "PATCH", {
    scheduled_at: busyKickoff,
    court_label: "Court 5",
  });
  await v1(admin, `/api/v1/fixtures/${busyFixtures[0]!.id}/officials`, "PATCH", {
    set: [{ official_id: busyOffId, role_key: "referee", locked: false }],
  });

  // Switch back to this org and read its own schedule Officials tab: offId
  // (the SAME claimed person, already assigned+accepted on fixtures[0]) is
  // flagged busy with a real time — the raw {time} template lives in the
  // page's embedded dict regardless, so only a substituted HH:MM counts.
  admin.cookies["seazn_org"] = orgId;
  const sched = await html(
    admin,
    `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/schedule?tab=officials`,
  );
  check(
    "off booked-elsewhere warns with a real time, not the raw {time} template",
    sched.status === 200 && /booked elsewhere ·\s*\d{1,2}:\d{2}/.test(sched.body),
  );
  // The org switcher legitimately lists every org THIS admin belongs to
  // (including busyOrg) regardless of this feature — that's normal nav
  // chrome, not a leak. The real leak surface is the derived-read's own
  // data: the other org's COMPETITION/DIVISION never reaches this page.
  check(
    "off booked-elsewhere never leaks the other org's competition/division",
    !sched.body.includes(`Busy Cup ${tag}`) && !sched.body.includes(`Busy A ${tag}`),
  );
}

/** v16 SPEC-3 marks & reports over real HTTP. Pro path (org2): create a
 *  decided fixture with an accepted official → rate it 1..5 (204) → the org
 *  profile summary reflects the average → the official files + submits a
 *  report (free portal) → the organiser console reads it. Free path (fresh
 *  community owner): the same decided-fixture setup, then the mark PUT is
 *  gated 402 while the report still files. Seeds the assignment + decided
 *  fixture BEFORE asserting (empty-data false-green lesson). */
async function marksReportsSuite(
  admin: Session,
  proOrgId: string,
  proOrgSlug: string,
): Promise<void> {
  // The fixture_officials surrogate id is never exposed by the API (the
  // console reads it server-side); the smoke reads it over its own connection,
  // same ad-hoc convention as checkOfficialClaimed.
  async function foId(fixtureId: string, officialId: string): Promise<string | null> {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const sql = postgres(url, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
      prepare: !url.includes(":6543"),
      max: 1,
    });
    try {
      const [r] = await sql<{ id: string }[]>`
        select id from fixture_officials
        where fixture_id = ${fixtureId} and official_id = ${officialId} limit 1`;
      return r?.id ?? null;
    } finally {
      await sql.end();
    }
  }

  // Build a decided fixture whose official has ACCEPTED (the mark + report
  // window). Returns the fixture id + official id + the ref's session.
  async function decidedFixtureWithOfficial(
    owner: Session,
    ownerOrgId: string,
    label: string,
  ): Promise<{ fx: string; offId: string; ref: Session }> {
    owner.cookies["seazn_org"] = ownerOrgId;
    const comp = v1data<{ id: string; slug: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `Marks ${label} ${tag}`,
        visibility: "public",
      }),
    );
    const div = v1data<{ id: string; slug: string }>(
      await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
    await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      {
        kind: "individual",
        display_name: `MA ${label} ${tag}`,
        seed: 1,
        members: [],
      },
      {
        kind: "individual",
        display_name: `MB ${label} ${tag}`,
        seed: 2,
        members: [],
      },
    ]);
    const stage = v1data<{ id: string }>(
      await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    const fx = v1data<{ fixtures: { id: string }[] }>(
      await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST"),
    ).fixtures[0]!.id;
    await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");
    const offId = v1data<{ id: string }>(
      await v1(owner, "/api/v1/officials", "POST", {
        display_name: `Mark Ref ${label} ${tag}`,
        role_keys: ["referee"],
      }),
    ).id;
    await v1(owner, `/api/v1/fixtures/${fx}/officials`, "PATCH", {
      set: [{ official_id: offId, role_key: "referee", locked: false }],
    });
    const refEmail = `marksref_${label}_${tag}@example.com`;
    const ref = newSession();
    await signIn(ref, refEmail);
    const inv = await v1(owner, `/api/v1/officials/${offId}/invite`, "POST", {
      email: refEmail,
    });
    const token = (v1data<{ claim_url: string }>(inv).claim_url ?? "").split("/claim/")[1]!;
    await call(ref, `/api/claims/${token}/accept`, "POST");
    await v1(ref, `/api/v1/me/assigned-fixtures/${fx}/response`, "PATCH", {
      response: "accepted",
    });
    // The accepted official scores a generic result → the fixture decides
    // (engine-db integration: generic.result → status 'decided').
    const st = v1data<{ last_seq: number }>(await v1(ref, `/api/v1/fixtures/${fx}/state`));
    await v1(ref, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: st.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    return { fx, offId, ref };
  }

  // ---- Pro path (org2 is Pro here) ----
  const pro = await decidedFixtureWithOfficial(admin, proOrgId, "Pro");
  const proFoId = await foId(pro.fx, pro.offId);
  check("marks: surrogate assignment id resolvable", !!proFoId);
  admin.cookies["seazn_org"] = proOrgId;
  const putMark = await v1(admin, `/api/v1/fixture-officials/${proFoId}/mark`, "PUT", { mark: 4 });
  check("marks pro: rate an accepted, decided official (204)", putMark.status === 204);
  const summary = v1data<{ average: number | null; count: number }>(
    await v1(admin, `/api/v1/officials/${pro.offId}/marks-summary`),
  );
  check(
    "marks pro: profile summary average reflects the mark",
    summary.count === 1 && summary.average === 4,
  );

  // Report (free portal, ungated even on a Pro org): the official files + submits.
  const draft = await v1(pro.ref, `/api/v1/me/officiating/${proFoId}/report`, "PUT", {
    body: "tidy game",
    incidents: [{ kind: "other", note: "smoke note" }],
  });
  check(
    "report: draft saves (free portal)",
    draft.status === 200 && v1data<{ status: string }>(draft).status === "draft",
  );
  const submitted = await v1(pro.ref, `/api/v1/me/officiating/${proFoId}/report/submit`, "POST");
  check(
    "report: submit is final",
    submitted.status === 200 && v1data<{ status: string }>(submitted).status === "submitted",
  );
  const fixReports = v1data<{ status: string }[]>(
    await v1(admin, `/api/v1/fixtures/${pro.fx}/reports`),
  );
  check(
    "report: organiser console reads the submitted report",
    Array.isArray(fixReports) && fixReports.length === 1,
  );

  // ---- Free path (fresh community owner) ----
  const commOwner = newSession();
  await signIn(commOwner, `markscomm_${tag}@example.com`);
  const commOrgId = ((await call(commOwner, "/api/orgs")) as { id: string }[])[0]!.id;
  const free = await decidedFixtureWithOfficial(commOwner, commOrgId, "Free");
  const freeFoId = await foId(free.fx, free.offId);
  commOwner.cookies["seazn_org"] = commOrgId;
  const freeMark = await v1(commOwner, `/api/v1/fixture-officials/${freeFoId}/mark`, "PUT", {
    mark: 3,
  });
  check(
    "marks free: rating is ungated on community (204, officials.marks #253)",
    freeMark.status === 204,
  );
  const freeDraft = await v1(free.ref, `/api/v1/me/officiating/${freeFoId}/report`, "PUT", {
    body: "community game",
    incidents: [],
  });
  const freeSubmit = await v1(free.ref, `/api/v1/me/officiating/${freeFoId}/report/submit`, "POST");
  check(
    "report free: files + submits on a community org (portal is free)",
    freeDraft.status === 200 &&
      freeSubmit.status === 200 &&
      v1data<{ status: string }>(freeSubmit).status === "submitted",
  );
}

/** v16 SPEC-2 org news over real HTTP. Pro path (org2 is Pro): an opted-in
 *  division auto-drafts a result post on the decided seam → the organiser lists
 *  it, publishes it, and the public feed / post page / story.png all serve.
 *  Free path (fresh community owner): a MANUAL post creates + publishes (free on
 *  every plan) and serves publicly, while the auto_posts toggle is gated 402
 *  (Pro news.auto). Seeds the decided fixture BEFORE asserting (empty-data
 *  false-green lesson). */
async function newsSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `News ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "News Prem",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const toggle = await v1(admin, `/api/v1/divisions/${div.id}`, "PATCH", {
    auto_posts: true,
  });
  check("news pro: auto_posts toggle allowed (news.auto)", toggle.status === 200);

  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: `NHome ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `NAway ${tag}`, seed: 2, members: [] },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const fx = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");
  const st = v1data<{ last_seq: number }>(await v1(admin, `/api/v1/fixtures/${fx}/state`));
  await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: st.last_seq,
    type: "generic.result",
    payload: { p1Score: 3, p2Score: 1 },
  });

  const drafts = v1data<{ id: string; kind: string; auto_source: unknown | null }[]>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/posts?status=draft`),
  );
  const auto = drafts.find((d) => d.kind === "result" && d.auto_source);
  check("news pro: a result post auto-drafted on the decided seam", !!auto);

  const pub = await v1(admin, `/api/v1/posts/${auto!.id}`, "PATCH", {
    action: "publish",
  });
  const pubData = v1data<{ status: string; slug: string }>(pub);
  check("news pro: draft publishes", pub.status === 200 && pubData.status === "published");

  const feed = await html(newSession(), `/shared/${proOrgSlug}/news`);
  check(
    "news pro: public feed 200 + shows a post card",
    feed.status === 200 && feed.body.includes("news-card"),
  );
  check(
    "news pro: feed carries the back-to-org link",
    feed.body.includes('data-testid="news-back"'),
  );
  const postPage = await html(newSession(), `/shared/${proOrgSlug}/news/${pubData.slug}`);
  check("news pro: public post page 200", postPage.status === 200);
  const story = await fetch(`${BASE}/shared/${proOrgSlug}/news/${pubData.slug}/story.png`);
  check(
    "news pro: story PNG 200 image/png",
    story.status === 200 && (story.headers.get("content-type") ?? "").includes("image/png"),
  );

  // Archive round-trip: off the public page, kept in ?status=archived, and
  // republish restores the same frozen slug (console Archived disclosure).
  const arch = await v1(admin, `/api/v1/posts/${auto!.id}`, "PATCH", {
    action: "archive",
  });
  check(
    "news pro: publish\u2192archive flips status",
    arch.status === 200 && v1data<{ status: string }>(arch).status === "archived",
  );
  const gonePage = await html(newSession(), `/shared/${proOrgSlug}/news/${pubData.slug}`);
  check("news pro: archived post page 404s publicly", gonePage.status === 404);
  const archList = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/posts?status=archived`),
  );
  check(
    "news pro: ?status=archived lists it",
    archList.some((x) => x.id === auto!.id),
  );
  const repub = v1data<{ status: string; slug: string }>(
    await v1(admin, `/api/v1/posts/${auto!.id}`, "PATCH", {
      action: "publish",
    }),
  );
  check(
    "news pro: republish restores published at the frozen slug",
    repub.status === "published" && repub.slug === pubData.slug,
  );
  const backPage = await html(newSession(), `/shared/${proOrgSlug}/news/${pubData.slug}`);
  check("news pro: republished page 200 again", backPage.status === 200);

  // ---- Free path (fresh community owner) ----
  const commOwner = newSession();
  await signIn(commOwner, `newscomm_${tag}@example.com`);
  const commOrg = ((await call(commOwner, "/api/orgs")) as { id: string; slug: string }[])[0]!;
  commOwner.cookies["seazn_org"] = commOrg.id;

  const manual = await v1(commOwner, `/api/v1/orgs/${commOrg.id}/posts`, "POST", {
    title: `Free news ${tag}`,
    body_md: "Hello **world**.",
    kind: "announcement",
  });
  check("news free: manual post create (free on every plan)", manual.status === 201);
  const manualPub = v1data<{ slug: string; status: string }>(
    await v1(commOwner, `/api/v1/posts/${v1data<{ id: string }>(manual).id}`, "PATCH", {
      action: "publish",
    }),
  );
  check("news free: manual post publishes", manualPub.status === "published");
  const freePost = await html(newSession(), `/shared/${commOrg.slug}/news/${manualPub.slug}`);
  check("news free: manual post public page 200", freePost.status === 200);

  const freeComp = v1data<{ id: string }>(
    await v1(commOwner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Free news comp ${tag}`,
      visibility: "public",
    }),
  );
  const freeDiv = v1data<{ id: string }>(
    await v1(commOwner, `/api/v1/competitions/${freeComp.id}/divisions`, "POST", {
      name: "Div",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const freeToggle = await v1(commOwner, `/api/v1/divisions/${freeDiv.id}`, "PATCH", {
    auto_posts: true,
  });
  check("news free: auto_posts toggle gated 402 (Pro news.auto)", freeToggle.status === 402);
}

/** PLG growth loops (design/plg): the free-tier "Powered by Seazn Club"
 *  footer is an acquisition CTA (attribution-link.tsx) and every public
 *  competition page carries a fan-facing share bar (share-bar.tsx) — pro
 *  orgs keep the share bar but drop the attribution footer (unchanged
 *  org.branded gate). /me carries the player→organiser nudge
 *  (run-your-own-cta.tsx) and /discover always offers the /start CTA. */
async function plgGrowthSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;

  // --- Pro path: share bar present, "Powered by" attribution footer gone.
  const proComp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `PLG Pro Cup ${tag}`,
      visibility: "public",
    }),
  );
  const proShared = await html(newSession(), `/shared/${proOrgSlug}/${proComp.slug}`);
  check(
    "plg pro page keeps the fan ShareBar",
    proShared.status === 200 &&
      proShared.body.includes("Share on WhatsApp") &&
      proShared.body.includes("Copy link"),
  );
  check(
    // Key off the attribution CTA's own text, not a bare "Powered by" — the
    // community attribution line itself reads "Powered by Seazn Club", so that
    // substring never isolated the footer that org.branded drops.
    "plg pro page drops the Seazn attribution footer",
    !proShared.body.includes("Run your own free"),
  );

  // --- Free path: a fresh community owner's public page carries both the
  // attribution CTA and the fan ShareBar.
  const free = newSession();
  const freeVer = await signIn(free, `plg_free_${tag}@example.com`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `PLG Free Cup ${tag}`,
      visibility: "public",
    }),
  );
  const freeShared = await html(newSession(), `/shared/${freeOrg.slug}/${freeComp.slug}`);
  check(
    "plg free page carries the Seazn attribution CTA",
    freeShared.status === 200 && freeShared.body.includes("Run your own free"),
  );
  check(
    "plg free page also renders the fan ShareBar",
    freeShared.body.includes("Share on WhatsApp") && freeShared.body.includes("Copy link"),
  );

  // --- /me: the player→organiser "run your own" CTA is gated to users with
  // NO org (organisers must never see their own acquisition pitch). `free`
  // owns an org → hidden; a fresh org-less session → shown.
  const meRun = await html(free, "/me");
  check(
    "plg /me hides run-your-own from a user who has an org",
    meRun.status === 200 && !meRun.body.includes("utm_source=me"),
  );
  // An org-less session needs consume-with-next: a bare signIn auto-creates
  // "My organization" (ensureActiveOrg), but a `next` target skips the org
  // bootstrap (postAuthLanding) — exactly how claim/invite emails land.
  const playerOnly = newSession();
  const plgReq = (await call(playerOnly, "/api/auth/magic-link", "POST", {
    email: `plg_player_${tag}@example.com`,
  })) as { login_url?: string };
  const plgTok = new URL(plgReq.login_url ?? "").searchParams.get("token");
  await call(playerOnly, "/api/auth/magic-link/consume", "POST", {
    token: plgTok,
    next: "/me",
  });
  const meRunPlayer = await html(playerOnly, "/me");
  check(
    "plg /me renders run-your-own for an org-less player",
    meRunPlayer.status === 200 &&
      meRunPlayer.body.includes("Run your own tournament") &&
      meRunPlayer.body.includes("utm_source=me"),
  );

  // --- /discover: the acquisition CTA back to /start (unconditional —
  // renders whether or not any club happens to be live right now).
  const discover = await html(newSession(), "/en/discover");
  check(
    "plg /discover offers the /start acquisition CTA",
    discover.status === 200 &&
      discover.body.includes("utm_source=discover") &&
      discover.body.includes("Start free"),
  );
}

/** design/v6 PROMPT-48..50: the three new sports over real HTTP — a tennis
 *  set scored point-by-point (rally mode), an icehockey OT result paying
 *  2/1 through standings, and a power-play goal with the strength chip
 *  visible on the anonymous public fixture read. */
async function v6SportsSuite(admin: Session): Promise<void> {
  // Local-run fallback: CI runs sync:sports; a local DB may predate v6.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = postgres(dbUrl, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl:
        process.env.DATABASE_SSL === "disable"
          ? false
          : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
            ? false
            : "require",
      prepare: !dbUrl.includes(":6543"),
      max: 1,
    });
    const empty = { groups: [], lineup: { size: 1, benchMax: 1 } };
    for (const [key, name] of [
      ["tennis", "Tennis"],
      ["icehockey", "Ice Hockey"],
    ] as const) {
      await db`insert into sports (key, name, module_version, position_catalog)
               values (${key}, ${name}, '1.0.0', ${db.json(empty)})
               on conflict (key) do nothing`;
    }
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('tennis', 'tour', 'Tour', ${db.json({})}, true)
             on conflict do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('icehockey', 'iihf', 'IIHF', ${db.json({})}, true)
             on conflict do nothing`;
    await db.end();
  }

  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `V6 Sports ${tag}`,
    visibility: "public",
  });
  check("v6 competition created", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;

  // --- Tennis (PROMPT-48): one set scored rally-mode, then a summary set ---
  const tdiv = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Tennis",
    sport_key: "tennis",
    variant_key: "tour",
  });
  check("v6 tennis division created from catalog", tdiv.status === 201);
  const tdivId = v1data<{ id: string }>(tdiv).id;
  const tents = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${tdivId}/entrants`, "POST", [
      { kind: "individual", display_name: "Rune", seed: 1 },
      { kind: "individual", display_name: "Sasha", seed: 2 },
    ]),
  );
  const tstage = await v1(admin, `/api/v1/divisions/${tdivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const tgen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(tstage).id}/generate`,
    "POST",
  );
  const tfx = v1data<{ fixtures: { id: string }[] }>(tgen).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${tdivId}/start`, "POST");
  let seq = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    }),
  ).seq;
  // 24 straight points = a 6–0 set in rally mode.
  for (let i = 0; i < 24; i++) {
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq,
        type: "tennis.point",
        payload: { by: tents[0]!.id },
      }),
    ).seq;
  }
  const midState = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
  const midHeadline = v1data<{ summary: { headline: string } }>(midState).summary.headline;
  check("v6 tennis rally set banked (1 — 0 · 6–0)", midHeadline.startsWith("1 — 0"));
  // Undo the last point and re-score it — the fold reopens cleanly.
  const events = await v1(admin, `/api/v1/fixtures/${tfx}/events`);
  const lastPoint = v1data<{ id: string; type: string; seq: number }[]>(events)
    .filter((e) => e.type === "tennis.point")
    .sort((a, b) => b.seq - a.seq)[0];
  if (lastPoint) {
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq,
        type: "core.void",
        payload: { event_id: lastPoint.id },
      }),
    ).seq;
    const reopened = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
    check(
      "v6 tennis undo restores the live point",
      v1data<{ summary: { headline: string } }>(reopened).summary.headline.startsWith("0 — 0"),
    );
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq,
        type: "tennis.point",
        payload: { by: tents[0]!.id },
      }),
    ).seq;
  }
  // Second set as a tier-0 summary; the match decides.
  seq = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
      expected_seq: seq,
      type: "tennis.set_summary",
      payload: { home: 6, away: 0 },
    }),
  ).seq;
  const tdone = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
  check(
    "v6 tennis match decided from mixed fidelity",
    v1data<{ status: string }>(tdone).status === "decided",
  );

  // --- Ice hockey (PROMPT-49/50): OT points + PP goal + strength chip ---
  const idiv = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Ice",
    sport_key: "icehockey",
    variant_key: "iihf",
  });
  check("v6 icehockey division created from catalog", idiv.status === 201);
  const idivId = v1data<{ id: string }>(idiv).id;
  const ients = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${idivId}/entrants`, "POST", [
      { kind: "team", display_name: "Polar Bears", seed: 1 },
      { kind: "team", display_name: "Glacier Kings", seed: 2 },
    ]),
  );
  const istage = await v1(admin, `/api/v1/divisions/${idivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const istageId = v1data<{ id: string }>(istage).id;
  const igen = await v1(admin, `/api/v1/stages/${istageId}/generate`, "POST");
  const ifx = v1data<{ fixtures: { id: string }[] }>(igen).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${idivId}/start`, "POST");
  const iceSend = async (type: string, payload: unknown) => {
    iceSeq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${ifx}/events`, "POST", {
        expected_seq: iceSeq,
        type,
        payload,
      }),
    ).seq;
  };
  let iceSeq = 0;
  await iceSend("core.start", {});
  // Power play: minor on the Kings → 5v4 chip visible to an anonymous
  // public read (PROMPT-50 free path), PP goal, scorer releases the minor.
  await iceSend("icehockey.suspension.start", {
    by: ients[1]!.id,
    class: "minor",
  });
  const anon = newSession();
  const pub = await v1(anon, `/api/v1/public/fixtures/${ifx}`);
  const pubDetail = v1data<{ summary: { detail?: { strength?: string } } }>(pub).summary.detail;
  check("v6 public scorebug carries the 5v4 strength chip", pubDetail?.strength === "5v4");
  await iceSend("icehockey.goal", { by: ients[0]!.id, kind: "pp" });
  await iceSend("icehockey.suspension.end", {
    by: ients[1]!.id,
    class: "minor",
  });
  // Level it, run out regulation, win in sudden-death OT.
  await iceSend("icehockey.goal", { by: ients[1]!.id });
  await iceSend("icehockey.period.advance", { to: "P2" });
  await iceSend("icehockey.period.advance", { to: "P3" });
  await iceSend("icehockey.period.advance", { to: "FT" });
  await iceSend("icehockey.goal", { by: ients[0]!.id });
  const idone = await v1(admin, `/api/v1/fixtures/${ifx}/state`);
  check(
    "v6 icehockey OT decides with (OT) headline",
    v1data<{ status: string; summary: { headline: string } }>(idone).status === "decided" &&
      v1data<{ summary: { headline: string } }>(idone).summary.headline.includes("(OT)"),
  );
  const istandings = await v1(admin, `/api/v1/stages/${istageId}/standings`);
  const irows = v1data<{ rows: { entrantId: string; points: number }[] }>(istandings).rows;
  check(
    "v6 icehockey standings pay OT points 2/1 (Event Code §219)",
    irows.find((r) => r.entrantId === ients[0]!.id)?.points === 2 &&
      irows.find((r) => r.entrantId === ients[1]!.id)?.points === 1,
  );
}

// ---------------------------------------------------------------------------
// W4a (#425) — the core time model, end to end over real HTTP.
//
// The engine suites prove the fold; this proves the whole rail carries it: a
// GameTime survives the /api/v1 payload round-trip, `division.config` really
// does reach `apply()` (periodSeconds / sinBinMinutes / subWindows /
// interruptions are all NEW optional cfg keys), the derived `expiresAt` lands
// in the persisted `match_states.state`, and the two new engine codes map to
// 422 through ENGINE_HTTP rather than a 500.
//
// Assertions are written to fail against a broken engine, not merely to
// observe one: every expiry check is paired with the state IMMEDIATELY BEFORE
// it (still running / already gone), because "no suspension in the list" is
// equally true of a suspension that never started.
// ---------------------------------------------------------------------------

/** A GameTime as the pad sends it (core/time.ts §1.1 — elapsed is GAME clock,
 *  counted up from the start of the named period). */
interface Stamp {
  period: string;
  elapsed: number;
}
const stamp = (period: string, elapsed: number): Stamp => ({ period, elapsed });
const sameStamp = (a: Stamp | undefined, b: Stamp): boolean =>
  a !== undefined && a.period === b.period && a.elapsed === b.elapsed;

/**
 * Per-fixture event sender that tracks the ledger tip.
 *
 * A REJECTED post leaves `seq` untouched, deliberately: the next legal event
 * then lands on the same expected_seq, which is itself the proof that the
 * refusal persisted nothing (spec 03 §2 guarantee 2 — a throwing module aborts
 * the tx before any insert).
 */
function ledger(s: Session, fixtureId: string) {
  let seq = 0;
  return {
    async send(type: string, payload: unknown): Promise<V1Res> {
      const res = await v1(s, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
        expected_seq: seq,
        type,
        payload,
      });
      if (res.status === 201) seq = v1data<{ seq: number }>(res).seq;
      return res;
    },
    get seq(): number {
      return seq;
    },
    /** The RAW fold, not the summary — `match_states.state` is what carries
     *  `expiresAt`, `subWindows`, `interruptions` and `asOf`. */
    async fold<T>(): Promise<T> {
      const res = await v1(s, `/api/v1/fixtures/${fixtureId}/state`);
      return v1data<{ state: T }>(res).state;
    },
  };
}

/** Division → entrants → league stage → one generated fixture, started. */
async function timedFixture(
  s: Session,
  compId: string,
  spec: {
    name: string;
    sport_key: string;
    variant_key: string;
    config?: Record<string, unknown>;
    entrants: unknown[];
  },
): Promise<{ divisionId: string; entrantIds: string[]; fixtureId: string }> {
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: spec.name,
      sport_key: spec.sport_key,
      variant_key: spec.variant_key,
      ...(spec.config === undefined ? {} : { config: spec.config }),
    }),
  );
  const ents = v1data<{ id: string }[]>(
    await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", spec.entrants),
  );
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const gen = v1data<{ fixtures: { id: string }[] }>(
    await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
  );
  await v1(s, `/api/v1/divisions/${div.id}/start`, "POST");
  return {
    divisionId: div.id,
    entrantIds: ents.map((e) => e.id),
    fixtureId: gen.fixtures[0]!.id,
  };
}

interface ActiveSuspensionOut {
  side: string;
  classKey: string;
  startedAt?: Stamp;
  expiresAt?: Stamp;
}
interface IceFold {
  phase: string;
  entrants: { home: string; away: string };
  suspensions: ActiveSuspensionOut[];
  asOf?: Stamp;
}
interface SinBinOut {
  person?: string;
  startedAt?: Stamp;
  expiresAt?: Stamp;
}
interface FootballFold {
  entrants: { home: string; away: string };
  squads: {
    home: { onPitch: string[]; bench: string[]; sinBin?: SinBinOut[]; subWindows?: Stamp[] };
    away: { onPitch: string[]; bench: string[]; sinBin?: SinBinOut[]; subWindows?: Stamp[] };
  };
  asOf?: Stamp;
}
interface TableTennisFold {
  entrants: { home: string; away: string };
  setsWon: { home: number; away: number };
  expedite?: boolean;
  expediteUnchecked?: number;
}
interface InterruptionOut {
  kind: string;
  set: number;
  by?: string;
  person?: string;
  duration?: number;
  at?: Stamp;
  overran?: true;
  overCount?: true;
}
interface TennisFold {
  entrants: { home: string; away: string };
  interruptions?: InterruptionOut[];
}

/**
 * W4a (#425) — game-time over HTTP on the four sports that grew a time model.
 *
 * PRO path: the full scenario per sport. FREE path: the same four events are
 * Tier-2 scoring, so a community org gets 402 — with a Tier-0 stamped event
 * accepted alongside, so the check cannot pass by blocking everything.
 */
async function w4aTimeModelSuite(admin: Session): Promise<void> {
  // Local-run fallback for the one sport no earlier suite reaches (CI runs
  // sync:sports). tennis/icehockey are seeded by v6SportsSuite, football by
  // disciplineSuite; table tennis has an EMPTY position catalog, which is what
  // its module actually declares, so seeding it here is not a lossy stub.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = smokeDb();
    await db`insert into sports (key, name, module_version, position_catalog)
             values ('tabletennis', 'Table Tennis', '1.0.0',
                     ${db.json({ groups: [], lineup: { size: 1, benchMax: 1 } })})
             on conflict (key) do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('tabletennis', 'bo5', 'Best of 5', ${db.json({})}, true)
             on conflict do nothing`;
    await db.end();
  }

  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `W4a Time ${tag}`,
      visibility: "public",
    }),
  );

  // === Ice hockey — IIHF penalty time (§3.1 lazy expiry, §3.2 carry, §3.4 ===
  // === release-on-goal). `periodSeconds` is the new optional cfg key.      ===
  const ice = await timedFixture(admin, comp.id, {
    name: "Ice Time",
    sport_key: "icehockey",
    variant_key: "iihf",
    config: { periodSeconds: { P1: 1200, P2: 1200, P3: 1200, OT: 300 } },
    entrants: [
      { kind: "team", display_name: `Timber Wolves ${tag}`, seed: 1 },
      { kind: "team", display_name: `Frost Giants ${tag}`, seed: 2 },
    ],
  });
  const iceLedger = ledger(admin, ice.fixtureId);
  check("w4a icehockey division accepts the periodSeconds cfg", !!ice.divisionId);
  await iceLedger.send("core.start", {});
  // Entrant sides come from the FOLD, never from entrant creation order — the
  // whole point of the release-on-goal check is which side conceded.
  const iceSides = (await iceLedger.fold<IceFold>()).entrants;
  const home = iceSides.home;
  const away = iceSides.away;

  // (1) A minor at 01:40 runs 2:00 and is swept by the next stamped event.
  await iceLedger.send("icehockey.suspension.start", {
    by: away,
    class: "minor",
    at: stamp("P1", 100),
  });
  const iceOpen = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey minor derives expiresAt = start + 2:00",
    iceOpen.suspensions.length === 1 &&
      iceOpen.suspensions[0]!.side === "away" &&
      sameStamp(iceOpen.suspensions[0]!.startedAt, stamp("P1", 100)) &&
      sameStamp(iceOpen.suspensions[0]!.expiresAt, stamp("P1", 220)),
  );
  // A penalty shot AWARDED is the neutral stamped event here: it touches no
  // score and no suspension, so the sweep is the only thing that can move the
  // list. (A goal would confound expiry with release-on-goal.)
  await iceLedger.send("icehockey.set_piece", { by: home, kind: "ps", at: stamp("P1", 300) });
  const iceSwept = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey lazy sweep releases the expired minor at the next stamp",
    iceSwept.suspensions.length === 0 && sameStamp(iceSwept.asOf, stamp("P1", 300)),
  );

  // (2) A second minor, ended EARLY by the opposition goal (IIHF Rule 20.4).
  await iceLedger.send("icehockey.suspension.start", {
    by: away,
    class: "minor",
    at: stamp("P1", 400),
  });
  const iceSecond = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey second minor is running with 70s still to serve",
    iceSecond.suspensions.length === 1 &&
      sameStamp(iceSecond.suspensions[0]!.expiresAt, stamp("P1", 520)),
  );
  await iceLedger.send("icehockey.goal", { by: home, kind: "pp", at: stamp("P1", 450) });
  const iceReleased = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey power-play goal at 07:30 ends a minor that ran to 08:40",
    iceReleased.suspensions.length === 0 && sameStamp(iceReleased.asOf, stamp("P1", 450)),
  );

  // (3) THE CROSS-PERIOD CARRY — the defect this wave exists to close. A minor
  // at 19:10 of a 20:00 period owes 70s in P2, not 0 at the buzzer.
  await iceLedger.send("icehockey.suspension.start", {
    by: away,
    class: "minor",
    at: stamp("P1", 1150),
  });
  const iceCarry = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey minor at 19:10 carries its remainder into P2 (expiresAt P2 70)",
    iceCarry.suspensions.length === 1 &&
      sameStamp(iceCarry.suspensions[0]!.expiresAt, stamp("P2", 70)),
  );
  await iceLedger.send("icehockey.period.advance", { to: "P2", at: stamp("P1", 1200) });
  const iceWhistle = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey the P1 whistle does NOT sweep a penalty owed in P2",
    iceWhistle.phase === "P2" &&
      iceWhistle.suspensions.length === 1 &&
      sameStamp(iceWhistle.suspensions[0]!.expiresAt, stamp("P2", 70)),
  );
  await iceLedger.send("icehockey.set_piece", { by: home, kind: "ps", at: stamp("P2", 50) });
  const iceStillShort = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey still 5v4 at P2 00:50, 20 seconds short of the carry",
    iceStillShort.suspensions.length === 1,
  );
  await iceLedger.send("icehockey.set_piece", { by: home, kind: "ps", at: stamp("P2", 100) });
  const iceServed = await iceLedger.fold<IceFold>();
  check(
    "w4a icehockey the carried remainder is served by P2 01:40",
    iceServed.suspensions.length === 0 && sameStamp(iceServed.asOf, stamp("P2", 100)),
  );

  // === Football — sin bin expiry (§5.2) and Law 3 substitution WINDOWS ===
  const squad: string[] = [];
  for (let i = 1; i <= 7; i++) {
    squad.push(
      v1data<{ id: string }>(
        await v1(admin, "/api/v1/persons", "POST", {
          full_name: `Timed Player ${i} ${tag}`,
          consent: { public_name: true },
        }),
      ).id,
    );
  }
  const foot = await timedFixture(admin, comp.id, {
    name: "Sin Bin League",
    sport_key: "football",
    variant_key: "11-a-side",
    config: { sinBinMinutes: 10, subWindows: 2 },
    entrants: [
      {
        kind: "team",
        display_name: `Bin Rovers ${tag}`,
        seed: 1,
        members: squad.map((id) => ({ person_id: id })),
      },
      { kind: "team", display_name: `Window City ${tag}`, seed: 2 },
    ],
  });
  const roversId = foot.entrantIds[0]!;
  await v1(admin, `/api/v1/fixtures/${foot.fixtureId}/lineups/${roversId}`, "PUT", {
    slots: squad.map((personId, i) => ({
      person_id: personId,
      slot: i < 3 ? "starting" : "bench",
      position_key: "FW",
      order_no: i + 1,
      roles: [],
    })),
  });
  const footLedger = ledger(admin, foot.fixtureId);
  await footLedger.send("core.start", {});
  const footSides = (await footLedger.fold<FootballFold>()).entrants;
  // The lineup was written for the entrant, so read WHICH side it landed on
  // rather than assuming the generator put seed 1 at home.
  const binSide = footSides.home === roversId ? "home" : "away";
  const otherSide = binSide === "home" ? "away" : "home";
  const opponentId = binSide === "home" ? footSides.away : footSides.home;
  const [p1, p2, p3, p4, p5, p6, p7] = squad as [
    string, string, string, string, string, string, string,
  ];

  await footLedger.send("football.sinbin.start", {
    by: roversId,
    person: p1,
    at: stamp("H1", 600),
  });
  const footBinned = await footLedger.fold<FootballFold>();
  check(
    "w4a football sin bin at 10:00 derives a 10-minute expiry and clears the pitch",
    (footBinned.squads[binSide].sinBin ?? []).length === 1 &&
      sameStamp(footBinned.squads[binSide].sinBin![0]!.expiresAt, stamp("H1", 1200)) &&
      !footBinned.squads[binSide].onPitch.includes(p1),
  );

  // Two substitutions sharing ONE stamp are ONE window (Law 3).
  await footLedger.send("football.sub", { by: roversId, off: p2, on: p4, at: stamp("H1", 600) });
  await footLedger.send("football.sub", { by: roversId, off: p3, on: p5, at: stamp("H1", 600) });
  const footWindow1 = await footLedger.fold<FootballFold>();
  check(
    "w4a football two subs at one stoppage spend ONE window",
    (footWindow1.squads[binSide].subWindows ?? []).length === 1 &&
      sameStamp(footWindow1.squads[binSide].subWindows![0], stamp("H1", 600)),
  );

  // The boundary: 19:59 is still short, 20:00 is served.
  await footLedger.send("football.goal", { by: opponentId, at: stamp("H1", 1199) });
  const footShort = await footLedger.fold<FootballFold>();
  check(
    "w4a football the binned player is still off the pitch one second early",
    (footShort.squads[binSide].sinBin ?? []).length === 1 &&
      !footShort.squads[binSide].onPitch.includes(p1),
  );
  await footLedger.send("football.goal", { by: opponentId, at: stamp("H1", 1200) });
  const footBack = await footLedger.fold<FootballFold>();
  check(
    "w4a football the bin runs out exactly at 20:00 and returns the player",
    (footBack.squads[binSide].sinBin ?? []).length === 0 &&
      footBack.squads[binSide].onPitch.includes(p1) &&
      footBack.squads[otherSide].onPitch.length === 0,
  );

  await footLedger.send("football.sub", { by: roversId, off: p4, on: p6, at: stamp("H1", 1200) });
  const footWindow2 = await footLedger.fold<FootballFold>();
  check(
    "w4a football a sub at a new stamp opens the second window",
    (footWindow2.squads[binSide].subWindows ?? []).length === 2,
  );
  const seqBeforeRefusal = footLedger.seq;
  const footBlocked = await footLedger.send("football.sub", {
    by: roversId,
    off: p5,
    on: p7,
    at: stamp("H1", 1300),
  });
  check(
    "w4a football a third window is refused with SUB_WINDOW_EXCEEDED (422)",
    footBlocked.status === 422 && footBlocked.json.error?.code === "SUB_WINDOW_EXCEEDED",
  );
  const footAfterRefusal = await footLedger.fold<FootballFold>();
  check(
    "w4a football the refused substitution persisted nothing",
    footLedger.seq === seqBeforeRefusal &&
      (footAfterRefusal.squads[binSide].subWindows ?? []).length === 2 &&
      !footAfterRefusal.squads[binSide].onPitch.includes(p7),
  );

  // === Table tennis — the ITTF expedite system (§5.3, Law 2.15) ===
  const tt = await timedFixture(admin, comp.id, {
    name: "Expedite Open",
    sport_key: "tabletennis",
    variant_key: "bo5",
    entrants: [
      { kind: "individual", display_name: `Ma ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Ovtcharov ${tag}`, seed: 2 },
    ],
  });
  const ttLedger = ledger(admin, tt.fixtureId);
  await ttLedger.send("core.start", {});
  const ttSides = (await ttLedger.fold<TableTennisFold>()).entrants;
  await ttLedger.send("tabletennis.expedite.start", {});
  const ttOn = await ttLedger.fold<TableTennisFold>();
  check("w4a tabletennis the umpire introduces expedite", ttOn.expedite === true);
  // Eleven straight rallies close game 1 — ITTF 2.15.4 runs expedite to the END
  // OF THE MATCH, so banking a game must not clear it.
  for (let i = 0; i < 11; i++) {
    await ttLedger.send("tabletennis.rally", { wonBy: ttSides.home });
  }
  const ttGame1 = await ttLedger.fold<TableTennisFold>();
  check(
    "w4a tabletennis expedite SURVIVES the game it was called in (ITTF 2.15.4)",
    ttGame1.setsWon.home === 1 && ttGame1.expedite === true,
  );
  // Law 2.15.2: the RECEIVER takes the point on their 13th good return.
  const ttLegal = await ttLedger.send("tabletennis.rally", {
    wonBy: ttSides.away,
    serving: ttSides.home,
    returns: 13,
  });
  check("w4a tabletennis a 13-return rally to the RECEIVER stands", ttLegal.status === 201);
  const ttWrong = await ttLedger.send("tabletennis.rally", {
    wonBy: ttSides.home,
    serving: ttSides.home,
    returns: 13,
  });
  check(
    "w4a tabletennis the same rally credited to the SERVER is EXPEDITE_WRONG_WINNER (422)",
    ttWrong.status === 422 && ttWrong.json.error?.code === "EXPEDITE_WRONG_WINNER",
  );
  const ttUnchecked = await ttLedger.send("tabletennis.rally", {
    wonBy: ttSides.home,
    returns: 13,
  });
  const ttAfter = await ttLedger.fold<TableTennisFold>();
  check(
    "w4a tabletennis a 13-return rally with no `serving` stands and is COUNTED as unchecked",
    ttUnchecked.status === 201 && ttAfter.expediteUnchecked === 1 && ttAfter.setsWon.home === 1,
  );

  // === Tennis — Rule 30 interruptions (§5.4). Neither allowance REFUSES: a ===
  // === cfg-derived refusal fires on replay and bricks the fixture.        ===
  const treated = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Treated Player ${tag}`,
      consent: { public_name: true },
    }),
  ).id;
  const ten = await timedFixture(admin, comp.id, {
    name: "MTO Classic",
    sport_key: "tennis",
    variant_key: "tour",
    config: {
      interruptions: { medical: { count: 1, seconds: 180 }, other: { seconds: 60 } },
    },
    entrants: [
      { kind: "individual", display_name: `Alcaraz ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Zverev ${tag}`, seed: 2 },
    ],
  });
  const tenLedger = ledger(admin, ten.fixtureId);
  await tenLedger.send("core.start", {});
  const tenSides = (await tenLedger.fold<TennisFold>()).entrants;
  await tenLedger.send("tennis.interruption", {
    kind: "medical",
    by: tenSides.home,
    person: treated,
    duration: 180,
    at: stamp("S1", 120),
  });
  const tenFirst = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis an MTO is stamped in S1, charged to a side and credited to a player",
    tenFirst.length === 1 &&
      tenFirst[0]!.kind === "medical" &&
      tenFirst[0]!.set === 1 &&
      tenFirst[0]!.by === "home" &&
      tenFirst[0]!.person === treated &&
      sameStamp(tenFirst[0]!.at, stamp("S1", 120)) &&
      tenFirst[0]!.overCount === undefined &&
      tenFirst[0]!.overran === undefined,
  );
  // The SECOND MTO in the same set is beyond `count: 1`. Shipped rule (§5.4):
  // RECORDED and flagged, never refused — so the 201 is half the assertion.
  const tenSecond = await tenLedger.send("tennis.interruption", {
    kind: "medical",
    by: tenSides.home,
    person: treated,
    duration: 180,
    at: stamp("S1", 600),
  });
  const tenOverCount = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis a second MTO past the allowance is RECORDED with overCount, not refused",
    tenSecond.status === 201 &&
      tenOverCount.length === 2 &&
      tenOverCount[1]!.overCount === true &&
      tenOverCount[1]!.overran === undefined,
  );
  // `overran` is the other, independent flag: no count declared for `other`,
  // so a long break trips the duration allowance and nothing else.
  await tenLedger.send("tennis.interruption", {
    kind: "other",
    by: tenSides.away,
    duration: 90,
    at: stamp("S1", 700),
  });
  const tenOverran = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis an over-long break records overran, independently of overCount",
    tenOverran.length === 3 &&
      tenOverran[2]!.overran === true &&
      tenOverran[2]!.overCount === undefined,
  );
  // A stamped interruption survives a SET boundary: the fold derives `set` from
  // its own index, so S2 is only legal once set 1 has actually been banked.
  await tenLedger.send("tennis.set_summary", { home: 6, away: 0 });
  await tenLedger.send("tennis.interruption", {
    kind: "toilet",
    by: tenSides.away,
    at: stamp("S2", 60),
  });
  const tenSet2 = (await tenLedger.fold<TennisFold>()).interruptions ?? [];
  check(
    "w4a tennis a toilet break after the set summary is filed in S2, set 2",
    tenSet2.length === 4 &&
      tenSet2[3]!.kind === "toilet" &&
      tenSet2[3]!.set === 2 &&
      sameStamp(tenSet2[3]!.at, stamp("S2", 60)),
  );

  // === FREE path — the time model is Tier-2 scoring on all four sports. ===
  // Every W4a event sits in fidelityTiers 2/3 behind scoring.match_timeline
  // (period/football) or scoring.rally_by_rally (nested/set-based), so a
  // community org is paywalled out of it. The Tier-0 stamped advance below is
  // the control: a gate that answered 402 to EVERY stamped event would pass the
  // four checks above and fail this one.
  const free = newSession();
  await signIn(free, `w4a_free_${tag}@example.com`);
  const freeComp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `W4a Free Time ${tag}`,
      visibility: "public",
    }),
  );
  const gated: [string, string, string, string, unknown][] = [];
  const freeIce = await timedFixture(free, freeComp.id, {
    name: "Free Ice",
    sport_key: "icehockey",
    variant_key: "iihf",
    entrants: [
      { kind: "team", display_name: `Free Bears ${tag}`, seed: 1 },
      { kind: "team", display_name: `Free Kings ${tag}`, seed: 2 },
    ],
  });
  const freeFoot = await timedFixture(free, freeComp.id, {
    name: "Free Football",
    sport_key: "football",
    variant_key: "11-a-side",
    entrants: [
      { kind: "team", display_name: `Free Rovers ${tag}`, seed: 1 },
      { kind: "team", display_name: `Free City ${tag}`, seed: 2 },
    ],
  });
  const freeTt = await timedFixture(free, freeComp.id, {
    name: "Free Table Tennis",
    sport_key: "tabletennis",
    variant_key: "bo5",
    entrants: [
      { kind: "individual", display_name: `Free Ma ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Free Ovt ${tag}`, seed: 2 },
    ],
  });
  const freeTen = await timedFixture(free, freeComp.id, {
    name: "Free Tennis",
    sport_key: "tennis",
    variant_key: "tour",
    entrants: [
      { kind: "individual", display_name: `Free Carlos ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Free Sascha ${tag}`, seed: 2 },
    ],
  });
  gated.push(
    [
      "icehockey suspension",
      freeIce.fixtureId,
      "icehockey.suspension.start",
      "scoring.match_timeline",
      { by: freeIce.entrantIds[1]!, class: "minor", at: stamp("P1", 100) },
    ],
    [
      "football sin bin",
      freeFoot.fixtureId,
      "football.sinbin.start",
      "scoring.match_timeline",
      { by: freeFoot.entrantIds[0]!, at: stamp("H1", 600) },
    ],
    [
      "tabletennis expedite",
      freeTt.fixtureId,
      "tabletennis.expedite.start",
      "scoring.rally_by_rally",
      {},
    ],
    [
      "tennis interruption",
      freeTen.fixtureId,
      "tennis.interruption",
      "scoring.rally_by_rally",
      { kind: "medical", by: freeTen.entrantIds[0]!, at: stamp("S1", 60) },
    ],
  );
  const freeLedgers = new Map<string, ReturnType<typeof ledger>>();
  for (const [label, fixtureId, type, featureKey, payload] of gated) {
    const l = ledger(free, fixtureId);
    freeLedgers.set(fixtureId, l);
    await l.send("core.start", {});
    const res = await l.send(type, payload);
    check(
      `w4a free: ${label} is Pro-gated (402 ${featureKey})`,
      res.status === 402 &&
        (res.json.error as { feature_key?: string } | undefined)?.feature_key === featureKey,
    );
  }
  // The control — a Tier-0 event carrying the SAME `at` shape is free. Reuses
  // the ice ledger above: the fixture is already started, and its `seq` is
  // still 1 because the 402 never reached the ledger.
  const freeIceLedger = freeLedgers.get(freeIce.fixtureId)!;
  const freeAdvance = await freeIceLedger.send("icehockey.period.advance", {
    to: "P2",
    at: stamp("P1", 1200),
  });
  const freeFold = v1data<{ state: IceFold }>(
    await v1(free, `/api/v1/fixtures/${freeIce.fixtureId}/state`),
  ).state;
  check(
    "w4a free: a Tier-0 stamped advance is NOT paywalled and records asOf",
    freeAdvance.status === 201 &&
      freeFold.phase === "P2" &&
      sameStamp(freeFold.asOf, stamp("P1", 1200)),
  );
}

// ---------------------------------------------------------------------------
// #451 — DLS reads a FIXED 6-ball/10-wicket resource table, so a division whose
// format is not 6-ball/10-wicket must have its overs and wickets converted onto
// the table's own scales before the lookup. Two variants make that visible over
// real HTTP, and neither can be faked by a passing revise:
//
//   A. `hundred` — the OVERS axis. 5-ball overs, so 10 "overs" is 50 balls, not
//      60. Reading them as 6-ball overs inflates both resource percentages and
//      hands the chasing side a target that is simply wrong (86, not 84).
//   B. `pairs-6-a-side` — the WICKETS axis, and the one that reverses a RESULT.
//      Six players a side means 5 wickets in hand, not 10; scaled wrongly the
//      chase gets a target of 43 and "wins by 1 wicket" a match it actually
//      LOST by 4 runs. The winner is the assertion that matters here — the
//      number is incidental to a published result being wrong.
//
// Nothing paints `revisedTarget` or `targetSource` in the UI yet (#467), so
// both read the fold through `/api/v1/fixtures/{id}/state`. `cricket.revise`
// also takes an optional `target`, which stamps targetSource "manual" and skips
// the DLS maths entirely — every revise below sends `oversPerSide` ONLY, and
// asserts targetSource is "dls", or the suite would prove nothing.
// ---------------------------------------------------------------------------

interface CricketFold {
  entrants: { home: string; away: string };
  revisedTarget: number | null;
  targetSource: "dls" | "manual" | null;
  r1: number | null;
  r2: number | null;
  margin: string | null;
  outcome: { kind: string; winner?: string; loser?: string; method?: string } | null;
}

/** Resource percentages are doubles; compare on the value, not the printout. */
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;

async function cricketDlsSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `dls_${tag}@example.com`);
  // A DLS-computed target is a Pro feature (scoring.ts gates `cricket.revise`
  // without a manual target on `cricket.dls`); smoke's orgs start on community.
  await setPlan(who.org_id, "pro", owner);

  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `DLS Scales ${tag}`,
      visibility: "private",
    }),
  );
  const dls = { dls: { enabled: true, edition: "standard" } };

  // === A — the overs axis (`hundred`: 100 balls, 5 per over) ================
  const a = await timedFixture(owner, comp.id, {
    name: `Hundred DLS ${tag}`,
    sport_key: "cricket",
    variant_key: "hundred",
    config: dls,
    entrants: [
      { kind: "team", display_name: `Century Kings ${tag}`, seed: 1 },
      { kind: "team", display_name: `Century Queens ${tag}`, seed: 2 },
    ],
  });
  const aLedger = ledger(owner, a.fixtureId);
  const aBatFirst = a.entrantIds[0]!;
  await aLedger.send("cricket.toss", { wonBy: aBatFirst, elected: "bat" });
  await aLedger.send("core.start", {});
  await aLedger.send("cricket.innings.summary", {
    runs: 150,
    wickets: 0,
    legalBalls: 100,
    partial: true,
  });
  const aRevise = await aLedger.send("cricket.revise", { oversPerSide: 10 });
  check("dls/hundred: a Pro org's DLS revise is accepted over HTTP", aRevise.status === 201);
  const aFold = await aLedger.fold<CricketFold>();
  // The full innings is 100 balls of a 100-ball quota, so R1 is the resource
  // left when 10 five-ball overs remain — 50 balls, NOT 60.
  check(
    "dls/hundred: 10 five-ball overs are read as 50 balls on the table's scale",
    near(aFold.r1, 49.13333333333333) && near(aFold.r2, 27.366666666666667),
  );
  check(
    "dls/hundred: the revised target is the DLS one (84), not the 6-ball misread (86)",
    aFold.revisedTarget === 84 && aFold.targetSource === "dls",
  );

  // === B — the wickets axis (`pairs-6-a-side`: 6 a side ⇒ 5 wickets) ========
  // The reversal: under the misread the chase reaches a target of 43 and is
  // recorded as the winner; scaled correctly it falls 4 short of 53.
  const b = await timedFixture(owner, comp.id, {
    name: `Pairs DLS ${tag}`,
    sport_key: "cricket",
    variant_key: "pairs-6-a-side",
    config: dls,
    entrants: [
      { kind: "team", display_name: `Pairs Lions ${tag}`, seed: 1 },
      { kind: "team", display_name: `Pairs Tigers ${tag}`, seed: 2 },
    ],
  });
  const bLedger = ledger(owner, b.fixtureId);
  const bBatFirst = b.entrantIds[0]!;
  await bLedger.send("cricket.toss", { wonBy: bBatFirst, elected: "bat" });
  await bLedger.send("core.start", {});
  // 60/2 off the full 60-ball quota, then the chase reaches 30/4 off 30 before
  // the interruption cuts the match to 7 overs (42 balls).
  await bLedger.send("cricket.innings.summary", {
    runs: 60,
    wickets: 2,
    legalBalls: 60,
    partial: true,
  });
  await bLedger.send("cricket.innings.summary", {
    runs: 30,
    wickets: 4,
    legalBalls: 30,
    partial: true,
  });
  const bRevise = await bLedger.send("cricket.revise", { oversPerSide: 7 });
  check("dls/pairs: the mid-chase DLS revise is accepted over HTTP", bRevise.status === 201);
  const bRevised = await bLedger.fold<CricketFold>();
  check(
    "dls/pairs: 6 a side is 5 wickets on the 10-wicket table — target 53, not 43",
    bRevised.revisedTarget === 53 && bRevised.targetSource === "dls",
  );
  // Play out the shortened chase: 48 off 42 is short of 53 but past 43.
  await bLedger.send("cricket.innings.summary", {
    runs: 48,
    wickets: 4,
    legalBalls: 42,
    partial: true,
  });
  const bDone = await bLedger.fold<CricketFold>();
  check(
    "dls/pairs: the side that batted first WINS — the misread hands it to the chase",
    bDone.outcome?.kind === "win" &&
      bDone.outcome.winner === bBatFirst &&
      bDone.outcome.loser !== bBatFirst,
  );
  check(
    "dls/pairs: and the published margin is runs, not wickets",
    bDone.margin === "by 4 runs" && bDone.outcome?.method === "dls",
  );
  // The result the rest of the product reads is the `fixtures.outcome` column,
  // written beside the fold — not the fold cache the checks above read.
  const bRow = v1data<{ status: string; outcome: { winner?: string } | null }>(
    await v1(owner, `/api/v1/fixtures/${b.fixtureId}/state`),
  );
  check(
    "dls/pairs: the decided fixture row carries the same winner",
    bRow.status === "decided" && bRow.outcome?.winner === bBatFirst,
  );
}

// ---------------------------------------------------------------------------
// W4a follow-up (V347) — a config edit must not reach back into a scored
// fixture, over real HTTP.
//
// The adapter suites prove the column and the fold. This proves the rail: that
// `/api/v1/.../events` really freezes the resolved cfg on the first append,
// that a division-config edit afterwards can neither lock the scorer out of a
// match already in progress nor rewrite the result they published, and that
// /admin's escape hatch exists and refuses what it should.
//
// Assertions are paired so they cannot pass by doing nothing: the snapshot is
// read BEFORE and AFTER the edit, and the "still finalizable" check is paired
// with the outcome it finalized, because a 201 on core.finalize is equally true
// of a fixture whose result was silently rewritten on the way through.
// ---------------------------------------------------------------------------

/** The config a generic division starts on — `allowDraws` is an ungated
 *  cfg-derived refusal inside the module's apply(), which makes it the sharpest
 *  reproduction of the class this task closes. */
const SNAPSHOT_CFG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function configSnapshotSuite(admin: Session, adminEmail: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // The whole point is what happens when the config moves BEHIND the app's
    // back, which needs SQL. Announced rather than silently skipped — a suite
    // that vanishes without saying so is how a gate stops testing anything.
    console.log("SKIP  V347 config snapshot suite (DATABASE_URL not set)");
    return;
  }
  const db = smokeDb();
  try {
    const comp = v1data<{ id: string }>(
      await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `Cfg Snapshot ${tag}`,
        visibility: "private",
      }),
    );
    const fx = await timedFixture(admin, comp.id, {
      name: "Snapshot",
      sport_key: "generic",
      variant_key: "score",
      config: SNAPSHOT_CFG,
      entrants: [
        { kind: "individual", display_name: `Asha ${tag}`, seed: 1 },
        { kind: "individual", display_name: `Bala ${tag}`, seed: 2 },
      ],
    });
    const led = ledger(admin, fx.fixtureId);

    const snapshotOf = async (): Promise<Record<string, unknown> | null> => {
      const [row] = await db<{ config_snapshot: Record<string, unknown> | null }[]>`
        select config_snapshot from fixtures where id = ${fx.fixtureId}`;
      return row?.config_snapshot ?? null;
    };

    // (1) Nothing frozen before there is history worth protecting — an
    //     organiser still setting the division up must have their edits apply.
    check("V347 an unscored fixture carries no config snapshot", (await snapshotOf()) === null);

    await led.send("core.start", {});
    const frozen = await snapshotOf();
    check(
      "V347 the first event freezes the resolved cfg onto the fixture",
      frozen !== null && frozen.allowDraws === true && frozen.resultMode === "score",
    );

    const scored = await led.send("generic.result", { p1Score: 1, p2Score: 1 });
    const drawn = v1data<{ outcome: { kind?: string } | null }>(
      await v1(admin, `/api/v1/fixtures/${fx.fixtureId}/state`),
    );
    check(
      "V347 a 1-1 card decides as a draw under the config in force",
      scored.status === 201 && drawn.outcome?.kind === "draw",
    );

    // (2) The organiser bans draws, after the match was played. Every append
    //     re-folds the WHOLE stream, so before V347 this made every further
    //     write fail — core.void included, so there was no undo that recovered
    //     it, and the fixture could never be finalized.
    await db`update divisions set config = ${db.json({ ...SNAPSHOT_CFG, allowDraws: false })}
             where id = ${fx.divisionId}`;
    check(
      "V347 the frozen copy does not follow the division config",
      (await snapshotOf())?.allowDraws === true,
    );

    const finalize = await led.send("core.finalize", {});
    const after = v1data<{ outcome: { kind?: string } | null; status: string }>(
      await v1(admin, `/api/v1/fixtures/${fx.fixtureId}/state`),
    );
    check(
      "V347 a banned-draws edit neither locks the scorer out nor rewrites the result",
      finalize.status === 201 && after.status === "finalized" && after.outcome?.kind === "draw",
    );

    // (3) The escape hatch. Staff-only, and refused on a FINALIZED fixture —
    //     rewriting the config a finalized result was computed under is exactly
    //     the harm the snapshot exists to prevent.
    const [me] = await db<{ id: string; is_staff: boolean; staff_role: string | null }[]>`
      select id, is_staff, staff_role from users where email = ${adminEmail}`;
    const hatch = `/api/admin/fixtures/${fx.fixtureId}/config-snapshot`;
    const asOutsider = await raw(admin, hatch, "POST", { reason: "not staff" });
    // The EXACT code, not `>= 400`: that also swallows a 500, so a route that
    // crashed on every call would read as "properly guarded". AuthError → 401
    // through the shared handler.
    check("V347 the re-snapshot hatch refuses a non-staff caller", asOutsider.status === 401);

    // SUPERADMIN, not merely staff. The discarded config survives only in the
    // audit row this writes; a support-role operator passes `requireStaff` and
    // must still be refused, so this is the one caller whose verdict differs
    // between the two guards.
    await db`update users set is_staff = true, staff_role = 'support' where id = ${me.id}`;
    const asSupport = await raw(admin, hatch, "POST", { reason: "support is not superadmin" });
    check("V347 the re-snapshot hatch refuses a support-role staff user", asSupport.status === 401);

    await db`update users set is_staff = true, staff_role = 'superadmin' where id = ${me.id}`;
    try {
      const onFinalized = await raw(admin, hatch, "POST", { reason: "smoke: should refuse" });
      check(
        "V347 the hatch refuses a finalized fixture (reopen it first)",
        onFinalized.status === 409,
      );
      check(
        "V347 a refused re-snapshot leaves the frozen config alone",
        (await snapshotOf())?.allowDraws === true,
      );

      // Reopen, correct the division to something the recorded draw can still
      // be read under, and re-snapshot for real.
      await db`update fixtures set status = 'decided' where id = ${fx.fixtureId}`;
      await db`update divisions set config = ${db.json({
        ...SNAPSHOT_CFG,
        points: { w: 2, d: 1, l: 0 },
      })} where id = ${fx.divisionId}`;
      const done = await raw(admin, hatch, "POST", { reason: "smoke: points table was wrong" });
      const reFrozen = await snapshotOf();
      check(
        "V347 a reopened fixture re-snapshots from live config",
        done.status === 200 &&
          (reFrozen?.points as { w?: number } | undefined)?.w === 2 &&
          reFrozen?.allowDraws === true,
      );

      const [audit] = await db<{ action: string; detail: Record<string, unknown> }[]>`
        select action, detail from staff_audit_log
        where target_id = ${fx.fixtureId} order by created_at desc limit 1`;
      check(
        "V347 the re-snapshot is audited with its reason and the discarded config",
        audit?.action === "fixture_config_resnapshot" &&
          audit.detail.reason === "smoke: points table was wrong" &&
          (audit.detail.before as { points?: { w?: number } } | undefined)?.points?.w === 3,
      );

      // A hatch that leaves the fixture unreadable is not a hatch: the preflight
      // folds the recorded stream under live config inside the tx and rolls the
      // whole thing back when it cannot.
      await db`update divisions set config = ${db.json({ ...SNAPSHOT_CFG, allowDraws: false })}
               where id = ${fx.divisionId}`;
      const impossible = await raw(admin, hatch, "POST", { reason: "smoke: would brick it" });
      check(
        "V347 the hatch refuses a config that cannot read the recorded events",
        impossible.status === 409,
      );
      check(
        "V347 that refusal rolled the snapshot back too",
        (await snapshotOf())?.allowDraws === true,
      );
    } finally {
      // Shared-DB poison trap: the smoke owner outlives this suite.
      await db`update users set is_staff = ${me.is_staff}, staff_role = ${me.staff_role}
               where id = ${me.id}`;
    }
  } finally {
    await db.end();
  }
}

/** design/v7 PROMPT-52: the waitlist is a visible queue — the token status
 *  view carries a 1-based position and the public register card shows the
 *  queue length behind a full division. */
async function regQueueSuite(admin: Session): Promise<void> {
  // v1 writes land on the session's ACTIVE org (earlier suites switch it) —
  // resolve that org's slug, not the sign-in default's.
  const me = (await call(admin, "/api/users/me")) as {
    org: { id: string } | null;
  };
  const orgs = (await call(admin, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const orgSlug = orgs.find((o) => o.id === me.org?.id)!.slug;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Queue Probe ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Tiny Queue",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    }),
  );
  await v1(admin, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    capacity: 1,
    form_fields: [],
  });

  const submit = async (name: string) => {
    const res = await v1(
      newSession(),
      `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`,
      "POST",
      {
        division_id: div.id,
        display_name: name,
        contact_email: `${name.replace(/ /g, "").toLowerCase()}_${tag}@example.com`,
        privacy_consent: true,
      },
    );
    if (res.status !== 201) {
      console.log(`queue submit "${name}" failed:`, res.status, JSON.stringify(res.json));
    }
    return res;
  };
  const holder = await submit("Queue Holder"); // takes the only spot
  check("queue holder takes the spot", holder.status === 201);
  const w1res = await submit("Queue First");
  const w1 = v1data<{
    registration_id: string;
    access_token: string;
    status: string;
  }>(w1res);
  check("queue overflow waitlists", w1res.status === 201 && w1?.status === "waitlisted");
  await submit("Queue Second");

  const status = await v1(
    newSession(),
    `/api/v1/public/registrations/${w1.registration_id}?token=${encodeURIComponent(w1.access_token)}`,
  );
  const view = v1data<{ status: string; position: number | null }>(status);
  check("waitlist status carries #1 position", view.status === "waitlisted" && view.position === 1);

  const registerPage = await html(newSession(), `/shared/${orgSlug}/${comp.slug}/register`);
  check(
    "public card shows waitlist count",
    registerPage.status === 200 && registerPage.body.includes("full — waitlist: 2"),
  );
}

/** v11.1 pending-invite accept-by-id: confirm the official's person row
 *  actually got linked (not just a 200 on the accept call) — same ad-hoc
 *  connection convention as checkTermsStamp/setStaff. Keyless runs skip. */
async function checkOfficialClaimed(officialId: string, expected: boolean): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const [row] = await sql<{ claimed: boolean }[]>`
      select (p.user_id is not null) as claimed
      from officials o join persons p on p.id = o.person_id
      where o.id = ${officialId}`;
    check(
      `off official ${officialId.slice(0, 8)} claimed=${expected}`,
      (row?.claimed ?? false) === expected,
    );
  } finally {
    await sql.end();
  }
}

/** GDPR (spec 2026-07-14): assert the magic-link request stamped terms
 *  acceptance — same SQL convention as setStaff/setConnect. */
async function checkTermsStamp(email: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // keyless run: nothing to assert against
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const [row] = await sql<{ terms_accepted_at: Date | null; terms_version: string | null }[]>`
      select terms_accepted_at, terms_version from users where email = ${email}`;
    check("auth terms acceptance stamped", !!row?.terms_accepted_at && !!row?.terms_version);
  } finally {
    await sql.end();
  }
}

/** Flip the staff-console flag on a user — same SQL-flip convention as
 *  setPlan/setConnect (design/v7 PROMPT-51). */
async function setStaff(email: string, role: "superadmin" | null): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to flip staff in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      update users set is_staff = ${role !== null}, staff_role = ${role}
      where email = ${email}`;
  } finally {
    await sql.end();
  }
}

/** design/v7 PROMPT-51: staff revenue report — guard, rollup shape, CSV
 *  header. A keyless env asserts the 503 guard instead of the rollup. */
async function platformRevenueSuite(admin: Session, staffEmail: string): Promise<void> {
  const denied = await raw(admin, "/api/admin/revenue");
  check("revenue denied to non-staff", denied.status === 401);

  await setStaff(staffEmail, "superadmin");
  try {
    const res = await raw(admin, "/api/admin/revenue");
    if (res.status === 503) {
      check("revenue 503s without Stripe key", res.json.error === "Stripe is not configured");
    } else {
      const data = res.json.data as {
        byMonth?: unknown;
        byOrg?: unknown;
        rows?: unknown[];
      };
      check(
        "revenue JSON rollups",
        res.status === 200 && !!data.byMonth && !!data.byOrg && Array.isArray(data.rows),
      );
      const csv = await fetch(BASE + "/api/admin/revenue?format=csv", {
        headers: { cookie: cookieHeader(admin) },
      });
      const firstLine = (await csv.text()).split("\n")[0];
      check(
        "revenue CSV header",
        csv.status === 200 &&
          firstLine ===
            "month,org,org_slug,currency,gross_minor,refunded_minor,net_minor,fee_count",
      );
    }
    const bad = await raw(admin, "/api/admin/revenue?from=notadate");
    check("revenue 400s on malformed range", bad.status === 400);
  } finally {
    await setStaff(staffEmail, null);
  }
}

/** One Pro trial per organisation, ever (V277) over real HTTP. `trial_used_at`
 *  means "this org has ALREADY had Pro"; once stamped it is never cleared, so
 *  the downgrade→upgrade loop can't re-arm the 14-day checkout trial.
 *
 *  Pro path: the staff TRIAL-GRANT rail (extendTrial) — it lifts a community
 *  org to Pro, burns the one trial, survives an extension, is refused outright
 *  once Stripe owns the billing timeline, and still lands for a DEPARTED org
 *  whose cancelled subscription id is not liveness.
 *  Free path: the staff COMP rail (compToPro) — the other stamping writer —
 *  plus the surface an owner actually reads: the billing page's upgrade CTA,
 *  which must stop promising a trial the checkout would not grant.
 *
 *  Runs on its own fresh orgs (never touches org/org2) and is keyless-safe:
 *  no arm reaches Stripe — the comp rail has no subscription to update, and
 *  the refusal arm answers BEFORE the Stripe call by design. */
async function oneTrialSuite(): Promise<void> {
  const staffEmail = `trial_staff_${tag}@example.com`;
  const staff = newSession();
  await signIn(staff, staffEmail);

  interface TrialRow {
    plan_key: string;
    status: string;
    trial_end: Date | null;
    trial_used_at: Date | null;
  }
  /** The columns the one-trial contract is written in, read straight from the
   *  row the usecases write (same ad-hoc client convention as
   *  checkTermsStamp/setStaff). */
  const readSub = async (orgId: string): Promise<TrialRow> => {
    const db = smokeDb();
    try {
      // Reached through organizations.subscription_id — V310 dropped
      // subscriptions.org_id, because many orgs may now share the row.
      const [row] = await db<TrialRow[]>`
        select s.plan_key, s.status, s.trial_end, s.trial_used_at
        from subscriptions s
        join organizations o on o.subscription_id = s.id
        where o.id = ${orgId}`;
      return row!;
    } finally {
      await db.end();
    }
  };
  const at = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  /** Age an EXISTING burn so "the first burn survives" is a comparison against a
   *  date no later write could coincidentally reproduce (an org that trialled a
   *  month ago is the real-world state this pins).
   *
   *  `where trial_used_at is not null` is load-bearing: unconditionally writing
   *  the backdated stamp would MANUFACTURE the burn the writer under test was
   *  supposed to make, so a regression that dropped the stamp would still leave
   *  the following check green. This helper may only age a burn, never create
   *  one. */
  const backdateBurn = async (orgId: string): Promise<void> => {
    const db = smokeDb();
    try {
      // Addressed through organizations.subscription_id — V310 dropped
      // subscriptions.org_id. The trial belongs to the GROUP now, which is the
      // point: it is what stops a detach farming a fresh 14 days.
      await db`
        update subscriptions set trial_used_at = now() - interval '30 days'
        where id = (select subscription_id from organizations where id = ${orgId})
          and trial_used_at is not null`;
    } finally {
      await db.end();
    }
  };
  /** Put a Stripe subscription id on the row at the given status. The liveness
   *  rule is BOTH columns (`hasLiveSubscription`: id set AND status in
   *  trialing/active/past_due), so the status argument is what decides whether
   *  the org counts as Stripe-billed — a cancelled sub keeps its id forever and
   *  is NOT live. Used for both arms below: 'active' = live and refused,
   *  'canceled' = departed and still grantable. */
  const seedStripeBilled = async (orgId: string, status: string): Promise<void> => {
    const db = smokeDb();
    try {
      // Through organizations.subscription_id — see backdateBurn.
      await db`
        update subscriptions
        set stripe_subscription_id = ${"sub_smoke_" + orgId.slice(0, 8)}, status = ${status}
        where id = (select subscription_id from organizations where id = ${orgId})`;
    } finally {
      await db.end();
    }
  };

  // === PRO PATH — the staff trial-grant rail ============================
  const pro = newSession();
  const proOrg = (await signIn(pro, `trial_pro_${tag}@example.com`)).org_id;
  // A second pro-path org, used only for the DEPARTED case (an ex-customer that
  // kept its dead subscription id). It needs to be unburned at grant time, so
  // it cannot share proOrg.
  const dep = newSession();
  const depOrg = (await signIn(dep, `trial_dep_${tag}@example.com`)).org_id;

  // === FREE PATH — a fresh community owner ==============================
  const free = newSession();
  const freeOrg = (await signIn(free, `trial_free_${tag}@example.com`)).org_id;
  const freeSlug = ((await call(free, "/api/orgs")) as { id: string; slug: string }[]).find(
    (o) => o.id === freeOrg,
  )!.slug;

  // A community org's upgrade card composes its CTA label as
  // `${startTrial|goPro} — <price>/mo billed yearly`. Match the label as the
  // BUTTON renders it (leading '>'), never the bare dict string: the /o
  // DictProvider serializes the whole `ui` dict into the page's flight payload,
  // so both trial copies — and `upgrade.proCard.cta` = "Go Pro — 14-day free
  // trial" — sit in the body whatever the org's state. Inside that JSON the
  // label is preceded by an escaped quote, so only the rendered <button> text
  // matches here. ("Go Pro Plus — …" never collides: '>Go Pro —' needs the
  // dash next.)
  const OFFERS_TRIAL = ">Start free trial —";
  const OFFERS_NO_TRIAL = ">Go Pro —";

  const freshBilling = await html(free, `/o/${freeSlug}/settings/billing`);
  const freshSub = await readSub(freeOrg);
  check(
    "trial/free: a fresh community org is unburned and offered the 14-day trial",
    freshSub.trial_used_at === null &&
      freshBilling.status === 200 &&
      freshBilling.body.includes(OFFERS_TRIAL) &&
      !freshBilling.body.includes(OFFERS_NO_TRIAL),
  );

  await setStaff(staffEmail, "superadmin");
  try {
    // --- Pro path 1: the grant IS free Pro, so it burns the one trial.
    const grant = await raw(staff, `/api/admin/orgs/${proOrg}/grant-trial`, "POST", {
      days: 14,
      reason: "smoke: one trial per org",
    });
    const granted = await readSub(proOrg);
    check(
      "trial/pro: a staff-granted trial lifts the org to Pro and burns its one trial",
      grant.status === 200 &&
        granted.plan_key === "pro" &&
        granted.status === "trialing" &&
        granted.trial_used_at !== null,
    );

    // --- Pro path 2: extensions move trial_end; the BURN is written once.
    await backdateBurn(proOrg);
    const burned = await readSub(proOrg);
    const extend = await raw(staff, `/api/admin/orgs/${proOrg}/grant-trial`, "POST", {
      days: 7,
      reason: "smoke: extension must not re-burn",
    });
    const extended = await readSub(proOrg);
    check(
      "trial/pro: extending the trial moves trial_end but never re-burns trial_used_at",
      extend.status === 200 &&
        at(extended.trial_end) !== at(burned.trial_end) &&
        at(extended.trial_used_at) === at(burned.trial_used_at),
    );

    // --- Pro path 3: once Stripe owns the timeline the grant is refused with a
    // 400, before any write and before any Stripe call.
    //
    // What this proves: the guard fires and the endpoint refuses. It does NOT
    // discriminate the two-column liveness rule on its own — the seed sets id
    // AND a live status together, so a regression branching on the id alone
    // would refuse here too. Pro path 4 below is the case that tells them apart.
    //
    // trial_end is the only row column that can move on a realistic regression
    // here: if the guard stopped recognising this org as live, the non-live arm
    // would run and write trial_end unconditionally. `status` and
    // `trial_used_at` are NOT asserted — neither can move on any single
    // regression (the non-live arm gates status on `stripe_subscription_id is
    // null`, the live arm's pinned UPDATE requires status = 'trialing' while the
    // seed is 'active', and every writer coalesces an already-set trial_used_at)
    // so asserting them would be assertion theatre next to a "row untouched"
    // claim.
    await seedStripeBilled(proOrg, "active");
    const beforeRefusal = await readSub(proOrg);
    const refused = await raw(staff, `/api/admin/orgs/${proOrg}/grant-trial`, "POST", {
      days: 30,
      reason: "smoke: stripe-billed orgs are refused",
    });
    const afterRefusal = await readSub(proOrg);
    check(
      "trial/pro: a Stripe-billed org is refused a staff trial (400) and trial_end never moves",
      refused.status === 400 && at(afterRefusal.trial_end) === at(beforeRefusal.trial_end),
    );

    // --- Pro path 4: the DISCRIMINATING case. A departed org keeps its Stripe
    // subscription id for ever but is not billed by it, so liveness is
    // `id is not null AND status in (trialing, active, past_due)` — 'canceled'
    // fails it. Such an org is still grantable, and the grant still burns its
    // one trial. A blunter guard (`if (stripe_subscription_id)`) would 400 here
    // and leave trial_used_at null; that is what separates it from path 3.
    // The cancelled status must also survive the grant: writing a live-looking
    // status back onto a dead id would send the NEXT grant down the Stripe arm.
    await seedStripeBilled(depOrg, "canceled");
    const beforeDeparted = await readSub(depOrg);
    const departedGrant = await raw(staff, `/api/admin/orgs/${depOrg}/grant-trial`, "POST", {
      days: 14,
      reason: "smoke: a departed org is not Stripe-billed",
    });
    const departed = await readSub(depOrg);
    check(
      "trial/pro: a DEPARTED org (dead sub id, canceled) is still granted a trial, and it burns",
      beforeDeparted.trial_used_at === null &&
        departedGrant.status === 200 &&
        departed.plan_key === "pro" &&
        departed.trial_used_at !== null &&
        departed.status === "canceled",
    );

    // --- Restore trial 1: the sanctioned undo, on the departed org from path
    // 4 above (canceled status, dead id — not live, so the restore is
    // allowed). trial_used_at must actually clear, not just the call 200.
    const beforeRestore = await readSub(depOrg);
    const restore = await raw(staff, `/api/admin/orgs/${depOrg}/restore-trial`, "POST", {
      reason: "smoke: restore trial is the sanctioned one-time undo",
    });
    const restored = await readSub(depOrg);
    check(
      "trial/restore: a departed org's burn is cleared by restoreTrial",
      beforeRestore.trial_used_at !== null &&
        restore.status === 200 &&
        restored.trial_used_at === null,
    );

    // --- Restore trial 2: the DISCRIMINATING refusal. proOrg was made LIVE in
    // Pro path 3 above (id + status 'active') and is still burned — restoring
    // it would just be re-stamped by the next sync, so the usecase refuses
    // with 400 before writing anything. trial_used_at must be UNCHANGED, not
    // merely "still non-null" (which a broken restore that cleared-then-
    // recoalesced could still satisfy).
    const beforeRefuseRestore = await readSub(proOrg);
    const restoreRefused = await raw(staff, `/api/admin/orgs/${proOrg}/restore-trial`, "POST", {
      reason: "smoke: a live org keeps its burn",
    });
    const afterRefuseRestore = await readSub(proOrg);
    check(
      "trial/restore: a LIVE org is refused (400) and its burn is unchanged",
      beforeRefuseRestore.trial_used_at !== null &&
        restoreRefused.status === 400 &&
        at(afterRefuseRestore.trial_used_at) === at(beforeRefuseRestore.trial_used_at),
    );

    // --- Free path 2: the OTHER stamping writer. A comp is free Pro too.
    const comp = await raw(staff, `/api/admin/orgs/${freeOrg}/comp-to-pro`, "POST", {
      until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
      reason: "smoke: a comp burns the trial",
    });
    const comped = await readSub(freeOrg);
    check(
      "trial/free: a staff comp lifts the org to Pro and burns its one trial",
      comp.status === 200 && comped.plan_key === "pro" && comped.trial_used_at !== null,
    );

    // --- Free path 3: back on Community, the burn stands and the upgrade CTA
    // stops promising a second trial. This is the whole product rule, at the
    // surface the owner reads before paying.
    await backdateBurn(freeOrg);
    const burnedFree = await readSub(freeOrg);
    const down = await raw(staff, `/api/admin/orgs/${freeOrg}/downgrade`, "POST", {
      reason: "smoke: downgrade must not re-arm the trial",
    });
    const downgraded = await readSub(freeOrg);
    const returnBilling = await html(free, `/o/${freeSlug}/settings/billing`);
    check(
      "trial/free: downgrading to Community keeps the burn and the CTA offers no second trial",
      down.status === 200 &&
        downgraded.plan_key === "community" &&
        at(downgraded.trial_used_at) === at(burnedFree.trial_used_at) &&
        returnBilling.status === 200 &&
        returnBilling.body.includes(OFFERS_NO_TRIAL) &&
        !returnBilling.body.includes(OFFERS_TRIAL),
    );
  } finally {
    await setStaff(staffEmail, null);
  }
}

/** Task 11: staffRemovePaymentMethod (staff can remove even the DEFAULT card)
 *  and the customer-facing removePaymentMethod's default-card refusal, both
 *  new user-visible rails with no prior smoke arm. Needs a REAL Stripe
 *  test-mode customer + card — no app route mints one headless, since the
 *  actual "add a card" flow mounts Stripe's own Elements iframe
 *  (AddCardForm). Stripe's `pm_card_visa` token exists exactly for this:
 *  attaching it to a customer in test mode creates a real PaymentMethod with
 *  no client-side confirmation step needed. Keyless-safe: skips (rather than
 *  fails) without STRIPE_SECRET_KEY, the same convention as the sponsor
 *  Connect checkout suite. */
async function paymentMethodSuite(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) {
    check("pm: skipped (no STRIPE_SECRET_KEY — cannot attach a real test card)", true);
    return;
  }
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const staffEmail = `pm_staff_${tag}@example.com`;
  const staff = newSession();
  await signIn(staff, staffEmail);

  const owner = newSession();
  const ownerOrg = (await signIn(owner, `pm_owner_${tag}@example.com`)).org_id;

  const customer = await stripe.customers.create({
    email: `pm_owner_${tag}@example.com`,
  });
  const pm = await stripe.paymentMethods.attach("pm_card_visa", {
    customer: customer.id,
  });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  const readFlag = async (): Promise<boolean | null> => {
    const d = smokeDb();
    try {
      // Through organizations.subscription_id — see readSub; V310 dropped
      // subscriptions.org_id.
      const [row] = await d<{ has_payment_method: boolean | null }[]>`
        select s.has_payment_method from subscriptions s
        join organizations o on o.subscription_id = s.id
        where o.id = ${ownerOrg}`;
      return row ? row.has_payment_method : null;
    } finally {
      await d.end();
    }
  };

  const db = smokeDb();
  try {
    // Through organizations.subscription_id — V310 dropped subscriptions.org_id.
    await db`
      update subscriptions
      set stripe_customer_id = ${customer.id}, has_payment_method = true
      where id = (select subscription_id from organizations where id = ${ownerOrg})`;
  } finally {
    await db.end();
  }

  await setStaff(staffEmail, "superadmin");
  try {
    // The org's only card is also its default — the customer-facing path
    // refuses exactly that (400), before Stripe is ever called.
    const customerAttempt = await raw(owner, "/api/billing/remove-payment-method", "POST", {
      payment_method_id: pm.id,
    });
    check(
      "pm/customer: removing the DEFAULT card is refused (400)",
      customerAttempt.status === 400,
    );

    // Staff CAN remove it — the audited exception (Task 6C) — and the mirror
    // re-reads Stripe rather than assuming, so it flips false once no cards
    // remain (this org had exactly one).
    const staffRemove = await raw(
      staff,
      `/api/admin/orgs/${ownerOrg}/remove-payment-method`,
      "POST",
      {
        payment_method_id: pm.id,
        reason: "smoke: staff can remove the default card",
      },
    );
    check(
      "pm/staff: staff removes the default card (200) and has_payment_method re-mirrors false",
      staffRemove.status === 200 && (await readFlag()) === false,
    );
  } finally {
    await setStaff(staffEmail, null);
  }
}

/** v8 (spec 2026-07-13): the format is editable until fixtures exist, then
 *  PATCH rejects with FORMAT_LOCKED; the logo upload URL mints for editors. */
async function divisionSettingsSuite(admin: Session): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `V8 Probe ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Lockable",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  const pre = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", {
    config: { points: { w: 2, d: 1, l: 0 }, progressScore: false },
  });
  check("v8 format editable pre-fixtures", pre.status === 200);

  const uploadUrl = await raw(admin, `/api/v1/divisions/${div.id}/logo-upload-url`, "POST", {});
  const upload = uploadUrl.json.data as { storage_path?: string } | undefined;
  check(
    "v8 division logo upload URL mints (or 503 keyless)",
    (uploadUrl.status === 200 && !!upload?.storage_path?.includes(div.id)) ||
      // CI smoke runs without Supabase creds — the guard is the behavior.
      (uploadUrl.status === 503 &&
        (uploadUrl.json.error as { message?: string } | undefined)?.message ===
          "Storage is not configured"),
  );

  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    }),
  );
  await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST");

  const post = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", {
    variant_key: "score",
  });
  check(
    "v8 format 409s once fixtures exist",
    post.status === 409 &&
      (post.json.error as { code?: string } | undefined)?.code === "FORMAT_LOCKED",
  );

  const structSwap = await raw(admin, `/api/v1/divisions/${div.id}/stages`, "PUT", [
    { seq: 1, kind: "knockout", name: "KO", config: {}, qualification: null },
  ]);
  check(
    "v8 structure PUT 409s once fixtures exist",
    structSwap.status === 409 &&
      (structSwap.json.error as { code?: string } | undefined)?.code === "FORMAT_LOCKED",
  );
}

/** Flip Stripe Connect readiness (spec 2026-07-12) — Express onboarding can't
 *  run headless; a fake acct id satisfies account-exists checks. Same SQL-flip
 *  convention as setPlan/grantPass.
 *
 *  Pass `accountId` (i.e. CONNECT_TEST_ACCOUNT) to overwrite the fabricated id
 *  with a REAL connected account, the only way a destination charge can
 *  settle. `organizations.stripe_account_id` carries a partial UNIQUE index, so
 *  hand a real id to at most ONE org per run — every other caller must leave it
 *  undefined and keep its throwaway acct_smoke_* id. */
async function setConnect(
  orgId: string,
  chargesEnabled: boolean,
  accountId?: string,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to flip Connect in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    if (accountId) {
      await sql`
        update organizations
        set stripe_charges_enabled = ${chargesEnabled},
            stripe_account_id = ${accountId}
        where id = ${orgId}`;
    } else {
      await sql`
        update organizations
        set stripe_charges_enabled = ${chargesEnabled},
            stripe_account_id = coalesce(stripe_account_id, ${"acct_smoke_" + orgId.slice(0, 8)})
        where id = ${orgId}`;
    }
  } finally {
    await sql.end();
  }
}

/**
 * The Event Pass rungs (v17 #294). A hand-kept mirror of `PASS_KEYS`
 * (apps/web/src/lib/currency.ts): smoke runs under
 * `node --experimental-strip-types` and can resolve neither the app's `@/`
 * alias nor the JSON import `currency.ts` pulls in, so the list cannot be
 * imported. It is therefore ASSERTED against the `plans` table rather than
 * trusted — see the ladder check at the top of `passRungLSuite`, which reds the
 * day a third rung is seeded without this file learning about it.
 */
const PASS_RUNGS = ["event_pass", "event_pass_l"] as const;
type PassRung = (typeof PASS_RUNGS)[number];

/**
 * Insert an Event Pass row directly (v3/07 §3) — smoke targets a disposable DB
 * and the one-time Stripe checkout can't run without Stripe; the same SQL-flip
 * convention as setPlan. Used where the purchase itself is not what is under
 * test (a competition that just needs to BE passed), and for the states no
 * purchase can reach — a pass held by a PAID plan, for instance, which the buy
 * route refuses outright.
 *
 * v17 #294: `passKey` is REQUIRED, and deliberately has no default. This insert
 * used to omit the column entirely while V271 declares it `not null default
 * 'event_pass'`, so seeding an L pass here stored an M one — no FK error, no
 * exception, nothing red, and every downstream assertion then measured the
 * wrong rung's ceilings. That is the same landmine `recordPassPurchase` carried
 * (lib/billing.ts), and a default here would only relocate it: making callers
 * name the rung is what lets `tsc` enumerate every seed the day a third rung
 * appears.
 */
async function grantPass(
  orgId: string,
  competitionId: string,
  passKey: PassRung,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to grant a pass in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${competitionId}, ${orgId}, ${passKey})
      on conflict (competition_id) do nothing`;
  } finally {
    await sql.end();
  }
}

/**
 * Mark a competition completed directly via SQL (v17 gap #301).
 *
 * Same disposable-DB, SQL-flip convention as grantPass/setPlan, and for the
 * same reason: the thing under test is what every SURFACE says once the
 * resolver stops honouring a pass, and the only way to reach that state through
 * the product is to finish a competition, which is not a checkout flow smoke
 * can drive. The pass ROW is deliberately left untouched — that is the whole
 * point of the gap: the row outlives its own usefulness.
 */
async function endCompetition(competitionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to end a competition in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`update competitions set status = 'completed' where id = ${competitionId}`;
  } finally {
    await sql.end();
  }
}

/**
 * True when `name` is a REAL rendered HTML attribute — not merely a prop name
 * that survived into the RSC flight payload Next embeds in the same body.
 *
 * React does NOT drop an omitted prop when it serialises a server-rendered
 * element; it encodes the `undefined` so the client can tell "absent" from
 * "never sent". Rendering `<div data-pass-active={held || undefined}>` with
 * `held` false produces, verbatim:
 *
 *   0:["$","div",null,{"data-pass-active":"$undefined","data-pass-ended":true},…]
 *
 * So `body.includes("data-pass-active")` is TRUE for an attribute the browser
 * never sees, and the string is present in BOTH states. A bare-name check is
 * therefore vacuous in the positive direction and IMPOSSIBLE to satisfy in the
 * negative one — the p301 upgrade checks hit both halves of that at once.
 * Anchoring on `="` keys off the serialised attribute, which only real markup
 * carries.
 */
function renderedAttr(body: string, name: string): boolean {
  return body.includes(`${name}="`);
}

/** Every Event Pass rung the `plans` table actually carries, sorted. Read with
 *  a plain `select key` and filtered in JS rather than a `like 'event\_pass%'`
 *  — the escaped underscore is a needless trap inside a tagged template. */
async function passRungsInDb(): Promise<string[]> {
  const sql = smokeDb();
  try {
    const rows = await sql<{ key: string }[]>`select key from plans order by key`;
    return rows.map((r) => r.key).filter((k) => k.startsWith("event_pass"));
  } catch {
    return [];
  } finally {
    await sql.end();
  }
}

/** The Event Pass row a competition actually holds — the rung the resolver will
 *  enforce and the money trace will name. Read back, never assumed: the whole
 *  point of the L rung is that storing the wrong one is silent. */
async function passRowFor(
  competitionId: string,
): Promise<{ pass_key: string; stripe_payment_intent: string | null } | null> {
  const sql = smokeDb();
  try {
    const [row] = await sql<{ pass_key: string; stripe_payment_intent: string | null }[]>`
      select pass_key, stripe_payment_intent from competition_passes
      where competition_id = ${competitionId}`;
    return row ?? null;
  } finally {
    await sql.end();
  }
}

let smokeWebhookSeq = 0;

/**
 * Deliver a synthetic, correctly-signed Stripe event to the app's OWN webhook
 * route (`/api/webhooks/stripe`).
 *
 * Stripe cannot reach localhost and an embedded checkout cannot be completed
 * headlessly, so this is the only way smoke can drive the real money path —
 * `runEvent` → `handleCheckoutCompleted` → `recordPassPurchase` — rather than
 * re-implementing its effects in SQL and then asserting its own seed. The
 * signature is a plain HMAC-SHA256 over `${t}.${payload}`, exactly what
 * `stripe.webhooks.constructEvent` verifies, so nothing here needs the Stripe
 * SDK or a network call; the SERVER still needs a `STRIPE_SECRET_KEY` (the
 * route builds a client to verify with) and the SAME `STRIPE_WEBHOOK_SECRET`.
 * Mirrors `postSignedStripeWebhook` in e2e/event-pass.spec.ts.
 *
 * Returns the HTTP status so the caller asserts it rather than this helper
 * throwing an unlabelled error.
 */
async function postSignedStripeWebhook(type: string, object: unknown): Promise<number> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is required to sign a smoke webhook");
  const event = {
    // `evt_smoke_<tag>_…` is also what teardown deletes by: billing_events has
    // no org FK, so these rows would otherwise outlive the run's orgs.
    id: `evt_smoke_${tag}_${++smokeWebhookSeq}`,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${t},v1=${signature}`,
    },
    body: payload,
  });
  return res.status;
}

/**
 * A PAID Event Pass checkout session, in the shape `buildPassCheckoutParams`
 * stamps and `handleCheckoutCompleted` reads: `metadata.pass_key` is what tells
 * the handler which rung was bought, and `payment_status: "paid"` is what makes
 * it record anything at all.
 *
 * Deliberately carries NO `amount_total`: nothing in the pass branch reads it,
 * and writing a price here would plant exactly the kind of stale `2900` literal
 * this rung ladder exists to stop. `customer` is null so the handler skips
 * `linkStripeCustomer` — smoke has no Stripe customer to link and does not need
 * one to prove which rung landed.
 */
async function postPaidPassWebhook(args: {
  orgId: string;
  competitionId: string;
  passKey: PassRung;
  paymentIntent: string;
}): Promise<number> {
  return postSignedStripeWebhook("checkout.session.completed", {
    id: `cs_smoke_${tag}_${args.passKey}_${args.competitionId.slice(0, 8)}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    customer: null,
    payment_intent: args.paymentIntent,
    metadata: {
      org_id: args.orgId,
      competition_id: args.competitionId,
      pass_key: args.passKey,
    },
  });
}

/** payments-hardening P0-1: seed a PAID registration carrying unrefunded card
 *  money (payment_intent set, refunded < amount) — the delete guard keys off
 *  exactly this. Mirrors competitions-delete-money.test.ts's SQL seed; the
 *  Stripe checkout can't run headless. */
async function seedPaidRegistration(orgId: string, divisionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed a registration in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      insert into registrations
        (division_id, org_id, status, display_name, contact_email, amount_cents,
         payment_intent_id, refunded_cents, guardian_consent, answers, roster, access_token_hash)
      values (${divisionId}, ${orgId}, 'paid', 'Smoke Payer', 'payer@x.test', 2000,
              ${"pi_smoke_" + divisionId.slice(0, 8)}, 0, false, '{}', '[]', ${crypto.randomUUID()})`;
  } finally {
    await sql.end();
  }
}

/** payments-hardening P0-1: seed a PAID sponsor order scoped to a competition
 *  through its package — the delete guard's third money record. Mirrors
 *  competitions-delete-money.test.ts's SQL seed. */
async function seedPaidSponsorOrder(orgId: string, competitionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed a sponsor order in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const [pkg] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
      values (${orgId}, ${competitionId}, 'Gold', 25000, 'gbp', 'gold') returning id`;
    await sql`
      insert into sponsor_orders
        (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status, paid_at)
      values (${orgId}, ${pkg!.id}, 'Smoke Sponsor', 'sponsor@x.test', 25000, 'gbp', 'paid', now())`;
  } finally {
    await sql.end();
  }
}

/** payments-hardening P2-10: flip a division's registration settings to a
 *  card (Stripe) fee directly — the settings PUT gates the stripe method on
 *  the paid entitlement, but the public-read close reason is exactly what we
 *  want to prove, so SQL-seed the state the read evaluates. Always-open
 *  window (no opens/closes), uncapped. */
async function seedStripeFeeDivision(divisionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed registration settings in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
         fee_cents, currency, refund_lock_at, form_fields, payment_method,
         payment_instructions, updated_at)
      values (${divisionId}, true, 'individual', null, null, null,
              2000, 'gbp', null, '[]', 'stripe', null, now())
      on conflict (division_id) do update set
        enabled = true, fee_cents = 2000, currency = 'gbp',
        payment_method = 'stripe', opens_at = null, closes_at = null,
        capacity = null, updated_at = now()`;
  } finally {
    await sql.end();
  }
}

/** v17 Phase-2 (V320+): the AI Schedule/Officials Architect is metered by a
 *  prepaid credit WALLET (`ai_credit_ledger`), not a per-division run count —
 *  the old graded per-division cap key was retired outright (V322). The
 *  wallet id an org spends from is `coalesce(subscription_id, org_id)`
 *  (`lib/credits.ts`'s `walletIdFor`, mirrored here as raw SQL since smoke
 *  can't import server-only app code). */
async function walletIdForOrg(orgId: string): Promise<string> {
  const sql = smokeDb();
  try {
    const [row] = await sql<{ wallet_id: string }[]>`
      select coalesce(subscription_id, id)::text as wallet_id
        from organizations where id = ${orgId}`;
    if (!row) throw new Error(`walletIdForOrg: no organization ${orgId}`);
    return row.wallet_id;
  } finally {
    await sql.end();
  }
}

/** Credits currently in an org's AI wallet: `sum(delta)` over the ledger
 *  (mirrors `lib/credits.ts`'s `balance()`). */
async function walletBalance(orgId: string): Promise<number> {
  const walletId = await walletIdForOrg(orgId);
  const sql = smokeDb();
  try {
    const [row] = await sql<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger where wallet_id = ${walletId}`;
    return Number(row?.bal ?? 0);
  } finally {
    await sql.end();
  }
}

/** Same as `walletBalance` but takes the wallet id directly — used to prove
 *  a wallet a billing-group move stepped AWAY from (its old subscription/
 *  group id, before the attach) is left holding nothing, rather than
 *  resolving through an org's CURRENT (post-move) wallet like
 *  `walletBalance` does. */
async function walletBalanceByWalletId(walletId: string): Promise<number> {
  const sql = smokeDb();
  try {
    const [row] = await sql<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger where wallet_id = ${walletId}`;
    return Number(row?.bal ?? 0);
  } finally {
    await sql.end();
  }
}

/** Drain an org's AI credit wallet down to exactly `remaining` credits via a
 *  single raw ledger debit row — the keyless-safe way smoke proves the
 *  `ai.credits` 402 fires without spending on a real model call. This
 *  replaces the old `seedAiRuns` (which seeded fake `schedule.ai_generated`
 *  competition_events for the now-retired per-division count cap). A no-op if
 *  the wallet already holds `remaining` or less. */
async function drainWallet(orgId: string, remaining = 0): Promise<void> {
  const walletId = await walletIdForOrg(orgId);
  const current = await walletBalance(orgId);
  const drain = current - remaining;
  if (drain <= 0) return;
  const sql = smokeDb();
  try {
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, ${-drain}, 'admin_adjust', 'grant', ${remaining},
              ${`smoke-drain-${tag}-${orgId}-${Date.now()}`})`;
  } finally {
    await sql.end();
  }
}

/** Top up an org's AI credit wallet by `amount` via a single raw ledger
 *  credit row — the keyless-safe analog of the old `insertEntitlementOverride`
 *  "admin lifts the cap" step, updated for the wallet model: there is no
 *  per-division cap to override any more, only a balance to credit. Uses the
 *  grant bucket (SPEC-2 §5.4 D1); the bucket is immaterial to smoke, which only
 *  needs a spendable balance to drain. */
async function topUpWallet(orgId: string, amount: number): Promise<void> {
  const walletId = await walletIdForOrg(orgId);
  const current = await walletBalance(orgId);
  const sql = smokeDb();
  try {
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, ${amount}, 'admin_adjust', 'grant', ${current + amount},
              ${`smoke-topup-${tag}-${orgId}-${Date.now()}`})`;
  } finally {
    await sql.end();
  }
}

/** A configured smoke postgres client (search_path seazn_club, local/remote SSL,
 *  pooler-aware prepare). Caller owns the connection and must `.end()` it. */
function smokeDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for this smoke step");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
}

/** Grant an org-wide entitlement override — the same row /admin/entitlements
 *  writes. A boolean `value` lands in bool_value (a flag grant, e.g.
 *  api.access), a number in int_value (a graded cap, e.g.
 *  entrants.per_division.max). Not used for AI runs any more — those are
 *  metered by the credit wallet (`drainWallet`/`topUpWallet`), not an
 *  entitlement override (the old graded per-division run cap was retired,
 *  V322).
 *
 *  This is a raw-SQL write behind the resolver's back, exactly like setPlan's,
 *  so it busts the org's entitlement cache afterwards for the same reason: both
 *  call sites resolve (and therefore CACHE) the very key they are about to lift
 *  in the 402 check immediately above, so on any Redis-backed target the
 *  follow-up assertion would read the cached deny for up to 300s. `owner` is
 *  required, not optional — the bust needs a live owner session, and an
 *  optional parameter is an invitation for a future call site to skip it. */
async function insertEntitlementOverride(
  owner: Session,
  orgId: string,
  featureKey: string,
  value: number | boolean,
): Promise<void> {
  const boolValue = typeof value === "boolean" ? value : null;
  const intValue = typeof value === "number" ? value : null;
  const sql = smokeDb();
  try {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value)
      values (${orgId}, ${featureKey}, ${boolValue}, ${intValue})
      on conflict (org_id, feature_key) do update
        set bool_value = ${boolValue}, int_value = ${intValue}, expires_at = null`;
  } finally {
    await sql.end();
  }
  await bustOrgEntitlements(owner, orgId);
}

/** The most recent competition_events payload of a given type, or null. */
async function latestCompetitionEvent(
  competitionId: string,
  type: string,
): Promise<{
  model?: string;
  cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    repair_rounds: number;
  };
  /** #398: the stage-1 instruction compile, metered on its own line because it
   *  runs outside `spendCredit` and outside `budget`. */
  parse_tokens?: number;
  parse_failed?: boolean;
  spent_tokens?: number;
  budget?: number;
  /** #387: the `schedule.ai_quote_mismatch` payload — what the confirm card
   *  quoted against what the run actually charged. */
  quoted?: number;
  charged?: number;
} | null> {
  const sql = smokeDb();
  try {
    const [row] = await sql<
      {
        payload: {
          model?: string;
          cost_usd?: number;
          usage?: {
            input_tokens: number;
            output_tokens: number;
            repair_rounds: number;
          };
        };
      }[]
    >`
      select payload from competition_events
      where competition_id = ${competitionId} and type = ${type}
      order by created_at desc limit 1`;
    return row?.payload ?? null;
  } finally {
    await sql.end();
  }
}

/** A plannable division for the AI architect: 4 individual entrants, one league
 *  stage, two-court schedule settings, fixtures generated. Returns its ids.
 *
 *  `startAt` defaults to a fixed date; pass `null` for a division with NO
 *  configured start date — the board #397 exists for, which used to be drafted
 *  from the epoch (see the anchor checks in v4AiSuite). */
async function seedPlannableAiDivision(
  s: Session,
  label: string,
  startAt: string | null = "2026-10-01T09:00:00.000Z",
): Promise<{ compId: string; divId: string; stageId: string }> {
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(
    s,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: `${n}${tag}`,
      seed: i + 1,
    })),
  );
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      ...(startAt !== null ? { startAt } : {}),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST");
  return { compId: comp.id, divId: div.id, stageId: stage.id };
}

/** A four-entrant knockout WITH a third-place playoff, one person per entrant —
 *  the board that exercises the #396 participants recursion over HTTP.
 *
 *  Round 2 is two fixtures with no entrants at all: the final (fed by both semi
 *  winners) and the third-place playoff (fed by both semi losers). Every one of
 *  the four players can still reach EITHER of them, so the two are unsafe to
 *  play at the same moment — and nothing on the fixture rows says so, because
 *  both slots are null. Only walking the feeder graph behind those nulls finds
 *  the people, which is exactly what this seed exists to prove is happening.
 *
 *  `members: [{ person_id }]` is load-bearing. An individual entrant created
 *  from a bare `display_name` writes NO `entrant_members` row (entrants.ts), so
 *  it has no person, and every person rule passes on it vacuously — the seed
 *  would look right and assert nothing.
 *
 *  Its own competition, deliberately: a sibling division's applied board is fed
 *  to the planner as fixed court occupancy, which would make this a
 *  court-conflict test instead of a person one. */
async function seedBracketAiDivision(
  s: Session,
  label: string,
): Promise<{
  divId: string;
  personIds: string[];
  fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[];
}> {
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const personIds: string[] = [];
  const entrants: unknown[] = [];
  for (const [i, n] of ["A", "B", "C", "D"].entries()) {
    const person = v1data<{ id: string }>(
      await v1(s, "/api/v1/persons", "POST", {
        full_name: `${label} Player ${n} ${tag}`,
        consent: {},
      }),
    );
    personIds.push(person.id);
    entrants.push({
      kind: "individual",
      display_name: `${label} ${n}${tag}`,
      seed: i + 1,
      members: [{ person_id: person.id }],
    });
  }
  await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", entrants);
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Cup",
      config: { thirdPlace: true },
    }),
  );
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-08T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const gen = v1data<{
    fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[];
  }>(await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"));
  return { divId: div.id, personIds, fixtures: gen.fixtures };
}

/** #397 (calendar anchor): a time that never left 1970 — what the pack handed
 *  the model for a division with no configured start date, when the greedy
 *  draft was anchored at `toSlotConfig(settings, 0)`. The cut is the engine's
 *  own `isEpochSentinel` (anything before 1971-01-01), read off the INSTANT
 *  rather than the rendered year: west of UTC the epoch renders as 1969-12-31,
 *  so a year prefix would miss exactly the boards this check exists for. The
 *  pack now nulls these rather than showing them. */
const EPOCH_SENTINEL_BEFORE_MS = Date.UTC(1971, 0, 1);
const epochAnchored = (iso: string): boolean => Date.parse(iso) < EPOCH_SENTINEL_BEFORE_MS;

/** #397: the pack writes every time as `zonedIso(…, orgTz)` — an explicit UTC
 *  offset, in the ORGANISATION timezone. A pack with no timezone could not
 *  produce one, so the offset is the proof (over HTTP) that `pack.tz` is real.
 *  Note `Z` is deliberately NOT accepted: `zonedIso` always writes ±HH:MM. */
const zonedTime = (iso: string): boolean => /[+-]\d{2}:\d{2}$/.test(iso);

/** Today−1 as YYYY-MM-DD in UTC. One day of slack covers every organisation
 *  zone (±14h), so a draft dated on or after it cannot be epoch-anchored — or
 *  anchored at any other stale instant. */
const yesterdayUtcYmd = (): string =>
  new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

interface AiPlanResponseLite {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string }[];
  /** Engine `Conflict[]` — non-blocking verdicts the organiser is shown rather
   *  than having repaired (rest, blackout, start window, an instruction rule). */
  warnings: { fixtureId: string; reason: string; detail?: string; rule?: string }[];
  /** Residual blockers after the repair rounds. Since #399 `person_overlap` and
   *  `window` are in here, not in `warnings`. */
  blocking: { fixtureId: string; reason: string; detail?: string; rule?: string }[];
  diff: unknown;
  summary: string;
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number };
  /** W6 (#401): what the constraint solver did before any LLM repair round.
   *  Present on every plan — `solver_ran: false` on the clean path and when the
   *  kill switch is set — so its ABSENCE is a regression, not a valid state. */
  repair?: {
    engine: string;
    solver_ran: boolean;
    status?: string;
    moved?: number;
    unresolved?: number;
    minimality?: string;
  };
  officials_coverage: unknown;
}

/** W5 (#400): `AiParsePreviewResponse`, as much of it as smoke asserts on. */
interface AiPreviewLite {
  preview_id?: string;
  failed: boolean;
  compiled: {
    hard: { type: string }[];
    soft: { note: string; weight: number }[];
    unparsed: string[];
    assumptions: string[];
  };
  window: { start: string; end: string; tz: string } | null;
}

// ---------------------------------------------------------------------------
// #452 — the scheduling CONSTRAINT surface over real HTTP.
//
// Four defects (#443, #446, #447, #459) shipped past a fully green suite
// because nothing outside the unit tests ever stored a durable rule or a
// pool-bearing fixture. Before this suite `grep -c constraints scripts/smoke.ts`
// was 0 and `kind: "group"` appeared zero times, so `constraints.hard` and a
// pool-targeted `restByGroup` were both UNREACHABLE from an end-to-end run.
// ---------------------------------------------------------------------------

/** A conflict row as `mapConflicts` returns it. */
interface ScheduleConflictLite {
  fixture_id: string;
  code: string;
  rule?: string;
  detail?: string;
  blocking: boolean;
}
/** As much of a `fixtures` row as this suite reads. */
interface ConstraintFixtureLite {
  id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
}

const idsWithCode = (rows: readonly ScheduleConflictLite[], code: string): Set<string> =>
  new Set(rows.filter((c) => c.code === code).map((c) => c.fixture_id));

/**
 * #452: a durable `constraints.hard` rule and a pool-targeted `restByGroup`,
 * asserted on every surface the smoke harness can reach.
 *
 * ITS OWN ORG, and deliberately NOT bolted onto `seedBracketAiDivision`'s PUT
 * (see the report for the deviation): that seed sits behind TWO gates, not one —
 * `aiConfigured` (SCHEDULING_AI_BASE_URL) and then the `if (fixture)` block,
 * i.e. the fixture server having actually started. Hanging this coverage off it
 * would make the whole thing skip whenever EITHER is unmet — the same
 * "green run that asserted nothing" this issue exists to end. Its division is
 * also the subject of the #401 solver assertions (`repair.moved === 1`), and the
 * repair solver reads `effectiveHard`, so storing a rule there would have moved
 * an existing check's answer.
 *
 * EVERY "the rule fires" check below is paired with a "the rule stays silent
 * when it is satisfied" twin on the SAME board and the SAME stored rule. A
 * one-sided assertion passes when the rule binds nothing at all, which is
 * precisely #443/#446.
 *
 * Conflicts here are WARN-ONLY. `isBlockingConflict` covers court /
 * person_overlap / window / direct order — not `instruction` and not `rest` — so
 * an apply carrying them still returns 200 and still writes. The assertions
 * therefore read the returned `conflicts` array, never the status code.
 */
async function schedulingConstraintsSuite(): Promise<void> {
  const s = newSession();
  // `scheduling.constraints` (the whole constraints v2 family, `hard` included)
  // is Pro, and so is the board apply path.
  const orgId = (await signIn(s, `smoke-sched-constraints-${tag}@example.com`)).org_id;
  await setPlan(orgId, "pro", s);

  // ======================================================================
  // 1. A durable feeder→dependent rest rule on a real bracket (#443, #447)
  // ======================================================================
  const cupComp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Sched Constraints ${tag}` }),
  );
  const cupDiv = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${cupComp.id}/divisions`, "POST", {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(
    s,
    `/api/v1/divisions/${cupDiv.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: `Cup ${n}${tag}`,
      seed: i + 1,
    })),
  );
  const cupStage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${cupDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Cup",
      config: { thirdPlace: true },
    }),
  );

  // `scope: competition` on purpose: the narrower scopes are unit-tested, and a
  // scope that failed to match would make every assertion below vacuous in the
  // same direction — the failure mode this suite exists to catch.
  const FEEDER_REST_MIN = 60;
  const feederRule = [
    {
      type: "min_rest_minutes",
      minutes: FEEDER_REST_MIN,
      rest_scope: "feeder_to_dependent",
      scope: { kind: "competition" },
    },
  ];
  const cupSettings = (gapMinutes: number) => ({
    config: {
      startAt: "2026-11-05T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
      constraints: { hard: feederRule },
    },
    tz: "UTC",
  });
  const storedCup = v1data<{ config: { constraints?: { hard?: { rest_scope?: string }[] } } }>(
    await v1(s, `/api/v1/divisions/${cupDiv.id}/schedule-settings`, "PUT", cupSettings(0)),
  );
  check(
    // The field is API-only — no UI in the repo writes `constraints.hard` — so
    // this round trip is the first end-to-end proof it survives a save at all.
    "#452 constraints: a durable constraints.hard rule stores and reads back through the API",
    storedCup?.config?.constraints?.hard?.length === 1 &&
      storedCup.config.constraints.hard[0]?.rest_scope === "feeder_to_dependent",
  );

  const cupFixtures = v1data<{ fixtures: ConstraintFixtureLite[] }>(
    await v1(s, `/api/v1/stages/${cupStage.id}/generate`, "POST"),
  ).fixtures;
  // The semis carry both entrants; round 2 (final + third place) carries
  // neither, and `winner_to_fixture` from BOTH semis names the final — the feed
  // edge the rule joins on. Only the final is a dependent, so exactly one
  // round-2 fixture can ever be reported.
  const semis = cupFixtures.filter(
    (f) => f.home_entrant_id !== null && f.away_entrant_id !== null,
  );
  const round2 = cupFixtures.filter(
    (f) => f.home_entrant_id === null && f.away_entrant_id === null,
  );
  check(
    "#452 constraints: the bracket generated 2 fed semis + 2 TBD round-2 fixtures",
    cupFixtures.length === 4 && semis.length === 2 && round2.length === 2,
  );

  interface AutoOut {
    assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
    conflicts: ScheduleConflictLite[];
  }
  // ---- Surface 1: the AUTO pass ----
  // gapMinutes 0 packs round 2 straight onto the court the semi just vacated,
  // so the dependent starts 0 minutes after its feeder.
  const autoTight = v1data<AutoOut>(
    await v1(s, `/api/v1/stages/${cupStage.id}/schedule/auto`, "POST", {}),
  );
  const autoTightHits = idsWithCode(autoTight?.conflicts ?? [], "warn.instruction");
  check(
    "#452 auto: a stored feeder→dependent rest rule is REPORTED by the auto pass (#447)",
    (autoTight?.assignments ?? []).length === 4 &&
      autoTightHits.size === 1 &&
      round2.some((f) => autoTightHits.has(f.id)),
  );
  // The twin, on the same stored rule: a 90-minute court turnaround pushes round
  // 2 to exactly the 60 minutes the rule asks for, and the rule goes quiet.
  await v1(s, `/api/v1/divisions/${cupDiv.id}/schedule-settings`, "PUT", cupSettings(90));
  const autoLoose = v1data<AutoOut>(
    await v1(s, `/api/v1/stages/${cupStage.id}/schedule/auto`, "POST", {}),
  );
  check(
    "#452 auto: ...and stays SILENT once the turnaround gives the dependent its rest",
    (autoLoose?.assignments ?? []).length === 4 &&
      idsWithCode(autoLoose?.conflicts ?? [], "warn.instruction").size === 0,
  );
  await v1(s, `/api/v1/divisions/${cupDiv.id}/schedule-settings`, "PUT", cupSettings(0));

  // ---- Surfaces 2 & 3: the APPLY gate and the board's own conflict report ----
  interface ApplyOut {
    applied: number;
    conflicts: ScheduleConflictLite[];
  }
  const cupBoard = (round2At: string) => ({
    assignments: [
      { fixture_id: semis[0]!.id, scheduled_at: "2026-11-05T09:00:00.000Z", court_label: "A" },
      { fixture_id: semis[1]!.id, scheduled_at: "2026-11-05T09:00:00.000Z", court_label: "B" },
      { fixture_id: round2[0]!.id, scheduled_at: round2At, court_label: "A" },
      { fixture_id: round2[1]!.id, scheduled_at: round2At, court_label: "B" },
    ],
  });
  const validateCup = async (): Promise<ScheduleConflictLite[]> =>
    v1data<{ conflicts: ScheduleConflictLite[] }>(
      await v1(s, `/api/v1/divisions/${cupDiv.id}/schedule/validate`, "POST"),
    )?.conflicts ?? [];

  // Semis end 09:30; the final starts 09:45 — 15 minutes, against a 60 rule.
  const tightRes = await v1(
    s,
    `/api/v1/stages/${cupStage.id}/schedule/apply`,
    "POST",
    cupBoard("2026-11-05T09:45:00.000Z"),
  );
  const tightApply = v1data<ApplyOut>(tightRes);
  const tightRows = (tightApply?.conflicts ?? []).filter((c) => c.code === "warn.instruction");
  check(
    // 200, not 409: `instruction` is not in `isBlockingConflict`, so the gate
    // warns and still writes. A test that expected a 409 here would fail and
    // teach the next reader the wrong model.
    "#452 apply: the gate WARNS on a 15-min feeder gap and still writes it (warn-only, no 409)",
    tightRes.status === 200 &&
      tightApply?.applied === 4 &&
      // One row per FEEDER — both semis feed the same final.
      tightRows.length === 2 &&
      new Set(tightRows.map((r) => r.fixture_id)).size === 1 &&
      round2.some((f) => tightRows[0]!.fixture_id === f.id) &&
      tightRows.every((r) => r.blocking === false && r.rule === "H8"),
  );
  const tightReport = idsWithCode(await validateCup(), "warn.instruction");
  check(
    "#452 board report: the same durable rule shows on the board's own report (#447)",
    tightReport.size === 1 && tightReport.has(tightRows[0]!.fixture_id),
  );

  // The twin: 11:00 is 90 minutes after the semis end, clearing the 60-min rule.
  const looseRes = await v1(
    s,
    `/api/v1/stages/${cupStage.id}/schedule/apply`,
    "POST",
    cupBoard("2026-11-05T11:00:00.000Z"),
  );
  const looseApply = v1data<ApplyOut>(looseRes);
  check(
    "#452 apply: ...and is SILENT once the dependent starts 90 minutes after its feeder",
    looseRes.status === 200 &&
      looseApply?.applied === 4 &&
      idsWithCode(looseApply?.conflicts ?? [], "warn.instruction").size === 0,
  );
  check(
    "#452 board report: ...and the board report goes quiet with it",
    idsWithCode(await validateCup(), "warn.instruction").size === 0,
  );

  // ======================================================================
  // 2. A pool-bearing division and a two-keyed restByGroup (#446, #459)
  // ======================================================================
  const poolComp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Sched Pools ${tag}` }),
  );
  const poolDiv = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${poolComp.id}/divisions`, "POST", {
      name: "Pools",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  // SIX entrants, not four. Two pools of three give each pool a three-fixture
  // round robin in which EVERY pair shares exactly one entrant — so any two
  // fixtures of a pool are rest-checked against each other, whatever order the
  // generator emits them in. Two pools of two would be one fixture each and no
  // pair to rest at all: a seed that asserts nothing.
  await v1(
    s,
    `/api/v1/divisions/${poolDiv.id}/entrants`,
    "POST",
    ["A", "B", "C", "D", "E", "F"].map((n, i) => ({
      kind: "individual",
      display_name: `Pool ${n}${tag}`,
      seed: i + 1,
    })),
  );
  const poolStage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${poolDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "group",
      name: "Groups",
      // `group` is the pool-bearing kind — `poolCount(cfg)` reads exactly this,
      // and it is what writes a non-null `fixtures.pool_id`.
      config: { pools: { count: 2 } },
    }),
  );
  const poolFixtures = v1data<{ fixtures: ConstraintFixtureLite[] }>(
    await v1(s, `/api/v1/stages/${poolStage.id}/generate`, "POST"),
  ).fixtures;
  const poolIds = [
    ...new Set(poolFixtures.map((f) => f.pool_id).filter((p): p is string => p !== null)),
  ].sort();
  check(
    "#452 pools: a `group` stage populates pool_id on every fixture (the shape #446 needs)",
    poolFixtures.length === 6 &&
      poolIds.length === 2 &&
      poolFixtures.every((f) => f.pool_id !== null),
  );
  const ofPool = (p: string): ConstraintFixtureLite[] =>
    poolFixtures
      .filter((f) => f.pool_id === p)
      .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
  const strictPool = poolIds[0]!;
  const laxPool = poolIds[1]!;
  const sf = ofPool(strictPool);
  const lf = ofPool(laxPool);

  // The #459 configuration in one object: a division floor, a pool entry ABOVE
  // it, and a pool entry of exactly zero. Under the shipped MAX rule the first
  // pool resolves to 90 and the second to 30 (the division floor, unchanged);
  // under the `??` precedence it replaced, the second would have resolved to 0
  // and ERASED the division rule.
  const DIVISION_REST = 30;
  const STRICT_POOL_REST = 90;
  const poolSettings = {
    config: {
      startAt: "2026-11-12T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
      constraints: {
        restByGroup: {
          [poolDiv.id]: DIVISION_REST,
          [strictPool]: STRICT_POOL_REST,
          [laxPool]: 0,
        },
      },
    },
    tz: "UTC",
  };
  const storedPool = v1data<{ config: { constraints?: { restByGroup?: Record<string, number> } } }>(
    await v1(s, `/api/v1/divisions/${poolDiv.id}/schedule-settings`, "PUT", poolSettings),
  );
  check(
    "#452 pools: a restByGroup carrying BOTH a division-keyed and a pool-keyed entry stores (#459)",
    storedPool?.config?.constraints?.restByGroup?.[poolDiv.id] === DIVISION_REST &&
      storedPool.config.constraints.restByGroup[strictPool] === STRICT_POOL_REST &&
      storedPool.config.constraints.restByGroup[laxPool] === 0,
  );

  // ---- Surface 1: the AUTO pass, both directions in ONE run ----
  // The placer resolves rest per fixture through `effectiveRestMinutes`, so the
  // strict pool must come out ≥ 90 minutes apart and the lax pool ≥ 30. Both
  // halves are asserted: the second is what fails if the pool entry were applied
  // division-wide, the first if it were dropped.
  const poolAuto = v1data<AutoOut>(
    await v1(s, `/api/v1/stages/${poolStage.id}/schedule/auto`, "POST", {}),
  );
  const MATCH_MS = 30 * 60 * 1000;
  const minPoolGapMinutes = (ids: readonly string[]): number => {
    const times = (poolAuto?.assignments ?? [])
      .filter((a) => ids.includes(a.fixture_id))
      .map((a) => Date.parse(a.scheduled_at))
      .sort((a, b) => a - b);
    let min = Infinity;
    for (let i = 1; i < times.length; i++) {
      min = Math.min(min, (times[i]! - (times[i - 1]! + MATCH_MS)) / 60000);
    }
    return min;
  };
  const strictAutoGap = minPoolGapMinutes(sf.map((f) => f.id));
  const laxAutoGap = minPoolGapMinutes(lf.map((f) => f.id));
  check(
    "#452 pools/auto: the placer honours the POOL rest (≥90) and not division-wide (lax pool <90)",
    (poolAuto?.assignments ?? []).length === 6 &&
      strictAutoGap >= STRICT_POOL_REST &&
      laxAutoGap >= DIVISION_REST &&
      laxAutoGap < STRICT_POOL_REST,
  );

  // ---- Surfaces 2 & 3: the APPLY gate and the board report ----
  const at = (hhmm: string) => `2026-11-12T${hhmm}:00.000Z`;
  // One court per pool, so nothing here can produce a court clash and every row
  // reported is a rest row. The third fixture of each pool sits at 14:00, clear
  // of both the others under either rule — so it is never expected to appear,
  // and its absence is what proves the reported set is the PAIR and not the pool.
  const poolBoard = (strictSecond: string, laxSecond: string) => ({
    assignments: [
      { fixture_id: sf[0]!.id, scheduled_at: at("09:00"), court_label: "A" },
      { fixture_id: sf[1]!.id, scheduled_at: strictSecond, court_label: "A" },
      { fixture_id: sf[2]!.id, scheduled_at: at("14:00"), court_label: "A" },
      { fixture_id: lf[0]!.id, scheduled_at: at("09:00"), court_label: "B" },
      { fixture_id: lf[1]!.id, scheduled_at: laxSecond, court_label: "B" },
      { fixture_id: lf[2]!.id, scheduled_at: at("14:00"), court_label: "B" },
    ],
  });
  const validatePools = async (): Promise<ScheduleConflictLite[]> =>
    v1data<{ conflicts: ScheduleConflictLite[] }>(
      await v1(s, `/api/v1/divisions/${poolDiv.id}/schedule/validate`, "POST"),
    )?.conflicts ?? [];

  // Strict pool: 60 minutes apart — clears the 30 division floor, short of the
  // 90 pool rule. Lax pool: 15 minutes — short of the 30 division floor.
  const shortRes = await v1(
    s,
    `/api/v1/stages/${poolStage.id}/schedule/apply`,
    "POST",
    poolBoard(at("10:30"), at("09:45")),
  );
  const shortApply = v1data<ApplyOut>(shortRes);
  const shortRest = idsWithCode(shortApply?.conflicts ?? [], "warn.rest");
  check(
    "#452 pools/apply: a POOL-keyed rest BINDS — 60 min inside a 90-min pool is short (#446)",
    shortRes.status === 200 &&
      shortApply?.applied === 6 &&
      shortRest.has(sf[0]!.id) &&
      shortRest.has(sf[1]!.id),
  );
  check(
    // The `??` precedence this replaced resolved the lax pool to 0 and dropped
    // the division rule entirely, so this pair came back clean.
    "#452 pools/apply: an explicit pool `0` ADDS NOTHING — the 30-min division floor still bites (#459)",
    shortRest.has(lf[0]!.id) && shortRest.has(lf[1]!.id),
  );
  check(
    "#452 pools/apply: ...and only the two short PAIRS are rested, not the whole pool",
    shortRest.size === 4 && !shortRest.has(sf[2]!.id) && !shortRest.has(lf[2]!.id),
  );
  const shortReport = idsWithCode(await validatePools(), "warn.rest");
  check(
    "#452 pools/board report: the board's own report names the same four cards",
    shortReport.size === 4 &&
      [sf[0]!, sf[1]!, lf[0]!, lf[1]!].every((f) => shortReport.has(f.id)),
  );

  // The twin. Strict pool at exactly 90 (a floor is `<`, so equal is legal), lax
  // pool at 60 — which the 90 rule would flag if it had leaked out of its pool.
  const clearRes = await v1(
    s,
    `/api/v1/stages/${poolStage.id}/schedule/apply`,
    "POST",
    poolBoard(at("11:00"), at("10:30")),
  );
  const clearApply = v1data<ApplyOut>(clearRes);
  const clearRest = idsWithCode(clearApply?.conflicts ?? [], "warn.rest");
  check(
    "#452 pools/apply: the pool rule is SILENT at exactly its 90 minutes (raises the floor, #459)",
    clearRes.status === 200 &&
      clearApply?.applied === 6 &&
      !clearRest.has(sf[0]!.id) &&
      !clearRest.has(sf[1]!.id),
  );
  check(
    "#452 pools/apply: the 90-min pool rule does NOT leak onto the other pool (60 clears its 30)",
    clearRest.size === 0,
  );

  // ---- Surface 4: the drag/keyboard move (PATCH → moveFixture) ----
  // `moveFixture` computes the conflicts but the PATCH response is the fixture
  // ROW, so the rule cannot be read off the drag's own reply. What the console
  // does after a drag is re-validate, and that is what is asserted here: the
  // drag is real (it moves the card and it is not refused, because rest never
  // blocks), and the pool rule follows the card in both directions.
  await v1(s, `/api/v1/fixtures/${sf[1]!.id}`, "PATCH", {
    scheduled_at: at("10:30"),
    court_label: "A",
  });
  const draggedIn = idsWithCode(await validatePools(), "warn.rest");
  check(
    "#452 pools/drag: dragging a card inside its pool's 90-min rest surfaces on re-validate (#446)",
    draggedIn.size === 2 && draggedIn.has(sf[0]!.id) && draggedIn.has(sf[1]!.id),
  );
  await v1(s, `/api/v1/fixtures/${sf[1]!.id}`, "PATCH", {
    scheduled_at: at("11:00"),
    court_label: "A",
  });
  check(
    "#452 pools/drag: ...and dragging it back out clears it again",
    idsWithCode(await validatePools(), "warn.rest").size === 0,
  );
}

/** design/v4 (Task 18): the AI Schedule Architect end-to-end over HTTP.
 *
 *  A fresh Pro Plus org walks the two-phase happy path — schedule ai-plan
 *  (proposal shape + a schedule.ai_generated ledger row stamping model/usage/
 *  cost_usd) → apply with the `ai` provenance block → ai-last recall → officials
 *  ai-plan with an EMPTY instruction (zero-token solver draft →
 *  schedule.ai_officials_generated stamped model "solver-draft"). A fresh
 *  community org proves the AI credit WALLET gate (v17 Phase 2, V320+): drain
 *  its wallet to 0 → the next run 402s at `ai.credits`, before any model
 *  spend, and topping the wallet back up (the wallet-model analog of the old
 *  admin entitlement override) admits the next run (→ 200).
 *
 *  The model is never real: the Task 17 fixture server echoes the pack's own
 *  deterministic draft, so a run is CLEAN by construction. Model-dependent steps
 *  run only when SCHEDULING_AI_BASE_URL is set — the server under test must be
 *  booted pointing at our fixture server (recipe in the Task 18 report). The cap
 *  402 is keyless-safe and always runs. officials.auto is Pro Plus (V290), so the
 *  happy path uses its own fresh pro_plus org rather than the passed pro org. */
async function v4AiSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  void admin;
  void proOrgId;
  void proOrgSlug;
  const aiConfigured = !!process.env.SCHEDULING_AI_BASE_URL;
  let fixture: AiFixtureServer | null = null;
  if (aiConfigured) {
    try {
      fixture = await startAiFixtureServer();
    } catch (e) {
      console.log(
        `v4 AI: fixture server failed to start (${(e as Error).message}); model paths skipped`,
      );
    }
  } else {
    console.log(
      "v4 AI: SCHEDULING_AI_BASE_URL unset — model-dependent AI checks skipped (the cap 402 still runs)",
    );
  }

  try {
    // ---- Free path: the AI credit wallet gate (keyless — 402 fires before any model) ----
    const free = newSession();
    const freeOrg = (await signIn(free, `smoke-ai-free-${tag}@example.com`)).org_id;
    const freeDivIds = await seedPlannableAiDivision(free, "AI Free");
    await drainWallet(freeOrg, 0);
    const capped = await v1(
      free,
      `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-plan`,
      "POST",
      {
        instruction: "spread the fixtures across both courts",
      },
    );
    check(
      "v4 AI/free: an AI run 402s once the wallet is exhausted (ai.credits)",
      capped.status === 402 &&
        (capped.json.error as { feature_key?: string } | undefined)?.feature_key === "ai.credits",
    );

    // W5 (#400): the preview spends no CREDIT, but it does spend our parse
    // tokens, so it carries the run's own affordability gate ahead of the
    // model. Keyless-safe for the same reason the run's 402 is: an org that
    // provably cannot pay is turned away before anything is called.
    const cappedPreview = await v1(
      free,
      `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-preview`,
      "POST",
      { instruction: "spread the fixtures across both courts" },
    );
    check(
      "W5 preview/free: an exhausted wallet 402s the preview before any model call (#400)",
      cappedPreview.status === 402 &&
        (cappedPreview.json.error as { feature_key?: string } | undefined)?.feature_key ===
          "ai.credits",
    );

    // ---- Topping the wallet back up admits the next run (needs model) ----
    await topUpWallet(freeOrg, 1);
    if (fixture) {
      const lifted = await v1(
        free,
        `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-plan`,
        "POST",
        {
          instruction: "spread the fixtures across both courts",
        },
      );
      check(
        "v4 AI/topup: crediting the wallet admits the next run (200 + proposal)",
        lifted.status === 200 && Array.isArray(v1data<AiPlanResponseLite>(lifted).proposal),
      );
    }

    // ---- Pro Plus two-phase happy path (schedule + officials) — needs the model ----
    if (fixture) {
      const plus = newSession();
      const plusOrg = (await signIn(plus, `smoke-ai-plus-${tag}@example.com`)).org_id;
      await setPlan(plusOrg, "pro_plus", plus);
      const { compId, divId, stageId } = await seedPlannableAiDivision(plus, "AI Plus");
      const firstRefId = v1data<{ id: string }>(
        await v1(plus, "/api/v1/officials", "POST", {
          display_name: `AI Ref ${tag}`,
          role_keys: ["referee"],
        }),
      ).id;

      // #398: carries a phrase the stage-1 compiler can turn into a typed rule
      // ("two matches per day"), so the pre-flight compile actually runs on this
      // path and its ledger line is not vacuously present.
      const instruction = "finish by 6pm, keep both courts busy, two matches per day";

      // ---- W5 (#400): the compiled-instruction preview, ahead of any run ----
      // The gate's whole claim is that an organiser can see the rules BEFORE a
      // credit moves, so the wallet is read either side of the call. The brief
      // is the one the fixture server compiles for real
      // (`FIXTURE_COMPILE_BRIEF`); against any other sentence the canned model
      // answers "nothing compiled", and `hard.length > 0` would be asserting
      // the fixture rather than the endpoint.
      const creditsBeforePreview = await walletBalance(plusOrg);
      const pv = await v1(plus, `/api/v1/divisions/${divId}/schedule/ai-preview`, "POST", {
        instruction: FIXTURE_COMPILE_BRIEF,
      });
      const preview = v1data<AiPreviewLite>(pv);
      check(
        "W5 preview: an instruction compiles to typed rules and a reusable id (#400)",
        pv.status === 200 &&
          preview.failed === false &&
          typeof preview.preview_id === "string" &&
          preview.compiled.hard.length > 0 &&
          preview.compiled.soft.length > 0 &&
          preview.compiled.unparsed.length > 0 &&
          // Resolved against the ORG clock, not left symbolic on the wire.
          preview.window !== null &&
          /^\d{4}-\d{2}-\d{2}$/.test(preview.window.start),
      );
      check(
        "W5 preview: compiling spends NO credit — the point of the gate (#400)",
        (await walletBalance(plusOrg)) === creditsBeforePreview,
      );
      // Unpriced, but never invisible: the compile has its own ledger line under
      // the same field names a run stamps (#387/#398).
      const previewEvent = await latestCompetitionEvent(compId, "schedule.ai_previewed");
      check(
        "W5 preview: the compile books its own unpriced ledger line (schedule.ai_previewed)",
        !!previewEvent &&
          typeof previewEvent.parse_tokens === "number" &&
          previewEvent.parse_tokens > 0 &&
          previewEvent.parse_failed === false,
      );
      // The reuse gate. A confirmation is a confirmation of THAT sentence: an
      // edited brief must be refused, not silently recompiled behind the
      // agreement the organiser already gave.
      const stale = await v1(plus, `/api/v1/divisions/${divId}/schedule/ai-plan`, "POST", {
        instruction: "a completely different sentence",
        preview_id: preview.preview_id,
        mode: "generate",
      });
      check(
        "W5 preview: a changed instruction 409s rather than recompiling behind the confirm (#400)",
        stale.status === 409,
      );
      check(
        "W5 preview: the refused reuse charged nothing either",
        (await walletBalance(plusOrg)) === creditsBeforePreview,
      );

      const planRes = await v1(plus, `/api/v1/divisions/${divId}/schedule/ai-plan`, "POST", {
        instruction,
        mode: "generate",
        officials_policy: { roles: ["referee"] },
      });
      const plan = v1data<AiPlanResponseLite>(planRes);
      check(
        "v4 AI/plus: schedule ai-plan returns a verified proposal (proposal + diff + usage + coverage)",
        planRes.status === 200 &&
          Array.isArray(plan.proposal) &&
          plan.proposal.length > 0 &&
          !!plan.diff &&
          typeof plan.summary === "string" &&
          !!plan.usage &&
          plan.officials_coverage !== undefined,
      );
      check(
        "v4 AI/plus: the fixture model served the schedule phase",
        fixture.calls.some((c) => c.phase === "schedule"),
      );
      // ---- #397: the pack's calendar anchor, over the one surface that shows
      // it. `tz`, `clock`, `window` and `sessionHours` are pack-internal and
      // never reach the wire — but the fixture model echoes the pack's own
      // `draft` back verbatim (ai-fixture-server.ts), so on this path every
      // `proposal` row IS a draft row and its time is the pack builder's
      // `zonedIso(…, orgTz)` output. That makes the draft the projection of tz
      // and window that HTTP can actually assert on.
      check(
        "v4 AI/anchor: every drafted time is written with a real zone offset (pack.tz, #397)",
        plan.proposal.length > 0 && plan.proposal.every((a) => zonedTime(a.scheduled_at)),
      );
      check(
        "v4 AI/anchor: no drafted time is stuck at the epoch (#397)",
        plan.proposal.length > 0 && !plan.proposal.some((a) => epochAnchored(a.scheduled_at)),
      );

      const genEvent = await latestCompetitionEvent(compId, "schedule.ai_generated");
      check(
        "v4 AI/plus: schedule.ai_generated ledger row stamps model + usage + cost_usd",
        !!genEvent &&
          typeof genEvent.model === "string" &&
          !!genEvent.usage &&
          typeof genEvent.cost_usd === "number",
      );

      // #398/#387: the compile runs OUTSIDE spendCredit, so its spend is
      // invisible unless it has its own ledger line. Asserted as a real number
      // rather than truthiness — 0 is a legitimate value and must still stamp.
      // This run's instruction is non-empty and the wallet is funded, so a
      // compile DID run: `parse_tokens` must be a real, positive number. `>= 0`
      // would pass on the "never attempted" stamp this check exists to catch.
      check(
        "v4 AI/parse: schedule.ai_generated carries the pre-flight compile on its own line (#398)",
        !!genEvent &&
          typeof genEvent.parse_tokens === "number" &&
          genEvent.parse_tokens > 0 &&
          genEvent.parse_failed === false,
      );
      // The parse must NOT be folded into what the credit bought, or
      // reconciliation double-counts it. `usage.output_tokens` is asserted
      // PRESENT — defaulting it to spent_tokens makes the comparison `x === x`.
      check(
        "v4 AI/parse: parse spend is NOT added into spent_tokens (#398)",
        !!genEvent &&
          typeof genEvent.spent_tokens === "number" &&
          typeof genEvent.usage?.output_tokens === "number" &&
          genEvent.spent_tokens === genEvent.usage.output_tokens,
      );

      // W6 (#401): the constraint solver runs before any LLM repair round. The
      // report is present on EVERY plan, including the ones where it had nothing
      // to do — "the field exists" is what makes its absence a detectable
      // regression rather than a silent revert to LLM-only repair.
      check(
        "v6 AI/repair: the plan carries a solver report (#401)",
        !!plan.repair && typeof plan.repair.solver_ran === "boolean",
      );
      // It must cost nothing. The solver is not metered, so a run that repaired
      // a board still bills exactly what the model used — if solver work ever
      // leaked into the ledger, spent_tokens would diverge from the model's own
      // output_tokens, which the check above already pins.
      check(
        "v6 AI/repair: a solver repair spends no credits and no tokens (#401)",
        !!genEvent &&
          typeof genEvent.spent_tokens === "number" &&
          genEvent.spent_tokens === genEvent.usage?.output_tokens,
      );
      // Whatever it reports must be internally consistent: it cannot claim to
      // have moved fixtures without having run, and it cannot claim proved
      // minimality without a move count to be minimal about.
      check(
        "v6 AI/repair: the report never claims work it did not do (#401)",
        !!plan.repair &&
          ((plan.repair.moved ?? 0) === 0 || plan.repair.solver_ran === true) &&
          (plan.repair.minimality !== "proved" || typeof plan.repair.moved === "number"),
      );

      const applied = await v1(plus, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
        assignments: plan.proposal.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
        source: "ai",
        ai: {
          instruction,
          summary: plan.summary,
          model: "claude-sonnet-5",
          repair_rounds: plan.usage.repair_rounds,
        },
      });
      check(
        "v4 AI/plus: applying the AI proposal writes the schedule (source ai)",
        applied.status === 200 && v1data<{ applied: number }>(applied).applied > 0,
      );

      const last = await v1(plus, `/api/v1/divisions/${divId}/schedule/ai-last`);
      const lastData = v1data<{
        last?: { instruction?: string } | null;
        runs?: { used?: number; max?: number | null };
      }>(last);
      check(
        "v4 AI/plus: ai-last recalls the applied instruction",
        last.status === 200 && lastData?.last?.instruction === instruction,
      );
      check(
        // v17 Phase 2 Task 5 (V322) retired the per-division run cap `runs.max`
        // used to resolve (pro_plus 50); the AI credit wallet meters spend
        // instead, so `runs.max` is now always null (lastAiApply, schedule.ts) —
        // `runs.used` still counts the same schedule.ai_generated rows.
        "v4 AI/plus: ai-last reports 1 run used and no per-division max (wallet-metered now)",
        lastData?.runs?.used === 1 && lastData?.runs?.max === null,
      );

      const offRes = await v1(plus, `/api/v1/divisions/${divId}/officials/ai-plan`, "POST", {
        instruction: "",
        policy: { roles: ["referee"] },
        // #387: what a confirm card would have shown. The empty-instruction
        // path is priced at a flat 1 credit, so 3 is a deliberate divergence —
        // the server must REPORT it and RECORD it, and must still return the
        // plan (this is telemetry, not a gate).
        quoted_credits: 3,
        schedule: plan.proposal.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
      });
      const off = v1data<{
        usage: {
          input_tokens: number;
          output_tokens: number;
          repair_rounds: number;
        };
        assignments: unknown[];
        credits?: number;
        quote_mismatch?: { quoted: number; charged: number };
      }>(offRes);
      check(
        "v4 AI/plus: officials ai-plan (empty instruction) returns a zero-token solver draft",
        offRes.status === 200 &&
          off.usage.input_tokens === 0 &&
          off.usage.output_tokens === 0 &&
          off.usage.repair_rounds === 0,
      );
      check(
        "v4 AI/plus: the empty-instruction officials run made NO model call",
        !fixture.calls.some((c) => c.phase === "officials"),
      );
      const offEvent = await latestCompetitionEvent(compId, "schedule.ai_officials_generated");
      check(
        'v4 AI/plus: schedule.ai_officials_generated ledger row stamps model "solver-draft"',
        !!offEvent && offEvent.model === "solver-draft",
      );

      // #387 — quote/charge reconciliation.
      check(
        "#387: the officials run reports the card's quote against what it charged",
        off.quote_mismatch?.quoted === 3 && off.quote_mismatch?.charged === off.credits,
      );
      check(
        "#387: a mismatch does not withhold the plan — it is telemetry, not a gate",
        offRes.status === 200 && off.assignments.length > 0,
      );
      const mismatchEvent = await latestCompetitionEvent(compId, "schedule.ai_quote_mismatch");
      check(
        "#387: the divergence is recorded on the competition ledger",
        !!mismatchEvent && mismatchEvent.quoted === 3 && mismatchEvent.charged === 1,
      );

      // ---- #384: an adopted candidate reaches the SOLVE, not just the diff ----
      //
      // Adopting a candidate with an empty instruction used to be discarded:
      // `prior.assignments` was consumed only as a diff baseline, so the plan
      // was re-derived from the solver and the organiser's click vanished —
      // while the diff, which DID read the prior, then reported their own
      // adoption as something the AI had changed.
      //
      // NOT VACUOUS BY CONSTRUCTION: a second referee is added and the run
      // above is used as the control, so the adopted official is deliberately
      // the one the solver did NOT choose for that slot. If the adoption were
      // dropped, the response would come back naming the control's pick.
      const secondRefId = v1data<{ id: string }>(
        await v1(plus, "/api/v1/officials", "POST", {
          display_name: `AI Ref B ${tag}`,
          role_keys: ["referee"],
        }),
      ).id;
      const officialsSchedule = plan.proposal.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      }));
      const control = v1data<{
        assignments: { fixtureId: string; officialId: string; roleKey: string }[];
      }>(
        await v1(plus, `/api/v1/divisions/${divId}/officials/ai-plan`, "POST", {
          instruction: "",
          policy: { roles: ["referee"] },
          schedule: officialsSchedule,
        }),
      );
      const target = control.assignments[0];
      const adoptedId = target?.officialId === secondRefId ? firstRefId : secondRefId;
      const adoptRes = await v1(plus, `/api/v1/divisions/${divId}/officials/ai-plan`, "POST", {
        instruction: "",
        policy: { roles: ["referee"] },
        schedule: officialsSchedule,
        prior: {
          instruction: "",
          assignments: control.assignments.map((a) =>
            a.fixtureId === target?.fixtureId && a.roleKey === target?.roleKey
              ? { ...a, officialId: adoptedId }
              : a,
          ),
        },
      });
      const adopt = v1data<{
        assignments: { fixtureId: string; officialId: string; roleKey: string }[];
        diff: { changed: string[]; unchanged: string[] };
      }>(adoptRes);
      const adoptedSlot = adopt.assignments.find(
        (a) => a.fixtureId === target?.fixtureId && a.roleKey === target?.roleKey,
      );
      check(
        "#384: an adopted official survives the empty-instruction solve",
        adoptRes.status === 200 && !!target && adoptedSlot?.officialId === adoptedId,
      );
      check(
        "#384: the organiser's own adoption is not reported as AI-changed",
        !!target && !adopt.diff.changed.includes(target.fixtureId),
      );
      check(
        "#384: every other slot still comes back filled (an adopt does not blank the grid)",
        adopt.assignments.length === control.assignments.length,
      );

      // ---- #396: a to-be-decided bracket slot is checked against everyone who
      // could still reach it ----
      //
      // `refine`, not `generate`, on purpose. Refine takes the organiser's own
      // prior as the draft (schedule-ai.ts), the fixture model echoes it back,
      // and person_overlap is a WARNING rather than a blocker — so nothing
      // between here and the response is free to move the two cards apart. The
      // board handed over deliberately plays the final and the third-place
      // playoff at the same moment: legal on every rule that reads named
      // entrants (both slots are still null), unsafe on the four people who can
      // still reach them. Before #396 this run came back silent; the assertion
      // below is the difference, and it reds if the recursion behind the null
      // slots is removed, because an undecided fixture then carries no people
      // at all.
      const bracket = await seedBracketAiDivision(plus, "AI Bracket");
      const tbdIds = new Set(
        bracket.fixtures
          .filter((f) => f.home_entrant_id === null && f.away_entrant_id === null)
          .map((f) => f.id),
      );
      const decided = bracket.fixtures.filter(
        (f) => f.home_entrant_id !== null && f.away_entrant_id !== null,
      );
      const clashingPrior = [
        ...decided.map((f, i) => ({
          fixture_id: f.id,
          scheduled_at: "2026-10-08T09:00:00.000Z",
          court_label: i === 0 ? "A" : "B",
        })),
        ...[...tbdIds].map((id, i) => ({
          fixture_id: id,
          scheduled_at: "2026-10-08T09:30:00.000Z",
          court_label: i === 0 ? "A" : "B",
        })),
      ];
      const refinedRes = await v1(
        plus,
        `/api/v1/divisions/${bracket.divId}/schedule/ai-plan`,
        "POST",
        {
          instruction: "keep these kick-off times, they suit the venue",
          mode: "refine",
          prior: { instruction: "the organiser's own timetable", assignments: clashingPrior },
        },
      );
      const refined = v1data<AiPlanResponseLite>(refinedRes);
      const placedTbd = (refined?.proposal ?? []).filter((a) => tbdIds.has(a.fixture_id));
      // W6 (#401) CHANGED THIS OUTCOME, and the change is the point.
      //
      // These two checks used to assert that the clashing prior SURVIVED to the
      // response, on the stated premise that it was "unrepairable". That premise
      // was true only while nothing could repair it. The z3 solver now runs
      // before the model is asked again, so the organiser is no longer shown a
      // board that puts one human on two courts at once.
      //
      // Both fixtures are still placed — the clash is resolved by MOVING one, not
      // by dropping either. The guards below keep this from going vacuous in the
      // other direction: a plan that simply lost a fixture would also produce
      // "no two fixtures in one slot".
      check(
        "v4 AI/bracket: refine REPAIRS the clashing prior instead of shipping it (#401)",
        refinedRes.status === 200 &&
          tbdIds.size === 2 &&
          placedTbd.length === 2 &&
          placedTbd[0]!.scheduled_at !== placedTbd[1]!.scheduled_at,
      );
      check(
        // The solver's own report is the evidence that the repair happened here
        // rather than the fixture model having quietly returned something else.
        // `moved === 1` is the minimality claim in its smallest observable form:
        // two fixtures collide, exactly one has to move, and the engine proves
        // no smaller change exists.
        "v4 AI/bracket: ...by moving exactly ONE fixture, proved minimal (#401)",
        refined?.repair?.solver_ran === true &&
          refined.repair.status === "repaired" &&
          refined.repair.moved === 1 &&
          refined.repair.minimality === "proved",
      );
      check(
        // #399 promoted person_overlap out of `warnings` and into `blocking`: a
        // human on two courts at once is impossible, so the runner asks for a
        // repair instead of shipping it. That classification is still what drives
        // this — the solver only repairs BLOCKING families — but the outcome is
        // now the repair, so what survives to the organiser is nothing.
        "v4 AI/bracket: the person_overlap that blocked is GONE from the response (#396, #399, #401)",
        (refined?.blocking ?? []).every(
          (w) => !(w.reason === "person_overlap" && tbdIds.has(w.fixtureId)),
        ) && (refined?.repair?.unresolved ?? 0) === 0,
      );

      // ---- #397: the division with NO configured start date ----
      //
      // The board this wave exists for. Every division seeded above carries a
      // `startAt`, so none of them can red on the actual defect: with no start
      // date the pack drafted from `toSlotConfig(settings, 0)` and handed the
      // model 1970-01-01 for every fixture. The window now opens at today in
      // the organisation zone and the draft anchors on its first session hour,
      // so a drafted date must be today or later. Read, again, through the
      // proposal — the pack's own draft echoed back by the fixture model.
      //
      // Topped up first: this is one more metered run on the plus wallet, and
      // an `ai.credits` 402 here would look like an anchor regression.
      await topUpWallet(plusOrg, 3);
      const undated = await seedPlannableAiDivision(plus, "AI Undated", null);
      const undatedRes = await v1(
        plus,
        `/api/v1/divisions/${undated.divId}/schedule/ai-plan`,
        "POST",
        { instruction: "spread the fixtures across both courts", mode: "generate" },
      );
      const undatedTimes = (v1data<AiPlanResponseLite>(undatedRes)?.proposal ?? []).map(
        (a) => a.scheduled_at,
      );
      check(
        "v4 AI/anchor: a division with NO start date still drafts zoned, non-epoch times (#397)",
        undatedRes.status === 200 &&
          undatedTimes.length > 0 &&
          undatedTimes.every((t) => zonedTime(t)) &&
          !undatedTimes.some((t) => epochAnchored(t)),
      );
      check(
        "v4 AI/anchor: its window opens today, not at the epoch — nothing drafted before yesterday (#397)",
        undatedTimes.length > 0 && undatedTimes.every((t) => t.slice(0, 10) >= yesterdayUtcYmd()),
      );
    }
  } finally {
    await fixture?.close();
  }
}

/** One competition with TWO plannable divisions sharing the SAME court names.
 *  Shared courts are the whole point of a joint run — cross-division court
 *  identity is a string match and nothing else — so both divisions carry the
 *  same two labels rather than two disjoint sets. */
async function seedJointAiCompetition(
  s: Session,
  label: string,
): Promise<{ compId: string; divIds: string[] }> {
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${tag}` }),
  );
  const divIds: string[] = [];
  for (const name of ["Joint A", "Joint B"]) {
    const div = v1data<{ id: string }>(
      await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
    await v1(
      s,
      `/api/v1/divisions/${div.id}/entrants`,
      "POST",
      ["P", "Q", "R", "S"].map((n, i) => ({
        kind: "individual",
        display_name: `${name} ${n}${tag}`,
        seed: i + 1,
      })),
    );
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-11-02T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["Court 1", "Court 2"],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST");
    divIds.push(div.id);
  }
  return { compId: comp.id, divIds };
}

interface JointPlanLite {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string; division_id: string }[];
  summary: string;
  credits: number;
  discount: number;
  budget: number;
  divergent_courts: string[];
  divisions: { id: string; name: string; movable: number; rung: number; predicted_rung: number }[];
}

/**
 * #350 — multi-division JOINT AI scheduling over HTTP, on the two numbers a
 * customer can be overcharged by.
 *
 * Both are asserted against LITERALS rather than against anything the response
 * also supplies. A check that reads `credits` back out of the payload it is
 * validating proves the field exists, not that the batch discount was applied,
 * and the discount is exactly the arithmetic a support ticket is about. So the
 * rungs are FORCED with `rung_overrides` (2 and 3 — the predictor ships
 * uncalibrated, and a smoke seed's own prediction would drift the day it is
 * retuned), and the expectations are hand-computed:
 *
 *   rungTotal 5  →  charged max(1, 5−1) = 4 credits, discount 1
 *   budget       →  tokenBudgetForCredits(5) = 128K + 32K×2 = 192K, sized from the
 *                   UNDISCOUNTED total, so the batch discount is a price cut and
 *                   never a capability cut (#350 amendment)
 *
 * The insufficient-balance leg is KEYLESS-SAFE and runs with or without a
 * model, because the refusal has to happen before the model is ever called. It
 * asserts the fixture server's call log did not grow, which is the only way to
 * tell "refused before spending" from "spent, then refused".
 *
 * Rate limit: the joint endpoint allows 3 runs an hour per COMPETITION, and
 * this suite now makes exactly THREE rate-limited requests (the 402, the W5
 * preview and the real run) — the single-division 400 is refused before the
 * limiter. That is the ceiling, not room under it: a fourth would 429, so a new
 * joint call here needs one of these three to go, or a second competition.
 */
async function jointAiSuite(): Promise<void> {
  const aiConfigured = !!process.env.SCHEDULING_AI_BASE_URL;
  let fixture: AiFixtureServer | null = null;
  if (aiConfigured) {
    try {
      fixture = await startAiFixtureServer();
    } catch (e) {
      console.log(
        `#350 joint AI: fixture server failed to start (${(e as Error).message}); the priced run is skipped`,
      );
    }
  } else {
    console.log(
      "#350 joint AI: SCHEDULING_AI_BASE_URL unset — the priced run is skipped (the 400 and the 402 still run)",
    );
  }

  try {
    const s = newSession();
    const orgId = (await signIn(s, `smoke-ai-joint-${tag}@example.com`)).org_id;
    // scheduling.multi_division is Pro and above; Pro Plus matches the sibling
    // AI suite and keeps the grant comfortably above the 4 credits below.
    await setPlan(orgId, "pro_plus", s);
    const { compId, divIds } = await seedJointAiCompetition(s, "Joint AI");
    const instruction = "keep both divisions off each other's courts and finish by 6pm";
    const rung_overrides = { [divIds[0]!]: 2, [divIds[1]!]: 3 };

    // ---- One division is not a joint run: refused before the limiter ----
    const single = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-plan`, "POST", {
      division_ids: [divIds[0]],
      instruction,
    });
    check(
      "#350 joint/gate: a one-division joint request is refused 400 AI_PLAN_SINGLE_DIVISION (no discount arbitrage)",
      single.status === 400 &&
        (single.json.error as { code?: string } | undefined)?.code === "AI_PLAN_SINGLE_DIVISION",
    );

    // ---- Insufficient balance: refused BEFORE the model, not after ----
    await drainWallet(orgId, 3); // the run below costs 4
    const callsBeforeRefusal = fixture?.calls.length ?? 0;
    const poor = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-plan`, "POST", {
      division_ids: divIds,
      instruction,
      rung_overrides,
    });
    check(
      "#350 joint/credits: a wallet holding 3 credits cannot start a 4-credit joint run (402 ai.credits)",
      poor.status === 402 &&
        (poor.json.error as { feature_key?: string } | undefined)?.feature_key === "ai.credits",
    );
    // GUARDED, not `(fixture?.calls.length ?? 0) === callsBeforeRefusal`: that
    // form reads 0 on both sides with no fixture server and reports PASS for a
    // property it never tested. A check that passes when it cannot run is worse
    // than no check — it occupies the slot a real one would fill.
    if (fixture) {
      check(
        "#350 joint/credits: the refusal happened before any model call",
        fixture.calls.length === callsBeforeRefusal,
      );
    }

    if (!fixture) return;

    // ---- The priced run ----
    await topUpWallet(orgId, 20);
    const balanceBefore = await walletBalance(orgId);

    // W5 (#400): the same gate over a JOINT scope. It is priced from the same
    // `rung_overrides` the run will use — a preview that priced itself at the
    // prediction would refuse (or admit) a run nobody was about to make — and
    // it moves no money.
    const jointPreview = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-preview`, "POST", {
      division_ids: divIds,
      instruction: FIXTURE_COMPILE_BRIEF,
      rung_overrides,
    });
    const jpv = v1data<AiPreviewLite>(jointPreview);
    check(
      "W5 preview/joint: a joint instruction compiles over both divisions without spending (#400)",
      jointPreview.status === 200 &&
        jpv.failed === false &&
        typeof jpv.preview_id === "string" &&
        jpv.compiled.hard.length > 0 &&
        (await walletBalance(orgId)) === balanceBefore,
    );

    const runRes = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-plan`, "POST", {
      division_ids: divIds,
      instruction,
      rung_overrides,
    });
    const plan = v1data<JointPlanLite>(runRes);
    check(
      "#350 joint/run: a joint plan returns placements for BOTH divisions in one run",
      runRes.status === 200 &&
        Array.isArray(plan.proposal) &&
        new Set(plan.proposal.map((p) => p.division_id)).size === 2,
    );
    check(
      "#350 joint/price: rungs 2+3 are charged max(1, 5−1) = 4 credits with a 1-credit batch discount",
      plan.credits === 4 && plan.discount === 1,
    );
    check(
      "#350 joint/price: the budget is sized from the UNDISCOUNTED total (5 credits → 192K), not the 4 charged (which buys 160K)",
      plan.budget === 192_000,
    );
    check(
      "#350 joint/price: the breakdown names each division with the rung it was priced at",
      plan.divisions.length === 2 &&
        plan.divisions.every((d) => divIds.includes(d.id) && d.movable > 0 && !!d.name) &&
        plan.divisions
          .map((d) => d.rung)
          .sort()
          .join(",") === "2,3",
    );
    check(
      "#350 joint/price: the wallet actually moved by the 4 credits quoted",
      (await walletBalance(orgId)) === balanceBefore - 4,
    );
    check(
      "#350 joint/courts: two divisions on the same court names report no divergence",
      plan.divergent_courts.length === 0,
    );

    const jointEvent = await latestCompetitionEvent(compId, "schedule.ai_generated_multi");
    check(
      "#350 joint/ledger: the joint run books its own event type with model + usage + cost_usd",
      !!jointEvent &&
        typeof jointEvent.model === "string" &&
        !!jointEvent.usage &&
        typeof jointEvent.cost_usd === "number",
    );

    // ---- Atomic apply across both divisions ----
    const seqs = await divisionSeqs(divIds);
    const byDivision = divIds.map((id) => ({
      division_id: id,
      expected_seq: seqs[id] ?? 0,
      assignments: plan.proposal
        .filter((p) => p.division_id === id)
        .map((p) => ({
          fixture_id: p.fixture_id,
          scheduled_at: p.scheduled_at,
          court_label: p.court_label,
        })),
    }));
    const applied = await v1(s, `/api/v1/competitions/${compId}/schedule/apply`, "POST", {
      divisions: byDivision,
      source: "ai",
      ai: {
        instruction,
        summary: plan.summary,
        model: "claude-sonnet-5",
        repair_rounds: 0,
      },
    });
    check(
      "#350 joint/apply: one request writes every division's board",
      applied.status === 200 &&
        v1data<{ applied: number }>(applied).applied ===
          byDivision.reduce((n, d) => n + d.assignments.length, 0),
    );
    // EXACT counts, not `> 0`. A partial board is precisely what the atomic
    // apply exists to prevent, and `> 0` cannot see one — it only catches a
    // division that got nothing at all. The expected number per division is
    // already in hand as that division's own assignment list.
    const scheduled = await scheduledCountsByDivision(divIds);
    check(
      "#350 joint/apply: every division came out with its WHOLE board, not a partial one",
      byDivision.every((d) => (scheduled[d.division_id] ?? 0) === d.assignments.length) &&
        byDivision.every((d) => d.assignments.length > 0),
    );

    const last = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-last`);
    check(
      "#350 joint/ai-last: the competition recalls the applied joint instruction",
      last.status === 200 &&
        v1data<{ last?: { instruction?: string } | null }>(last)?.last?.instruction === instruction,
    );
  } finally {
    await fixture?.close();
  }
}

/** Each division's current optimistic-concurrency token. The joint apply
 *  REQUIRES one per division: a joint write that skipped the check on one would
 *  let a stale board silently overwrite a concurrent edit there while every
 *  other division was guarded. */
async function divisionSeqs(divisionIds: string[]): Promise<Record<string, number>> {
  const sql = smokeDb();
  try {
    const rows = await sql<{ division_id: string; seq: number }[]>`
      select division_id, coalesce(max(seq), 0)::int as seq
        from division_events
       where division_id = any(${divisionIds}::uuid[])
       group by division_id`;
    const out: Record<string, number> = {};
    for (const id of divisionIds) out[id] = 0;
    for (const r of rows) out[r.division_id] = r.seq;
    return out;
  } finally {
    await sql.end();
  }
}

/** Fixtures carrying a slot, per division — the apply's actual effect on the
 *  board, rather than the count it reported about itself. */
async function scheduledCountsByDivision(divisionIds: string[]): Promise<Record<string, number>> {
  const sql = smokeDb();
  try {
    const rows = await sql<{ division_id: string; n: number }[]>`
      select division_id, count(*)::int as n
        from fixtures
       where division_id = any(${divisionIds}::uuid[])
         and scheduled_at is not null
       group by division_id`;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.division_id] = r.n;
    return out;
  } finally {
    await sql.end();
  }
}

/** pro-plus-tier (Task 11, spec §1): community's per-fixture-official cap
 *  (1) and save-point cap (1) 402, api.write (any write-capable key scope —
 *  score or manage) is re-armed above Pro — Pro's read-only keys stay free
 *  but a score- or manage-scope key still needs Pro Plus — and Pro Plus
 *  lifts both quotas plus both key scopes. Runs
 *  on its own fresh community owner (never touches org/org2 from main()),
 *  but still restores the org's own plan at the end (shared-DB poison trap:
 *  leave a flipped org as found in case a later suite lands above this one). */
async function proPlusSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `proplus_${tag}@example.com`);
  const orgId = who.org_id;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Plus Probe ${tag}`,
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: `Plus A ${tag}`, seed: 1 },
    { kind: "individual", display_name: `Plus B ${tag}`, seed: 2 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const gen = await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST");
  const fixtureId = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[0]!.id;
  await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");

  // (a) Community: officials are ungated on every plan (#253, V319 —
  // officials.per_fixture.max is now unlimited), so a 2nd distinct official on
  // the SAME fixture is allowed (200), not refused.
  const offA = v1data<{ id: string }>(
    await v1(owner, "/api/v1/officials", "POST", {
      display_name: `Plus Ref A ${tag}`,
      role_keys: ["referee"],
    }),
  );
  const offB = v1data<{ id: string }>(
    await v1(owner, "/api/v1/officials", "POST", {
      display_name: `Plus Ref B ${tag}`,
      role_keys: ["referee"],
    }),
  );
  const setTwoOfficials = () =>
    v1(owner, `/api/v1/fixtures/${fixtureId}/officials`, "PATCH", {
      set: [
        { official_id: offA.id, role_key: "referee", locked: false },
        { official_id: offB.id, role_key: "referee", locked: false },
      ],
    });
  const officialsAllowed = await setTwoOfficials();
  check(
    "pp: community allows a 2nd official on one fixture (officials.per_fixture.max ungated #253)",
    officialsAllowed.status === 200,
  );

  // (a) Community: save points — community's window is 2 wide (V319). The 1st
  // and 2nd land silently; since #382 the 3rd ROLLS rather than 402ing, and the
  // response names the label it replaced.
  const cp1Label = `plus 1 ${tag}`;
  const cp1 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: cp1Label,
  });
  check("pp: community's first save point is free", cp1.status === 201);
  const cp2 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `plus 2 ${tag}`,
  });
  check("pp: community's second save point is free (cap is 2)", cp2.status === 201);
  const cp3Rolled = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `plus 3 ${tag}`,
  });
  check(
    "pp: community's 3rd save point rolls the window and names what it replaced (#382)",
    cp3Rolled.status === 201 &&
      (cp3Rolled.json.data as { evicted?: { label?: string } } | undefined)?.evicted?.label ===
        cp1Label,
  );
  const cpList = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "GET");
  check(
    "pp: community holds exactly 2 manual save points after the roll",
    ((cpList.json.data as { kind?: string }[] | undefined) ?? []).filter(
      (r) => (r.kind ?? "manual") === "manual",
    ).length === 2,
  );

  // (b) Pro: read-only keys stay free (api.access), but a score- or
  // manage-scope key still needs Pro Plus — V290 re-arms the above-Pro rung
  // (api.write).
  await setPlan(orgId, "pro", owner);
  const proScoreKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "plus score",
    scopes: ["score"],
  });
  check(
    "pp: pro 402s a score-scope key (api.write is Pro Plus only)",
    proScoreKey.status === 402 &&
      (proScoreKey.json.error as { feature_key?: string } | undefined)?.feature_key === "api.write",
  );
  const proManageKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "plus manage",
    scopes: ["manage"],
  });
  check(
    "pp: pro 402s a manage-scope key (api.write is Pro Plus only)",
    proManageKey.status === 402 &&
      (proManageKey.json.error as { feature_key?: string } | undefined)?.feature_key ===
        "api.write",
  );

  // (c) Pro Plus: both quota gates lift and both write-capable key scopes mint.
  await setPlan(orgId, "pro_plus", owner);
  const officialsOk = await setTwoOfficials();
  check("pp: pro_plus lifts officials.per_fixture.max", officialsOk.status === 200);
  const cp3 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `plus 3 ${tag}`,
  });
  check("pp: pro_plus lifts schedule.checkpoints.max", cp3.status === 201);
  const plusManageKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "plus manage",
    scopes: ["manage"],
  });
  check("pp: pro_plus mints a manage-scope key", plusManageKey.status === 201);

  // (d) /pricing renders the matrix marker + the Pro Plus offer — marketing
  // never drifts from what the resolver enforces (spec §5).
  const pricing = await html(newSession(), "/en/pricing");
  check(
    "pp: /pricing carries the comparison table + Pro Plus offer",
    pricing.status === 200 &&
      pricing.body.includes("data-pricing-matrix") &&
      pricing.body.includes("Pro Plus"),
  );
  // T84: the three v16 league-ops entitlements (discipline, marks, auto
  // news) are surfaced on the Pro card + comparison matrix, not just gated.
  check(
    "pp: /pricing surfaces the v16 league-ops entitlements",
    pricing.body.includes("Suspensions &amp; discipline tracking") &&
      pricing.body.includes("Automatic suspension tracking"),
  );

  // Restore: this org is never touched by another suite in main(), but leave
  // it as found in case a later suite lands above this one (poison trap).
  await setPlan(orgId, "community", owner);
}

/** PROMPT-36 (v3/07 §2–3): the plan matrix v3 + Event Pass, free → pass →
 *  pro → downgrade, on a fresh community owner. */
async function pricingV3Suite(): Promise<void> {
  const genericDivision = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  const buyer = newSession();
  const who = await signIn(buyer, `pass_${tag}@example.com`);
  const orgId = who.org_id;

  // Free caps (v17 matrix, V319 "free runs big"): community now runs several
  // active competitions, with 4 divisions inside each (was 2). The pass lifts
  // the per-competition DIVISION cap — that is the boundary this test drives.
  const compA = v1data<{ id: string; slug: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Pass Cup ${tag}`,
    }),
  );
  const secondComp = await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Second Cup ${tag}`,
  });
  check("p36: 2nd active competition allowed on free (community runs several)", secondComp.status === 201);
  for (const name of ["Div 1", "Div 2", "Div 3", "Div 4"]) {
    const d = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
      name,
      ...genericDivision,
    });
    check(`p36: free org creates ${name.toLowerCase()}`, d.status === 201);
  }
  const div5Blocked = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 5",
    ...genericDivision,
  });
  check("p36: 5th division blocked on free (402, community's cap is 4)", div5Blocked.status === 402);

  // Event Pass on comp A lifts ITS per-competition caps — the 5th division it
  // just refused now lands.
  await grantPass(orgId, compA.id, "event_pass");
  const div5 = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 5",
    ...genericDivision,
  });
  check("p36: pass lifts division cap on the passed comp", div5.status === 201);
  const compB = v1data<{ id: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sibling Cup ${tag}`,
    }),
  );
  check("p36: a sibling competition is created (community runs several)", !!compB.id);

  // …while the sibling competition — no pass — stays on the community DIVISION
  // cap (4), proving the pass is scoped to comp A and not the org.
  for (const name of ["S1", "S2", "S3", "S4"]) {
    await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
      name,
      ...genericDivision,
    });
  }
  const sibBlocked = await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
    name: "S5",
    ...genericDivision,
  });
  check("p36: sibling comp still community-capped (402)", sibBlocked.status === 402);

  // Pro org buying a pass is pointless — the route refuses before Stripe.
  await setPlan(orgId, "pro", buyer);
  const proBuy = await raw(buyer, "/api/billing/pass-checkout", "POST", {
    competition_id: compB.id,
  });
  check("p36: pass purchase blocked on Pro (400)", proBuy.status === 400);
  const sibUnderPro = await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
    name: "S5",
    ...genericDivision,
  });
  check("p36: pro lifts the sibling comp", sibUnderPro.status === 201);

  // Downgrade: the pass survives — comp A keeps its 10-division headroom.
  await setPlan(orgId, "community", buyer);
  const afterDowngrade = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 6",
    ...genericDivision,
  });
  check("p36: pass survives downgrade (comp A still lifted)", afterDowngrade.status === 201);

  // The upgrade page reflects the pass state.
  const [orgRow] = (await call(buyer, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const upgradePage = await html(buyer, `/o/${orgRow.slug}/c/${compA.slug}/upgrade`);
  check(
    "p36: upgrade page shows pass active",
    upgradePage.status === 200 && renderedAttr(upgradePage.body, "data-pass-active"),
  );

  // v17 gap #301: finish compA's competition and prove every surface stops
  // calling its pass "active". The row is untouched, so anything still reading
  // row existence alone keeps saying active and fails here — which is exactly
  // the defect, and the reason these are integration checks rather than more
  // unit tests: each surface passed its own tests while disagreeing with the
  // resolver.
  await endCompetition(compA.id);

  const upgradeEnded = await html(buyer, `/o/${orgRow.slug}/c/${compA.slug}/upgrade`);
  // Three separate checks, deliberately. The first version ANDed all three into
  // one boolean and failed in CI without saying WHICH part failed — the same
  // "reports less than it knows" defect this wave keeps finding in guards.
  //
  // All marker checks go through `renderedAttr`, never `body.includes(name)`:
  // the flight payload carries the prop NAME in both states (see its doc), so a
  // bare-name check passed here in the wrong state and failed in the right one.
  check(
    `p301: the upgrade page still renders for a finished competition (got ${upgradeEnded.status})`,
    upgradeEnded.status === 200,
  );
  check(
    "p301: upgrade page marks the pass ENDED once its competition finished",
    renderedAttr(upgradeEnded.body, "data-pass-ended"),
  );
  check(
    "p301: upgrade page drops the ACTIVE marker once its competition finished",
    !renderedAttr(upgradeEnded.body, "data-pass-active"),
  );

  const dashboardEnded = await html(buyer, `/o/${orgRow.slug}`);
  check(
    "p301: dashboard card seal shows ENDED once its competition finished",
    dashboardEnded.status === 200 && renderedAttr(dashboardEnded.body, "data-pass-ended"),
  );
  check(
    "p301: dashboard card seal drops the HELD marker once its competition finished",
    !renderedAttr(dashboardEnded.body, "data-pass-held"),
  );

  const billingEnded = await html(buyer, `/o/${orgRow.slug}/settings/billing`);
  check(
    "p301: billing page marks the purchase ended and does not re-offer that competition",
    billingEnded.status === 200 &&
      billingEnded.body.includes('data-pass-status="ended"') &&
      !billingEnded.body.includes(`href="/o/${orgRow.slug}/c/${compA.slug}/upgrade"`),
  );

  const rebuyEnded = await raw(buyer, "/api/billing/pass-checkout", "POST", {
    competition_id: compA.id,
  });
  check(
    "p301: re-buying an ENDED pass still 400s, with the sentence that is true in both states",
    rebuyEnded.status === 400 &&
      typeof rebuyEnded.json.error === "string" &&
      /on file/i.test(rebuyEnded.json.error),
  );
}

/** PROMPT-36 (v3/07 §6): /start funnel — draft → dev claim link → signed in
 *  inside the created competition; the token is single-use. */
// --- PROMPT-40 marketing redesign: matchday-arc home, public format-preview
// API, /scheduling page (free path — no session anywhere).
async function i18nSuite(): Promise<void> {
  const fr = await fetch(`${BASE}/fr/start`);
  const frHtml = await fr.text();
  check("i18n: /fr/start 200", fr.status === 200);
  check("i18n: /fr/start renders French", frHtml.includes("Lancez votre comp"));

  const en = await fetch(`${BASE}/en/start`);
  const enHtml = await en.text();
  check("i18n: /en/start renders English", enHtml.includes("Start your competition"));

  const bare = await fetch(`${BASE}/start`, { redirect: "manual" });
  check("i18n: /start rewrites to en (200, no redirect)", bare.status === 200);

  const bad = await fetch(`${BASE}/de/start`);
  check("i18n: unsupported locale 404s", bad.status === 404);

  // Scoring vocab (2026-07-16): sport names on the public /discover chips now
  // localize (sport.<key>). Gate on the en page actually showing the chip so
  // the assertion is robust to whichever sports are seeded as discoverable.
  const enDisc = await fetch(`${BASE}/en/discover`);
  const enDiscHtml = await enDisc.text();
  const frDisc = await fetch(`${BASE}/fr/discover`);
  const frDiscHtml = await frDisc.text();
  check("i18n: /fr/discover 200", frDisc.status === 200);
  if (enDiscHtml.includes("Board game")) {
    check(
      "i18n: /fr/discover localizes the 'Board game' sport name",
      !frDiscHtml.includes("Board game"),
    );
  } else {
    check("i18n: /discover has no boardgame seed to assert (skipped)", true);
  }

  const enHome = await fetch(`${BASE}/en`);
  const enHomeHtml = await enHome.text();
  check("i18n: /en home English", enHomeHtml.includes("Any sport. Live in minutes."));

  const frHome = await fetch(`${BASE}/fr`);
  const frHomeHtml = await frHome.text();
  check("i18n: /fr home French", frHomeHtml.includes("importe quel sport"));

  const root = await fetch(`${BASE}/`, { redirect: "manual" });
  check("i18n: / rewrites to en home (200, no redirect)", root.status === 200);

  // Email localization end-to-end (spec cycle 46): a user whose stored locale is
  // French gets the French transactional templates. change-email renders the
  // subject+html+text from the fr emails dict server-side before sending, so a
  // missing key or broken {placeholder} would surface as a 500 here. Emails are
  // not tier-gated, so this exercises the path for free and pro accounts alike.
  const mailer = newSession();
  await signIn(mailer, `i18nmail_${tag}@example.com`);
  await call(mailer, "/api/users/me", "PATCH", { locale: "fr" });
  const chg = await raw(mailer, "/api/auth/change-email", "POST", {
    new_email: `i18nmail2_${tag}@example.com`,
  });
  check("i18n: fr-locale user renders French change-email server-side", chg.status === 200);

  // Console chrome (spec cycle 46): the shared authed nav resolves the same
  // fr locale (cookie → user.locale) and renders from the `console` dict. The
  // signed-in mailer has locale=fr, so its nav shows the French Dashboard label.
  const chrome = await html(mailer, "/directory");
  check(
    "i18n: fr-locale user sees translated console chrome (nav)",
    chrome.status === 200 && chrome.body.includes("Tableau de bord"),
  );
}

async function marketingSuite(): Promise<void> {
  const home = await fetch(`${BASE}/`, { redirect: "manual" });
  const html = await home.text();
  check("marketing: home 200", home.status === 200);
  check("marketing: home has The Draw", html.includes("The Draw"));
  check("marketing: home has funnel form", html.includes("data-start-funnel"));
  check("marketing: home SSR default draw", html.includes("GROUP STAGE"));

  const preview = await fetch(`${BASE}/api/public/format-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "groups-knockout", entrants: 8 }),
  });
  const body = (await preview.json()) as {
    ok?: boolean;
    data?: { phases?: Array<{ sections: unknown[] }> };
  };
  check("marketing: format-preview 200", preview.status === 200);
  check("marketing: format-preview two phases", body.data?.phases?.length === 2);

  const sched = await fetch(`${BASE}/scheduling`);
  const shtml = await sched.text();
  check("marketing: /scheduling 200", sched.status === 200);
  check("marketing: /scheduling has rundown", shtml.includes("Order of play"));
}

async function funnelSuite(): Promise<void> {
  const visitor = newSession();
  const started = (await call(visitor, "/api/funnel/start", "POST", {
    email: `funnel_${tag}@example.com`,
    name: `Funnel Fiesta ${tag}`,
    sport: "Badminton",
    entrants: 8,
  })) as { claim_url?: string };
  check("funnel: draft created with dev claim_url", !!started.claim_url);

  const token = new URL(started.claim_url ?? "").searchParams.get("token");
  const claimed = (await call(visitor, "/api/funnel/claim", "POST", {
    token,
  })) as {
    redirect: string;
  };
  check(
    "funnel: claim lands inside the competition (entrants tab)",
    /^\/o\/[^/]+\/c\/funnel-fiesta[^/]*\/d\/[^/?]+\?tab=entrants$/.test(claimed.redirect),
  );
  check("funnel: claim started a session", !!visitor.cookies["seazn_session"]);
  const landing = await html(visitor, claimed.redirect);
  check(
    "funnel: landing page renders the new competition",
    landing.status === 200 && landing.body.includes(`Funnel Fiesta ${tag}`),
  );

  // Single-use: a second consume fails cleanly.
  const again = await raw(visitor, "/api/funnel/claim", "POST", { token });
  check("funnel: claim token is single-use", again.json.ok === false);
}

/** Fetch a page WITHOUT following redirects — for 301 assertions (PROMPT-30). */
async function pageRedirect(
  s: Session,
  path: string,
): Promise<{ status: number; location: string | null }> {
  const res = await fetch(BASE + path, {
    redirect: "manual",
    headers: Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {},
  });
  return { status: res.status, location: res.headers.get("location") };
}

/** Fetch a page as HTML with the session's cookies (raw() assumes JSON). */
async function html(s: Session, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(BASE + path, {
    headers: Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {},
  });
  return { status: res.status, body: await res.text() };
}

/** v10 sponsor CRM smoke: tiered manager + public placement + tracked click
 *  on the pro org; free path keeps the flat partner strip and gets 402 on
 *  tiers/packages. Checkout runs the order-first Connect rail; keyless envs
 *  assert the 409 gate + order insert (webhook activation is unit-tested —
 *  smoke can't complete a hosted card payment). */
async function sponsorsSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  // --- Pro path: tiers, per-competition scoping, placement, click tracking.
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sponsor Cup ${tag}`,
      visibility: "public",
    }),
  );
  const gold = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Goldco ${tag}`,
    tier: "gold",
    url: "https://goldco.example",
  });
  check("sp pro creates a gold sponsor", gold.status === 201);
  const goldId = v1data<{ id: string }>(gold).id;
  const scoped = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Cup Title ${tag}`,
    tier: "title",
    competition_id: comp.id,
  });
  check("sp pro creates a competition-scoped title sponsor", scoped.status === 201);

  const shared = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}`);
  check(
    "sp public page renders the perimeter board (title leads)",
    shared.status === 200 &&
      shared.body.includes("Presented by") &&
      shared.body.includes(`Cup Title ${tag}`) &&
      shared.body.includes(`Goldco ${tag}`),
  );
  check("sp public logo links via tracked redirect", shared.body.includes(`/s/${goldId}`));

  const click = await pageRedirect(newSession(), `/s/${goldId}`);
  // Response.redirect normalizes the URL (adds the trailing slash).
  check(
    "sp click 302s to the sponsor url",
    click.status === 302 && (click.location ?? "").startsWith("https://goldco.example"),
  );
  // The bump is deferred() tail work — it lands after the 302 by design, so
  // poll briefly instead of racing it (CI runners lose the instant read).
  let clicked = false;
  for (let i = 0; i < 10 && !clicked; i++) {
    const afterClick = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`);
    clicked =
      v1data<{ id: string; click_count: number }[]>(afterClick).find((s) => s.id === goldId)
        ?.click_count === 1;
    if (!clicked) await new Promise((r) => setTimeout(r, 300));
  }
  check("sp click_count incremented", clicked);

  // --- Monetization: package + order-first Connect checkout.
  const pkgRes = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-packages`, "POST", {
    name: `Gold Package ${tag}`,
    price_cents: 25_000,
    currency: "gbp",
    tier: "gold",
  });
  check("sp pro creates a package", pkgRes.status === 201);
  const pkg = v1data<{ id: string }>(pkgRes);

  // Connect gate: same refusal as entry fees, before any order row exists.
  await setConnect(proOrgId, false);
  const gated = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id,
    sponsor_name: "Gate Probe",
    sponsor_email: `gate_${tag}@example.com`,
  });
  check("sp checkout refused without Connect (409)", gated.status === 409);
  // The one org in the run that gets a REAL connected account, when supplied —
  // stripe_account_id is UNIQUE, so it can only ever be handed to one.
  await setConnect(proOrgId, true, CONNECT_TEST_ACCOUNT);

  const started = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id,
    sponsor_name: `Acme ${tag}`,
    sponsor_email: `acme_${tag}@example.com`,
  });
  if (!process.env.STRIPE_SECRET_KEY) {
    // Keyless: the Stripe mint fails AFTER the pending order landed — the
    // order-before-intent rail is still observable below.
    check("sp checkout keyless fails after the order insert", started.status >= 500);
  } else if (!CONNECT_TEST_ACCOUNT) {
    // Keyed but destination-less. A secret key is NOT a proxy for "Connect is
    // usable": the checkout sends setConnect's fabricated acct_smoke_* as
    // transfer_data.destination, which Stripe rejects with resource_missing,
    // so 201 is unreachable no matter how valid the key is. Skip (counting the
    // check, same convention as paymentMethodSuite) rather than assert a
    // failure the fixture — not the app — causes.
    check(
      "sp checkout: skipped (no STRIPE_CONNECT_TEST_ACCOUNT — destination charge needs a real connected account)",
      true,
    );
  } else {
    check(
      "sp checkout starts (order + session url)",
      started.status === 201 && !!v1data<{ checkout_url: string }>(started).checkout_url,
    );
  }
  const orders = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`);
  check(
    "sp order row landed pending (order-before-intent)",
    orders.status === 200 &&
      v1data<{ status: string; sponsor_name: string }[]>(orders).some(
        (o) => o.status === "pending" && o.sponsor_name === `Acme ${tag}`,
      ),
  );

  // --- Free path: flat partner strip stays free; tiers + packages are 402.
  const free = newSession();
  const freeVer = await signIn(free, `sponsor_free_${tag}@example.com`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sponsor Free ${tag}`,
      visibility: "public",
    }),
  );
  const partner = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: `Corner Shop ${tag}`,
    url: "https://corner.example",
  });
  check("sp free adds a partner sponsor", partner.status === 201);
  const freeGold = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: "Blocked Gold",
    tier: "gold",
  });
  check("sp free tiering gated (402)", freeGold.status === 402);
  const freeShared = await html(newSession(), `/shared/${freeOrg.slug}/${freeComp.slug}`);
  check(
    "sp free strip renders publicly, un-tiered",
    freeShared.status === 200 &&
      freeShared.body.includes(`Corner Shop ${tag}`) &&
      !freeShared.body.includes("Presented by"),
  );
  const freePkg = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsor-packages`, "POST", {
    name: "Blocked Package",
    price_cents: 1_000,
    currency: "gbp",
    tier: "partner",
  });
  check("sp free packages gated (402)", freePkg.status === 402);
}

/** PROMPT-32 smoke: match-day cards render server-side and the visibility
 *  keys flip end-to-end (share page live + noindex) on pro AND free orgs. */
async function uiSystemSuite(admin: Session, proOrgSlug: string): Promise<void> {
  // Pro path (admin's active org is the pro org2).
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `UI Cards ${tag}`,
      visibility: "private",
    }),
  );
  const dash = await html(admin, "/dashboard");
  check("dashboard renders card grid (pro)", dash.status === 200 && dash.body.includes("ecard"));
  check("card carries status chip", dash.body.includes('data-chip="draft"'));
  check("console dashboard renders English by default", dash.body.includes("Matchday console"));

  // v5 i18n cycle 47: the console renders in the viewer's locale. Same page with
  // seazn_locale=fr → the English eyebrow is gone, the French one is present.
  const frDash = await html({ cookies: { ...admin.cookies, seazn_locale: "fr" } }, "/dashboard");
  check(
    "console dashboard localizes to French (ui catalog)",
    frDash.status === 200 &&
      frDash.body.includes("Console de jour de match") &&
      !frDash.body.includes("Matchday console"),
  );

  const flip = await v1(admin, `/api/v1/competitions/${comp.id}`, "PATCH", {
    visibility: "unlisted",
  });
  check("visibility flips to Link only (pro)", flip.status === 200);
  const shared = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}`);
  check("link-only page serves (pro)", shared.status === 200);
  check("link-only page keeps noindex", shared.body.includes("noindex"));

  // Free path: fresh community owner, same flow.
  const free = newSession();
  const freeVer = await signIn(free, `ui_free_${tag}@example.com`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `UI Cards Free ${tag}`,
      visibility: "private",
    }),
  );
  const freeDash = await html(free, "/dashboard");
  check(
    "dashboard renders card grid (free)",
    freeDash.status === 200 && freeDash.body.includes("ecard"),
  );
  // PROMPT-30 free path: slug console URL serves for community orgs too.
  const freeConsole = await html(free, `/o/${freeOrg.slug}/c/${freeComp.slug}`);
  check("console competition page serves (free)", freeConsole.status === 200);
  const freeFlip = await v1(free, `/api/v1/competitions/${freeComp.id}`, "PATCH", {
    visibility: "unlisted",
  });
  check("visibility flips to Link only (free)", freeFlip.status === 200);
  const freeShared = await html(newSession(), `/shared/${freeOrg.slug}/${freeComp.slug}`);
  check(
    "link-only page serves + noindex (free)",
    freeShared.status === 200 && freeShared.body.includes("noindex"),
  );

  // --- v3/11 in-app billing: the portal is dead by default, the manage
  // endpoints exist behind owner auth and degrade cleanly without a Stripe
  // customer, and the billing page renders with no portal button. ---
  const portalDead = await raw(admin, "/api/billing/portal", "POST", {});
  check("v3/11 portal route 404s without the fallback flag (pro)", portalDead.status === 404);
  const proSetup = await raw(admin, "/api/billing/setup-intent", "POST", {});
  check(
    "v3/11 setup-intent wants a Stripe customer first (comped pro)",
    proSetup.status === 400 && !!proSetup.json.error?.includes("billing account"),
  );
  const proPreview = await raw(admin, "/api/billing/interval/preview?interval=annual");
  check("v3/11 interval preview wants a Stripe customer first (pro)", proPreview.status === 400);
  // Developer API keys must never reach billing: /api/billing/* is session-
  // cookie auth only (never reads Authorization), lives outside /api/v1 and
  // the OpenAPI surface. A Bearer token without a session is a plain 401.
  const bearerOnly = await fetch(`${BASE}/api/billing/setup-intent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer sc_smoke_fake_key",
    },
    body: "{}",
  });
  check(
    "v3/11 API keys can't touch billing routes (401, header ignored)",
    bearerOnly.status === 401,
  );
  const proBilling = await html(admin, `/o/${proOrgSlug}/settings/billing`);
  check(
    "v3/11 billing page renders without the portal button (pro)",
    proBilling.status === 200 &&
      proBilling.body.includes("Plan &amp; Billing") &&
      !proBilling.body.includes("Manage billing →"),
  );
  check(
    "v3/11 manage sections stay hidden without a Stripe customer (pro)",
    // Check the rendered section, not the bare label: the /o DictProvider
    // serializes the whole `ui` dict (incl. "billing.paymentMethods") into the
    // page's flight payload, so the localized string is always present in body.
    !proBilling.body.includes('id="payment-methods"'),
  );
  // Product tour: the Billing and Connect steps highlight real anchors — the
  // plan card on billing, the Stripe card on payments (owner-only).
  check(
    "product tour: billing step anchor present (pro)",
    proBilling.body.includes('data-tour="billing-plan"'),
  );
  const proPayments = await html(admin, `/o/${proOrgSlug}/settings/connect`);
  check(
    "product tour: Connect step anchor present on Connect settings (owner)",
    proPayments.status === 200 && proPayments.body.includes('data-tour="connect-stripe"'),
  );
  // Rename regression (2026-07-18): the old Payments URL must forward to
  // Connect — fetch follows the redirect, so the anchor proves the landing.
  const legacyPayments = await html(admin, `/o/${proOrgSlug}/settings/payments?connect=return`);
  check(
    "legacy /settings/payments redirects to Connect (query preserved)",
    legacyPayments.status === 200 && legacyPayments.body.includes('data-tour="connect-stripe"'),
  );
  const freeCancel = await raw(free, "/api/billing/cancel", "POST", {});
  check("v3/11 cancel wants a Stripe customer first (free)", freeCancel.status === 400);
  const proAddress = await raw(admin, "/api/billing/address", "POST", {
    address: {
      line1: "1 Test Way",
      city: "London",
      postal_code: "SW1A 1AA",
      country: "GB",
    },
  });
  check("v3/11 address update wants a Stripe customer first (pro)", proAddress.status === 400);
  const freePromo = await raw(free, "/api/billing/promo", "POST", {
    code: "NOPE",
  });
  check("v3/11 promo apply wants a Stripe customer first (free)", freePromo.status === 400);
  const freeBilling = await html(free, `/o/${freeOrg.slug}/settings/billing`);
  check(
    "v3/11 billing page renders upgrade path, no portal (free)",
    freeBilling.status === 200 &&
      freeBilling.body.includes("Upgrade to Pro") &&
      !freeBilling.body.includes("Manage billing →"),
  );
  check(
    "product tour: billing step anchor present (free)",
    freeBilling.body.includes('data-tour="billing-plan"'),
  );
}

/** PROMPT-33/34 smoke: board v3 renders + a seq-tokened reschedule lands and
 *  a stale token 409s (pro); registration issues an SZ ref and /r/[ref]
 *  resolves it on pro AND free orgs (house rule). */
async function schedRegV3Suite(
  admin: Session,
  proOrgSlug: string,
  proOrgId: string,
): Promise<void> {
  // --- Pro path: competition + division + timetable + board page ---
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sched v3 ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Boarded",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "S1", seed: 1 },
    { kind: "individual", display_name: "S2", seed: 2 },
    { kind: "individual", display_name: "S3", seed: 3 },
    { kind: "individual", display_name: "S4", seed: 4 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  // V305: no `tz` in the body — the console never sends one. The venue zone
  // comes from the ORGANISATION and is inherited by every division.
  await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-01T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });

  // Org scheduling timezone (V305): set it once on the org, and the division
  // that stores no tz of its own reports it. Then pin the division explicitly
  // and prove a tz-less save no longer moves it (pre-V305 divisions keep
  // their zone forever), before restoring inheritance with an explicit null.
  await call(admin, `/api/orgs/${proOrgId}`, "PATCH", {
    timezone: "Europe/Madrid",
  });
  const inherited = v1data<{ tz: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`),
  );
  check("division inherits the org scheduling timezone (V305)", inherited.tz === "Europe/Madrid");
  await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-01T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "Asia/Kolkata",
  });
  const kept = v1data<{ tz: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-10-01T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["A", "B"],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    }),
  );
  check("a tz-less save keeps a division's own timezone (V305)", kept.tz === "Asia/Kolkata");
  const recleared = v1data<{ tz: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-10-01T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["A", "B"],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: null,
    }),
  );
  check("tz: null clears back to inheriting the org zone (V305)", recleared.tz === "Europe/Madrid");
  // Restore: the rest of this suite (and every later suite on this org)
  // assumes UTC wall clocks.
  await call(admin, `/api/orgs/${proOrgId}`, "PATCH", { timezone: null });

  const gen = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  );
  const fixture = gen.fixtures[0]!.id;

  const board = await html(admin, `/o/${proOrgSlug}/c/${comp.slug}/schedule`);
  check(
    "sched board v3 renders (pro)",
    board.status === 200 && board.body.includes("Board density"),
  );

  // Matchday documents (v12 PR1, Task 9): timetable PDF export renders a
  // real PDF for this division's fixtures. It renders REAL PDFs, so assert
  // validity via magic bytes + content-type, not literal text (font
  // subsetting encodes glyph IDs, not characters) — the branded-vs-plain
  // visual proof is the Task 18 gallery, not a byte assertion.
  const docPdf = await fetch(`${BASE}/api/v1/divisions/${div.id}/exports/timetable?format=pdf`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const docPdfBytes = Buffer.from(await docPdf.arrayBuffer());
  check(
    "exports timetable PDF renders a valid branded PDF (pro)",
    docPdf.status === 200 &&
      (docPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      docPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      docPdfBytes.byteLength > 1024,
  );

  // Matchday documents (v12, Task 17): the officials rota only emits duty
  // rows for fixtures carrying a live assignment (buildOfficialsRotaDoc
  // reads fixture_officials joined to still-scheduled fixtures) — assign one
  // before hitting the export so it renders the real content path, not just
  // the empty masthead. Same official/assign shape as the officials-unify
  // suite: POST /officials → PATCH the fixture's officials.
  const docOfficial = v1data<{ id: string }>(
    await v1(admin, "/api/v1/officials", "POST", {
      display_name: `Doc Umpire ${tag}`,
      role_keys: ["referee"],
    }),
  );
  const assignDocOfficial = await v1(admin, `/api/v1/fixtures/${fixture}/officials`, "PATCH", {
    set: [{ official_id: docOfficial.id, role_key: "referee", locked: false }],
  });
  check("doc-export official assigned to a fixture", assignDocOfficial.status === 200);
  const rotaPdf = await fetch(
    `${BASE}/api/v1/divisions/${div.id}/exports/officials_rota?format=pdf`,
    { headers: { cookie: cookieHeader(admin) } },
  );
  const rotaPdfBytes = Buffer.from(await rotaPdf.arrayBuffer());
  check(
    "exports officials rota PDF renders a valid PDF with a real duty row (pro)",
    rotaPdf.status === 200 &&
      (rotaPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      rotaPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      rotaPdfBytes.byteLength > 1024,
  );

  // Reschedule with the current division seq — lands; replaying the same
  // (now stale) token 409s with SEQ_CONFLICT (v3/11 gap 10).
  const seq0 = v1data<{ seq: number }>(await v1(admin, `/api/v1/divisions/${div.id}`)).seq;
  const move = await v1(admin, `/api/v1/fixtures/${fixture}`, "PATCH", {
    scheduled_at: "2026-10-01T09:00:00.000Z",
    court_label: "A",
    expected_seq: Number(seq0),
  });
  check("sched seq-tokened reschedule lands", move.status === 200);
  const stale = await v1(admin, `/api/v1/fixtures/${fixture}`, "PATCH", {
    scheduled_at: "2026-10-01T10:00:00.000Z",
    court_label: "A",
    expected_seq: Number(seq0),
  });
  check(
    "sched stale seq 409s with SEQ_CONFLICT",
    stale.status === 409 && stale.json.error?.code === "SEQ_CONFLICT",
  );

  // Registration → SZ ref → public /r/[ref] page (pro org).
  await v1(admin, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });
  const reg = await v1(
    newSession(),
    `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      division_id: div.id,
      display_name: `Ref Probe ${tag}`,
      contact_email: `refprobe_${tag}@example.com`,
      privacy_consent: true,
    },
  );
  const regData = v1data<{
    registration_id: string;
    status: string;
    ref_code: string;
  }>(reg);
  check(
    "reg issues an SZ ref (pro)",
    reg.status === 201 && /^SZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(regData.ref_code ?? ""),
  );
  const refPage = await html(newSession(), `/r/${regData.ref_code}`);
  check(
    "reg /r/[ref] resolves (pro)",
    refPage.status === 200 && refPage.body.includes(regData.ref_code),
  );
  // Save-ticket PNG (next/og) renders for the same ref.
  const png = await fetch(`${BASE}/r/${regData.ref_code}/ticket.png`);
  check(
    "reg ticket.png renders (pro)",
    png.status === 200 && (png.headers.get("content-type") ?? "").startsWith("image/png"),
  );

  // Matchday documents (v12, Task 17): admit tickets only render a section
  // per CONFIRMED registration with a ref_code (buildAdmitTicketsDoc filters
  // status = 'confirmed') — the fresh submission above is still 'pending',
  // so confirm it first, then hit the export to exercise the real
  // ticket/QR/masked-name render path, not just the empty masthead.
  const confirmRegForTicket = await v1(
    admin,
    `/api/v1/registrations/${regData.registration_id}/confirm`,
    "POST",
    {},
  );
  check(
    "reg confirmed ahead of the tickets export (pro)",
    confirmRegForTicket.status === 200 || confirmRegForTicket.status === 201,
  );
  const ticketsPdf = await fetch(
    `${BASE}/api/v1/competitions/${comp.id}/exports/tickets?format=pdf`,
    { headers: { cookie: cookieHeader(admin) } },
  );
  const ticketsPdfBytes = Buffer.from(await ticketsPdf.arrayBuffer());
  check(
    "exports admit tickets PDF renders a valid PDF with a real ticket (pro)",
    ticketsPdf.status === 200 &&
      (ticketsPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      ticketsPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      ticketsPdfBytes.byteLength > 1024,
  );

  // Honeypot: a filled `website` field is rejected before any work.
  const honey = await v1(
    newSession(),
    `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      division_id: div.id,
      display_name: "Bot Entry",
      contact_email: `bot_${tag}@example.com`,
      website: "https://spam.example",
    },
  );
  check("reg honeypot rejects bots (400)", honey.status === 400);

  // GDPR (spec 2026-07-14): a submission without privacy consent is refused.
  const noConsent = await v1(
    newSession(),
    `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      division_id: div.id,
      display_name: `No Consent ${tag}`,
      contact_email: `noconsent_${tag}@example.com`,
    },
  );
  check("reg without privacy consent refused (422)", noConsent.status === 422);

  // --- Dual payments (spec 2026-07-12): offline mark-paid + card gates (pro) ---
  const payDiv = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Paid Offline",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${payDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 1500,
    currency: "gbp",
    form_fields: [],
    payment_method: "offline",
    payment_instructions: `Cash desk ${tag}`,
  });
  const offReg = await v1(
    newSession(),
    `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      division_id: payDiv.id,
      display_name: `Cash Payer ${tag}`,
      contact_email: `cash_${tag}@example.com`,
      privacy_consent: true,
    },
  );
  const offRegData = v1data<{
    registration_id: string;
    checkout_url: string | null;
  }>(offReg);
  check(
    "pay offline submit: pending, no checkout",
    offReg.status === 201 && offRegData.checkout_url === null,
  );
  const confirmEarly = await v1(
    admin,
    `/api/v1/registrations/${offRegData.registration_id}/confirm`,
    "POST",
    {},
  );
  check("pay unpaid confirm blocked (422)", confirmEarly.status === 422);
  const markPaid = await v1(
    admin,
    `/api/v1/registrations/${offRegData.registration_id}/mark-paid`,
    "POST",
    {},
  );
  const markPaidData = v1data<{
    status: string;
    offline_marked_paid_at: string | null;
  }>(markPaid);
  check(
    "pay mark-paid confirms entry",
    markPaid.status === 200 &&
      markPaidData.status === "confirmed" &&
      !!markPaidData.offline_marked_paid_at,
  );

  // Card method gates: rejected without Connect, accepted once flipped.
  const cardPutNoConnect = await v1(
    admin,
    `/api/v1/divisions/${payDiv.id}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      currency: "gbp",
      form_fields: [],
      payment_method: "stripe",
    },
  );
  check("pay card method needs Connect (422)", cardPutNoConnect.status === 422);
  await setConnect(proOrgId, true);
  const cardPut = await v1(admin, `/api/v1/divisions/${payDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
    payment_method: "stripe",
  });
  check("pay card method saves with Connect", cardPut.status === 200);
  const cardReg = await v1(
    newSession(),
    `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      division_id: payDiv.id,
      display_name: `Card Payer ${tag}`,
      contact_email: `card_${tag}@example.com`,
      privacy_consent: true,
    },
  );
  const cardRegData = v1data<{ registration_id: string; status: string }>(cardReg);
  // No Stripe key in smoke: the session mint fails gracefully — the row still
  // lands pending with a 48h window (pay-later from the status page).
  check(
    "pay card submit holds a pending spot",
    cardReg.status === 201 && cardRegData.status === "pending",
  );
  const waived = await v1(
    admin,
    `/api/v1/registrations/${cardRegData.registration_id}/waive`,
    "POST",
    {},
  );
  check(
    "pay waive confirms without payment",
    waived.status === 200 && v1data<{ status: string }>(waived).status === "confirmed",
  );
  await setConnect(proOrgId, false);

  // --- Free path: fresh community owner, registration + ref lookup ---
  const free = newSession();
  const freeVer = await signIn(free, `sched_free_${tag}@example.com`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const fComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sched Free ${tag}`,
      visibility: "public",
    }),
  );
  const fDiv = v1data<{ id: string; slug: string }>(
    await v1(free, `/api/v1/competitions/${fComp.id}/divisions`, "POST", {
      name: "Free Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });
  const fReg = await v1(
    newSession(),
    `/api/v1/public/orgs/${freeOrg.slug}/competitions/${fComp.slug}/register`,
    "POST",
    {
      division_id: fDiv.id,
      display_name: `Free Ref ${tag}`,
      contact_email: `freeref_${tag}@example.com`,
      privacy_consent: true,
    },
  );
  const fRegData = v1data<{ ref_code: string }>(fReg);
  check(
    "reg issues an SZ ref (free)",
    fReg.status === 201 && /^SZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(fRegData.ref_code ?? ""),
  );
  const fRefPage = await html(newSession(), `/r/${fRegData.ref_code}`);
  check(
    "reg /r/[ref] resolves (free)",
    fRefPage.status === 200 && fRefPage.body.includes(fRegData.ref_code),
  );
  // Community sees the division fixtures page (schedule list) fine.
  const fFixtures = await html(
    free,
    `/o/${freeOrg.slug}/c/${fComp.slug}/d/${fDiv.slug}?tab=fixtures`,
  );
  check("division fixtures page renders (free)", fFixtures.status === 200);

  // Dual payments on community: offline fees were always plan-free, and since
  // V310 (registration.paid on every plan) the CARD method is free too — the
  // platform monetises it through the higher community fee (8% vs pro's 2%),
  // not by gating it. It still requires Connect, so it is refused UNTIL Connect
  // is live, then allowed.
  const fOffline = await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
    payment_method: "offline",
  });
  check("pay offline fee allowed on community", fOffline.status === 200);
  await setConnect(freeVer.org_id, true);
  const fCard = await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
    payment_method: "stripe",
  });
  check("pay card method allowed on community once Connect is live (V310)", fCard.status === 200);
  await setConnect(freeVer.org_id, false);
}

// v1 responses: { ok, data | error: {code, message, …}, requestId }.
interface V1Res {
  status: number;
  headers: Headers;
  json: {
    ok: boolean;
    data?: unknown;
    error?: {
      code?: string;
      message?: string;
      current_seq?: number;
      /** Blocking schedule conflicts ride the 409 body (doc 12 §2, #399). */
      conflicts?: { rule?: string; blocking?: boolean; code?: string }[];
    };
    requestId?: string;
  };
}
async function v1(
  s: Session,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<V1Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as V1Res["json"];
  return { status: res.status, headers: res.headers, json };
}
const v1data = <T>(r: V1Res): T => r.json.data as T;

/**
 * Exercise the whole /api/v1 lifecycle over real HTTP (PROMPT-11 §7):
 * auth'd CRUD, generate, scoring append + concurrency + void, public reads,
 * API-key auth and the 402 entitlement gate.
 */
async function v1Suite(admin: Session, orgId: string, orgSlug: string): Promise<void> {
  // The division needs the sport catalog; seed the generic sport directly when
  // we have DB access (CI runs sync:sports, so this is a local-run fallback).
  const dbUrl = process.env.DATABASE_URL;
  const db = dbUrl
    ? postgres(dbUrl, {
        connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
        ssl:
          process.env.DATABASE_SSL === "disable"
            ? false
            : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
              ? false
              : "require",
        prepare: !dbUrl.includes(":6543"),
        max: 1,
      })
    : null;
  const genericConfig = {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  };
  if (db) {
    await db`insert into sports (key, name, module_version, position_catalog)
             values ('generic', 'Generic', '1.0.0', ${db.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
             on conflict (key) do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('generic', 'score', 'Score', ${db.json(genericConfig)}, true)
             on conflict do nothing`;
  }

  // CRUD happy path: competition → division → entrants (bulk) → stage → generate.
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `V1 Cup ${tag}`,
    visibility: "public",
  });
  check(
    "v1 create competition → 201 + envelope",
    comp.status === 201 && comp.json.ok === true && !!comp.json.requestId,
  );
  const compId = v1data<{ id: string; slug: string }>(comp).id;
  const compSlug = v1data<{ id: string; slug: string }>(comp).slug;

  const list = await v1(admin, "/api/v1/competitions?limit=1");
  check(
    "v1 list paginates",
    list.status === 200 && Array.isArray(v1data<{ items: unknown[] }>(list).items),
  );

  const div = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    // The 'score' preset is partial; the module schema requires the rest.
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  check(
    "v1 create division pins module version",
    div.status === 201 && !!v1data<{ module_version: string }>(div).module_version,
  );
  const divId = v1data<{ id: string; slug: string }>(div).id;
  const divSlug = v1data<{ id: string; slug: string }>(div).slug;

  const entrants = await v1(
    admin,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  check(
    "v1 bulk entrants registered",
    entrants.status === 201 && v1data<unknown[]>(entrants).length === 4,
  );

  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const stageId = v1data<{ id: string }>(stage).id;

  const gen1 = await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST");
  const gen2 = await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST");
  check("v1 generate creates 6 RR fixtures", v1data<{ created: number }>(gen1).created === 6);
  check(
    "v1 generate is idempotent",
    v1data<{ created: number; existing: number }>(gen2).created === 0,
  );
  const fixtures = v1data<{ fixtures: { id: string }[] }>(gen1).fixtures;

  // --- PROMPT-30: slug console routes + legacy 301s ---
  const consolePage = await html(admin, `/o/${orgSlug}/c/${compSlug}/d/${divSlug}`);
  check("console division page serves on slug URL", consolePage.status === 200);
  const fixturePage = await html(admin, `/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/1`);
  check("fixture ordinal page serves (/f/1)", fixturePage.status === 200);
  const legacy = await pageRedirect(admin, `/divisions/${divId}`);
  check(
    "legacy /divisions/[id] 301s to the slug chain",
    legacy.status >= 301 &&
      legacy.status <= 308 &&
      (legacy.location ?? "").includes(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}`),
  );

  // Scheduling console (doc 12, PROMPT-17): scoring is closed until the
  // explicit start; auto pass proposes without persisting; start opens scoring.
  const fx = fixtures[0].id;
  const early = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  check(
    "v1 scoring before start → 422 WRONG_PHASE",
    early.status === 422 && early.json.error?.code === "WRONG_PHASE",
  );
  const auto = await v1(admin, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  check(
    "v1 schedule/auto proposes all fixtures",
    v1data<{ assignments: unknown[] }>(auto).assignments.length === 6,
  );

  // --- #399 W4: blocking is DELTA-based ------------------------------------
  // Persist the proposal, then prove both halves of the rule against the live
  // API: a move that INTRODUCES a person double-booking is refused, and the
  // board it left behind is still editable.
  {
    const assignments = v1data<
      { assignments: { fixture_id: string; scheduled_at: string; court_label: string }[] }
    >(auto).assignments;
    const applyRes = await v1(admin, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
      assignments: assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      // "auto", not "manual": a manual apply is board editing and needs the Pro
      // `scheduling.board` key, and this section runs on a community org.
      source: "auto",
    });
    check(
      "v1 W4: the clean proposal applies with nothing blocking",
      applyRes.status === 200 &&
        v1data<{ conflicts: { blocking: boolean }[] }>(applyRes).conflicts.every(
          (c) => !c.blocking,
        ),
    );
    // Four entrants, one round robin. Round 1's two fixtures cover all four
    // entrants, so ANY later-round fixture shares an entrant with each of them.
    // The auto pass emits in round order, so [0] and [2] are always such a pair.
    // Same instant, DIFFERENT court — the only defect is the human.
    const anchor = assignments[0]!;
    const sharer = assignments[2]!;
    const clash = await v1(admin, `/api/v1/fixtures/${sharer.fixture_id}`, "PATCH", {
      scheduled_at: anchor.scheduled_at,
      court_label: "Court 9",
    });
    check(
      "v1 W4: a move that introduces a clash → 409 SCHEDULE_CONFLICT",
      clash.status === 409 && clash.json.error?.code === "SCHEDULE_CONFLICT",
    );
    check(
      "v1 W4: the refusal names the rule the AI prompt teaches",
      (clash.json.error?.conflicts ?? []).some((c) => !!c.rule && c.blocking === true),
    );
    // And the board still moves: the refusal was about the change, not the board.
    const legal = await v1(admin, `/api/v1/fixtures/${sharer.fixture_id}`, "PATCH", {
      court_label: "Court 9",
    });
    check("v1 W4: an unrelated edit on the same board still applies", legal.status === 200);
  }
  const startRes = await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");
  check("v1 division start → active", v1data<{ status: string }>(startRes).status === "active");

  // Scoring: append, optimistic-concurrency 409 (parallel scorers), void.
  const started = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  check(
    "v1 scoring append → 201 with seq",
    started.status === 201 && v1data<{ seq: number }>(started).seq === 1,
  );

  const race = await Promise.all([
    v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: 1,
      type: "core.note",
      payload: { text: "a" },
    }),
    v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: 1,
      type: "core.note",
      payload: { text: "b" },
    }),
  ]);
  const won = race.filter((r) => r.status === 201);
  const lost = race.filter((r) => r.status === 409);
  check("v1 parallel scorers: one 201, one 409", won.length === 1 && lost.length === 1);
  check("v1 409 carries current_seq", lost[0]?.json.error?.current_seq === 2);
  check("v1 409 code is SEQ_CONFLICT", lost[0]?.json.error?.code === "SEQ_CONFLICT");

  // Losing scorer resyncs from its seq and replays.
  const resync = await v1(admin, `/api/v1/fixtures/${fx}/events?since_seq=1`);
  check(
    "v1 events since_seq resyncs",
    resync.status === 200 && v1data<unknown[]>(resync).length === 1,
  );

  // Undo: void the note through the same path.
  const events = v1data<{ id: string; seq: number }[]>(
    await v1(admin, `/api/v1/fixtures/${fx}/events`),
  );
  const note = events.find((e) => e.seq === 2);
  const voided = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 2,
    type: "core.void",
    payload: { event_id: note?.id },
  });
  check(
    "v1 undo via core.void",
    voided.status === 201 && v1data<{ seq: number }>(voided).seq === 3,
  );

  // Decide every fixture, read authed standings, then the public dashboard.
  for (const f of fixtures) {
    const state = await v1(admin, `/api/v1/fixtures/${f.id}/state`);
    const seq = v1data<{ last_seq: number }>(state).last_seq;
    await v1(admin, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  }
  const standings = await v1(admin, `/api/v1/stages/${stageId}/standings`);
  check("v1 standings ranked", v1data<{ rows: unknown[] }>(standings).rows.length === 4);

  const anon = newSession();
  const pubStandings = await v1(
    anon,
    `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/divisions/${divSlug}/standings`,
  );
  // Flaked once in CI (2026-07-13, 404) with no body in the log — keep the
  // response visible so a recurrence is diagnosable.
  if (pubStandings.status !== 200) {
    console.log(
      "public standings response:",
      pubStandings.status,
      JSON.stringify(pubStandings.json),
    );
  }
  check(
    "v1 public standings (no auth)",
    pubStandings.status === 200 && pubStandings.json.ok === true,
  );
  check(
    "v1 public reads are cacheable",
    (pubStandings.headers.get("cache-control") ?? "").includes("s-maxage"),
  );
  const pubComp = await v1(anon, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}`);
  check(
    "v1 public competition lists divisions",
    v1data<{ divisions: unknown[] }>(pubComp).divisions.length === 1,
  );

  // Public-page theming, free path (public redesign): the branding write is
  // accepted, but the public view empties it for orgs without
  // dashboard.branding — the page must NOT carry the --ps-* accent override.
  const branded = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    branding: { colors: { primary: "#0f766e" } },
  });
  check("v1 branding patch accepted", branded.status === 200);
  const freePage = await fetch(`${BASE}/shared/${orgSlug}/${compSlug}`);
  const freeHtml = await freePage.text();
  check(
    "public competition page renders (community)",
    freePage.status === 200 && freeHtml.includes("V1 Cup"),
  );
  check("community public page keeps default theme", !freeHtml.includes("--ps-accent:#0f766e"));
  // Slideshow shares the courtside theme layer, gated the same way: on
  // Community the board must keep the default violet, not the brand color.
  const freeBoard = await fetch(`${BASE}/slideshow/divisions/${divId}`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const freeBoardHtml = await freeBoard.text();
  check("community slideshow renders", freeBoard.status === 200);
  check("community slideshow keeps default theme", !freeBoardHtml.includes("--ps-accent:#0f766e"));
  // Org-level brand color: the write lands on any plan, but the public org
  // landing ignores it without dashboard.branding.
  const orgBrand = await raw(admin, `/api/orgs/${orgId}`, "PATCH", {
    branding: { colors: { primary: "#0f766e" } },
  });
  check("org branding patch accepted", orgBrand.status === 200);
  const freeOrgHtml = await (await fetch(`${BASE}/shared/${orgSlug}`)).text();
  check("community org landing keeps default theme", !freeOrgHtml.includes("--ps-accent:#0f766e"));

  // Entitlement gate: community org → 402; Pro override → key works via Bearer.
  const denied = await v1(admin, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "ci",
    scopes: ["read"],
  });
  check(
    "v1 API keys 402-gated on api.access",
    denied.status === 402 && denied.json.error?.code === "PAYMENT_REQUIRED",
  );

  if (db) {
    await insertEntitlementOverride(admin, orgId, "api.access", true);
    const minted = await v1(admin, `/api/v1/orgs/${orgId}/api-keys`, "POST", { name: "ci", scopes: ["read"] });
    const secret = v1data<{ id: string; secret: string }>(minted).secret;
    check("v1 API key minted once (sc_)", minted.status === 201 && secret.startsWith("sc_"));

    const keyed = await v1(newSession(), "/api/v1/competitions", "GET", undefined, {
      Authorization: `Bearer ${secret}`,
    });
    check("v1 Bearer key authenticates reads", keyed.status === 200 && keyed.json.ok === true);
    const keyedWrite = await v1(
      newSession(),
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: "Nope" },
      {
        Authorization: `Bearer ${secret}`,
      },
    );
    check("v1 read-scoped key cannot write", keyedWrite.status === 403);

    const keyId = v1data<{ id: string }>(minted).id;
    await v1(admin, `/api/v1/orgs/${orgId}/api-keys/${keyId}`, "DELETE");
    const revoked = await v1(newSession(), "/api/v1/competitions", "GET", undefined, {
      Authorization: `Bearer ${secret}`,
    });
    check("v1 revoked key stops authenticating", revoked.status === 401);
    await db.end();
  } else {
    console.log("v1 API-key positive path skipped (DATABASE_URL not set)");
  }

  // Spec is served and matches the implemented surface.
  const spec = (await fetch(BASE + "/api/v1/openapi.json").then((r) => r.json())) as {
    openapi: string;
    paths: Record<string, unknown>;
  };
  check(
    "v1 openapi served",
    spec.openapi === "3.1.0" && !!spec.paths["/api/v1/fixtures/{id}/events"],
  );
}

// Multipart POST for the file-upload endpoints (imports, logos).
async function v1Multipart(s: Session, path: string, form: FormData): Promise<V1Res> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
    },
    body: form,
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as V1Res["json"];
  return { status: res.status, headers: res.headers, json };
}

/**
 * Exercise the Jul3 route families (PROMPT-21..28) over real HTTP so a broken
 * route/auth/envelope fails CI even when the usecase unit passes. Runs against
 * a Pro org (advanced features are entitlement-gated).
 */
async function jul3Suite(admin: Session, orgId: string, orgSlug: string): Promise<void> {
  // Fresh competition + football division (football has the richest surface:
  // scorers, cards, MOTM, scoresheets).
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Jul3 Cup ${tag}`,
      visibility: "public",
    }),
  );

  // Public-page theming, pro path (public redesign): dashboard.branding lets
  // the brand color through the public view and the competition page inlines
  // the --ps-* accent override for its whole subtree.
  await v1(admin, `/api/v1/competitions/${comp.id}`, "PATCH", {
    branding: { colors: { primary: "#0f766e" } },
  });
  const themedHtml = await (await fetch(`${BASE}/shared/${orgSlug}/${comp.slug}`)).text();
  check("pro public page carries the org accent theme", themedHtml.includes("--ps-accent:#0f766e"));
  const div = await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;

  // Slideshow theming, pro path: dashboard.branding tints the noticeboard
  // with the brand color via the same --ps-* resolver.
  const proBoard = await fetch(`${BASE}/slideshow/divisions/${divId}`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const proBoardHtml = await proBoard.text();
  check("pro slideshow renders", proBoard.status === 200);
  check("pro slideshow carries the org accent theme", proBoardHtml.includes("--ps-accent:#0f766e"));

  // Org default vs competition override (theme chain): an org-level color
  // themes the org landing; a competition with its own color still wins.
  await call(admin, `/api/orgs/${orgId}`, "PATCH", {
    branding: { colors: { primary: "#1d4ed8" } },
  });
  const orgLandingHtml = await (await fetch(`${BASE}/shared/${orgSlug}`)).text();
  check("pro org landing carries the org color", orgLandingHtml.includes("--ps-accent:#1d4ed8"));
  const overrideHtml = await (await fetch(`${BASE}/shared/${orgSlug}/${comp.slug}`)).text();
  check("competition color overrides the org color", overrideHtml.includes("--ps-accent:#0f766e"));

  // -- PROMPT-21: clubs + bulk import ------------------------------------
  const club = await v1(admin, "/api/v1/clubs", "POST", {
    name: `Acme ${tag}`,
    short_name: "ACM",
  });
  check("jul3 clubs create (Pro clubs.hierarchy)", club.status === 201);
  const clubs = await v1(admin, "/api/v1/clubs");
  check("jul3 clubs list", clubs.status === 200 && v1data<unknown[]>(clubs).length >= 1);

  const csv = [
    "Team,Player,Division",
    `Acme U12,Ada One,${v1data<{ slug: string }>(div).slug}`,
  ].join("\n");
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "import.csv");
  const imp = await v1Multipart(admin, "/api/v1/imports", form);
  check(
    "jul3 import dry-run → plan",
    imp.status === 201 && Array.isArray(v1data<{ plan: { ops: unknown[] } }>(imp).plan.ops),
  );
  const importId = v1data<{ importId: string }>(imp).importId;
  const committed = await v1(admin, `/api/v1/imports/${importId}/commit`, "POST", undefined, {
    "Idempotency-Key": `smoke-${tag}`,
  });
  check(
    "jul3 import commit",
    committed.status === 201 && v1data<{ stats: { teams: number } }>(committed).stats.teams === 1,
  );

  // -- PROMPT-22: officials ---------------------------------------------
  const official = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ref ${tag}`,
    role_keys: ["referee"],
  });
  check("jul3 officials create", official.status === 201);
  const officials = await v1(admin, "/api/v1/officials");
  check("jul3 officials list", officials.status === 200);

  // Build a scored-through division to exercise the rest.
  const entrants = v1data<{ id: string }[]>(
    await v1(
      admin,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      ["A", "B", "C", "D"].map((n, i) => ({
        kind: "individual",
        display_name: n,
        seed: i + 1,
      })),
    ),
  );
  const stageId = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  ).id;
  const fixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST"),
  ).fixtures;
  await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");

  const officialId = v1data<{ id: string }[]>(officials)[0]!.id;
  // V290 moved officials.auto up to Pro Plus (approved hard move, no grandfather).
  // This suite runs on a plain Pro org, so the auto-propose path now 402s here —
  // the ALLOWED path moved to smokePlanMatrix's pro_plus persona, so coverage of
  // the feature lands on the right tier instead of vanishing.
  const auto = await v1(admin, `/api/v1/divisions/${divId}/officials/auto`, "POST", {
    policy: { roles: ["referee"] },
  });
  check(
    "jul3 officials auto is Pro Plus only (402 officials.auto on Pro)",
    auto.status === 402 &&
      (auto.json.error as { feature_key?: string } | undefined)?.feature_key === "officials.auto",
  );
  const patchOff = await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}/officials`, "PATCH", {
    set: [{ official_id: officialId, role_key: "referee", locked: false }],
  });
  check("jul3 officials manual assign", patchOff.status === 200);

  // -- PROMPT-24: bulk shift + wait report ------------------------------
  await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}`, "PATCH", {
    scheduled_at: "2026-07-20T09:00:00.000Z",
    court_label: "C1",
  });
  const shift = await v1(admin, "/api/v1/schedule/shift", "POST", {
    division_id: divId,
    scope: { excludeLocked: true },
    delta_minutes: 15,
  });
  check("jul3 bulk shift", shift.status === 200 && v1data<{ shifted: number }>(shift).shifted >= 1);
  const report = await v1(admin, `/api/v1/divisions/${divId}/schedule/report`);
  check(
    "jul3 wait report",
    report.status === 200 && Array.isArray(v1data<{ perEntrant: unknown[] }>(report).perEntrant),
  );

  // -- PROMPT-23: undo/redo/history/checkpoints -------------------------
  const undo = await v1(admin, `/api/v1/divisions/${divId}/undo`, "POST", {});
  check(
    "jul3 undo appends inverse",
    undo.status === 200 && typeof v1data<{ watermark: number }>(undo).watermark === "number",
  );
  const redo = await v1(admin, `/api/v1/divisions/${divId}/redo`, "POST", {});
  check("jul3 redo", redo.status === 200);
  const cp = await v1(admin, `/api/v1/divisions/${divId}/checkpoints`, "POST", {
    label: `smoke ${tag}`,
  });
  check("jul3 checkpoint saved", cp.status === 201);
  const history = await v1(admin, `/api/v1/divisions/${divId}/history`);
  check(
    "jul3 history slice",
    history.status === 200 && Array.isArray(v1data<{ events: unknown[] }>(history).events),
  );

  // Decide every fixture for stats/standings/export.
  for (const f of fixtures) {
    const state = await v1(admin, `/api/v1/fixtures/${f.id}/state`);
    const seq = v1data<{ last_seq: number }>(state).last_seq;
    await v1(admin, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  }

  // -- PROMPT-25: manual rank override ----------------------------------
  const override = await v1(admin, `/api/v1/stages/${stageId}/standings/override`, "POST", {
    rows: [
      { entrant_id: entrants[2]!.id, rank: 3, reason: "placement game" },
      { entrant_id: entrants[3]!.id, rank: 4, reason: "placement game" },
    ],
  });
  check("jul3 rank override (Pro tiebreakers.custom)", override.status === 200);

  // -- PROMPT-26: exports (PDF + XLSX bytes) ----------------------------
  const pdf = await fetch(`${BASE}/api/v1/divisions/${divId}/exports/timetable?format=pdf`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  check(
    "jul3 timetable PDF bytes",
    pdf.status === 200 && pdfBytes.subarray(0, 5).toString() === "%PDF-",
  );
  const xlsx = await fetch(`${BASE}/api/v1/divisions/${divId}/exports/participants?format=xlsx`, {
    headers: { cookie: cookieHeader(admin) },
  });
  check(
    "jul3 participants XLSX bytes",
    xlsx.status === 200 && (await xlsx.arrayBuffer()).byteLength > 500,
  );

  // -- PROMPT-27: player stats ------------------------------------------
  const stats = await v1(admin, `/api/v1/divisions/${divId}/stats/players`);
  check(
    "jul3 player stats leaderboard (Pro stats.player)",
    stats.status === 200 && Array.isArray(v1data<{ rows: unknown[] }>(stats).rows),
  );

  // -- PROMPT-28: format extensions (triple RR + ladder challenge) ------
  const tripleComp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Triple ${tag}`,
      visibility: "private",
    }),
  );
  const tripleDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${tripleComp.id}/divisions`, "POST", {
      name: "T",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  ).id;
  await v1(
    admin,
    `/api/v1/divisions/${tripleDiv}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const tripleStage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${tripleDiv}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "Triple",
      config: { legs: 3 },
    }),
  ).id;
  const tripleGen = await v1(admin, `/api/v1/stages/${tripleStage}/generate`, "POST");
  check("jul3 triple RR = 18 fixtures", v1data<{ created: number }>(tripleGen).created === 18);

  // Ladder challenge (formats.advanced): a stage + an in-range challenge.
  const ladderStage = await v1(admin, `/api/v1/divisions/${tripleDiv}/stages`, "POST", {
    seq: 2,
    kind: "ladder",
    name: "Ladder",
    config: { challengeRange: 2 },
  });
  check("jul3 ladder stage (Pro formats.advanced)", ladderStage.status === 201);
}

/**
 * Growth-wave coverage the earlier suites miss (kept per feedback: every
 * feature exercised on the pro AND the free path where a free path exists):
 * device links, scorer seats via scoped invites, discovery, public
 * registration, ownership transfer, account export, and the in-app
 * downgrade → competition-freeze path. `proOrgId` (org2) must be Pro on
 * entry; the downgrade at the end deliberately flips it to community.
 */
// PROMPT-38 (v3/09 §4): division delete on free, archive/restore on pro.
async function divisionLifecycleSuite(admin: Session, proOrgId: string): Promise<void> {
  const genericDivision = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };

  // --- Free path: a fresh org (no subscription row) is community — the
  // divisions.per_competition quota is 4 (V319 "free runs big"), and DELETE
  // frees a slot. Creating the org switches the active-org cookie onto it.
  await call(admin, "/api/orgs", "POST", { name: `Del Org ${tag}` });
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Del Cup ${tag}`,
  });
  const compId = v1data<{ id: string }>(comp).id;
  const first = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "First",
    ...genericDivision,
  });
  check("del: free org creates division 1", first.status === 201);
  const firstId = v1data<{ id: string }>(first).id;
  for (const name of ["Filler 2", "Filler 3", "Filler 4"]) {
    await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name,
      ...genericDivision,
    });
  }
  const blocked = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Fifth",
    ...genericDivision,
  });
  check("del: division 5 blocked on free (402, community's cap is 4)", blocked.status === 402);

  // Open registration blocks delete; closing it unblocks.
  await v1(admin, `/api/v1/divisions/${firstId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });
  const regBlocked = await v1(admin, `/api/v1/divisions/${firstId}`, "DELETE");
  check(
    "del: open registration blocks delete (409 REGISTRATION_OPEN)",
    regBlocked.status === 409 && regBlocked.json.error?.code === "REGISTRATION_OPEN",
  );
  await v1(admin, `/api/v1/divisions/${firstId}/registration-settings`, "PUT", {
    enabled: false,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });

  const deleted = await v1(admin, `/api/v1/divisions/${firstId}`, "DELETE");
  check("del: setup division hard-deletes (204)", deleted.status === 204);
  const retried = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Second",
    ...genericDivision,
  });
  check("del: delete lifted the free-plan gate", retried.status === 201);

  // --- Pro path: a resulted division 409s with the archive hint, archives,
  // hides from the console list, then restores with results intact.
  await raw(admin, "/api/orgs/active", "POST", { org_id: proOrgId });
  const proComp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Arch Cup ${tag}`,
  });
  const proCompId = v1data<{ id: string }>(proComp).id;
  const div = await v1(admin, `/api/v1/competitions/${proCompId}/divisions`, "POST", {
    name: "Resulted",
    ...genericDivision,
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;
  await v1(
    admin,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    ["DA", "DB"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`,
    "POST",
  );
  const fixtureId = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");
  await v1(admin, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  await v1(admin, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 3, p2Score: 1 },
  });

  const hardDelete = await v1(admin, `/api/v1/divisions/${divId}`, "DELETE");
  check(
    "arch: resulted division delete 409s with archive hint",
    hardDelete.status === 409 &&
      hardDelete.json.error?.code === "DIVISION_HAS_RESULTS" &&
      (hardDelete.json.error as { archive?: boolean }).archive === true,
  );
  const archived = await v1(admin, `/api/v1/divisions/${divId}/archive`, "POST");
  check(
    "arch: archive succeeds on pro",
    archived.status === 200 &&
      v1data<{ archived_at: string | null }>(archived).archived_at !== null,
  );
  const listed = await v1(admin, `/api/v1/competitions/${proCompId}/divisions`);
  check(
    "arch: archived division hidden from console list",
    v1data<{ id: string }[]>(listed).every((d) => d.id !== divId),
  );
  const restored = await v1(admin, `/api/v1/divisions/${divId}/archive`, "DELETE");
  check(
    "arch: restore round-trips",
    restored.status === 200 &&
      v1data<{ archived_at: string | null }>(restored).archived_at === null,
  );
  const fixture = await v1(admin, `/api/v1/fixtures/${fixtureId}`);
  check(
    "arch: results intact after restore",
    v1data<{ status: string }>(fixture).status === "decided",
  );
}

async function gapSuite(admin: Session, org1Id: string, proOrgId: string): Promise<void> {
  // A dedicated started division in the Pro org for device links + scorers.
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Gap Cup ${tag}`,
  });
  const compId = v1data<{ id: string }>(comp).id;
  const div = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Gap",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;
  await v1(
    admin,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    ["GA", "GB", "GC", "GD"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`,
    "POST",
  );
  const fixtureId = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");

  // --- Device links (Pro): mint once, token opens the scoring door alone ---
  const dl = await v1(admin, `/api/v1/fixtures/${fixtureId}/device-links`, "POST", {
    label: "Court 1",
  });
  const dlSecret = v1data<{ secret: string }>(dl).secret ?? "";
  check("gap device link minted (dl_)", dl.status === 201 && dlSecret.startsWith("dl_"));

  // Saved lineups must reach the account-less pad: /score/[token] once
  // rendered `lineup: []`, so fixture-console saves never showed courtside.
  // Runs before the scoring event below — lineups lock once in_play. The
  // name lands in the pad payload twice (roster prop + lineup prop); the
  // roster alone would make a bare includes() pass even without the fix.
  const fx0 = v1data<{ home_entrant_id: string }>(
    await v1(admin, `/api/v1/fixtures/${fixtureId}`, "GET"),
  );
  const padPerson = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Pad Lineup ${tag}`,
    }),
  );
  await v1(admin, `/api/v1/entrants/${fx0.home_entrant_id}`, "PATCH", {
    members: [{ person_id: padPerson.id }],
  });
  const luPut = await v1(
    admin,
    `/api/v1/fixtures/${fixtureId}/lineups/${fx0.home_entrant_id}`,
    "PUT",
    { slots: [{ person_id: padPerson.id, slot: "starting", order_no: 1 }] },
  );
  check("gap lineup saved while scheduled", luPut.status === 200);
  const luPadHtml = await (await fetch(`${BASE}/score/${dlSecret}`)).text();
  const luHits = luPadHtml.split(`Pad Lineup ${tag}`).length - 1;
  check("gap device pad carries the saved lineup (roster + lineup props)", luHits >= 2);
  const bare = newSession(); // no cookies — the token is the credential
  const dlState = await v1(bare, `/api/v1/fixtures/${fixtureId}/state`, "GET", undefined, {
    Authorization: `Bearer ${dlSecret}`,
  });
  const dlSeq = v1data<{ last_seq: number }>(dlState).last_seq;
  const dlEvent = await v1(
    bare,
    `/api/v1/fixtures/${fixtureId}/events`,
    "POST",
    {
      expected_seq: dlSeq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    },
    { Authorization: `Bearer ${dlSecret}` },
  );
  check("gap device-link bearer can score", dlEvent.status === 201);
  // The pad page wears the org brand (chain set by jul3Suite: org #1d4ed8);
  // Gap Cup has no competition color, so the org default shows through.
  const padHtml = await (await fetch(`${BASE}/score/${dlSecret}`)).text();
  check("gap device pad carries the org theme", padHtml.includes("--ps-accent:#1d4ed8"));

  // --- Scorer seat: a division-scoped invite creates membership + assignment ---
  const scorerInvite = (await call(admin, `/api/orgs/${proOrgId}/invites`, "POST", {
    role: "scorer",
    max_uses: 1,
    default_scope: { type: "division", id: divId },
  })) as { token: string };
  const scorer = newSession();
  await signIn(scorer, `scorer_${tag}@example.com`);
  const accepted = (await call(
    scorer,
    `/api/invites/${scorerInvite.token}/accept`,
    "POST",
    {},
  )) as {
    landing: string;
  };
  check("gap scorer lands on my-matches", accepted.landing === "/my-matches");
  const assigned = await v1(scorer, "/api/v1/me/assigned-fixtures");
  check(
    "gap scorer sees assigned fixtures",
    assigned.status === 200 && v1data<unknown[]>(assigned).length > 0,
  );
  // scorers.max (Pro = 1): a second scorer can't take a seat.
  const scorerInvite2 = (await call(admin, `/api/orgs/${proOrgId}/invites`, "POST", {
    role: "scorer",
    max_uses: 1,
    default_scope: { type: "division", id: divId },
  })) as { token: string };
  const scorer2 = newSession();
  await signIn(scorer2, `scorer2_${tag}@example.com`);
  const seatFull = await raw(scorer2, `/api/invites/${scorerInvite2.token}/accept`, "POST", {});
  check("gap second scorer seat blocked (scorers.max)", seatFull.status === 402);

  // --- Additive invites: accepting never changes an existing role. An
  // editor's own test scan is a no-op that doesn't burn the link; a viewer
  // accepting the same link keeps viewer and gains the assignment — even
  // with the scorer seat pool full (no seat is charged) ---
  const gapViewerInvite = (await call(admin, `/api/orgs/${proOrgId}/invites`, "POST", {
    role: "viewer",
    max_uses: 1,
  })) as { token: string };
  const gapViewer = newSession();
  await signIn(gapViewer, `gap_viewer_${tag}@example.com`);
  await call(gapViewer, `/api/invites/${gapViewerInvite.token}/accept`, "POST", {});
  const umpInvite = (await call(admin, `/api/orgs/${proOrgId}/invites`, "POST", {
    role: "scorer",
    max_uses: 1,
    default_scope: { type: "division", id: divId },
  })) as { token: string };
  const ownScan = (await call(admin, `/api/invites/${umpInvite.token}/accept`, "POST", {})) as {
    outcome: string;
    role: string;
  };
  check(
    "gap editor test-scan is a no-op (role kept)",
    ownScan.outcome === "already_member" && ownScan.role !== "scorer",
  );
  const vAccept = (await call(gapViewer, `/api/invites/${umpInvite.token}/accept`, "POST", {})) as {
    outcome: string;
    role: string;
    landing: string;
  };
  check(
    "gap viewer umpire invite: scope added, role kept",
    vAccept.outcome === "scope_added" &&
      vAccept.role === "viewer" &&
      vAccept.landing === "/my-matches",
  );
  const vAssigned = await v1(gapViewer, "/api/v1/me/assigned-fixtures");
  check(
    "gap viewer sees assigned fixtures",
    vAssigned.status === 200 && v1data<unknown[]>(vAssigned).length > 0,
  );
  const vFixture = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[1]!.id;
  const vState = await v1(gapViewer, `/api/v1/fixtures/${vFixture}/state`);
  const vEvent = await v1(gapViewer, `/api/v1/fixtures/${vFixture}/events`, "POST", {
    expected_seq: v1data<{ last_seq: number }>(vState).last_seq,
    type: "generic.result",
    payload: { p1Score: 1, p2Score: 0 },
  });
  check("gap viewer scores via assignment", vEvent.status === 201);

  // --- Discovery: public + discoverable (started division passes the quality
  // floor); discoverable without public visibility is rejected ---
  const pub = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    visibility: "public",
  });
  check("gap competition made public", pub.status === 200);
  const disc = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    discoverable: true,
    discovery: { country: "GB" },
  });
  check("gap discoverable set", disc.status === 200);
  const discovery = await v1(
    bare,
    `/api/v1/public/discovery?q=${encodeURIComponent(`Gap Cup ${tag}`)}`,
  );
  check(
    "gap discovery lists the competition",
    discovery.status === 200 &&
      v1data<{ items: { name: string }[] }>(discovery).items.some(
        (i) => i.name === `Gap Cup ${tag}`,
      ),
  );
  const privComp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Gap Hidden ${tag}`,
    visibility: "private",
  });
  const badDisc = await v1(
    admin,
    `/api/v1/competitions/${v1data<{ id: string }>(privComp).id}`,
    "PATCH",
    {
      discoverable: true,
    },
  );
  check("gap discoverable requires public (422)", badDisc.status === 422);

  // --- Public registration: open free signup → pending + access token →
  // organiser confirm materialises an entrant ---
  const regSettings = await v1(admin, `/api/v1/divisions/${divId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    capacity: 10,
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });
  check("gap registration opened", regSettings.status === 200);
  const orgs = (await call(admin, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const proSlug = orgs.find((o) => o.id === proOrgId)!.slug;
  const compSlug = v1data<{ slug: string }>(await v1(admin, `/api/v1/competitions/${compId}`)).slug;
  const reg = await v1(
    bare,
    `/api/v1/public/orgs/${proSlug}/competitions/${compSlug}/register`,
    "POST",
    {
      division_id: divId,
      display_name: `Walk In ${tag}`,
      contact_email: `walkin_${tag}@example.com`,
      privacy_consent: true,
    },
  );
  const regData = v1data<{
    registration_id: string;
    status: string;
    access_token: string;
  }>(reg);
  check(
    "gap public registration pending + tokened",
    reg.status === 201 && regData.status === "pending" && regData.access_token.length > 0,
  );
  const confirmed = await v1(
    admin,
    `/api/v1/registrations/${regData.registration_id}/confirm`,
    "POST",
    {},
  );
  check("gap registration confirmed", confirmed.status === 200 || confirmed.status === 201);
  const gapEntrants = await v1(admin, `/api/v1/divisions/${divId}/entrants`);
  check(
    "gap confirmed registration is an entrant",
    v1data<{ display_name: string }[]>(gapEntrants).some(
      (e) => e.display_name === `Walk In ${tag}`,
    ),
  );

  // --- #402: a SIGNED-IN registrant who affirms "I'm registering myself" is
  // ONE person across every division they enter; the same account registering
  // a child under guardian consent stays a SEPARATE person (the server-side
  // veto — a signed-in guardian entering two children shares one user_id, so
  // an inferred link would fuse the siblings exactly as contact_email would).
  //
  // Person identity is observed through GET /api/v1/entrants/{id}, whose
  // `members[]` carry `person_id`; the division entrants LIST does not (it
  // returns entrant columns only). /api/v1/me/persons is the second, distinct
  // vantage point: it selects on persons.user_id, so it proves the link was
  // actually written rather than that two entrants merely share a row.
  const selfDivIds: string[] = [];
  for (const lane of ["Self A", "Self B", "Self Guardian"]) {
    const selfDiv = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: `${lane} ${tag}`,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const selfDivId = v1data<{ id: string }>(selfDiv).id;
    const selfSettings = await v1(
      admin,
      `/api/v1/divisions/${selfDivId}/registration-settings`,
      "PUT",
      {
        enabled: true,
        entrant_kind: "individual",
        capacity: 10,
        fee_cents: 0,
        currency: "gbp",
        form_fields: [],
      },
    );
    check(`gap self-link division "${lane}" open for registration`, selfSettings.status === 200);
    selfDivIds.push(selfDivId);
  }
  const selfEmail = `selflink_${tag}@example.com`;
  const selfSession = newSession();
  await signIn(selfSession, selfEmail);
  // #402 — an affirmation without a date of birth is refused (400) and never
  // links: an undated registrant may be a child, and a parent entering two of
  // them would otherwise fuse both siblings into one persons row.
  const adultDob = "1990-05-05";
  const registerAsSelf = (divisionId: string, extra: Record<string, unknown>) =>
    v1(selfSession, `/api/v1/public/orgs/${proSlug}/competitions/${compSlug}/register`, "POST", {
      division_id: divisionId,
      display_name: `Self Link ${tag}`,
      contact_email: selfEmail,
      privacy_consent: true,
      registering_self: true,
      dob: adultDob,
      ...extra,
    });
  /** Confirm a submitted registration and return the person the entrant carries. */
  const confirmToPerson = async (submitted: V1Res): Promise<string | null> => {
    const regId = v1data<{ registration_id: string }>(submitted).registration_id;
    const done = await v1(admin, `/api/v1/registrations/${regId}/confirm`, "POST", {});
    const entrantId = v1data<{ entrant_id: string | null }>(done).entrant_id;
    if (!entrantId) return null;
    const entrant = await v1(admin, `/api/v1/entrants/${entrantId}`);
    return v1data<{ members: { person_id: string }[] }>(entrant).members[0]?.person_id ?? null;
  };

  const selfA = await registerAsSelf(selfDivIds[0]!, {});
  const selfB = await registerAsSelf(selfDivIds[1]!, {});
  check(
    "gap self-link registrations accepted in two divisions",
    selfA.status === 201 && selfB.status === 201,
  );
  // The affirmation carries no weight without an age: refused at the schema so
  // the registrant is told why, and unlinkable at the server either way.
  const undatedSelf = await registerAsSelf(selfDivIds[2]!, { dob: null });
  check("gap an affirmed registration with NO date of birth is refused", undatedSelf.status === 400);
  const selfPersonA = await confirmToPerson(selfA);
  const selfPersonB = await confirmToPerson(selfB);
  check(
    "gap signed-in self-registration resolves ONE person across two divisions",
    selfPersonA !== null && selfPersonA === selfPersonB,
  );

  // Always ~10 years old, so the guardian branch is genuinely required rather
  // than decorative (a bare dob-less pair would be accepted either way).
  const kidDob = new Date(Date.now() - 10 * 365.25 * 864e5).toISOString().slice(0, 10);
  const kid = await registerAsSelf(selfDivIds[2]!, {
    display_name: `Self Kid ${tag}`,
    dob: kidDob,
    guardian_name: `Self Link ${tag}`,
    guardian_consent: true,
  });
  check("gap guardian registration accepted from the same account", kid.status === 201);
  const kidPerson = await confirmToPerson(kid);
  check(
    "gap guardian entry from the same account is a SEPARATE person",
    kidPerson !== null && kidPerson !== selfPersonA,
  );

  const myPersons = await v1(selfSession, "/api/v1/me/persons");
  const myPersonIds = v1data<{ id: string }[]>(myPersons) ?? [];
  check(
    "gap the registrant's account claims the linked person exactly once",
    myPersons.status === 200 &&
      selfPersonA !== null &&
      myPersonIds.filter((p) => p.id === selfPersonA).length === 1,
  );
  check(
    "gap the guardian's child never joins the registrant's account",
    kidPerson !== null && !myPersonIds.some((p) => p.id === kidPerson),
  );

  // --- Free paths on a fresh community owner: device links 402, offline
  // entry fees allowed without Stripe ---
  const free = newSession();
  await signIn(free, `free_${tag}@example.com`);
  const fComp = await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Free Gap ${tag}`,
  });
  const fDiv = await v1(
    free,
    `/api/v1/competitions/${v1data<{ id: string }>(fComp).id}/divisions`,
    "POST",
    {
      name: "Free",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const fDivId = v1data<{ id: string }>(fDiv).id;
  await v1(free, `/api/v1/divisions/${fDivId}/entrants`, "POST", [
    { kind: "individual", display_name: "F1", seed: 1 },
    { kind: "individual", display_name: "F2", seed: 2 },
  ]);
  const fStage = await v1(free, `/api/v1/divisions/${fDivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const fGen = await v1(
    free,
    `/api/v1/stages/${v1data<{ id: string }>(fStage).id}/generate`,
    "POST",
  );
  const fFixture = v1data<{ fixtures: { id: string }[] }>(fGen).fixtures[0]!.id;
  const fDl = await v1(free, `/api/v1/fixtures/${fFixture}/device-links`, "POST", { label: "X" });
  check(
    "gap device links Pro-gated (402 on community)",
    fDl.status === 402 && fDl.json.error?.code === "PAYMENT_REQUIRED",
  );
  const fFee = await v1(free, `/api/v1/divisions/${fDivId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
  });
  check("gap offline entry fee allowed on community", fFee.status === 200);

  // Matchday documents (v12 PR1, Task 9): same export renders a valid PDF on
  // a community org — tables upgrade for every plan, only the masthead/
  // sponsor chrome differs (a visual difference the Task 18 gallery proves,
  // not a byte-level one).
  const freeDocPdf = await fetch(
    `${BASE}/api/v1/divisions/${fDivId}/exports/timetable?format=pdf`,
    {
      headers: { cookie: cookieHeader(free) },
    },
  );
  const freeDocPdfBytes = Buffer.from(await freeDocPdf.arrayBuffer());
  check(
    "exports timetable PDF renders a valid plain PDF (free)",
    freeDocPdf.status === 200 &&
      (freeDocPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      freeDocPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      freeDocPdfBytes.byteLength > 1024,
  );

  // --- Ownership transfer on org1 (owner + the invited members): away & back ---
  const members = (await call(admin, `/api/orgs/${org1Id}/members`)) as {
    user_id: string;
    email: string;
    role: string;
  }[];
  const owner = members.find((m) => m.role === "owner")!;
  const target = members.find((m) => m.role !== "owner" && m.role !== "scorer")!;
  await call(admin, `/api/orgs/${org1Id}/transfer-owner`, "POST", {
    new_owner_id: target.user_id,
  });
  const mid = (await call(admin, `/api/orgs/${org1Id}/members`)) as {
    user_id: string;
    role: string;
  }[];
  check(
    "gap ownership transferred",
    mid.find((m) => m.user_id === target.user_id)?.role === "owner" &&
      mid.find((m) => m.user_id === owner.user_id)?.role === "admin",
  );
  // The old owner is admin now — the NEW owner must hand it back. Their
  // session belongs to viewer/member users created earlier; sign the target
  // user in fresh (same passwordless door).
  const targetSession = newSession();
  await signIn(targetSession, target.email);
  await raw(targetSession, "/api/orgs/active", "POST", { org_id: org1Id });
  await call(targetSession, `/api/orgs/${org1Id}/transfer-owner`, "POST", {
    new_owner_id: owner.user_id,
  });
  const after = (await call(admin, `/api/orgs/${org1Id}/members`)) as {
    user_id: string;
    role: string;
  }[];
  check("gap ownership restored", after.find((m) => m.user_id === owner.user_id)?.role === "owner");

  // --- Account: display-name edit + GDPR export ---
  const renamedMe = await raw(admin, "/api/users/me", "PATCH", {
    display_name: `Gap Admin ${tag}`,
  });
  check("gap display name updated", renamedMe.status === 200);
  const exported = await fetch(`${BASE}/api/users/me/export`, {
    headers: { cookie: cookieHeader(admin) },
  });
  check("gap account export downloads", exported.status === 200);

  // --- Downgrade → freeze (destructive; keep last). org2 has no Stripe
  // subscription, so the in-app downgrade applies immediately; over-quota
  // competitions freeze (least-recently-active first) while the rest stay
  // writable. ---
  await raw(admin, "/api/orgs/active", "POST", { org_id: proOrgId });
  const down = await raw(admin, "/api/billing/downgrade", "POST", {});
  check("gap in-app downgrade to community", down.status === 200);
  const list = await v1(admin, "/api/v1/competitions?limit=50");
  const comps = v1data<{ items: { id: string }[] } | { id: string }[]>(list);
  const ids = (Array.isArray(comps) ? comps : comps.items).map((c) => c.id);
  const probes = await Promise.all(
    ids.map((id) =>
      v1(admin, `/api/v1/competitions/${id}`, "PATCH", {
        description: "probe",
      }),
    ),
  );
  const blocked = probes.filter((p) => p.status === 402).length;
  const writable = probes.filter((p) => p.status === 200).length;
  check("gap downgrade freezes over-quota competitions", blocked >= 1);
  // Branding read-gates follow the plan down: the pad sheds the org theme.
  const downPadHtml = await (await fetch(`${BASE}/score/${dlSecret}`)).text();
  check("gap downgraded pad drops the org theme", !downPadHtml.includes("--ps-accent:#1d4ed8"));
  check("gap in-quota competitions stay writable", writable >= 1);
}

/**
 * Purge this run's test data: delete the run's test users and every org they
 * created (org delete cascades competitions/divisions/fixtures/members/
 * invites). Scoped to the run's `tag` by exact email match. No-op when
 * DATABASE_URL is unset. Never throws — teardown must not fail the run.
 */
// =====================================================================
// v3 content + API wave (PROMPT-35/37/39): markdown descriptions render
// through the one prose pipeline, /help + /developers are live, API keys
// carry scopes + pins + rate headers, OG/poster/embed/sponsors work on the
// pro path and gate/degrade honestly on the free path.
// =====================================================================
async function v3ContentApiSuite(
  admin: Session,
  proOrgId: string,
  proOrgSlug: string,
): Promise<void> {
  const bin = async (path: string, s?: Session) => {
    const res = await fetch(BASE + path, {
      headers: s && Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {},
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      buf,
    };
  };

  // ---- PRO PATH -------------------------------------------------------
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Content Wave ${tag}`,
    visibility: "public",
    description:
      `## Welcome\n\nA **great** day out.\n\n**[Register now](https://example.com/r)**\n\n` +
      `<script>alert(1)</script>`,
  });
  check("v3: markdown competition created", comp.status === 201);
  const compData = v1data<{ id: string; slug: string }>(comp);

  // Full config on purpose — the seeded variant preset can be sparse in a
  // shared/dev DB (the CONFIG_INVALID variant-poisoning gotcha, PR #63).
  const div = await v1(admin, `/api/v1/competitions/${compData.id}/divisions`, "POST", {
    name: "Open Singles",
    sport_key: "generic",
    variant_key: "score",
    config: {
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    },
  });
  check("v3: division created", div.status === 201);
  const divData = v1data<{ id: string; slug: string }>(div);
  const patchedDiv = await v1(admin, `/api/v1/divisions/${divData.id}`, "PATCH", {
    description: "### House rules\n\nBe kind.",
  });
  check("v3: division description via PATCH", patchedDiv.status === 200);

  const publicComp = await html(newSession(), `/shared/${proOrgSlug}/${compData.slug}`);
  check("v3: public page renders markdown h2", publicComp.body.includes("<h2>Welcome</h2>"));
  check("v3: CTA button rendered", publicComp.body.includes("prose-cta"));
  check("v3: XSS neutralised on public page", !publicComp.body.includes("<script>alert"));

  // Help centre + format gallery + developer docs are live.
  const helpHome = await html(newSession(), "/help");
  check("v3: /help renders", helpHome.status === 200 && helpHome.body.includes("Getting started"));
  const helpFormats = await html(newSession(), "/help/formats/league");
  check(
    "v3: format explainer renders",
    helpFormats.status === 200 && helpFormats.body.includes("Round robin"),
  );
  const helpIndex = (await (await fetch(BASE + "/api/help-index")).json()) as {
    slug: string;
  }[];
  check(
    "v3: help search index has waitlist",
    helpIndex.some((d) => d.slug === "registration/waitlist"),
  );
  const dev = await html(newSession(), "/developers");
  check("v3: /developers renders", dev.status === 200 && dev.body.includes("scope"));
  const pubSpec = (await (await fetch(BASE + "/api/v1/openapi.json?published=1")).json()) as {
    paths: Record<string, unknown>;
  };
  check(
    "v3: published spec excludes key management",
    !Object.keys(pubSpec.paths).some((p) => p.includes("api-keys")),
  );

  // Scoped API keys (PROMPT-37): read key reads with rate headers, 403s on
  // writes; pinned key stays inside its competition.
  const mkKey = await v1(admin, `/api/v1/orgs/${proOrgId}/api-keys`, "POST", {
    name: "smoke read",
    scopes: ["read"],
  });
  check("v3: read key minted", mkKey.status === 201);
  const keySecret = v1data<{ secret: string }>(mkKey).secret;
  const keyAuth = { Authorization: `Bearer ${keySecret}` };
  const keyRead = await v1(newSession(), "/api/v1/competitions", "GET", undefined, keyAuth);
  check("v3: read key GETs competitions", keyRead.status === 200);
  check("v3: rate-limit headers present", !!keyRead.headers.get("X-RateLimit-Limit"));
  const keyWrite = await v1(
    newSession(),
    "/api/v1/competitions",
    "POST",
    { ends_on: "2030-12-31", name: "Nope" },
    keyAuth,
  );
  check("v3: read key 403 on manage route", keyWrite.status === 403);

  const otherComp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Pin Other ${tag}`,
  });
  const otherId = v1data<{ id: string }>(otherComp).id;
  const mkPinned = await v1(admin, `/api/v1/orgs/${proOrgId}/api-keys`, "POST", {
    name: "smoke pinned",
    scopes: ["read"],
    competition_id: compData.id,
  });
  const pinnedAuth = {
    Authorization: `Bearer ${v1data<{ secret: string }>(mkPinned).secret}`,
  };
  const pinnedOk = await v1(
    newSession(),
    `/api/v1/competitions/${compData.id}`,
    "GET",
    undefined,
    pinnedAuth,
  );
  check("v3: pinned key reads its competition", pinnedOk.status === 200);
  const pinnedOut = await v1(
    newSession(),
    `/api/v1/competitions/${otherId}`,
    "GET",
    undefined,
    pinnedAuth,
  );
  check("v3: pinned key 403 outside its competition", pinnedOut.status === 403);

  // OG share card + QR poster (PROMPT-39 #1/#3). Next serves dynamic
  // metadata images on hash-suffixed URLs — read og:image off the page.
  const ogUrl = (body: string) =>
    /<meta property="og:image" content="([^"]+)"/.exec(body)?.[1]?.replace(/^https?:\/\/[^/]+/, "");
  const ogPath = ogUrl(publicComp.body);
  check("v3: page exposes og:image", !!ogPath);
  const og = await bin(ogPath ?? "/missing");
  check("v3: competition OG card is a PNG", og.status === 200 && og.type.includes("image/png"));
  const poster = await bin(`/shared/${proOrgSlug}/${compData.slug}/poster.pdf`);
  check(
    "v3: QR poster is a PDF",
    poster.status === 200 &&
      poster.buf[0] === 0x25 &&
      poster.buf[1] === 0x50 &&
      poster.buf[2] === 0x44 &&
      poster.buf[3] === 0x46,
  );

  // Embeds (PROMPT-39 #4): pro renders, and sponsors (#5) reach the dashboard.
  const embed = await html(newSession(), `/embed/divisions/${divData.id}/standings`);
  check("v3: embed renders on pro", embed.status === 200 && embed.body.includes("seazn.club"));
  const sponsorPatch = (await call(admin, `/api/orgs/${proOrgId}`, "PATCH", {
    sponsors: [{ name: `Acme ${tag}`, url: "https://acme.example" }],
  })) as { id?: string };
  check("v3: sponsors saved", !!sponsorPatch.id);
  // v10: the blob is a read shim only — once the org has sponsors table rows
  // (sponsorsSuite created them), public pages render rows, not the blob.
  const stripRow = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Strip ${tag}`,
    url: "https://strip.example",
  });
  check("v3: sponsor row created for strip", stripRow.status === 201);
  const compPage2 = await html(newSession(), `/shared/${proOrgSlug}/${compData.slug}`);
  check("v3: sponsor strip on pro dashboard", compPage2.body.includes(`Strip ${tag}`));
  check(
    "v3: blob sponsor stays shim-only once rows exist",
    !compPage2.body.includes(`Acme ${tag}`),
  );

  // ---- FREE PATH ------------------------------------------------------
  const free = newSession();
  const freeVer = await signIn(free, `content_free_${tag}@example.com`);
  const freeOrgId = freeVer.org_id as string;
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeSlug = freeOrgs.find((o) => o.id === freeOrgId)?.slug ?? "";

  const freeComp = await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Free Content ${tag}`,
    visibility: "public",
    description: "## Free words\n\nStill **rendered**.",
  });
  check("v3: free org markdown competition", freeComp.status === 201);
  const freeCompData = v1data<{ id: string; slug: string }>(freeComp);
  const freeDiv = await v1(free, `/api/v1/competitions/${freeCompData.id}/divisions`, "POST", {
    name: "Free Div",
    sport_key: "generic",
    variant_key: "score",
    config: {
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    },
  });
  const freeDivId = v1data<{ id: string }>(freeDiv).id;

  const freePage = await html(newSession(), `/shared/${freeSlug}/${freeCompData.slug}`);
  check("v3: free public page renders markdown", freePage.body.includes("<h2>Free words</h2>"));
  const freeOg = await bin(ogUrl(freePage.body) ?? "/missing");
  check(
    "v3: free OG card renders (violet)",
    freeOg.status === 200 && freeOg.type.includes("image/png"),
  );

  const freeKey = await v1(free, `/api/v1/orgs/${freeOrgId}/api-keys`, "POST", {
    name: "nope",
    scopes: ["read"],
  });
  check("v3: key creation 402 on free", freeKey.status === 402);
  const freeEmbed = await html(newSession(), `/embed/divisions/${freeDivId}/standings`);
  check("v3: embed 404 on free", freeEmbed.status === 404);

  await call(free, `/api/orgs/${freeOrgId}`, "PATCH", {
    sponsors: [{ name: `Acme Free ${tag}` }],
  });
  // v10 policy change: the un-tiered partner strip is free — a community
  // org's sponsors (here via the blob shim: no table rows yet) render
  // publicly, flat, with no tier labels.
  const freePage2 = await html(newSession(), `/shared/${freeSlug}/${freeCompData.slug}`);
  check(
    "v3→v10: free sponsor strip renders publicly, un-tiered",
    freePage2.body.includes(`Acme Free ${tag}`) && !freePage2.body.includes("Presented by"),
  );
}

/** SPEC-1 discipline (PROMPT-79): Pro org auto-accumulates a 5-yellow ban the
 *  organiser confirms (→ active + public strip); a free org gets 402 on the
 *  rules PUT and a PlusReveal on the Discipline tab. Cards must be seeded
 *  BEFORE checking (empty-doc false-green lesson). */
async function disciplineSuite(
  admin: Session,
  proOrgId: string,
  proOrgSlug: string,
): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Discipline Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Prem",
      sport_key: "football",
      variant_key: "11-a-side",
    }),
  );
  check("disc: football division created", !!div.id);

  const player = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Card Magnet ${tag}`,
      consent: { public_name: true },
    }),
  );
  const ents = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      {
        kind: "team",
        display_name: `Rovers ${tag}`,
        seed: 1,
        members: [{ person_id: player.id }],
      },
      { kind: "team", display_name: `City ${tag}`, seed: 2 },
    ]),
  );
  const rovers = ents[0]!.id;

  // Enable rules (FA default shape) — 5 yellows → 1 match.
  const put = await v1(admin, `/api/v1/divisions/${div.id}/discipline-rules`, "PUT", {
    enabled: true,
    rules: {
      accumulation: [
        { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
        { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
      ],
      dismissal: [
        { key: "second_yellow", color: "second_yellow", ban_matches: 1 },
        { key: "red", color: "red", ban_matches: 1 },
      ],
    },
  });
  check(
    "disc: pro enables rules",
    put.status === 200 && v1data<{ enabled: boolean }>(put).enabled === true,
  );

  // League with 5 legs → 5 Rovers-vs-City fixtures.
  const stageId = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
      config: { legs: 5 },
    }),
  ).id;
  const fixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST"),
  ).fixtures;
  check("disc: 5 fixtures generated (legs:5)", fixtures.length === 5);
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  // Seed one yellow per fixture — lineup must carry the player for the card.
  for (const fx of fixtures) {
    await v1(admin, `/api/v1/fixtures/${fx.id}/lineups/${rovers}`, "PUT", {
      slots: [
        {
          person_id: player.id,
          slot: "starting",
          position_key: "FW",
          order_no: 1,
          roles: [],
        },
      ],
    });
    const started = await v1(admin, `/api/v1/fixtures/${fx.id}/events`, "POST", {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    const seq = v1data<{ seq: number }>(started).seq;
    await v1(admin, `/api/v1/fixtures/${fx.id}/events`, "POST", {
      expected_seq: seq,
      type: "football.card",
      payload: { by: rovers, person: player.id, color: "yellow" },
    });
  }

  const pending = v1data<{ id: string; status: string; source: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/suspensions?status=pending`),
  );
  const auto = pending.find((s) => s.source === "auto_accumulation");
  check("disc: 5 yellows raise a pending accumulation ban", !!auto);

  if (auto) {
    const confirmed = await v1(admin, `/api/v1/suspensions/${auto.id}`, "PATCH", {
      kind: "confirm",
    });
    check(
      "disc: confirm activates the ban",
      v1data<{ status: string }>(confirmed).status === "active",
    );
  }
  const active = v1data<{ status: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/suspensions?status=active`),
  );
  check("disc: ban listed active after confirm", active.length >= 1);

  const pub = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}/${div.slug}`);
  check(
    "disc: public suspensions strip shows the ban",
    pub.status === 200 && pub.body.includes("Suspensions") && pub.body.includes("to serve"),
  );

  // --- Free path: 402 on the rules PUT + PlusReveal on the Discipline tab ---
  const free = newSession();
  await signIn(free, `disc_free_${tag}@example.com`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs[0]!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Free Disc ${tag}`,
      visibility: "public",
    }),
  );
  const freeDiv = v1data<{ id: string; slug: string }>(
    await v1(free, `/api/v1/competitions/${freeComp.id}/divisions`, "POST", {
      name: "Sunday",
      sport_key: "football",
      variant_key: "11-a-side",
    }),
  );
  const freePut = await v1(free, `/api/v1/divisions/${freeDiv.id}/discipline-rules`, "PUT", {
    enabled: true,
    rules: { accumulation: [], dismissal: [] },
  });
  check("disc: free rules PUT → 402", freePut.status === 402);
  const freeTab = await html(
    free,
    `/o/${freeOrg.slug}/c/${freeComp.slug}/d/${freeDiv.slug}?tab=discipline`,
  );
  check(
    "disc: free Discipline tab shows the PlusReveal",
    freeTab.status === 200 && freeTab.body.includes("discipline.enforced"),
  );
}

/**
 * Drop an org's server-side entitlement cache (`ent:{org}:*`) after a raw-SQL
 * write that the resolver cannot see — a plan flip (setPlan) or an override
 * grant (insertEntitlementOverride). lib/entitlements resolves cache-aside with
 * a 300s TTL, so on any Redis-backed target (staging, a prod smoke run) an
 * entitlement resolved BEFORE the write stays cached and the write never lands
 * inside the run. Locally and in CI REDIS_URL is normally unset — the cache
 * layer is inert there and this is a cheap no-op round-trip.
 *
 * There is no public invalidation endpoint, so this rides the superadmin
 * entitlement-override route (its POST and DELETE both call
 * invalidateOrgEntitlements): the org's OWNER is flipped to superadmin in SQL
 * for the two calls, then restored. Same mechanism as
 * apps/web/e2e/helpers.ts:283-307.
 *
 * `owner` must be a live session for that org's owner. It is deliberately an
 * EXISTING session rather than a fresh signIn: /api/auth/magic-link is rate
 * limited to 5 per 300s per IP and fails CLOSED wherever Redis is configured —
 * i.e. in exactly the environments this bust exists for.
 */
async function bustOrgEntitlements(owner: Session, orgId: string): Promise<void> {
  const setOwnerStaff = async (on: boolean) => {
    const sql = smokeDb();
    try {
      await sql`
        update users set is_staff = ${on}, staff_role = ${on ? "superadmin" : null}
        where id in (
          select user_id from org_members where org_id = ${orgId} and role = 'owner'
        )`;
    } finally {
      await sql.end();
    }
  };
  const KEY = "smoke.cache.bust";
  const path = `/api/admin/orgs/${orgId}/entitlement-override`;
  // The elevate is INSIDE the try: its update commits before the call returns,
  // so anything that throws between the commit and the try entering would leave
  // the org owner a live superadmin with nothing to restore it. `finally` runs
  // whether or not the elevate itself succeeded, and demoting an already-plain
  // user is a harmless no-op.
  try {
    await setOwnerStaff(true);
    // Both calls THROW on non-2xx rather than check(). raw() returns a status
    // and never throws, so an unasserted 401/404 here is a silent no-op: no
    // invalidation, no override row, run still green — the exact bug this
    // function exists to fix, with no signal. A throw is stronger than a check
    // because it stops the run at the cause instead of letting every later
    // assertion read a stale cache; it also surfaces a failed DELETE, which is
    // the only thing standing between this and a stranded override row.
    const posted = await raw(owner, path, "POST", {
      feature_key: KEY,
      reason: "smoke: drop cached entitlements after a raw entitlement write",
    });
    if (posted.status < 200 || posted.status >= 300) {
      throw new Error(
        `entitlement-cache bust POST failed (${posted.status}): ${JSON.stringify(posted.json)}`,
      );
    }
    const deleted = await raw(owner, path, "DELETE", { feature_key: KEY });
    if (deleted.status < 200 || deleted.status >= 300) {
      throw new Error(
        `entitlement-cache bust DELETE failed (${deleted.status}) — the ${KEY} override is stranded: ` +
          JSON.stringify(deleted.json),
      );
    }
  } finally {
    await setOwnerStaff(false);
  }
}

/** Flip an org's plan directly in the DB — smoke targets a disposable DB and
 *  the billing checkout path can't run without Stripe. `owner` (the org
 *  owner's session) is required, not optional: the raw-SQL write goes behind
 *  the resolver's back, so every flip must bust the entitlement cache or a
 *  Redis-backed target keeps serving the pre-flip answers for up to 300s. */
async function setPlan(orgId: string, plan: string, owner: Session): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to change a plan in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    // Billing lives on the GROUP (V310): reprice the group the org already bills
    // through, and only mint one — with the org's owner as payer — if it has none.
    const [org] = await sql<{ subscription_id: string | null }[]>`
      select subscription_id from organizations where id = ${orgId}`;
    if (org?.subscription_id) {
      await sql`
        update subscriptions
           set plan_key = ${plan}, status = 'active', updated_at = now()
         where id = ${org.subscription_id}`;
    } else {
      const [group] = await sql<{ id: string }[]>`
        insert into subscriptions (owner_user_id, plan_key, status)
        select coalesce(
                 (select m.user_id from org_members m
                   where m.org_id = o.id and m.role = 'owner'
                   order by m.created_at limit 1),
                 o.created_by),
               ${plan}, 'active'
          from organizations o where o.id = ${orgId}
        returning id`;
      await sql`update organizations set subscription_id = ${group!.id} where id = ${orgId}`;
    }
  } finally {
    await sql.end();
  }
  await bustOrgEntitlements(owner, orgId);
}

async function cleanup(tag: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("cleanup skipped (DATABASE_URL not set)");
    return;
  }
  const emails = [
    `admin_${tag}@example.com`,
    `viewer_${tag}@example.com`,
    `member_${tag}@example.com`,
    `scorer_${tag}@example.com`,
    `scorer2_${tag}@example.com`,
    `free_${tag}@example.com`,
    `walkin_${tag}@example.com`,
    // #402 — gapSuite's signed-in self-registrant. Its persons rows live in the
    // admin's Pro org and go with that org in the same delete statement above,
    // so nothing still references this user by the time the users delete runs.
    `selflink_${tag}@example.com`,
    `ui_free_${tag}@example.com`,
    `disc_free_${tag}@example.com`,
    `pass_${tag}@example.com`,
    `proplus_${tag}@example.com`,
    `funnel_${tag}@example.com`,
    `tos_${tag}@example.com`,
    `player_${tag}@example.com`,
    `ref_${tag}@example.com`,
    `p72_${tag}@example.com`,
    // #451 cricketDlsSuite — its own Pro org (two cricket divisions cascade).
    `dls_${tag}@example.com`,
    // #404 personMergeSuite — its own Pro org (its two persons, their
    // suspension and the person_merges ledger row all cascade with it).
    `dupmerge_${tag}@example.com`,
    `p72comm_${tag}@example.com`,
    `smoke-community-${tag}@example.com`,
    `smoke-pro-${tag}@example.com`,
    `smoke-proplus-${tag}@example.com`,
    `smoke-pass-${tag}@example.com`,
    // Task 23 — passGrantsSuite's own org (its two competitions, pass row,
    // sponsors, packages, person and AI ledger rows all cascade with it).
    `passgrant_${tag}@example.com`,
    // v17 #294 passRungLSuite — the community buyer (three competitions, two
    // bought passes, the +25 grants) and the Pro org holding an inert L pass.
    `passl_${tag}@example.com`,
    `passlpro_${tag}@example.com`,
    // Task 20 — the three extra users seeded per plan org (owner is above).
    ...["community", "pro", "proplus", "pass"].flatMap((k) => [
      `scorer_${k}_${tag}@example.com`,
      `official_${k}_${tag}@example.com`,
      `player_${k}_${tag}@example.com`,
    ]),
    `clubpro_${tag}@example.com`,
    `clubfree_${tag}@example.com`,
    `trial_staff_${tag}@example.com`,
    `trial_pro_${tag}@example.com`,
    `trial_free_${tag}@example.com`,
    `trial_dep_${tag}@example.com`,
    `pm_staff_${tag}@example.com`,
    `pm_owner_${tag}@example.com`,
    // The one-click email-invite claimee (auto-login + join). Its org_members
    // row is dropped inline after the claim assertions to free the seat; this
    // clears the leftover user row at teardown.
    `emailinvitee_${tag}@example.com`,
    // #267 referralSuite — referrer + referred, own orgs. Both rows go in the
    // same `delete from organizations` statement, so the self-referencing
    // `referred_by_org_id` FK (NO ACTION, checked at end-of-statement) never
    // trips: by the time it's checked, both rows are already gone together.
    `referrer_${tag}@example.com`,
    `referred_${tag}@example.com`,
    // #293 extraOrgAddonSuite — the Pro Plus payer (whose nine seeded fill
    // organisations carry created_by = this user and so go with the purge
    // below), the non-payer co-owner, and the community owner.
    `orgaddon_${tag}@example.com`,
    `orgaddon_nonpayer_${tag}@example.com`,
    `orgaddon_free_${tag}@example.com`,
  ];
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  let teardownError: string | null = null;
  try {
    // billing_events carries NO org FK (it is the raw Stripe ledger, keyed by
    // event id), so passRungLSuite's synthetic webhook rows survive the org
    // purge below. Dropped by the run's own `evt_smoke_<tag>_` prefix, which
    // cannot touch another run's rows or a real Stripe event.
    await sql`delete from billing_events where id like ${`evt_smoke_${tag}_%`}`;
    // org_addons.wallet_id is TEXT with NO foreign key (V323 — a wallet is
    // coalesce(group_subscription_id, org_id) and so cannot reference one
    // table), so #293's rider row outlives both its organisation and its
    // group. Dropped by this run's own stripe_item_id, which cannot match
    // another run's row nor a real Stripe item.
    await sql`delete from org_addons where stripe_item_id = ${`si_smoke_orgaddon_${tag}`}`;
    // sponsor_orders are RESTRICT (V299): money rows must go before their org.
    await sql`
      delete from sponsor_orders
      where org_id in (select id from organizations
                       where created_by in (select id from users where email = any(${emails})))`;
    const orgs = await sql`
      delete from organizations
      where created_by in (select id from users where email = any(${emails}))`;
    // Any test user the run turned into a staff ACTOR is deliberately left
    // behind. staff_audit_log.actor_id → users.id has no ON DELETE, so those
    // users cannot be dropped without first touching the audit log — and the
    // audit log must not be touched. V111 makes it tamper-EVIDENT: every row's
    // hash is chained to the previous one, and /admin/audit renders a permanent
    // "hash chain broken" banner as soon as verify_staff_audit_log_chain()
    // finds a mismatch. Deleting rows is exactly the tampering that design
    // exists to detect, and repointing actor_id is no better — the verifier
    // recomputes row_hash from the LIVE column values (actor_id among them),
    // while the trigger only fires `before insert`, so an UPDATE breaks the
    // chain just as permanently. Nothing repairs it afterwards. A handful of
    // leftover user rows per run is the cheaper cost by a wide margin.
    // That set is no longer two accounts. It is oneTrialSuite's staff account,
    // platformRevenueSuite's admin (the revenue page logs
    // revenue_report_viewed), AND the OWNER of every org that went through
    // setPlan or insertEntitlementOverride — both bust the entitlement cache
    // through the superadmin override route, which logs an
    // entitlement_override + entitlement_override_removed pair under that
    // owner's id. Measured on a full local run: 16 distinct owners become bust
    // actors (26 override/override_removed pairs), 19 distinct staff actors in
    // total — so ~19 retained user rows per run, up from ~2. It is the
    // accepted price of a bust that actually works: the alternative is a
    // dedicated staff account, which needs its own signIn, and
    // /api/auth/magic-link is rate limited to 5 per 300s per IP and fails
    // CLOSED wherever Redis is set. Do not engineer around the residue — the
    // subquery keeps this correct for any suite that becomes a staff writer
    // later, and their ORGS are still removed (the org purge above keys on the
    // same `emails` list).
    // Billing groups outlive their organisations (V310): organizations points
    // AT subscriptions, so dropping the orgs above leaves the group rows behind,
    // and subscriptions.owner_user_id → users(id) has no ON DELETE. Without this
    // the user delete below aborts on subscriptions_owner_fk and takes the whole
    // teardown with it. Only groups nobody is in — a group still holding an org
    // belongs to another run and must not be touched.
    await sql`
      delete from subscriptions s
      where s.owner_user_id in (select id from users where email = any(${emails}))
        and not exists (select 1 from organizations o where o.subscription_id = s.id)`;
    const users = await sql`
      delete from users
      where email = any(${emails})
        and id not in (select actor_id from staff_audit_log)`;
    console.log(`cleanup: removed ${orgs.count} org(s), ${users.count} user(s)`);
  } catch (e) {
    // Recorded, not swallowed. The check below is the guard against a teardown
    // that damages the audit trail, and the symptom that motivated it WAS a
    // teardown abort (the staff_audit_log FK violation) — so an abort has to
    // make that check red, never a warning line next to a green run.
    teardownError = e instanceof Error ? e.message : String(e);
    console.warn("cleanup failed:", teardownError);
  }
  // Deliberately OUTSIDE the try above, so a throw in the deletes still reaches
  // this assertion. Its own failures are caught the same way, for the same
  // reason: an unreadable audit table is a red check, not a silent skip.
  let audit: { mine: number; broken: string | null } | undefined;
  try {
    [audit] = await sql<{ mine: number; broken: string | null }[]>`
      select (select count(*)::int from staff_audit_log
              where actor_id in (select id from users where email = any(${emails}))) as mine,
             verify_staff_audit_log_chain()::text as broken`;
  } catch (e) {
    console.warn("audit-trail probe failed:", e instanceof Error ? e.message : e);
  } finally {
    await sql.end();
  }
  // Teardown must complete AND leave the audit trail alone. Every conjunct can
  // fail on a different real regression:
  //  - teardownError — the deletes threw (the original symptom: the
  //    staff_audit_log FK aborting the whole purge);
  //  - audit.mine > 0 — the run's own audit rows were deleted, which is what a
  //    teardown that purges them (the fix this replaced) does;
  //  - audit.broken === null — the V111 hash chain no longer verifies, which is
  //    what a MID-chain deletion does. On its own this conjunct is NOT enough:
  //    the run's rows sit at the TIP of the chain on a quiet DB, and lopping off
  //    the tail still verifies — the corruption only becomes permanent once
  //    anything else (a parallel e2e run, a real staff action) has written after
  //    them. All three together are the honest assertion.
  check(
    "cleanup completes and keeps the staff audit trail (rows survive, V111 chain verifies)",
    teardownError === null && !!audit && audit.mine > 0 && audit.broken === null,
  );
}

main()
  .then(async () => {
    await cleanup(tag);
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("ERROR:", e.message);
    await cleanup(tag);
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(1);
  });

// --- v13 real-competition fidelity (PROMPT-59/60/61/62/63/64/66) -----------
// Pro path on the given org; the free path flips the SAME org to community
// for the audit 402 (cheapest honest gate check) and flips back.
async function v13Suite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `V13 Cup ${tag}`,
      visibility: "public",
    }),
  );

  // --- PROMPT-60: badge on create (echoed) + inline new-person members.
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const badged = await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", {
    kind: "team",
    display_name: `Mexico ${tag}`,
    badge_url: "https://flags.example/mex.png",
    members: [
      { new_person: { full_name: `Striker ${tag}` }, squad_number: 9 },
      { new_person: { full_name: `Keeper ${tag}` }, squad_number: 1 },
    ],
  });
  check("v13 entrant carries badge_url + inline members (201)", badged.status === 201);
  const badgedRow = v1data<
    { badge_url: string | null; id: string }[] | { badge_url: string | null; id: string }
  >(badged);
  const badgedOne = Array.isArray(badgedRow) ? badgedRow[0]! : badgedRow;
  check(
    "v13 badge_url echoed on the created entrant",
    badgedOne.badge_url === "https://flags.example/mex.png",
  );
  // --- PROMPT-66: league stage takes an ad-hoc match; it scores + counts.
  const others: string[] = [];
  for (const name of ["B", "C", "D"]) {
    const row = await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", {
      kind: "team",
      display_name: `${name} ${tag}`,
    });
    const data = v1data<{ id: string }[] | { id: string }>(row);
    others.push(Array.isArray(data) ? data[0]!.id : data.id);
  }
  const league = await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const leagueId = v1data<{ id: string }>(league).id;
  await v1(admin, `/api/v1/stages/${leagueId}/generate`, "POST");
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");
  const adhoc = await v1(admin, `/api/v1/stages/${leagueId}/fixtures`, "POST", {
    home_entrant_id: badgedOne.id,
    away_entrant_id: others[0]!,
  });
  check("v13 addFixture on a league stage (201)", adhoc.status === 201);
  const adhocId = v1data<{ fixture_id: string }>(adhoc).fixture_id;
  await v1(admin, `/api/v1/fixtures/${adhocId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  const adhocScore = await v1(admin, `/api/v1/fixtures/${adhocId}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 0 },
  });
  check("v13 ad-hoc match scores like any other", adhocScore.status === 201);

  // --- PROMPT-61: a knockout can't finalize level; PROMPT-62: bracket PDF.
  const kdiv = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Knockout",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  for (const name of ["KA", "KB", "KC", "KD"]) {
    await v1(admin, `/api/v1/divisions/${kdiv.id}/entrants`, "POST", {
      kind: "team",
      display_name: `${name} ${tag}`,
    });
  }
  const ko = await v1(admin, `/api/v1/divisions/${kdiv.id}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "KO",
  });
  const koId = v1data<{ id: string }>(ko).id;
  const kgen = await v1(admin, `/api/v1/stages/${koId}/generate`, "POST");
  const kf = v1data<{ fixtures: { id: string }[] }>(kgen).fixtures[0]!;
  await v1(admin, `/api/v1/divisions/${kdiv.id}/start`, "POST");
  await v1(admin, `/api/v1/fixtures/${kf.id}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  const level = await v1(admin, `/api/v1/fixtures/${kf.id}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 1, p2Score: 1 },
  });
  check("v13 knockout refuses a level result (422 DRAW_NOT_ALLOWED)", level.status === 422);
  const decided = await v1(admin, `/api/v1/fixtures/${kf.id}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  check("v13 decisive knockout result lands", decided.status === 201);

  const poster = await fetch(`${BASE}/api/v1/divisions/${kdiv.id}/exports/bracket?format=pdf`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const posterBytes = Buffer.from(await poster.arrayBuffer());
  check(
    "v13 bracket poster exports a PDF",
    poster.status === 200 && posterBytes.subarray(0, 5).toString() === "%PDF-",
  );

  // --- PROMPT-63: audit trail — Pro 200 (verified + signature field), free 402.
  const audit = await v1(admin, `/api/v1/fixtures/${kf.id}/audit`, "GET");
  check("v13 audit trail downloads on Pro", audit.status === 200);
  const auditData = v1data<{ verified: boolean; head_hash: string | null; signature: unknown }>(audit);
  check("v13 audit chain verifies with a head hash", auditData.verified === true && auditData.head_hash !== null);
  check("v13 audit carries the signature field (null without a key, never absent)", "signature" in auditData);
  await setPlan(proOrgId, "community", admin);
  const gated = await v1(admin, `/api/v1/fixtures/${kf.id}/audit`, "GET");
  check("v13 audit is Pro-gated (402 on community)", gated.status === 402);
  await setPlan(proOrgId, "pro", admin);

  const keys = await fetch(`${BASE}/.well-known/seazn-audit-keys`);
  check("v13 audit verify keys are public", keys.status === 200);

  // --- PROMPT-64: no-login presentation mode renders for the public comp.
  const present = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}/present`);
  check(
    "v13 presentation mode renders without login",
    present.status === 200 && present.body.includes(`V13 Cup ${tag}`),
  );

  // --- entrant shapes (spec 2026-07-18): the sport presets the entrant shape,
  // Settings → Entrants overrides it per division, and the in-use guard blocks
  // narrowing kinds while a live entrant of that kind still exists.
  const esDbUrl = process.env.DATABASE_URL;
  if (esDbUrl) {
    // Local-run fallback (CI runs sync:sports): seed the board-game catalog so
    // the division create below resolves its sport + variant.
    const esDb = postgres(esDbUrl, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl:
        process.env.DATABASE_SSL === "disable"
          ? false
          : /@(localhost|127\.0\.0\.1)[:/]/.test(esDbUrl)
            ? false
            : "require",
      prepare: !esDbUrl.includes(":6543"),
      max: 1,
    });
    await esDb`insert into sports (key, name, module_version, position_catalog)
               values ('boardgame', 'Board game', '1.0.0', ${esDb.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
               on conflict (key) do nothing`;
    await esDb`insert into sport_variants (sport_key, key, name, config, is_system)
               values ('boardgame', 'classical', 'Classical', ${esDb.json({})}, true)
               on conflict do nothing`;
    await esDb.end();
  }

  // Board game presets individual-only (entrantModel kinds: ['individual']).
  const bgConfig = { colors: true };
  const bgDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Chess",
      sport_key: "boardgame",
      variant_key: "classical",
      config: bgConfig,
    }),
  );
  // A 2-person roster overflows the structural individual cap of 1.
  const esTooBig = await v1(admin, `/api/v1/divisions/${bgDiv.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `Overflow ${tag}`,
    members: [
      { new_person: { full_name: `P1 ${tag}` } },
      { new_person: { full_name: `P2 ${tag}` } },
    ],
  });
  check(
    "entrant-shapes: 2-person individual rejected (422 ENTRANT_ROSTER_TOO_BIG)",
    esTooBig.status === 422 && esTooBig.json.error?.code === "ENTRANT_ROSTER_TOO_BIG",
  );
  // A single-person individual is exactly one seat — accepted, name echoed.
  const esSolo = await v1(admin, `/api/v1/divisions/${bgDiv.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `Magnus ${tag}`,
    members: [{ new_person: { full_name: `Magnus ${tag}` } }],
  });
  check("entrant-shapes: single-person individual accepted (201)", esSolo.status === 201);
  const esSoloRow = v1data<{ display_name: string }[] | { display_name: string }>(esSolo);
  const esSoloOne = Array.isArray(esSoloRow) ? esSoloRow[0]! : esSoloRow;
  check(
    "entrant-shapes: display_name echoed on the created individual",
    esSoloOne.display_name === `Magnus ${tag}`,
  );

  // A team entrant is refused until Settings widens the division's kinds.
  const esTeamBlocked = await v1(admin, `/api/v1/divisions/${bgDiv.id}/entrants`, "POST", {
    kind: "team",
    display_name: `Squad ${tag}`,
  });
  check(
    "entrant-shapes: team refused before widening (422 ENTRANT_KIND_NOT_ALLOWED)",
    esTeamBlocked.status === 422 && esTeamBlocked.json.error?.code === "ENTRANT_KIND_NOT_ALLOWED",
  );
  // Settings → Entrants override: widen kinds to allow teams. The config is
  // written wholesale, so re-send the full config with the entrants block.
  const esWiden = await v1(admin, `/api/v1/divisions/${bgDiv.id}`, "PATCH", {
    config: {
      ...bgConfig,
      entrants: { kinds: ["individual", "team"], defaultKind: "individual" },
    },
  });
  check("entrant-shapes: widening kinds via config PATCH (200)", esWiden.status === 200);
  const esTeamOk = await v1(admin, `/api/v1/divisions/${bgDiv.id}/entrants`, "POST", {
    kind: "team",
    display_name: `Squad ${tag}`,
  });
  check("entrant-shapes: team accepted after widening (201)", esTeamOk.status === 201);

  // Guard: narrowing kinds back to individual-only while that team entrant is
  // live is refused — organisers must withdraw it first.
  const esNarrow = await v1(admin, `/api/v1/divisions/${bgDiv.id}`, "PATCH", {
    config: {
      ...bgConfig,
      entrants: { kinds: ["individual"], defaultKind: "individual" },
    },
  });
  check(
    "entrant-shapes: narrowing under a live team refused (422 ENTRANT_KIND_IN_USE)",
    esNarrow.status === 422 && esNarrow.json.error?.code === "ENTRANT_KIND_IN_USE",
  );
}

// --- Page playoffs (IPL / spec 2026-07-19): template stages, feed wiring,
// second-life resolution — Q1's loser must land in Q2.
async function pagePlayoffSuite(admin: Session): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `PP Cup ${tag}` }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Playoffs",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const seeds = ["PP One", "PP Two", "PP Three", "PP Four"];
  await v1(
    admin,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    seeds.map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "page_playoff",
      name: "Playoffs",
    }),
  );
  const gen = await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST");
  const fixtures = v1data<{
    fixtures: {
      id: string;
      round_no: number;
      seq_in_round: number;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
    }[];
  }>(gen).fixtures;
  check("pp generates the four playoff fixtures", fixtures.length === 4);
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  const entrants = v1data<{ id: string; display_name: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`),
  );
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const q1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
  const elim = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 2)!;
  check(
    "pp Q1 is 1 v 2",
    q1.home_entrant_id === byName.get("PP One") && q1.away_entrant_id === byName.get("PP Two"),
  );
  check(
    "pp Eliminator is 3 v 4",
    elim.home_entrant_id === byName.get("PP Three") &&
      elim.away_entrant_id === byName.get("PP Four"),
  );

  // Decide Q1 (Two beats One) + the Eliminator (Three wins) → Q2 must pair
  // One (Q1 loser) with Three (Eliminator winner); the Final holds Two.
  const decide = async (fid: string, a: number, b: number) => {
    const st = v1data<{ last_seq: number }>(await v1(admin, `/api/v1/fixtures/${fid}/state`));
    return v1(admin, `/api/v1/fixtures/${fid}/events`, "POST", {
      expected_seq: st.last_seq ?? 0,
      type: "generic.result",
      payload: { p1Score: a, p2Score: b },
    });
  };
  await decide(q1.id, 1, 2);
  await decide(elim.id, 3, 0);
  const q2f = v1data<{
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  }>(await v1(admin, `/api/v1/fixtures/${fixtures.find((f) => f.round_no === 2)!.id}`));
  check(
    "pp Q2 = Q1 loser vs Eliminator winner",
    q2f.home_entrant_id === byName.get("PP One") && q2f.away_entrant_id === byName.get("PP Three"),
  );
  const finF = v1data<{ home_entrant_id: string | null }>(
    await v1(admin, `/api/v1/fixtures/${fixtures.find((f) => f.round_no === 3)!.id}`),
  );
  check("pp Final home = Q1 winner", finF.home_entrant_id === byName.get("PP Two"));
}
