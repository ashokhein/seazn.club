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

const tag = Date.now().toString(36);

async function main() {
  const admin = newSession();

  // --- Auth: sign up a fresh owner (signup -> verify -> session) ---
  const areg = (await call(admin, "/api/auth/signup", "POST", {
    email: `admin_${tag}@example.com`,
    password: "adminpass",
  })) as { verify_token?: string };
  const ver = (await call(admin, "/api/auth/verify-email", "POST", {
    token: areg.verify_token,
  })) as { has_org: boolean; org_id: string; redirect: string };
  check("admin signed up + verified", !!admin.cookies["seazn_session"]);
  // A default org is auto-provisioned on first sign-in (no forced form).
  check("default org auto-provisioned", !!ver.org_id && ver.has_org === true);
  check("active org cookie set", admin.cookies["seazn_org"] === ver.org_id);
  // A brand-new account (no onboarding completed) lands on the first-run wizard.
  check("verify redirects new user to onboarding", ver.redirect === "/onboarding");
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
  const vreg = (await call(viewer, "/api/auth/signup", "POST", {
    email: viewerEmail,
    password: "viewerpass",
  })) as { needs_verification: boolean; verify_token?: string };
  check("signup requires verification", vreg.needs_verification === true);
  check("no session before verifying", !viewer.cookies["seazn_session"]);
  await expectFail("login blocked before verification", () =>
    call(newSession(), "/api/auth/login", "POST", {
      email: viewerEmail,
      password: "viewerpass",
    }),
  );
  await call(viewer, "/api/auth/verify-email", "POST", {
    token: vreg.verify_token,
  });
  check("session created after verifying", !!viewer.cookies["seazn_session"]);

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
  const mreg = (await call(member, "/api/auth/signup", "POST", {
    email: `member_${tag}@example.com`,
    password: "memberpass",
  })) as { verify_token?: string };
  await call(member, "/api/auth/verify-email", "POST", {
    token: mreg.verify_token,
  });
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
  check("org slug auto-generated", /^org-[0-9a-f]+$/.test(org2.slug));
  check("creating org switches active", admin.cookies["seazn_org"] === org2.id);
  const myOrgs = (await call(admin, "/api/orgs")) as { id: string }[];
  check("admin now belongs to 2 orgs", myOrgs.length === 2);
  // Rename the active org; slug stays immutable.
  const renamed = (await call(admin, `/api/orgs/${org2.id}`, "PATCH", {
    name: "Renamed Org",
  })) as { name: string; slug: string };
  check("org renamed", renamed.name === "Renamed Org");
  check("slug immutable on rename", renamed.slug === org2.slug);

  // --- Platform API /api/v1 (PROMPT-11) — the full engine v2 lifecycle ---
  await v1Suite(admin, org2.id, org2.slug);

  // --- Jul3 feature wave (PROMPT-21..28) over real HTTP ---
  // The advanced features are entitlement-gated — org2 must be Pro (and it
  // needs headroom past competitions.max_active for the extra competitions).
  await setPlan(org2.id, "pro");
  await jul3Suite(admin, org2.id);
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
async function jul3Suite(admin: Session, orgId: string): Promise<void> {
  void orgId;
  // Fresh competition + football division (football has the richest surface:
  // scorers, cards, MOTM, scoresheets).
  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { name: `Jul3 Cup ${tag}`, visibility: "public" }),
  );
  const div = await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;

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
 * Purge this run's test data: delete the three test users and every org they
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
