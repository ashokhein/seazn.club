// End-to-end smoke test against the running dev server (http://localhost:3000).
// Run with: node --experimental-strip-types scripts/smoke.ts
//
// Teardown: when DATABASE_URL is set (CI, or `node --env-file=.env.local`), the
// run's own test users + their orgs are purged afterwards (see cleanup). The DB
// must be the same one the target server uses.
import postgres from "postgres";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

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
): Promise<{ status: number; json: { ok: boolean; data?: unknown; error?: string } }> {
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
  const comp = await v1(admin, "/api/v1/competitions", "POST", { name: `Perm Probe ${tag}` });
  check("owner creates competition", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;

  const del = await v1(admin, `/api/v1/competitions/${compId}`, "DELETE");
  check("unscored competition deletable", del.status === 200 || del.status === 204);
  const gone = await v1(admin, `/api/v1/competitions/${compId}`);
  check("deleted competition gone", gone.status === 404);

  // A competition to probe viewer permissions against.
  const probe = await v1(admin, "/api/v1/competitions", "POST", { name: `Viewer Probe ${tag}` });
  const probeId = v1data<{ id: string }>(probe).id;

  // =====================================================================
  // Team management: invites + role enforcement
  // =====================================================================

  // Create a viewer invite and a second user that joins with it.
  const viewerInvite = (await call(
    admin,
    `/api/orgs/${org.id}/invites`,
    "POST",
    { role: "viewer", max_uses: 1 },
  )) as { token: string };
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
    call(newSession(), "/api/auth/magic-link/consume", "POST", { token: vtoken }),
  );

  const accept = (await call(
    viewer,
    `/api/invites/${viewerInvite.token}/accept`,
    "POST",
  )) as { role: string };
  check("viewer joined as viewer", accept.role === "viewer");
  check("viewer active org set", viewer.cookies["seazn_org"] === org.id);

  // Viewer can read but cannot write (doc 08 §2: write needs an editor role).
  const viewerRead = await v1(viewer, `/api/v1/competitions/${probeId}`);
  check("viewer can read competitions", viewerRead.status === 200);
  const viewerWrite = await v1(viewer, "/api/v1/competitions", "POST", { name: "Nope" });
  check("viewer cannot create competition", viewerWrite.status === 401 || viewerWrite.status === 403);
  const viewerPatch = await v1(viewer, `/api/v1/competitions/${probeId}`, "PATCH", { name: "Nope" });
  check("viewer cannot edit competition", viewerPatch.status === 401 || viewerPatch.status === 403);
  // The single-use invite is now spent.
  await expectFail("single-use invite is spent", () =>
    call(newSession(), `/api/invites/${viewerInvite.token}/accept`, "POST"),
  );

  // Invite-by-email (team settings): personal invite, single-use forced,
  // address stored; email_sent reports the Resend outcome (false with a blank
  // key — the UI then offers the personal link for manual sharing).
  const emailInvitee = `emailinvitee_${tag}@example.com`;
  const emailInvite = (await call(
    admin,
    `/api/orgs/${org.id}/invites`,
    "POST",
    { role: "viewer", email: emailInvitee },
  )) as { token: string; email: string | null; max_uses: number; email_sent?: boolean };
  check("email invite stores address", emailInvite.email === emailInvitee);
  check("email invite forced single-use", emailInvite.max_uses === 1);
  check("email invite reports send status", typeof emailInvite.email_sent === "boolean");
  // Personal: only the invited address may accept — anyone else holding the
  // link (here: the admin who minted it) is turned away with a 403.
  await expectFail("email invite rejects a different account", () =>
    call(admin, `/api/invites/${emailInvite.token}/accept`, "POST", {}),
  );

  // Invite-by-link (team settings): multi-use with a 24-hour expiry — it must
  // outlive the tab that created it and stay listed for later copying.
  const linkInvite = (await call(
    admin,
    `/api/orgs/${org.id}/invites`,
    "POST",
    { role: "viewer", max_uses: 0, expires_in_days: 1 },
  )) as { token: string; expires_at: string | null };
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
  await v1(admin, `/api/v1/competitions/${probeId}`, "PATCH", { status: "archived" });
  const adminInvite = (await call(
    admin,
    `/api/orgs/${org.id}/invites`,
    "POST",
    { role: "admin", max_uses: 0 },
  )) as { token: string };
  const member = newSession();
  await signIn(member, `member_${tag}@example.com`);
  await call(member, `/api/invites/${adminInvite.token}/accept`, "POST");
  const memberComp = await v1(member, "/api/v1/competitions", "POST", { name: `Member Made ${tag}` });
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
  await setPlan(org.id, "pro");

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
  check("rename regenerates slug", renamed.slug !== org2.slug && renamed.slug.startsWith("renamed-org"));
  const oldConsole = await pageRedirect(admin, `/o/${org2.slug}`);
  check(
    "old org slug 301s on the console",
    oldConsole.status >= 301 && oldConsole.status <= 308 &&
      (oldConsole.location ?? "").includes(`/o/${renamed.slug}`),
  );

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
  await setPlan(org2.id, "pro");
  await jul3Suite(admin, org2.id, renamed.slug);

  // --- Division delete/archive lifecycle (PROMPT-38, v3/09 §4): delete on a
  // free org lifts the divisions quota; archive/restore on the Pro org.
  await divisionLifecycleSuite(admin, org2.id);

  // --- v3 UI system (PROMPT-32): card grid render + visibility flip on both
  // plans — pro on org2, free on a fresh community owner.
  await uiSystemSuite(admin, renamed.slug);

  // --- v3 scheduling board + registration v2 (PROMPT-33/34): board render,
  // seq-tokened reschedule + stale 409, SZ refs + /r/[ref] on pro AND free.
  await schedRegV3Suite(admin, renamed.slug);

  // --- v10 sponsor CRM: tiers + placement + tracked clicks + Connect rail
  // on the pro org; flat free strip + 402 gates on a fresh community owner.
  await sponsorsSuite(admin, org2.id, renamed.slug);

  // --- v3 content + API wave (PROMPT-35/37/39): markdown editor render,
  // /help + /developers, scoped keys, OG/poster/embed/sponsors — pro + free.
  await v3ContentApiSuite(admin, org2.id, renamed.slug);

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

  // --- design/v9 PROMPT-55: dispute-loss recovery surfaces.
  await disputeSurfacesSuite();

  await gapSuite(admin, org.id, org2.id);

  // --- design/v7 PROMPT-51: staff-console platform revenue report.
  await platformRevenueSuite(admin, `admin_${tag}@example.com`);
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
  await setPlan(who.org_id, "pro");
  const refused = await v1(owner, `/api/v1/orgs/${who.org_id}/connect`, "POST", {
    return_path: "/settings/payments",
  });
  check("p55: connect refuses without ToS agreement (422)", refused.status === 422);
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
  const orgs = (await call(admin, "/api/orgs")) as { id: string; slug: string }[];
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
    full_name: `Pat Claimer ${tag}`, consent: {},
  });
  const pb = await v1(admin, "/api/v1/persons", "POST", {
    full_name: `Uma Unclaimed ${tag}`, consent: {},
  });
  const personId = v1data<{ id: string }>(pa).id;
  const unclaimedId = v1data<{ id: string }>(pb).id;
  await v1(admin, `/api/v1/divisions/${divData.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Pat", seed: 1, members: [{ person_id: personId }] },
    { kind: "individual", display_name: "Uma", seed: 2, members: [{ person_id: unclaimedId }] },
  ]);
  const stage = await v1(admin, `/api/v1/divisions/${divData.id}/stages`, "POST", {
    seq: 1, kind: "league", name: "League",
  });
  const gen = await v1(admin, `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`, "POST");
  const fixture = v1data<{ fixtures: { id: string; fixture_no: number }[] }>(gen).fixtures[0]!;
  await v1(admin, `/api/v1/divisions/${divData.id}/start`, "POST");
  const fixturePath = `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/f/${fixture.fixture_no}`;

  // Invite → claim (the claim_url IS the credential; shown once).
  const invite = await v1(admin, `/api/v1/persons/${personId}/claim-invites`, "POST", {
    email: `player_${tag}@example.com`,
  });
  const claimUrl = v1data<{ claim_url: string }>(invite).claim_url ?? "";
  check("pa claim invite minted", invite.status === 201 && claimUrl.includes("/claim/pc_"));
  const accepted = (await call(player, `/api/claims/${claimUrl.split("/claim/")[1]}/accept`, "POST")) as {
    person_id?: string;
  };
  check("pa player claimed the profile", accepted.person_id === personId);

  // /me carries the fixture; RSVP out with a note.
  const mine = await v1(player, "/api/v1/me/fixtures");
  const upcoming = v1data<{ upcoming: { id: string }[] }>(mine).upcoming ?? [];
  check("pa /me/fixtures lists the claimed fixture", upcoming.some((f) => f.id === fixture.id));
  const rsvp = await v1(player, `/api/v1/me/fixtures/${fixture.id}/availability`, "PUT", {
    status: "out",
    note: "smoke note",
  });
  check("pa RSVP saved", rsvp.status === 200);

  // Organiser grid: ✗ chip with the note; unclaimed teammate shows "—".
  const gridRes = await fetch(`${BASE}${fixturePath}`, {
    headers: { cookie: Object.entries(admin.cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  const html = await gridRes.text();
  check("pa grid shows the unavailable chip", gridRes.status === 200 && html.includes("unavailable — smoke note"));
  check("pa unclaimed teammate shows no-answer chip", html.includes("no availability answer"));

  // QR check-in: organiser mints, player taps; presence keeps the RSVP.
  const link = await v1(admin, `/api/v1/fixtures/${fixture.id}/checkin-link`, "POST");
  const url = v1data<{ url: string }>(link).url ?? "";
  check("pa check-in link minted", link.status === 201 && url.includes("/checkin/"));
  const checkedIn = (await call(player, `/api/checkin/${url.split("/checkin/")[1]}`, "POST")) as {
    checked_in?: boolean;
    status?: string;
  };
  check("pa QR check-in keeps the explicit RSVP", checkedIn.checked_in === true && checkedIn.status === "out");

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
    full_name: `Free Player ${tag}`, consent: {},
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
async function officialOnboardingSuite(admin: Session, orgId: string, orgSlug: string): Promise<void> {
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
    { kind: "individual", display_name: `Whistle A ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `Whistle B ${tag}`, seed: 2, members: [] },
    { kind: "individual", display_name: `Whistle C ${tag}`, seed: 3, members: [] },
    { kind: "individual", display_name: `Whistle D ${tag}`, seed: 4, members: [] },
  ]);
  const stage = await v1(admin, `/api/v1/divisions/${divData.id}/stages`, "POST", {
    seq: 1, kind: "league", name: "League",
  });
  const gen = await v1(admin, `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`, "POST");
  const fixtures = v1data<{ fixtures: { id: string }[] }>(gen).fixtures;
  await v1(admin, `/api/v1/divisions/${divData.id}/start`, "POST");
  // Future kickoff: the /me lane only lists today-or-later fixtures.
  const kickoff = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}`, "PATCH", {
    scheduled_at: kickoff, court_label: "Court 9",
  });

  // Create + assign BEFORE the invite: the fresh assignment must be pending.
  const off = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref ${tag}`, role_keys: ["referee"],
  });
  const offId = v1data<{ id: string }>(off).id;
  await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}/officials`, "PATCH", {
    set: [{ official_id: offId, role_key: "referee", locked: false }],
  });

  // Invite through the SHARED person-claim rail (pc_ token, officiating copy).
  const invite = await v1(admin, `/api/v1/officials/${offId}/invite`, "POST", { email: refEmail });
  const claimUrl = v1data<{ claim_url: string }>(invite).claim_url ?? "";
  check("off invite mints through the person-claim rail", invite.status === 201 && claimUrl.includes("/claim/pc_"));
  const token = claimUrl.split("/claim/")[1]!;
  const claimPage = await fetch(`${BASE}/claim/${token}`);
  const claimHtml = await claimPage.text();
  check("off claim page shows officiating copy", claimPage.status === 200 && claimHtml.includes("Claim your officiating profile"));

  const accepted = (await call(ref, `/api/claims/${token}/accept`, "POST")) as { person_id?: string };
  check("off claim links the official's login", !!accepted.person_id);

  // /me carries the assignment card (assert on the unique fixture label, not
  // dict copy — the /me DictProvider serialises every ui string into the HTML).
  const meRes = await fetch(`${BASE}/me`, {
    headers: { cookie: Object.entries(ref.cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  const meHtml = await meRes.text();
  check("off /me lists the assigned fixture", meRes.status === 200 && meHtml.includes(`Whistle A ${tag}`));

  // Accept; then decline a second assignment with a reason → organiser flag.
  const acceptRes = await v1(ref, `/api/v1/me/assigned-fixtures/${fixtures[0]!.id}/response`, "PATCH", {
    response: "accepted",
  });
  check("off accept lands", acceptRes.status === 200 && v1data<{ response: string }>(acceptRes).response === "accepted");
  await v1(admin, `/api/v1/fixtures/${fixtures[1]!.id}/officials`, "PATCH", {
    set: [{ official_id: offId, role_key: "referee", locked: false }],
  });
  await v1(ref, `/api/v1/me/assigned-fixtures/${fixtures[1]!.id}/response`, "PATCH", {
    response: "declined", decline_reason: "smoke clash",
  });
  const flagged = await v1(admin, `/api/v1/fixtures/${fixtures[1]!.id}`);
  const flaggedOfficials = v1data<{ officials: { response?: string; decline_reason?: string }[] }>(flagged).officials ?? [];
  check(
    "off decline flags on the organiser read (no auto-reassign)",
    flaggedOfficials.length === 1 && flaggedOfficials[0]!.response === "declined" && flaggedOfficials[0]!.decline_reason === "smoke clash",
  );
  // accepted → declined is refused (ask the organiser)
  const illegal = await v1(ref, `/api/v1/me/assigned-fixtures/${fixtures[0]!.id}/response`, "PATCH", {
    response: "declined",
  });
  check("off accepted assignment cannot be self-declined", illegal.status === 422);

  // Blackout date: set (upsert) then clear.
  const blackout = await v1(ref, "/api/v1/me/availability/officiating", "POST", {
    date: "2027-03-07", note: "away",
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

  // Pending-invite accept-by-id (v11.1 /me "Pending invites" card): officials
  // belong to multiple orgs — a SECOND invite for the same ref, accepted
  // without ever touching the emailed token (the claim id from the invite
  // response is enough; the session's verified email does the rest).
  const off2 = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref Two ${tag}`, role_keys: ["referee"],
  });
  const off2Id = v1data<{ id: string }>(off2).id;
  const invite2 = await v1(admin, `/api/v1/officials/${off2Id}/invite`, "POST", { email: refEmail });
  const claim2Id = v1data<{ id: string }>(invite2).id ?? "";
  check("off second org invite mints its own claim id", invite2.status === 201 && !!claim2Id);

  // wrong email gets the generic 404 — same as a bogus id, so a non-owner
  // can't even learn the claim exists (review fix 2026-07-17).
  const stranger = newSession();
  await signIn(stranger, `stranger_${tag}@example.com`);
  const wrongAccept = await v1(stranger, `/api/v1/me/officiating-claims/${claim2Id}/accept`, "POST");
  const bogusAccept = await v1(stranger, `/api/v1/me/officiating-claims/${crypto.randomUUID()}/accept`, "POST");
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
    display_name: `Free Ref ${tag}`, role_keys: ["referee"],
  });
  const freeInvite = await v1(ref, `/api/v1/officials/${v1data<{ id: string }>(freeOff).id}/invite`, "POST", {
    email: `else_${tag}@example.com`,
  });
  check(
    "off invite mints on a community org (portal is free)",
    refVer.has_org === true && freeInvite.status === 201,
  );

  // Cross-org "booked elsewhere" derived read (v11.1 follow-up): the SAME
  // claimed official (offId, this org) also holds a scheduled assignment in
  // a DIFFERENT org (the account's own first org from signup) — the schedule's
  // Officials tab must warn with a time, never the other org's identity.
  const myOrgs = (await call(admin, "/api/orgs")) as { id: string; slug: string }[];
  const busyOrg = myOrgs.find((o) => o.id !== orgId)!;
  admin.cookies["seazn_org"] = busyOrg.id;
  const busyOff = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref Busy ${tag}`, role_keys: ["referee"],
  });
  const busyOffId = v1data<{ id: string }>(busyOff).id;
  const busyInvite = await v1(admin, `/api/v1/officials/${busyOffId}/invite`, "POST", { email: refEmail });
  const busyClaimId = v1data<{ id: string }>(busyInvite).id ?? "";
  await v1(ref, `/api/v1/me/officiating-claims/${busyClaimId}/accept`, "POST");

  const busyComp = await v1(admin, "/api/v1/competitions", "POST", {
    name: `Busy Cup ${tag}`, visibility: "public",
  });
  const busyDiv = await v1(admin, `/api/v1/competitions/${v1data<{ id: string }>(busyComp).id}/divisions`, "POST", {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const busyDivId = v1data<{ id: string }>(busyDiv).id;
  await v1(admin, `/api/v1/divisions/${busyDivId}/entrants`, "POST", [
    { kind: "individual", display_name: `Busy A ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `Busy B ${tag}`, seed: 2, members: [] },
  ]);
  const busyStage = await v1(admin, `/api/v1/divisions/${busyDivId}/stages`, "POST", {
    seq: 1, kind: "league", name: "League",
  });
  const busyGen = await v1(admin, `/api/v1/stages/${v1data<{ id: string }>(busyStage).id}/generate`, "POST");
  const busyFixtures = v1data<{ fixtures: { id: string }[] }>(busyGen).fixtures;
  await v1(admin, `/api/v1/divisions/${busyDivId}/start`, "POST");
  // Same calendar day as this org's fixtures[0] kickoff, a few hours later —
  // the warning is a same-day match, not an exact-instant one.
  const busyKickoff = new Date(new Date(kickoff).getTime() + 3 * 3_600_000).toISOString();
  await v1(admin, `/api/v1/fixtures/${busyFixtures[0]!.id}`, "PATCH", {
    scheduled_at: busyKickoff, court_label: "Court 5",
  });
  await v1(admin, `/api/v1/fixtures/${busyFixtures[0]!.id}/officials`, "PATCH", {
    set: [{ official_id: busyOffId, role_key: "referee", locked: false }],
  });

  // Switch back to this org and read its own schedule Officials tab: offId
  // (the SAME claimed person, already assigned+accepted on fixtures[0]) is
  // flagged busy with a real time — the raw {time} template lives in the
  // page's embedded dict regardless, so only a substituted HH:MM counts.
  admin.cookies["seazn_org"] = orgId;
  const sched = await html(admin, `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/schedule?tab=officials`);
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
      ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
      prepare: !dbUrl.includes(":6543"),
      max: 1,
    });
    const empty = { groups: [], lineup: { size: 1, benchMax: 1 } };
    for (const [key, name] of [["tennis", "Tennis"], ["icehockey", "Ice Hockey"]] as const) {
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
    name: "Tennis", sport_key: "tennis", variant_key: "tour",
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
    seq: 1, kind: "league", name: "League",
  });
  const tgen = await v1(admin, `/api/v1/stages/${v1data<{ id: string }>(tstage).id}/generate`, "POST");
  const tfx = v1data<{ fixtures: { id: string }[] }>(tgen).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${tdivId}/start`, "POST");
  let seq = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
      expected_seq: 0, type: "core.start", payload: {},
    }),
  ).seq;
  // 24 straight points = a 6–0 set in rally mode.
  for (let i = 0; i < 24; i++) {
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq, type: "tennis.point", payload: { by: tents[0]!.id },
      }),
    ).seq;
  }
  const midState = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
  const midHeadline =
    v1data<{ summary: { headline: string } }>(midState).summary.headline;
  check("v6 tennis rally set banked (1 — 0 · 6–0)", midHeadline.startsWith("1 — 0"));
  // Undo the last point and re-score it — the fold reopens cleanly.
  const events = await v1(admin, `/api/v1/fixtures/${tfx}/events`);
  const lastPoint = v1data<{ id: string; type: string; seq: number }[]>(events)
    .filter((e) => e.type === "tennis.point")
    .sort((a, b) => b.seq - a.seq)[0];
  if (lastPoint) {
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq, type: "core.void", payload: { event_id: lastPoint.id },
      }),
    ).seq;
    const reopened = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
    check(
      "v6 tennis undo restores the live point",
      v1data<{ summary: { headline: string } }>(reopened).summary.headline.startsWith("0 — 0"),
    );
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq, type: "tennis.point", payload: { by: tents[0]!.id },
      }),
    ).seq;
  }
  // Second set as a tier-0 summary; the match decides.
  seq = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
      expected_seq: seq, type: "tennis.set_summary", payload: { home: 6, away: 0 },
    }),
  ).seq;
  const tdone = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
  check(
    "v6 tennis match decided from mixed fidelity",
    v1data<{ status: string }>(tdone).status === "decided",
  );

  // --- Ice hockey (PROMPT-49/50): OT points + PP goal + strength chip ---
  const idiv = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Ice", sport_key: "icehockey", variant_key: "iihf",
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
    seq: 1, kind: "league", name: "League",
  });
  const istageId = v1data<{ id: string }>(istage).id;
  const igen = await v1(admin, `/api/v1/stages/${istageId}/generate`, "POST");
  const ifx = v1data<{ fixtures: { id: string }[] }>(igen).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${idivId}/start`, "POST");
  const iceSend = async (type: string, payload: unknown) => {
    iceSeq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${ifx}/events`, "POST", {
        expected_seq: iceSeq, type, payload,
      }),
    ).seq;
  };
  let iceSeq = 0;
  await iceSend("core.start", {});
  // Power play: minor on the Kings → 5v4 chip visible to an anonymous
  // public read (PROMPT-50 free path), PP goal, scorer releases the minor.
  await iceSend("icehockey.suspension.start", { by: ients[1]!.id, class: "minor" });
  const anon = newSession();
  const pub = await v1(anon, `/api/v1/public/fixtures/${ifx}`);
  const pubDetail = v1data<{ summary: { detail?: { strength?: string } } }>(pub).summary.detail;
  check("v6 public scorebug carries the 5v4 strength chip", pubDetail?.strength === "5v4");
  await iceSend("icehockey.goal", { by: ients[0]!.id, kind: "pp" });
  await iceSend("icehockey.suspension.end", { by: ients[1]!.id, class: "minor" });
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
  const me = (await call(admin, "/api/users/me")) as { org: { id: string } | null };
  const orgs = (await call(admin, "/api/orgs")) as { id: string; slug: string }[];
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
    enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "gbp",
    capacity: 1, form_fields: [],
  });

  const submit = async (name: string) => {
    const res = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`, "POST", {
      division_id: div.id,
      display_name: name,
      contact_email: `${name.replace(/ /g, "").toLowerCase()}_${tag}@example.com`,
      privacy_consent: true,
    });
    if (res.status !== 201) {
      console.log(`queue submit "${name}" failed:`, res.status, JSON.stringify(res.json));
    }
    return res;
  };
  const holder = await submit("Queue Holder"); // takes the only spot
  check("queue holder takes the spot", holder.status === 201);
  const w1res = await submit("Queue First");
  const w1 = v1data<{ registration_id: string; access_token: string; status: string }>(w1res);
  check("queue overflow waitlists", w1res.status === 201 && w1?.status === "waitlisted");
  await submit("Queue Second");

  const status = await v1(
    newSession(),
    `/api/v1/public/registrations/${w1.registration_id}?token=${encodeURIComponent(w1.access_token)}`,
  );
  const view = v1data<{ status: string; position: number | null }>(status);
  check(
    "waitlist status carries #1 position",
    view.status === "waitlisted" && view.position === 1,
  );

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
    check(`off official ${officialId.slice(0, 8)} claimed=${expected}`, (row?.claimed ?? false) === expected);
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
      const data = res.json.data as { byMonth?: unknown; byOrg?: unknown; rows?: unknown[] };
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
          firstLine === "month,org,org_slug,currency,gross_minor,refunded_minor,net_minor,fee_count",
      );
    }
    const bad = await raw(admin, "/api/admin/revenue?from=notadate");
    check("revenue 400s on malformed range", bad.status === 400);
  } finally {
    await setStaff(staffEmail, null);
  }
}

