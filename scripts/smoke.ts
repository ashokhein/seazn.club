// End-to-end smoke test against the running dev server (http://localhost:3000).
// Run with: node --experimental-strip-types scripts/smoke.ts
const BASE = "http://localhost:3000";

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

type State = {
  tournament: { status: string; undo_remaining: number };
  players: { id: string; name: string }[];
  rounds: { id: string; name: string; stage: string; round_number: number }[];
  matches: {
    id: string;
    round_id: string;
    player1_id: string | null;
    player2_id: string | null;
    winner_id: string | null;
    status: string;
    is_bye: boolean;
  }[];
  standings: { rank: number; player: { name: string }; points: number }[];
};

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

async function winReady(
  s: Session,
  id: string,
  side: "p1" | "p2" = "p1",
) {
  const st = (await call(s, `/api/tournaments/${id}/state`)) as State;
  const m = st.matches.find(
    (x) => x.status === "ready" && x.player1_id && x.player2_id,
  );
  if (!m) throw new Error(`no ready match on ${id}`);
  const winnerId = side === "p1" ? m.player1_id : m.player2_id;
  await call(s, `/api/tournaments/${id}/result`, "POST", {
    match_id: m.id,
    winner_id: winnerId,
  });
}

async function winNamed(s: Session, id: string, winnerName: string) {
  const st = (await call(s, `/api/tournaments/${id}/state`)) as State;
  const winnerId = st.players.find((p) => p.name === winnerName)!.id;
  const m = st.matches.find(
    (x) =>
      x.status === "ready" &&
      x.player1_id &&
      x.player2_id &&
      (x.player1_id === winnerId || x.player2_id === winnerId),
  );
  if (!m) throw new Error(`no ready match for ${winnerName} on ${id}`);
  await call(s, `/api/tournaments/${id}/result`, "POST", {
    match_id: m.id,
    winner_id: winnerId,
  });
}

