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

  // Admin invite -> a second user joins and CAN create a competition.
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

  // --- Growth-wave gaps (device links, scorer seats, discovery, registration,
  // ownership transfer, downgrade freeze) — pro paths on org2, free paths on a
  // fresh community owner. Destructive downgrade runs last.
  await gapSuite(admin, org.id, org2.id);
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
  // divisions.per_competition quota is 1, and DELETE frees the slot. Creating
  // the org switches the active-org cookie onto it.
  await call(admin, "/api/orgs", "POST", { name: `Del Org ${tag}` });
  const comp = await v1(admin, "/api/v1/competitions", "POST", { name: `Del Cup ${tag}` });
  const compId = v1data<{ id: string }>(comp).id;
  const first = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "First",
    ...genericDivision,
  });
  check("del: free org creates division 1", first.status === 201);
  const firstId = v1data<{ id: string }>(first).id;
  const blocked = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Second",
    ...genericDivision,
  });
  check("del: division 2 blocked on free (402)", blocked.status === 402);

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