/** v8 (spec 2026-07-13): the format is editable until fixtures exist, then
 *  PATCH rejects with FORMAT_LOCKED; the logo upload URL mints for editors. */
async function divisionSettingsSuite(admin: Session): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { name: `V8 Probe ${tag}` }),
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
      seq: 1, kind: "league", name: "L", config: {},
    }),
  );
  await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST");

  const post = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", { variant_key: "score" });
  check(
    "v8 format 409s once fixtures exist",
    post.status === 409 && (post.json.error as { code?: string } | undefined)?.code === "FORMAT_LOCKED",
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
 *  convention as setPlan/grantPass. */
async function setConnect(orgId: string, chargesEnabled: boolean): Promise<void> {
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
    await sql`
      update organizations
      set stripe_charges_enabled = ${chargesEnabled},
          stripe_account_id = coalesce(stripe_account_id, ${"acct_smoke_" + orgId.slice(0, 8)})
      where id = ${orgId}`;
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

  // Free caps (v3 matrix): 1 active competition, 2 divisions inside it.
  const compA = v1data<{ id: string; slug: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", { name: `Pass Cup ${tag}` }),
  );
  const blockedComp = await v1(buyer, "/api/v1/competitions", "POST", {
    name: `Second Cup ${tag}`,
  });
  check("p36: 2nd active competition blocked on free (402)", blockedComp.status === 402);
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

  // Event Pass on comp A lifts ITS caps and frees the active-comp slot…
  await grantPass(orgId, compA.id);
  const div3 = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 3",
    ...genericDivision,
  });
  check("p36: pass lifts division cap on the passed comp", div3.status === 201);
  const compB = v1data<{ id: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", { name: `Sibling Cup ${tag}` }),
  );
  check("p36: passed comp leaves the active-comp quota", !!compB.id);

  // …while the sibling competition stays on community limits.
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
  await setPlan(orgId, "pro");
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
  await setPlan(orgId, "community");
  const afterDowngrade = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 4",
    ...genericDivision,
  });
  check("p36: pass survives downgrade (comp A still lifted)", afterDowngrade.status === 201);

  // The upgrade page reflects the pass state.
  const [orgRow] = (await call(buyer, "/api/orgs")) as { id: string; slug: string }[];
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
  const claimed = (await call(visitor, "/api/funnel/claim", "POST", { token })) as {
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
    name: `Goldco ${tag}`, tier: "gold", url: "https://goldco.example",
  });
  check("sp pro creates a gold sponsor", gold.status === 201);
  const goldId = v1data<{ id: string }>(gold).id;
  const scoped = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Cup Title ${tag}`, tier: "title", competition_id: comp.id,
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
  const afterClick = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`);
  check(
    "sp click_count incremented",
    v1data<{ id: string; click_count: number }[]>(afterClick).find((s) => s.id === goldId)
      ?.click_count === 1,
  );

  // --- Monetization: package + order-first Connect checkout.
  const pkgRes = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-packages`, "POST", {
    name: `Gold Package ${tag}`, price_cents: 25_000, currency: "gbp", tier: "gold",
  });
  check("sp pro creates a package", pkgRes.status === 201);
  const pkg = v1data<{ id: string }>(pkgRes);

  // Connect gate: same refusal as entry fees, before any order row exists.
  await setConnect(proOrgId, false);
  const gated = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id, sponsor_name: "Gate Probe", sponsor_email: `gate_${tag}@example.com`,
  });
  check("sp checkout refused without Connect (409)", gated.status === 409);
  await setConnect(proOrgId, true);

  const started = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id, sponsor_name: `Acme ${tag}`, sponsor_email: `acme_${tag}@example.com`,
  });
  if (process.env.STRIPE_SECRET_KEY) {
    check(
      "sp checkout starts (order + session url)",
      started.status === 201 && !!v1data<{ checkout_url: string }>(started).checkout_url,
    );
  } else {
    // Keyless: the Stripe mint fails AFTER the pending order landed — the
    // order-before-intent rail is still observable below.
    check("sp checkout keyless fails after the order insert", started.status >= 500);
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
  const freeOrgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      name: `Sponsor Free ${tag}`,
      visibility: "public",
    }),
  );
  const partner = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: `Corner Shop ${tag}`, url: "https://corner.example",
  });
  check("sp free adds a partner sponsor", partner.status === 201);
  const freeGold = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: "Blocked Gold", tier: "gold",
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
    name: "Blocked Package", price_cents: 1_000, currency: "gbp", tier: "partner",
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
  const freeOrgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
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
  check("link-only page serves + noindex (free)", freeShared.status === 200 && freeShared.body.includes("noindex"));

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
    headers: { "Content-Type": "application/json", authorization: "Bearer sc_smoke_fake_key" },
    body: "{}",
  });
  check("v3/11 API keys can't touch billing routes (401, header ignored)", bearerOnly.status === 401);
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
  const proPayments = await html(admin, `/o/${proOrgSlug}/settings/payments`);
  check(
    "product tour: Connect step anchor present on payments (owner)",
    proPayments.status === 200 && proPayments.body.includes('data-tour="connect-stripe"'),
  );
  const freeCancel = await raw(free, "/api/billing/cancel", "POST", {});
  check("v3/11 cancel wants a Stripe customer first (free)", freeCancel.status === 400);
  const proAddress = await raw(admin, "/api/billing/address", "POST", {
    address: { line1: "1 Test Way", city: "London", postal_code: "SW1A 1AA", country: "GB" },
  });
  check("v3/11 address update wants a Stripe customer first (pro)", proAddress.status === 400);
  const freePromo = await raw(free, "/api/billing/promo", "POST", { code: "NOPE" });
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
      seq: 1, kind: "league", name: "League",
    }),
  );
  await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-01T09:00:00.000Z", matchMinutes: 30, gapMinutes: 0,
      courts: ["A", "B"], perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
    },
    tz: "UTC",
  });
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

  // Matchday documents (v12, Task 17): officials rota + admit tickets also
  // render real, valid PDFs — same magic-bytes/content-type assertion as the
  // timetable check above (font subsetting rules out literal-text asserts).
  const rotaPdf = await fetch(
    `${BASE}/api/v1/divisions/${div.id}/exports/officials_rota?format=pdf`,
    { headers: { cookie: cookieHeader(admin) } },
  );
  const rotaPdfBytes = Buffer.from(await rotaPdf.arrayBuffer());
  check(
    "exports officials rota PDF renders a valid PDF (pro)",
    rotaPdf.status === 200 &&
      (rotaPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      rotaPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      rotaPdfBytes.byteLength > 1024,
  );
  const ticketsPdf = await fetch(
    `${BASE}/api/v1/competitions/${comp.id}/exports/tickets?format=pdf`,
    { headers: { cookie: cookieHeader(admin) } },
  );
  const ticketsPdfBytes = Buffer.from(await ticketsPdf.arrayBuffer());
  check(
    "exports admit tickets PDF renders a valid PDF (pro)",
    ticketsPdf.status === 200 &&
      (ticketsPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      ticketsPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      ticketsPdfBytes.byteLength > 1024,
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
    enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "gbp", form_fields: [],
  });
  const reg = await v1(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`, "POST", {
    division_id: div.id,
    display_name: `Ref Probe ${tag}`,
    contact_email: `refprobe_${tag}@example.com`,
    privacy_consent: true,
  });
  const regData = v1data<{ ref_code: string }>(reg);
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

  // Honeypot: a filled `website` field is rejected before any work.
  const honey = await v1(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`, "POST", {
    division_id: div.id,
    display_name: "Bot Entry",
    contact_email: `bot_${tag}@example.com`,
    website: "https://spam.example",
  });
  check("reg honeypot rejects bots (400)", honey.status === 400);

  // GDPR (spec 2026-07-14): a submission without privacy consent is refused.
  const noConsent = await v1(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`, "POST", {
    division_id: div.id,
    display_name: `No Consent ${tag}`,
    contact_email: `noconsent_${tag}@example.com`,
  });
  check("reg without privacy consent refused (422)", noConsent.status === 422);

  // --- Dual payments (spec 2026-07-12): offline mark-paid + card gates (pro) ---
  const orgsList = (await call(admin, "/api/orgs")) as { id: string; slug: string }[];
  const proOrgId = orgsList.find((o) => o.slug === proOrgSlug)!.id;
  const payDiv = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Paid Offline",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${payDiv.id}/registration-settings`, "PUT", {
    enabled: true, entrant_kind: "individual", fee_cents: 1500, currency: "gbp",
    form_fields: [], payment_method: "offline",
    payment_instructions: `Cash desk ${tag}`,
  });
  const offReg = await v1(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`, "POST", {
    division_id: payDiv.id,
    display_name: `Cash Payer ${tag}`,
    contact_email: `cash_${tag}@example.com`,
    privacy_consent: true,
  });
  const offRegData = v1data<{ registration_id: string; checkout_url: string | null }>(offReg);
  check(
    "pay offline submit: pending, no checkout",
    offReg.status === 201 && offRegData.checkout_url === null,
  );
  const confirmEarly = await v1(admin, `/api/v1/registrations/${offRegData.registration_id}/confirm`, "POST", {});
  check("pay unpaid confirm blocked (422)", confirmEarly.status === 422);
  const markPaid = await v1(admin, `/api/v1/registrations/${offRegData.registration_id}/mark-paid`, "POST", {});
  const markPaidData = v1data<{ status: string; offline_marked_paid_at: string | null }>(markPaid);
  check(
    "pay mark-paid confirms entry",
    markPaid.status === 200 && markPaidData.status === "confirmed" && !!markPaidData.offline_marked_paid_at,
  );

  // Card method gates: rejected without Connect, accepted once flipped.
  const cardPutNoConnect = await v1(admin, `/api/v1/divisions/${payDiv.id}/registration-settings`, "PUT", {
    enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "gbp",
    form_fields: [], payment_method: "stripe",
  });
  check("pay card method needs Connect (422)", cardPutNoConnect.status === 422);
  await setConnect(proOrgId, true);
  const cardPut = await v1(admin, `/api/v1/divisions/${payDiv.id}/registration-settings`, "PUT", {
    enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "gbp",
    form_fields: [], payment_method: "stripe",
  });
  check("pay card method saves with Connect", cardPut.status === 200);
  const cardReg = await v1(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`, "POST", {
    division_id: payDiv.id,
    display_name: `Card Payer ${tag}`,
    contact_email: `card_${tag}@example.com`,
    privacy_consent: true,
  });
  const cardRegData = v1data<{ registration_id: string; status: string }>(cardReg);
  // No Stripe key in smoke: the session mint fails gracefully — the row still
  // lands pending with a 48h window (pay-later from the status page).
  check("pay card submit holds a pending spot", cardReg.status === 201 && cardRegData.status === "pending");
  const waived = await v1(admin, `/api/v1/registrations/${cardRegData.registration_id}/waive`, "POST", {});
  check(
    "pay waive confirms without payment",
    waived.status === 200 && v1data<{ status: string }>(waived).status === "confirmed",
  );
  await setConnect(proOrgId, false);

  // --- Free path: fresh community owner, registration + ref lookup ---
  const free = newSession();
  const freeVer = await signIn(free, `sched_free_${tag}@example.com`);
  const freeOrgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const fComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { name: `Sched Free ${tag}`, visibility: "public" }),
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
    enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "gbp", form_fields: [],
  });
  const fReg = await v1(newSession(), `/api/v1/public/orgs/${freeOrg.slug}/competitions/${fComp.slug}/register`, "POST", {
    division_id: fDiv.id,
    display_name: `Free Ref ${tag}`,
    contact_email: `freeref_${tag}@example.com`,
    privacy_consent: true,
  });
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
  const fFixtures = await html(free, `/o/${freeOrg.slug}/c/${fComp.slug}/d/${fDiv.slug}?tab=fixtures`);
  check("division fixtures page renders (free)", fFixtures.status === 200);

  // Dual payments on community (spec 2026-07-12): offline fees stay plan-free;
  // the card method is the paid layer even with Connect flipped on.
  const fOffline = await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "gbp",
    form_fields: [], payment_method: "offline",
  });
  check("pay offline fee allowed on community", fOffline.status === 200);
  await setConnect(freeVer.org_id, true);
  const fCard = await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true, entrant_kind: "individual", fee_cents: 500, currency: "gbp",
    form_fields: [], payment_method: "stripe",
  });
  check("pay card method is Pro-gated on community (402)", fCard.status === 402);
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
        ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
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
  check("v1 create competition → 201 + envelope", comp.status === 201 && comp.json.ok === true && !!comp.json.requestId);
  const compId = v1data<{ id: string; slug: string }>(comp).id;
  const compSlug = v1data<{ id: string; slug: string }>(comp).slug;

  const list = await v1(admin, "/api/v1/competitions?limit=1");
  check("v1 list paginates", list.status === 200 && Array.isArray(v1data<{ items: unknown[] }>(list).items));

  const div = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    // The 'score' preset is partial; the module schema requires the rest.
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  check("v1 create division pins module version", div.status === 201 && !!v1data<{ module_version: string }>(div).module_version);
  const divId = v1data<{ id: string; slug: string }>(div).id;
  const divSlug = v1data<{ id: string; slug: string }>(div).slug;

  const entrants = await v1(admin, `/api/v1/divisions/${divId}/entrants`, "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })));
  check("v1 bulk entrants registered", entrants.status === 201 && v1data<unknown[]>(entrants).length === 4);

  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1, kind: "league", name: "League",
  });
  const stageId = v1data<{ id: string }>(stage).id;

  const gen1 = await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST");
  const gen2 = await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST");
  check("v1 generate creates 6 RR fixtures", v1data<{ created: number }>(gen1).created === 6);
  check("v1 generate is idempotent", v1data<{ created: number; existing: number }>(gen2).created === 0);
  const fixtures = v1data<{ fixtures: { id: string }[] }>(gen1).fixtures;

  // --- PROMPT-30: slug console routes + legacy 301s ---
  const consolePage = await html(admin, `/o/${orgSlug}/c/${compSlug}/d/${divSlug}`);
  check("console division page serves on slug URL", consolePage.status === 200);
  const fixturePage = await html(admin, `/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/1`);
  check("fixture ordinal page serves (/f/1)", fixturePage.status === 200);
  const legacy = await pageRedirect(admin, `/divisions/${divId}`);
  check(
    "legacy /divisions/[id] 301s to the slug chain",
    legacy.status >= 301 && legacy.status <= 308 &&
      (legacy.location ?? "").includes(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}`),
  );

  // Scheduling console (doc 12, PROMPT-17): scoring is closed until the
  // explicit start; auto pass proposes without persisting; start opens scoring.
  const fx = fixtures[0].id;
  const early = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 0, type: "core.start", payload: {},
  });
  check("v1 scoring before start → 422 WRONG_PHASE", early.status === 422 && early.json.error?.code === "WRONG_PHASE");
  const auto = await v1(admin, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  check("v1 schedule/auto proposes all fixtures", v1data<{ assignments: unknown[] }>(auto).assignments.length === 6);
  const startRes = await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");
  check("v1 division start → active", v1data<{ status: string }>(startRes).status === "active");

  // Scoring: append, optimistic-concurrency 409 (parallel scorers), void.
  const started = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 0, type: "core.start", payload: {},
  });
  check("v1 scoring append → 201 with seq", started.status === 201 && v1data<{ seq: number }>(started).seq === 1);

  const race = await Promise.all([
    v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", { expected_seq: 1, type: "core.note", payload: { text: "a" } }),
    v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", { expected_seq: 1, type: "core.note", payload: { text: "b" } }),
  ]);
  const won = race.filter((r) => r.status === 201);
  const lost = race.filter((r) => r.status === 409);
  check("v1 parallel scorers: one 201, one 409", won.length === 1 && lost.length === 1);
  check("v1 409 carries current_seq", lost[0]?.json.error?.current_seq === 2);
  check("v1 409 code is SEQ_CONFLICT", lost[0]?.json.error?.code === "SEQ_CONFLICT");

  // Losing scorer resyncs from its seq and replays.
  const resync = await v1(admin, `/api/v1/fixtures/${fx}/events?since_seq=1`);
  check("v1 events since_seq resyncs", resync.status === 200 && v1data<unknown[]>(resync).length === 1);

  // Undo: void the note through the same path.
  const events = v1data<{ id: string; seq: number }[]>(await v1(admin, `/api/v1/fixtures/${fx}/events`));
  const note = events.find((e) => e.seq === 2);
  const voided = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 2, type: "core.void", payload: { event_id: note?.id },
  });
  check("v1 undo via core.void", voided.status === 201 && v1data<{ seq: number }>(voided).seq === 3);

  // Decide every fixture, read authed standings, then the public dashboard.
  for (const f of fixtures) {
    const state = await v1(admin, `/api/v1/fixtures/${f.id}/state`);
    const seq = v1data<{ last_seq: number }>(state).last_seq;
    await v1(admin, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: seq, type: "generic.result", payload: { p1Score: 2, p2Score: 0 },
    });
  }
  const standings = await v1(admin, `/api/v1/stages/${stageId}/standings`);
  check("v1 standings ranked", v1data<{ rows: unknown[] }>(standings).rows.length === 4);

  const anon = newSession();
  const pubStandings = await v1(anon, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/divisions/${divSlug}/standings`);
  // Flaked once in CI (2026-07-13, 404) with no body in the log — keep the
  // response visible so a recurrence is diagnosable.
  if (pubStandings.status !== 200) {
    console.log("public standings response:", pubStandings.status, JSON.stringify(pubStandings.json));
  }
  check("v1 public standings (no auth)", pubStandings.status === 200 && pubStandings.json.ok === true);
  check("v1 public reads are cacheable", (pubStandings.headers.get("cache-control") ?? "").includes("s-maxage"));
  const pubComp = await v1(anon, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}`);
  check("v1 public competition lists divisions", v1data<{ divisions: unknown[] }>(pubComp).divisions.length === 1);

  // Public-page theming, free path (public redesign): the branding write is
  // accepted, but the public view empties it for orgs without
  // dashboard.branding — the page must NOT carry the --ps-* accent override.
  const branded = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    branding: { colors: { primary: "#0f766e" } },
  });
  check("v1 branding patch accepted", branded.status === 200);
  const freePage = await fetch(`${BASE}/shared/${orgSlug}/${compSlug}`);
  const freeHtml = await freePage.text();
  check("public competition page renders (community)", freePage.status === 200 && freeHtml.includes("V1 Cup"));
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
  const denied = await v1(admin, `/api/v1/orgs/${orgId}/api-keys`, "POST", { name: "ci", scopes: ["read"] });
  check("v1 API keys 402-gated on api.access", denied.status === 402 && denied.json.error?.code === "PAYMENT_REQUIRED");

  if (db) {
    await db`insert into org_entitlement_overrides (org_id, feature_key, bool_value)
             values (${orgId}, 'api.access', true)
             on conflict (org_id, feature_key) do update set bool_value = true`;
    const minted = await v1(admin, `/api/v1/orgs/${orgId}/api-keys`, "POST", { name: "ci", scopes: ["read"] });
    const secret = v1data<{ id: string; secret: string }>(minted).secret;
    check("v1 API key minted once (sc_)", minted.status === 201 && secret.startsWith("sc_"));

    const keyed = await v1(newSession(), "/api/v1/competitions", "GET", undefined, {
      Authorization: `Bearer ${secret}`,
    });
    check("v1 Bearer key authenticates reads", keyed.status === 200 && keyed.json.ok === true);
    const keyedWrite = await v1(newSession(), "/api/v1/competitions", "POST", { name: "Nope" }, {
      Authorization: `Bearer ${secret}`,
    });
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
  const spec = await fetch(BASE + "/api/v1/openapi.json").then((r) => r.json()) as {
    openapi: string; paths: Record<string, unknown>;
  };
  check("v1 openapi served", spec.openapi === "3.1.0" && !!spec.paths["/api/v1/fixtures/{id}/events"]);
}

// Multipart POST for the file-upload endpoints (imports, logos).
async function v1Multipart(
  s: Session,
  path: string,
  form: FormData,
): Promise<V1Res> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}) },
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
    await v1(admin, "/api/v1/competitions", "POST", { name: `Jul3 Cup ${tag}`, visibility: "public" }),
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
    name: "Open", sport_key: "generic", variant_key: "score",
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
  const club = await v1(admin, "/api/v1/clubs", "POST", { name: `Acme ${tag}`, short_name: "ACM" });
  check("jul3 clubs create (Pro clubs.hierarchy)", club.status === 201);
  const clubs = await v1(admin, "/api/v1/clubs");
  check("jul3 clubs list", clubs.status === 200 && v1data<unknown[]>(clubs).length >= 1);

  const csv = ["Team,Player,Division", `Acme U12,Ada One,${v1data<{ slug: string }>(div).slug}`].join("\n");
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "import.csv");
  const imp = await v1Multipart(admin, "/api/v1/imports", form);
  check("jul3 import dry-run → plan", imp.status === 201 && Array.isArray(v1data<{ plan: { ops: unknown[] } }>(imp).plan.ops));
  const importId = v1data<{ importId: string }>(imp).importId;
  const committed = await v1(admin, `/api/v1/imports/${importId}/commit`, "POST", undefined, {
    "Idempotency-Key": `smoke-${tag}`,
  });
  check("jul3 import commit", committed.status === 201 && v1data<{ stats: { teams: number } }>(committed).stats.teams === 1);

  // -- PROMPT-22: officials ---------------------------------------------
  const official = await v1(admin, "/api/v1/officials", "POST", { display_name: `Ref ${tag}`, role_keys: ["referee"] });
  check("jul3 officials create", official.status === 201);
  const officials = await v1(admin, "/api/v1/officials");
  check("jul3 officials list", officials.status === 200);

  // Build a scored-through division to exercise the rest.
  const entrants = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${divId}/entrants`, "POST",
      ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 }))),
  );
  const stageId = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  ).id;
  const fixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST"),
  ).fixtures;
  await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");

  const officialId = v1data<{ id: string }[]>(officials)[0]!.id;
  const auto = await v1(admin, `/api/v1/divisions/${divId}/officials/auto`, "POST", {
    policy: { roles: ["referee"] },
  });
  check("jul3 officials auto proposes", auto.status === 200 && Array.isArray(v1data<{ assignments: unknown[] }>(auto).assignments));
  const patchOff = await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}/officials`, "PATCH", {
    set: [{ official_id: officialId, role_key: "referee", locked: false }],
  });
  check("jul3 officials manual assign", patchOff.status === 200);

  // -- PROMPT-24: bulk shift + wait report ------------------------------
  await v1(admin, `/api/v1/fixtures/${fixtures[0]!.id}`, "PATCH", {
    scheduled_at: "2026-07-20T09:00:00.000Z", court_label: "C1",
  });
  const shift = await v1(admin, "/api/v1/schedule/shift", "POST", {
    division_id: divId, scope: { excludeLocked: true }, delta_minutes: 15,
  });
  check("jul3 bulk shift", shift.status === 200 && v1data<{ shifted: number }>(shift).shifted >= 1);
  const report = await v1(admin, `/api/v1/divisions/${divId}/schedule/report`);
  check("jul3 wait report", report.status === 200 && Array.isArray(v1data<{ perEntrant: unknown[] }>(report).perEntrant));

  // -- PROMPT-23: undo/redo/history/checkpoints -------------------------
  const undo = await v1(admin, `/api/v1/divisions/${divId}/undo`, "POST", {});
  check("jul3 undo appends inverse", undo.status === 200 && typeof v1data<{ watermark: number }>(undo).watermark === "number");
  const redo = await v1(admin, `/api/v1/divisions/${divId}/redo`, "POST", {});
  check("jul3 redo", redo.status === 200);
  const cp = await v1(admin, `/api/v1/divisions/${divId}/checkpoints`, "POST", { label: `smoke ${tag}` });
  check("jul3 checkpoint saved", cp.status === 201);
  const history = await v1(admin, `/api/v1/divisions/${divId}/history`);
  check("jul3 history slice", history.status === 200 && Array.isArray(v1data<{ events: unknown[] }>(history).events));

  // Decide every fixture for stats/standings/export.
  for (const f of fixtures) {
    const state = await v1(admin, `/api/v1/fixtures/${f.id}/state`);
    const seq = v1data<{ last_seq: number }>(state).last_seq;
    await v1(admin, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: seq, type: "generic.result", payload: { p1Score: 2, p2Score: 0 },
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
  check("jul3 timetable PDF bytes", pdf.status === 200 && pdfBytes.subarray(0, 5).toString() === "%PDF-");
  const xlsx = await fetch(`${BASE}/api/v1/divisions/${divId}/exports/participants?format=xlsx`, {
    headers: { cookie: cookieHeader(admin) },
  });
  check("jul3 participants XLSX bytes", xlsx.status === 200 && (await xlsx.arrayBuffer()).byteLength > 500);

  // -- PROMPT-27: player stats ------------------------------------------
  const stats = await v1(admin, `/api/v1/divisions/${divId}/stats/players`);
  check("jul3 player stats leaderboard (Pro stats.player)", stats.status === 200 && Array.isArray(v1data<{ rows: unknown[] }>(stats).rows));

  // -- PROMPT-28: format extensions (triple RR + ladder challenge) ------
  const tripleComp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { name: `Triple ${tag}`, visibility: "private" }),
  );
  const tripleDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${tripleComp.id}/divisions`, "POST", {
      name: "T", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  ).id;
  await v1(admin, `/api/v1/divisions/${tripleDiv}/entrants`, "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })));
  const tripleStage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${tripleDiv}/stages`, "POST", {
      seq: 1, kind: "league", name: "Triple", config: { legs: 3 },
    }),
  ).id;
  const tripleGen = await v1(admin, `/api/v1/stages/${tripleStage}/generate`, "POST");
  check("jul3 triple RR = 18 fixtures", v1data<{ created: number }>(tripleGen).created === 18);

  // Ladder challenge (formats.advanced): a stage + an in-range challenge.
  const ladderStage = await v1(admin, `/api/v1/divisions/${tripleDiv}/stages`, "POST", {
    seq: 2, kind: "ladder", name: "Ladder", config: { challengeRange: 2 },
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
  const comp = await v1(admin, "/api/v1/competitions", "POST", { name: `Del Cup ${tag}` });
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
  const proComp = await v1(admin, "/api/v1/competitions", "POST", { name: `Arch Cup ${tag}` });
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
    ["DA", "DB"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(admin, `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`, "POST");
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
    archived.status === 200 && v1data<{ archived_at: string | null }>(archived).archived_at !== null,
  );
  const listed = await v1(admin, `/api/v1/competitions/${proCompId}/divisions`);
  check(
    "arch: archived division hidden from console list",
    v1data<{ id: string }[]>(listed).every((d) => d.id !== divId),
  );
  const restored = await v1(admin, `/api/v1/divisions/${divId}/archive`, "DELETE");
  check(
    "arch: restore round-trips",
    restored.status === 200 && v1data<{ archived_at: string | null }>(restored).archived_at === null,
  );
  const fixture = await v1(admin, `/api/v1/fixtures/${fixtureId}`);
  check(
    "arch: results intact after restore",
    v1data<{ status: string }>(fixture).status === "decided",
  );
}

async function gapSuite(admin: Session, org1Id: string, proOrgId: string): Promise<void> {
  // A dedicated started division in the Pro org for device links + scorers.
  const comp = await v1(admin, "/api/v1/competitions", "POST", { name: `Gap Cup ${tag}` });
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
    ["GA", "GB", "GC", "GD"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(admin, `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`, "POST");
  const fixtureId = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");

  // --- Device links (Pro): mint once, token opens the scoring door alone ---
  const dl = await v1(admin, `/api/v1/fixtures/${fixtureId}/device-links`, "POST", {
    label: "Court 1",
  });
  const dlSecret = v1data<{ secret: string }>(dl).secret ?? "";
  check("gap device link minted (dl_)", dl.status === 201 && dlSecret.startsWith("dl_"));
  const bare = newSession(); // no cookies — the token is the credential
  const dlState = await v1(bare, `/api/v1/fixtures/${fixtureId}/state`, "GET", undefined, {
    Authorization: `Bearer ${dlSecret}`,
  });
  const dlSeq = v1data<{ last_seq: number }>(dlState).last_seq;
  const dlEvent = await v1(
    bare,
    `/api/v1/fixtures/${fixtureId}/events`,
    "POST",
    { expected_seq: dlSeq, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
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
  const accepted = (await call(scorer, `/api/invites/${scorerInvite.token}/accept`, "POST", {})) as {
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
    vAccept.outcome === "scope_added" && vAccept.role === "viewer" &&
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
  const pub = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", { visibility: "public" });
  check("gap competition made public", pub.status === 200);
  const disc = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    discoverable: true,
    discovery: { country: "GB" },
  });
  check("gap discoverable set", disc.status === 200);
  const discovery = await v1(bare, `/api/v1/public/discovery?q=${encodeURIComponent(`Gap Cup ${tag}`)}`);
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
  const badDisc = await v1(admin, `/api/v1/competitions/${v1data<{ id: string }>(privComp).id}`, "PATCH", {
    discoverable: true,
  });
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
  const orgs = (await call(admin, "/api/orgs")) as { id: string; slug: string }[];
  const proSlug = orgs.find((o) => o.id === proOrgId)!.slug;
  const compSlug = v1data<{ slug: string }>(await v1(admin, `/api/v1/competitions/${compId}`)).slug;
  const reg = await v1(bare, `/api/v1/public/orgs/${proSlug}/competitions/${compSlug}/register`, "POST", {
    division_id: divId,
    display_name: `Walk In ${tag}`,
    contact_email: `walkin_${tag}@example.com`,
    privacy_consent: true,
  });
  const regData = v1data<{ registration_id: string; status: string; access_token: string }>(reg);
  check(
    "gap public registration pending + tokened",
    reg.status === 201 && regData.status === "pending" && regData.access_token.length > 0,
  );
  const confirmed = await v1(admin, `/api/v1/registrations/${regData.registration_id}/confirm`, "POST", {});
  check("gap registration confirmed", confirmed.status === 200 || confirmed.status === 201);
  const gapEntrants = await v1(admin, `/api/v1/divisions/${divId}/entrants`);
  check(
    "gap confirmed registration is an entrant",
    v1data<{ display_name: string }[]>(gapEntrants).some((e) => e.display_name === `Walk In ${tag}`),
  );

  // --- Free paths on a fresh community owner: device links 402, offline
  // entry fees allowed without Stripe ---
  const free = newSession();
  await signIn(free, `free_${tag}@example.com`);
  const fComp = await v1(free, "/api/v1/competitions", "POST", { name: `Free Gap ${tag}` });
  const fDiv = await v1(free, `/api/v1/competitions/${v1data<{ id: string }>(fComp).id}/divisions`, "POST", {
    name: "Free",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
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
  const fGen = await v1(free, `/api/v1/stages/${v1data<{ id: string }>(fStage).id}/generate`, "POST");
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
  const freeDocPdf = await fetch(`${BASE}/api/v1/divisions/${fDivId}/exports/timetable?format=pdf`, {
    headers: { cookie: cookieHeader(free) },
  });
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
  await call(admin, `/api/orgs/${org1Id}/transfer-owner`, "POST", { new_owner_id: target.user_id });
  const mid = (await call(admin, `/api/orgs/${org1Id}/members`)) as { user_id: string; role: string }[];
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
  const renamedMe = await raw(admin, "/api/users/me", "PATCH", { display_name: `Gap Admin ${tag}` });
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
    ids.map((id) => v1(admin, `/api/v1/competitions/${id}`, "PATCH", { description: "probe" })),
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
    return { status: res.status, type: res.headers.get("content-type") ?? "", buf };
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
  check("v3: format explainer renders", helpFormats.status === 200 && helpFormats.body.includes("Round robin"));
  const helpIndex = (await (await fetch(BASE + "/api/help-index")).json()) as { slug: string }[];
  check("v3: help search index has waitlist", helpIndex.some((d) => d.slug === "registration/waitlist"));
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
    name: "smoke read", scopes: ["read"],
  });
  check("v3: read key minted", mkKey.status === 201);
  const keySecret = v1data<{ secret: string }>(mkKey).secret;
  const keyAuth = { Authorization: `Bearer ${keySecret}` };
  const keyRead = await v1(newSession(), "/api/v1/competitions", "GET", undefined, keyAuth);
  check("v3: read key GETs competitions", keyRead.status === 200);
  check("v3: rate-limit headers present", !!keyRead.headers.get("X-RateLimit-Limit"));
  const keyWrite = await v1(newSession(), "/api/v1/competitions", "POST", { name: "Nope" }, keyAuth);
  check("v3: read key 403 on manage route", keyWrite.status === 403);

  const otherComp = await v1(admin, "/api/v1/competitions", "POST", { name: `Pin Other ${tag}` });
  const otherId = v1data<{ id: string }>(otherComp).id;
  const mkPinned = await v1(admin, `/api/v1/orgs/${proOrgId}/api-keys`, "POST", {
    name: "smoke pinned", scopes: ["read"], competition_id: compData.id,
  });
  const pinnedAuth = { Authorization: `Bearer ${v1data<{ secret: string }>(mkPinned).secret}` };
  const pinnedOk = await v1(newSession(), `/api/v1/competitions/${compData.id}`, "GET", undefined, pinnedAuth);
  check("v3: pinned key reads its competition", pinnedOk.status === 200);
  const pinnedOut = await v1(newSession(), `/api/v1/competitions/${otherId}`, "GET", undefined, pinnedAuth);
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
      poster.buf[0] === 0x25 && poster.buf[1] === 0x50 && poster.buf[2] === 0x44 && poster.buf[3] === 0x46,
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
    name: `Strip ${tag}`, url: "https://strip.example",
  });
  check("v3: sponsor row created for strip", stripRow.status === 201);
  const compPage2 = await html(newSession(), `/shared/${proOrgSlug}/${compData.slug}`);
  check("v3: sponsor strip on pro dashboard", compPage2.body.includes(`Strip ${tag}`));
  check("v3: blob sponsor stays shim-only once rows exist", !compPage2.body.includes(`Acme ${tag}`));

  // ---- FREE PATH ------------------------------------------------------
  const free = newSession();
  const freeVer = await signIn(free, `content_free_${tag}@example.com`);
  const freeOrgId = freeVer.org_id as string;
  const freeOrgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const freeSlug = freeOrgs.find((o) => o.id === freeOrgId)?.slug ?? "";

  const freeComp = await v1(free, "/api/v1/competitions", "POST", {
    name: `Free Content ${tag}`,
    visibility: "public",
    description: "## Free words\n\nStill **rendered**.",
  });
  check("v3: free org markdown competition", freeComp.status === 201);
  const freeCompData = v1data<{ id: string; slug: string }>(freeComp);
  const freeDiv = await v1(free, `/api/v1/competitions/${freeCompData.id}/divisions`, "POST", {
    name: "Free Div", sport_key: "generic", variant_key: "score",
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
  check("v3: free OG card renders (violet)", freeOg.status === 200 && freeOg.type.includes("image/png"));

  const freeKey = await v1(free, `/api/v1/orgs/${freeOrgId}/api-keys`, "POST", {
    name: "nope", scopes: ["read"],
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

/** Flip an org's plan directly in the DB — smoke targets a disposable DB and
 *  the billing checkout path can't run without Stripe. */
async function setPlan(orgId: string, plan: string): Promise<void> {
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
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update
        set plan_key = ${plan}, status = 'active', updated_at = now()`;
  } finally {
    await sql.end();
  }
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
    `pass_${tag}@example.com`,
    `funnel_${tag}@example.com`,
    `tos_${tag}@example.com`,
    `player_${tag}@example.com`,
    `ref_${tag}@example.com`,
  ];
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const orgs = await sql`
      delete from organizations
      where created_by in (select id from users where email = any(${emails}))`;
    const users = await sql`delete from users where email = any(${emails})`;
    console.log(`cleanup: removed ${orgs.count} org(s), ${users.count} user(s)`);
  } catch (e) {
    console.warn("cleanup failed:", e instanceof Error ? e.message : e);
  } finally {
    await sql.end();
  }
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