async function playToCompletion(s: Session, id: string, scoreMode = false, max = 80) {
  let st = (await call(s, `/api/tournaments/${id}/state`)) as State;
  for (let i = 0; i < max && st.tournament.status !== "completed"; i++) {
    const next = st.matches.find(
      (m) => m.status === "ready" && m.player1_id && m.player2_id,
    );
    if (!next) break;
    const payload = scoreMode
      ? { match_id: next.id, player1_score: 2, player2_score: 1 }
      : { match_id: next.id, winner_id: next.player1_id };
    await call(s, `/api/tournaments/${id}/result`, "POST", payload);
    st = (await call(s, `/api/tournaments/${id}/state`)) as State;
  }
  return st;
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
  check("admin signed up + verified", !!admin.cookies["safe_session"]);
  // A default org is auto-provisioned on first sign-in (no forced form).
  check("default org auto-provisioned", !!ver.org_id && ver.has_org === true);
  check("active org cookie set", admin.cookies["safe_org"] === ver.org_id);
  check("verify redirects to dashboard", ver.redirect === "/dashboard");
  const org = { id: ver.org_id };

  const season = (await call(admin, "/api/seasons", "POST", {
    name: "Smoke Season",
    slug: `smoke-season-${tag}`,
  })) as { id: string };
  check("season created in org", !!season.id);

  const presets = (await call(
    admin,
    `/api/orgs/${org.id}/sport-presets`,
  )) as { sport_key: string; use_progress_score: boolean; sport_name: string }[];
  check("sport presets seeded for org", presets.length >= 7);
  const chessPreset = presets.find((p) => p.sport_key === "chess");
  check(
    "chess preset uses progress score",
    chessPreset?.use_progress_score === true,
  );

  const created: string[] = [];

  // --- Swiss + knockout, 8 players (chess) ---
  const t = (await call(admin, "/api/tournaments", "POST", {
    season_id: season.id,
    sport: "Chess",
    name: "Smoke Swiss",
    category: "adult",
    format: "swiss_knockout",
    num_group_rounds: 3,
    knockout_size: 4,
    players: ["Sathis", "Prabhu", "Kiran", "Threno", "Mahendra", "Adil", "Ashok", "Pooja"],
    result_mode: "win_loss",
    use_progress_score: true,
  })) as { id: string };
  created.push(t.id);
  check("swiss created", !!t.id);

  await call(admin, `/api/tournaments/${t.id}/players`, "POST", {
    players: ["LateComer"],
  });
  const stPreStart = (await call(admin, `/api/tournaments/${t.id}/state`)) as State;
  check("player added before start", stPreStart.players.length === 9);

  await call(admin, `/api/tournaments/${t.id}/start`, "POST");
  let st = (await call(admin, `/api/tournaments/${t.id}/state`)) as State;
  const r1 = st.rounds.find((r) => r.round_number === 1)!;
  check("round 1 has 5 boards (9 players)", st.matches.filter((m) => m.round_id === r1.id).length === 5);

  st = await playToCompletion(admin, t.id);
  check("swiss completed", st.tournament.status === "completed");
  check("3 group rounds", st.rounds.filter((r) => r.stage === "group").length === 3);
  check("knockout built", st.rounds.filter((r) => r.stage !== "group").length === 2);

  // --- Undo / budget ---
  await call(admin, `/api/tournaments/${t.id}/undo`, "POST");
  const st2 = (await call(admin, `/api/tournaments/${t.id}/state`)) as State;
  check("undo decremented", st2.tournament.undo_remaining === 2);
  await call(admin, `/api/tournaments/${t.id}/undo`, "POST");
  await call(admin, `/api/tournaments/${t.id}/undo`, "POST");
  await expectFail("undo capped at 3", () =>
    call(admin, `/api/tournaments/${t.id}/undo`, "POST"),
  );

  await call(admin, `/api/tournaments/${t.id}/reset`, "POST");
  const stReset = (await call(admin, `/api/tournaments/${t.id}/state`)) as State;
  check("reset -> setup", stReset.tournament.status === "setup");

  // --- Check-in: drop one player, start with 7 ---
  const drop = stReset.players[0];
  await call(admin, `/api/tournaments/${t.id}/checkin`, "POST", {
    player_id: drop.id,
    checked_in: false,
  });
  await call(admin, `/api/tournaments/${t.id}/start`, "POST");
  const stCheckin = (await call(admin, `/api/tournaments/${t.id}/state`)) as State;
  const r1b = stCheckin.rounds.find((r) => r.round_number === 1)!;
  const r1bMatches = stCheckin.matches.filter((m) => m.round_id === r1b.id);
  check("check-in excluded one player (7 -> 4 boards incl bye)", r1bMatches.length === 4);

  // --- Pure knockout, 6 players (byes) ---
  const k = (await call(admin, "/api/tournaments", "POST", {
    season_id: null,
    sport: "Carrom",
    name: "Smoke Knockout",
    category: "open",
    format: "knockout",
    num_group_rounds: 0,
    knockout_size: 0,
    players: ["A", "B", "C", "D", "E", "F"],
    result_mode: "win_loss",
  })) as { id: string };
  created.push(k.id);
  await call(admin, `/api/tournaments/${k.id}/start`, "POST");
  const kst = await playToCompletion(admin, k.id);
  check("knockout completed", kst.tournament.status === "completed");

  // --- Round robin league only, 4 players ---
  const rr = (await call(admin, "/api/tournaments", "POST", {
    season_id: null,
    sport: "Carrom",
    name: "Smoke RR League",
    category: "open",
    format: "round_robin",
    num_group_rounds: 0,
    knockout_size: 0,
    players: ["W", "X", "Y", "Z"],
    result_mode: "win_loss",
  })) as { id: string };
  created.push(rr.id);
  await call(admin, `/api/tournaments/${rr.id}/start`, "POST");
  const rrStart = (await call(admin, `/api/tournaments/${rr.id}/state`)) as State;
  check("RR generated 3 rounds", rrStart.rounds.filter((r) => r.stage === "group").length === 3);
  check("RR generated 6 fixtures", rrStart.matches.length === 6);
  const rrDone = await playToCompletion(admin, rr.id);
  check("RR league completed", rrDone.tournament.status === "completed");

  // --- Stepladder top 3 with 2nd/3rd tie: play-off then Final only (no semi rematch) ---
  const sl3 = (await call(admin, "/api/tournaments", "POST", {
    season_id: season.id,
    sport: "Chess",
    name: "Smoke Stepladder 3 tie",
    category: "adult",
    format: "progress_stepladder",
    num_group_rounds: 3,
    knockout_size: 4,
    players: ["A", "B", "C"],
    result_mode: "win_loss",
    use_progress_score: true,
  })) as { id: string };
  created.push(sl3.id);
  await call(admin, `/api/tournaments/${sl3.id}/start`, "POST");
  // R1: A beats B | R2: C beats A | R3: B beats C => all tie on 1 pt
  await winNamed(admin, sl3.id, "A");
  await winNamed(admin, sl3.id, "C");
  await winNamed(admin, sl3.id, "B");
  const sl3Tie = (await call(admin, `/api/tournaments/${sl3.id}/state`)) as State;
  check("stepladder3 tie triggers play-off", sl3Tie.rounds.some((r) => r.name === "Seeding play-off"));
  check(
    "stepladder3 no semi before play-off result",
    !sl3Tie.rounds.some((r) => r.name === "Semi-final"),
  );
  await winNamed(admin, sl3.id, "B");
  const sl3After = (await call(admin, `/api/tournaments/${sl3.id}/state`)) as State;
  check(
    "stepladder3 no semi after play-off",
    !sl3After.rounds.some((r) => r.name === "Semi-final"),
  );
  check(
    "stepladder3 play-off winner in final",
    sl3After.matches.some(
      (m) =>
        m.label === "Final" &&
        m.status === "ready" &&
        m.player1_id &&
        m.player2_id,
    ),
  );
  const bId = sl3After.players.find((p) => p.name === "B")!.id;
  const cId = sl3After.players.find((p) => p.name === "C")!.id;
  const finalsBc = sl3After.matches.filter((m) => {
    const r = sl3After.rounds.find((rd) => rd.id === m.round_id);
    return (
      r &&
      r.stage !== "group" &&
      ((m.player1_id === bId && m.player2_id === cId) ||
        (m.player1_id === cId && m.player2_id === bId))
    );
  });
  check("stepladder3 B and C meet only once after group", finalsBc.length === 1);

  // --- Stepladder finals (Top 4) with a forced 2nd/3rd tie -> seeding play-off ---
  const sl4 = (await call(admin, "/api/tournaments", "POST", {
    season_id: season.id,
    sport: "Chess",
    name: "Smoke Stepladder 4",
    category: "adult",
    format: "progress_stepladder",
    num_group_rounds: 2,
    knockout_size: 4,
    players: ["S1", "S2", "S3", "S4"],
    result_mode: "win_loss",
  })) as { id: string };
  created.push(sl4.id);
  await call(admin, `/api/tournaments/${sl4.id}/start`, "POST");
  const sl4Done = await playToCompletion(admin, sl4.id);
  const names4 = sl4Done.rounds.map((r) => r.name);
  check("stepladder4 completed", sl4Done.tournament.status === "completed");
  check("stepladder4 seeding play-off triggered", names4.includes("Seeding play-off"));
  check("stepladder4 has Eliminator", names4.includes("Eliminator"));
  check("stepladder4 has Semi-final", names4.includes("Semi-final"));
  check(
    "stepladder4 has a single Final (stage=final)",
    sl4Done.rounds.filter((r) => r.stage === "final").length === 1,
  );

  // =====================================================================
  // Team management: invites + role enforcement
  // =====================================================================

  // A fresh tournament we can use to probe edit permissions while it's live.
  const tv = (await call(admin, "/api/tournaments", "POST", {
    season_id: null,
    sport: "Carrom",
    name: "Smoke Perms",
    category: "open",
    format: "round_robin",
    num_group_rounds: 0,
    knockout_size: 0,
    players: ["P1", "P2", "P3", "P4"],
    result_mode: "win_loss",
  })) as { id: string };
  created.push(tv.id);
  await call(admin, `/api/tournaments/${tv.id}/start`, "POST");

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
  check("no session before verifying", !viewer.cookies["safe_session"]);
  await expectFail("login blocked before verification", () =>
    call(newSession(), "/api/auth/login", "POST", {
      email: viewerEmail,
      password: "viewerpass",
    }),
  );
  await call(viewer, "/api/auth/verify-email", "POST", {
    token: vreg.verify_token,
  });
  check("session created after verifying", !!viewer.cookies["safe_session"]);

  const accept = (await call(
    viewer,
    `/api/invites/${viewerInvite.token}/accept`,
    "POST",
  )) as { role: string };
  check("viewer joined as viewer", accept.role === "viewer");
  check("viewer active org set", viewer.cookies["safe_org"] === org.id);

  // Viewer can read state (public) but cannot create or record.
  await call(viewer, `/api/tournaments/${tv.id}/state`);
  check("viewer can read state", true);
  await expectFail("viewer cannot create tournament", () =>
    call(viewer, "/api/tournaments", "POST", {
      season_id: null,
      sport: "Chess",
      name: "Nope",
      category: "open",
      format: "knockout",
      num_group_rounds: 0,
      knockout_size: 0,
      players: ["x", "y"],
      result_mode: "win_loss",
    }),
  );
  const liveState = (await call(viewer, `/api/tournaments/${tv.id}/state`)) as State;
  const ready = liveState.matches.find(
    (m) => m.status === "ready" && m.player1_id,
  )!;
  await expectFail("viewer cannot record a result", () =>
    call(viewer, `/api/tournaments/${tv.id}/result`, "POST", {
      match_id: ready.id,
      winner_id: ready.player1_id,
    }),
  );
  // The single-use invite is now spent.
  await expectFail("single-use invite is spent", () =>
    call(newSession(), `/api/invites/${viewerInvite.token}/accept`, "POST"),
  );

  // Admin invite -> a second user joins and CAN create a tournament.
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
  const mt = (await call(member, "/api/tournaments", "POST", {
    season_id: null,
    sport: "Chess",
    name: "Member Made",
    category: "open",
    format: "knockout",
    num_group_rounds: 0,
    knockout_size: 0,
    players: ["m1", "m2", "m3", "m4"],
    result_mode: "win_loss",
  })) as { id: string };
  created.push(mt.id);
  check("invited admin can create tournament", !!mt.id);

  // Members listing reflects 3 people (owner + viewer + admin).
  const members = (await call(admin, `/api/orgs/${org.id}/members`)) as {
    role: string;
  }[];
  check("org has 3 members", members.length === 3);
  check("exactly one owner", members.filter((m) => m.role === "owner").length === 1);

  // --- Multi-org: a user may create additional orgs; slug is auto-assigned ---
  const org2 = (await call(admin, "/api/orgs", "POST", {
    name: `Second Org ${tag}`,
  })) as { id: string; slug: string };
  check("can create additional org", !!org2.id);
  check("org slug auto-generated", /^org-[0-9a-f]+$/.test(org2.slug));
  check("creating org switches active", admin.cookies["safe_org"] === org2.id);
  const myOrgs = (await call(admin, "/api/orgs")) as { id: string }[];
  check("admin now belongs to 2 orgs", myOrgs.length === 2);
  // Rename the active org; slug stays immutable.
  const renamed = (await call(admin, `/api/orgs/${org2.id}`, "PATCH", {
    name: "Renamed Org",
  })) as { name: string; slug: string };
  check("org renamed", renamed.name === "Renamed Org");
  check("slug immutable on rename", renamed.slug === org2.slug);

  // --- Delete tournament (setup only) ---
  const trash = (await call(admin, "/api/tournaments", "POST", {
    season_id: null,
    sport: "Chess",
    name: "Delete Me",
    category: "open",
    format: "knockout",
    num_group_rounds: 0,
    knockout_size: 0,
    players: ["X", "Y"],
    result_mode: "win_loss",
  })) as { id: string };
  await call(admin, `/api/tournaments/${trash.id}`, "DELETE");
  await expectFail("deleted tournament gone", () =>
    call(admin, `/api/tournaments/${trash.id}/state`),
  );
  const started = (await call(admin, "/api/tournaments", "POST", {
    season_id: null,
    sport: "Chess",
    name: "Started",
    category: "open",
    format: "knockout",
    num_group_rounds: 0,
    knockout_size: 0,
    players: ["P", "Q"],
    result_mode: "win_loss",
  })) as { id: string };
  created.push(started.id);
  await call(admin, `/api/tournaments/${started.id}/start`, "POST");
  await expectFail("cannot delete started tournament", () =>
    call(admin, `/api/tournaments/${started.id}`, "DELETE"),
  );

  console.log(`\nCreated test tournaments: ${created.join(", ")}`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
