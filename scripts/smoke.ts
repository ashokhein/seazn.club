// End-to-end smoke test against the running dev server (http://localhost:3000).
// Run with: node --experimental-strip-types scripts/smoke.ts
//
// Teardown: when DATABASE_URL is set (CI, or `node --env-file=.env.local`), the
// run's own test users + their orgs are purged afterwards (see cleanup). The DB
// must be the same one the target server uses.
import postgres from "postgres";
import { startAiFixtureServer, type AiFixtureServer } from "../apps/web/e2e/ai-fixture-server.ts";

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
  json: { ok: boolean; data?: unknown; error?: string };
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
  const comp = await v1(admin, "/api/v1/competitions", "POST", {
    name: `Perm Probe ${tag}`,
  });
  check("owner creates competition", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;

  const del = await v1(admin, `/api/v1/competitions/${compId}`, "DELETE");
  check("unscored competition deletable", del.status === 200 || del.status === 204);
  const gone = await v1(admin, `/api/v1/competitions/${compId}`);
  check("deleted competition gone", gone.status === 404);

  // A competition to probe viewer permissions against.
  const probe = await v1(admin, "/api/v1/competitions", "POST", {
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
  const viewerWrite = await v1(viewer, "/api/v1/competitions", "POST", {
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
  const memberComp = await v1(member, "/api/v1/competitions", "POST", {
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
      org2Ent.entitlements["scheduling.ai.runs_per_division.max"]?.limit === 20,
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
    const detached = (await call(admin, "/api/billing/group/detach", "POST", {
      org_id: org2.id,
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

  // --- v10 sponsor CRM: tiers + placement + tracked clicks + Connect rail
  // on the pro org; flat free strip + 402 gates on a fresh community owner.
  await sponsorsSuite(admin, org2.id, renamed.slug);

  // --- v13 real-competition fidelity: badge + inline members, ad-hoc match,
  // knockout draw guard, bracket poster, signed audit (pro 200 / free 402),
  // public presentation mode.
  await v13Suite(admin, org2.id, renamed.slug);

  // --- v4 AI Schedule Architect (Task 18): two-phase happy path on a fresh Pro
  // Plus org (schedule ai-plan → apply+ledger → ai-last → officials draft) plus
  // the graded run-cap 402 and an admin-override lift on a fresh community org.
  // The T17 fixture server stands in for the model (needs the server booted with
  // SCHEDULING_AI_BASE_URL); the cap 402 is keyless-safe and always runs.
  await v4AiSuite(admin, org2.id, renamed.slug);

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
      await v1(owner, "/api/v1/competitions", "POST", {
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
  await grantPass(orgId, passComp.id);
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
    await v1(comm, "/api/v1/competitions", "POST", {
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
    await v1(comm, "/api/v1/competitions", "POST", { name: `P72 Open Card Cup ${tag}`, visibility: "unlisted" }),
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
  // V302: the AI Schedule Architect is granted on EVERY plan; only the
  // per-division generation quota is graded (community 5).
  check(
    "matrix/community: scheduling.ai is granted on every plan (V302)",
    commEnt.entitlements["scheduling.ai"]?.enabled === true,
  );
  check(
    "matrix/community: scheduling.ai.runs_per_division.max resolves 5",
    commEnt.entitlements["scheduling.ai.runs_per_division.max"]?.limit === 5,
  );

  // A scored-through division so a real export renders.
  const cComp = v1data<{ id: string; slug: string }>(
    await v1(comm, "/api/v1/competitions", "POST", {
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

  // The graded run cap is the paid boundary now (not the feature itself): seed
  // 5 prior runs on this division → the 6th ai-plan 402s at the cap BEFORE any
  // model call (keyless-safe), and the 402 carries the contextual upgrade prompt
  // the UpgradeGate renders.
  await seedAiRuns(commOrg, cComp.id, cDiv.id, 5);
  const commAi = await v1(comm, `/api/v1/divisions/${cDiv.id}/schedule/ai-plan`, "POST", {
    instruction: "two courts, weekday evenings only",
  });
  const commAiErr = featureKey(commAi);
  check(
    "matrix/community: the 6th AI run/division 402s at the graded cap (scheduling.ai.runs_per_division.max)",
    commAi.status === 402 && commAiErr.feature_key === "scheduling.ai.runs_per_division.max",
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
    "matrix/pro: scheduling.ai.runs_per_division.max resolves 20 (V302)",
    proEnt.entitlements["scheduling.ai.runs_per_division.max"]?.limit === 20,
  );
  check(
    "matrix/pro: officials.per_fixture.max is unlimited (null)",
    proEnt.entitlements["officials.per_fixture.max"]?.limit === null,
  );

  // Behavioural proof of the cap: seed 20 prior AI runs on a division, the 21st
  // 402s at the cap (fires before the LLM → keyless-safe).
  const proComp = v1data<{ id: string }>(
    await v1(pro, "/api/v1/competitions", "POST", {
      name: `Matrix Pro ${tag}`,
    }),
  );
  const proDiv = v1data<{ id: string }>(
    await v1(pro, `/api/v1/competitions/${proComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await seedAiRuns(proOrg, proComp.id, proDiv.id, 20);
  const proCapped = await v1(pro, `/api/v1/divisions/${proDiv.id}/schedule/ai-plan`, "POST", {
    instruction: "spread evenly across both courts",
  });
  check(
    "matrix/pro: the 21st AI run/division 402s at the cap (scheduling.ai.runs_per_division.max)",
    proCapped.status === 402 &&
      featureKey(proCapped).feature_key === "scheduling.ai.runs_per_division.max",
  );

  // === PERSONA 3 — pro_plus ============================================
  const plus = newSession();
  const plusOrg = (await signIn(plus, `smoke-proplus-${tag}@example.com`)).org_id;
  await setPlan(plusOrg, "pro_plus", plus);
  const plusEnt = await readEnt(plus, plusOrg);
  check("matrix/pro_plus: org resolves the pro_plus plan", plusEnt.plan_key === "pro_plus");
  check(
    "matrix/pro_plus: scheduling.ai.runs_per_division.max resolves 50 (V302)",
    plusEnt.entitlements["scheduling.ai.runs_per_division.max"]?.limit === 50,
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
    await v1(plus, "/api/v1/competitions", "POST", {
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
  await v1(plus, `/api/v1/stages/${plusStage.id}/generate`, "POST");
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

  // === PERSONA 4 — event_pass (community org + a single-comp pass) ======
  const passer = newSession();
  const passOrg = (await signIn(passer, `smoke-pass-${tag}@example.com`)).org_id;

  // Passed comp: create, then grant its pass. Unlisted sidesteps the public
  // dashboard cap; the pass frees the active-comp slot for the sibling below.
  const passedComp = v1data<{ id: string; slug: string }>(
    await v1(passer, "/api/v1/competitions", "POST", {
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
  await grantPass(passOrg, passedComp.id);

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
    await v1(passer, "/api/v1/competitions", "POST", {
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
    "matrix/event_pass: org-wide members.max resolves the community value (3)",
    passEnt.entitlements["members.max"]?.limit === 3,
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
 * fail for the right reason — "allowed at 64" alone passes on a plan with no
 * ceiling at all, and "refused at 65" alone passes on Community's 32.
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
 *  • "the 32-entrant cap" — V311 raised Community to 32 and the pass to 64.
 *    Asserting 32 asserts what a passless community org already gets.
 * The live matrix (`set search_path = seazn_club`; the `public` schema holds a
 * stale pre-v3 copy) is the authority for every figure below.
 *
 * ── Keyless- and model-safe ────────────────────────────────────────────────
 * Nothing here needs Stripe, and nothing spends an Anthropic token. The AI
 * probes run `mode: "repair"` against a division with no movable fixtures, so
 * the request dies at AI_PLAN_EMPTY_SCOPE inside buildSchedulePack — which sits
 * AFTER the quota gate and BEFORE the model call, making "not capped" and
 * "capped" cleanly distinguishable for free.
 */
async function passGrantsSuite(): Promise<void> {
  const genericDiv = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  const featureKey = (r: V1Res) => (r.json.error as { feature_key?: string } | undefined)?.feature_key;
  const errCode = (r: V1Res) => r.json.error?.code;

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
      await v1(s, "/api/v1/competitions", "POST", { name: `${name} ${tag}`, visibility: "unlisted" }),
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
  await grantPass(orgId, passComp.id);
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

  // === entrants.per_division.max — community 32, pass 64 =================
  const passCap = await mkDiv(passComp.id, "Entrant Cap");
  const plainCap = await mkDiv(plainComp.id, "Entrant Cap");
  const passTo64 = await v1(s, `/api/v1/divisions/${passCap.id}/entrants`, "POST", entrants(64, 1, "P"));
  const pass65 = await v1(s, `/api/v1/divisions/${passCap.id}/entrants`, "POST", entrants(1, 65, "P"));
  const plainTo32 = await v1(s, `/api/v1/divisions/${plainCap.id}/entrants`, "POST", entrants(32, 1, "C"));
  const plain33 = await v1(s, `/api/v1/divisions/${plainCap.id}/entrants`, "POST", entrants(1, 33, "C"));
  check(
    "pass grants/entrants: the passed competition seats 64 — past community's 32",
    passTo64.status === 201,
  );
  check(
    "pass grants/entrants: the 65th is refused (the pass ceiling is 64, not unlimited)",
    pass65.status === 402 && featureKey(pass65) === "entrants.per_division.max",
  );
  check(
    "pass grants/entrants: the sibling competition seats 32 (community's own cap)",
    plainTo32.status === 201,
  );
  check(
    "pass grants/entrants: the sibling is refused at 33 — the 64 did not leak org-wide",
    plain33.status === 402 && featureKey(plain33) === "entrants.per_division.max",
  );

  // === scheduling.ai.runs_per_division.max — community 5, pass 10 =========
  // Three probes bracket the number exactly: 6th admitted on the pass, 11th
  // refused on the pass, 6th refused on the sibling. Seeding only one side
  // would pass whether the grant were 10 or unchanged at 5.
  const passAiDiv = await mkDiv(passComp.id, "AI Five");
  await seedAiRuns(orgId, passComp.id, passAiDiv.id, 5);
  await seedAiRuns(orgId, passComp.id, passCap.id, 10);
  await seedAiRuns(orgId, plainComp.id, plainCap.id, 5);
  const emptyRepair = {
    instruction: "smoke probe: repair with nothing movable in scope",
    mode: "repair",
    scope: { courts: [] },
  };
  const passAi6 = await v1(s, `/api/v1/divisions/${passAiDiv.id}/schedule/ai-plan`, "POST", emptyRepair);
  const passAi11 = await v1(s, `/api/v1/divisions/${passCap.id}/schedule/ai-plan`, "POST", emptyRepair);
  const plainAi6 = await v1(s, `/api/v1/divisions/${plainCap.id}/schedule/ai-plan`, "POST", emptyRepair);
  check(
    "pass grants/ai: the 6th run/division is ADMITTED on the passed competition (past community's 5)",
    passAi6.status === 422 && errCode(passAi6) === "AI_PLAN_EMPTY_SCOPE",
  );
  check(
    "pass grants/ai: the 11th run/division is refused (the pass ceiling is 10)",
    passAi11.status === 402 && featureKey(passAi11) === "scheduling.ai.runs_per_division.max",
  );
  check(
    "pass grants/ai: the sibling is refused at its 6th — the 10 did not leak org-wide",
    plainAi6.status === 402 && featureKey(plainAi6) === "scheduling.ai.runs_per_division.max",
  );

  // === divisions.per_competition.max — community 2, pass 10 ===============
  // The passed competition already holds three (Board, Entrant Cap, AI Five);
  // that third one is itself the proof it is past community's 2, because the
  // sibling — same org, same day — is refused its third below.
  const plainThird = await v1(s, `/api/v1/competitions/${plainComp.id}/divisions`, "POST", {
    name: "Third",
    ...genericDiv,
  });
  check(
    "pass grants/divisions: the sibling competition is refused a 3rd division (community's cap is 2)",
    plainThird.status === 402 && featureKey(plainThird) === "divisions.per_competition.max",
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
    "pass grants/divisions: the passed competition takes all 10 (past community's 2)",
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
    "pass grants/scope: every quota stays at the community figure org-wide (32/2/5 entrants/divisions/AI, fee 8%)",
    ent.entitlements["entrants.per_division.max"]?.limit === 32 &&
      ent.entitlements["divisions.per_competition.max"]?.limit === 2 &&
      ent.entitlements["scheduling.ai.runs_per_division.max"]?.limit === 5 &&
      ent.entitlements["registration.fee_percent"]?.limit === 8,
  );
}

/** clubs-w1 (W1 §5): parent clubs group teams across divisions. The Pro path
 *  walks the whole /clubs/[id] hub lifecycle over HTTP — create a club, PATCH
 *  its profile (home ground), add a committee contact, create a *standalone*
 *  team, move it under the club, then replace its squad with a person created
 *  inline (the squad editor's quick-add). The free path proves the V292
 *  community cap: clubs.max = 2, so two clubs succeed and the third 402s with
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
  const syncComp = await v1(pro, "/api/v1/competitions", "POST", {
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

  // --- Free path: the tunable community clubs.max = 2 (V292). Two clubs land,
  // the third 402s with the feature key that drives the paywall.
  const free = newSession();
  await signIn(free, `clubfree_${tag}@example.com`);
  const c1 = await v1(free, "/api/v1/clubs", "POST", {
    name: `Free Club One ${tag}`,
  });
  const c2 = await v1(free, "/api/v1/clubs", "POST", {
    name: `Free Club Two ${tag}`,
  });
  check("clubs free: first two clubs allowed on community", c1.status === 201 && c2.status === 201);
  const c3 = await v1(free, "/api/v1/clubs", "POST", {
    name: `Free Club Three ${tag}`,
  });
  check(
    "clubs free: third club 402s with the clubs.max feature key",
    c3.status === 402 &&
      (c3.json.error as { feature_key?: string } | undefined)?.feature_key === "clubs.max",
  );
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

  const comp = await v1(admin, "/api/v1/competitions", "POST", {
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
  const comp = await v1(admin, "/api/v1/competitions", "POST", {
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

  const busyComp = await v1(admin, "/api/v1/competitions", "POST", {
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
      await v1(owner, "/api/v1/competitions", "POST", {
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
  check("marks free: rating is gated 402 (Pro officials.marks)", freeMark.status === 402);
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(commOwner, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(free, "/api/v1/competitions", "POST", {
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

  const comp = await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", {
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

/** Insert an Event Pass row directly (v3/07 §3) — smoke targets a disposable
 *  DB and the one-time Stripe checkout can't run without Stripe; the same
 *  SQL-flip convention as setPlan. */
async function grantPass(orgId: string, competitionId: string): Promise<void> {
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
      insert into competition_passes (competition_id, org_id)
      values (${competitionId}, ${orgId})
      on conflict (competition_id) do nothing`;
  } finally {
    await sql.end();
  }
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

/** payments-hardening Task 15 (Pro AI cap): seed N prior `schedule.ai_generated`
 *  competition_events for a division — the per-division AI cap counts exactly
 *  these. Mirrors schedule-plus.test.ts's seed; the LLM can't run headless, so
 *  we seed the ledger the cap reads and let the (cap+1)th request 402 BEFORE the
 *  model call (keyless-safe). */
async function seedAiRuns(
  orgId: string,
  competitionId: string,
  divisionId: string,
  n: number,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed AI runs in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    for (let i = 0; i < n; i++) {
      await sql`
        insert into competition_events (competition_id, org_id, type, payload)
        values (${competitionId}, ${orgId}, 'schedule.ai_generated',
                ${sql.json({ division_id: divisionId })})`;
    }
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
 *  scheduling.ai.runs_per_division.max).
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
 *  stage, two-court schedule settings, fixtures generated. Returns its ids. */
async function seedPlannableAiDivision(
  s: Session,
  label: string,
): Promise<{ compId: string; divId: string; stageId: string }> {
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { name: `${label} ${tag}` }),
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
      startAt: "2026-10-01T09:00:00.000Z",
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

interface AiPlanResponseLite {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string }[];
  diff: unknown;
  summary: string;
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number };
  officials_coverage: unknown;
}

/** design/v4 (Task 18): the AI Schedule Architect end-to-end over HTTP.
 *
 *  A fresh Pro Plus org walks the two-phase happy path — schedule ai-plan
 *  (proposal shape + a schedule.ai_generated ledger row stamping model/usage/
 *  cost_usd) → apply with the `ai` provenance block → ai-last recall → officials
 *  ai-plan with an EMPTY instruction (zero-token solver draft →
 *  schedule.ai_officials_generated stamped model "solver-draft"). A fresh
 *  community org proves the graded per-division run cap (seed 5 → the 6th 402s at
 *  scheduling.ai.runs_per_division.max, before any model spend) and that an admin
 *  entitlement override lifts it (→ 200).
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
    // ---- Free path: the graded run cap (keyless — 402 fires before any model) ----
    const free = newSession();
    const freeOrg = (await signIn(free, `smoke-ai-free-${tag}@example.com`)).org_id;
    const freeDivIds = await seedPlannableAiDivision(free, "AI Free");
    await seedAiRuns(freeOrg, freeDivIds.compId, freeDivIds.divId, 5);
    const capped = await v1(
      free,
      `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-plan`,
      "POST",
      {
        instruction: "spread the fixtures across both courts",
      },
    );
    check(
      "v4 AI/free: the 6th run/division 402s at the graded cap (scheduling.ai.runs_per_division.max)",
      capped.status === 402 &&
        (capped.json.error as { feature_key?: string } | undefined)?.feature_key ===
          "scheduling.ai.runs_per_division.max",
    );

    // ---- Admin override lifts the cap → the next run is admitted (needs model) ----
    await insertEntitlementOverride(free, freeOrg, "scheduling.ai.runs_per_division.max", 6);
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
        "v4 AI/override: an entitlement override lifts the cap → the next run is admitted (200 + proposal)",
        lifted.status === 200 && Array.isArray(v1data<AiPlanResponseLite>(lifted).proposal),
      );
    }

    // ---- Pro Plus two-phase happy path (schedule + officials) — needs the model ----
    if (fixture) {
      const plus = newSession();
      const plusOrg = (await signIn(plus, `smoke-ai-plus-${tag}@example.com`)).org_id;
      await setPlan(plusOrg, "pro_plus", plus);
      const { compId, divId, stageId } = await seedPlannableAiDivision(plus, "AI Plus");
      await v1(plus, "/api/v1/officials", "POST", {
        display_name: `AI Ref ${tag}`,
        role_keys: ["referee"],
      });

      const instruction = "finish by 6pm, keep both courts busy";
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

      const genEvent = await latestCompetitionEvent(compId, "schedule.ai_generated");
      check(
        "v4 AI/plus: schedule.ai_generated ledger row stamps model + usage + cost_usd",
        !!genEvent &&
          typeof genEvent.model === "string" &&
          !!genEvent.usage &&
          typeof genEvent.cost_usd === "number",
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
        "v4 AI/plus: ai-last reports the generation budget (1 used of pro_plus 50)",
        lastData?.runs?.used === 1 && lastData?.runs?.max === 50,
      );

      const offRes = await v1(plus, `/api/v1/divisions/${divId}/officials/ai-plan`, "POST", {
        instruction: "",
        policy: { roles: ["referee"] },
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
    }
  } finally {
    await fixture?.close();
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
    await v1(owner, "/api/v1/competitions", "POST", {
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

  // (a) Community: a fixture already covers ONE official free on every plan
  // (Jul3/02 §5) — a 2nd distinct official on the SAME fixture 402s.
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
  const officialsDenied = await setTwoOfficials();
  check(
    "pp: community 402s a 2nd official on one fixture (officials.per_fixture.max)",
    officialsDenied.status === 402 &&
      (officialsDenied.json.error as { feature_key?: string } | undefined)?.feature_key ===
        "officials.per_fixture.max",
  );

  // (a) Community: the 1st save point is free, the 2nd 402s.
  const cp1 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `plus 1 ${tag}`,
  });
  check("pp: community's first save point is free", cp1.status === 201);
  const cp2 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `plus 2 ${tag}`,
  });
  check(
    "pp: community 402s a 2nd save point (schedule.checkpoints.max)",
    cp2.status === 402 &&
      (cp2.json.error as { feature_key?: string } | undefined)?.feature_key ===
        "schedule.checkpoints.max",
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

  // Free caps (v3.1 matrix, V311): community now runs up to 5 active
  // competitions (was 1), still 2 divisions inside each. The pass lifts the
  // per-competition DIVISION cap — that is the boundary this test drives below.
  const compA = v1data<{ id: string; slug: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", {
      name: `Pass Cup ${tag}`,
    }),
  );
  const secondComp = await v1(buyer, "/api/v1/competitions", "POST", {
    name: `Second Cup ${tag}`,
  });
  check("p36: 2nd active competition allowed on free (V311 raised the cap to 5)", secondComp.status === 201);
  for (const name of ["Div 1", "Div 2"]) {
    const d = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
      name,
      ...genericDivision,
    });
    check(`p36: free org creates ${name.toLowerCase()}`, d.status === 201);
  }
  const div3Blocked = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 3",
    ...genericDivision,
  });
  check("p36: 3rd division blocked on free (402)", div3Blocked.status === 402);

  // Event Pass on comp A lifts ITS per-competition caps — the 3rd division it
  // just refused now lands.
  await grantPass(orgId, compA.id);
  const div3 = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 3",
    ...genericDivision,
  });
  check("p36: pass lifts division cap on the passed comp", div3.status === 201);
  const compB = v1data<{ id: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", {
      name: `Sibling Cup ${tag}`,
    }),
  );
  check("p36: a sibling competition is created (community runs several)", !!compB.id);

  // …while the sibling competition — no pass — stays on the community DIVISION
  // cap, proving the pass is scoped to comp A and not the org.
  for (const name of ["S1", "S2"]) {
    await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
      name,
      ...genericDivision,
    });
  }
  const sibBlocked = await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
    name: "S3",
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
    name: "S3",
    ...genericDivision,
  });
  check("p36: pro lifts the sibling comp", sibUnderPro.status === 201);

  // Downgrade: the pass survives — comp A keeps its 10-division headroom.
  await setPlan(orgId, "community", buyer);
  const afterDowngrade = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 4",
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
    upgradePage.status === 200 && upgradePage.body.includes("data-pass-active"),
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(free, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(free, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(free, "/api/v1/competitions", "POST", {
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
    error?: { code?: string; message?: string; current_seq?: number };
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
  const comp = await v1(admin, "/api/v1/competitions", "POST", {
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
      { name: "Nope" },
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
  // divisions.per_competition quota is 2 (v3 matrix), and DELETE frees a
  // slot. Creating the org switches the active-org cookie onto it.
  await call(admin, "/api/orgs", "POST", { name: `Del Org ${tag}` });
  const comp = await v1(admin, "/api/v1/competitions", "POST", {
    name: `Del Cup ${tag}`,
  });
  const compId = v1data<{ id: string }>(comp).id;
  const first = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "First",
    ...genericDivision,
  });
  check("del: free org creates division 1", first.status === 201);
  const firstId = v1data<{ id: string }>(first).id;
  await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Filler",
    ...genericDivision,
  });
  const blocked = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Second",
    ...genericDivision,
  });
  check("del: division 3 blocked on free (402)", blocked.status === 402);

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
  const proComp = await v1(admin, "/api/v1/competitions", "POST", {
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
  const comp = await v1(admin, "/api/v1/competitions", "POST", {
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
  const privComp = await v1(admin, "/api/v1/competitions", "POST", {
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

  // --- Free paths on a fresh community owner: device links 402, offline
  // entry fees allowed without Stripe ---
  const free = newSession();
  await signIn(free, `free_${tag}@example.com`);
  const fComp = await v1(free, "/api/v1/competitions", "POST", {
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
  const comp = await v1(admin, "/api/v1/competitions", "POST", {
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
    { name: "Nope" },
    keyAuth,
  );
  check("v3: read key 403 on manage route", keyWrite.status === 403);

  const otherComp = await v1(admin, "/api/v1/competitions", "POST", {
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

  const freeComp = await v1(free, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(free, "/api/v1/competitions", "POST", {
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
    `ui_free_${tag}@example.com`,
    `disc_free_${tag}@example.com`,
    `pass_${tag}@example.com`,
    `proplus_${tag}@example.com`,
    `funnel_${tag}@example.com`,
    `tos_${tag}@example.com`,
    `player_${tag}@example.com`,
    `ref_${tag}@example.com`,
    `p72_${tag}@example.com`,
    `p72comm_${tag}@example.com`,
    `smoke-community-${tag}@example.com`,
    `smoke-pro-${tag}@example.com`,
    `smoke-proplus-${tag}@example.com`,
    `smoke-pass-${tag}@example.com`,
    // Task 23 — passGrantsSuite's own org (its two competitions, pass row,
    // sponsors, packages, person and AI ledger rows all cascade with it).
    `passgrant_${tag}@example.com`,
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
    await v1(admin, "/api/v1/competitions", "POST", {
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
    await v1(admin, "/api/v1/competitions", "POST", { name: `PP Cup ${tag}` }),
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
