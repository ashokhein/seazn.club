// Per-sport e2e smoke: drives one full fixture lifecycle for EVERY shipped
// sport module over real HTTP (http://localhost:3000), with sport-specific
// edge cases plus the cross-sport invariants (forfeit, seq conflict, void,
// idempotency, finalize lock) exercised on their own fixtures.
//
// Run with: node --experimental-strip-types scripts/smoke-sports.ts
//
// Requires DATABASE_URL (plan flips + sport-catalog seed + teardown must hit
// the same DB the target server uses). The sport catalog is seeded from the
// engine registry exactly like scripts/sync-sports.ts.
import postgres from "postgres";
import { builtinModules } from "@seazn/engine/sports";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// HTTP plumbing (same shapes as scripts/smoke.ts)
// ---------------------------------------------------------------------------

interface Session {
  cookies: Record<string, string>;
}
const newSession = (): Session => ({ cookies: {} });
const cookieHeader = (s: Session) =>
  Object.entries(s.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

interface V1Res {
  status: number;
  json: {
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string; current_seq?: number };
  };
}

async function v1(
  s: Session,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<V1Res> {
  for (let attempt = 0; ; attempt++) {
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
    // Scoring cadence is 10 events/s per fixture (doc 08 §6) — a sequential
    // smoke can outrun it, so back off and retry instead of failing the run.
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }
    const json = (await res.json().catch(() => ({ ok: false }))) as V1Res["json"];
    return { status: res.status, json };
  }
}
const data = <T>(r: V1Res): T => r.json.data as T;

async function must(s: Session, path: string, method = "GET", body?: unknown): Promise<V1Res> {
  const r = await v1(s, path, method, body);
  if (!r.json.ok) {
    // /api/v1 errors are objects; the auth endpoints return a string.
    const e = r.json.error as { code?: string; message?: string } | string | undefined;
    const detail = typeof e === "string" ? e : `${e?.code ?? ""} ${e?.message ?? ""}`;
    throw new Error(`${method} ${path} → ${r.status} ${detail}`);
  }
  return r;
}

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : `  [${detail}]`}`);
  cond ? pass++ : fail++;
};

const tag = Date.now().toString(36);

// ---------------------------------------------------------------------------
// DB side-channel: catalog seed, plan flip, teardown
// ---------------------------------------------------------------------------

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for smoke-sports");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
}

/** Seed sports + system variants from the engine registry (sync-sports.ts). */
async function seedCatalog(): Promise<void> {
  const sql = db();
  try {
    for (const m of builtinModules) {
      await sql`
        insert into sports (key, name, module_version, position_catalog)
        values (${m.key}, ${m.key}, ${m.version}, ${sql.json(m.positions as never)})
        on conflict (key) do update set
          module_version = excluded.module_version,
          position_catalog = excluded.position_catalog`;
      for (const [variantKey, config] of Object.entries(m.variants)) {
        await sql`
          insert into sport_variants (sport_key, key, name, config, is_system, org_id)
          values (${m.key}, ${variantKey}, ${variantKey}, ${sql.json((config ?? {}) as never)}, true, null)
          on conflict on constraint sport_variants_pkey do update set
            config = excluded.config, is_system = true`;
      }
    }
  } finally {
    await sql.end();
  }
}

async function setPlan(orgId: string, plan: string): Promise<void> {
  const sql = db();
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

async function cleanup(): Promise<void> {
  const emails = [`sports_${tag}@example.com`, `community_${tag}@example.com`];
  const sql = db();
  try {
    // sponsor_orders are RESTRICT (V299): money rows must go before their org.
    await sql`
      delete from sponsor_orders
      where org_id in (select id from organizations
                       where created_by in (select id from users where email = any(${emails})))`;
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

// ---------------------------------------------------------------------------
// Sport drivers
// ---------------------------------------------------------------------------

interface Fx {
  id: string;
  home: string;
  away: string;
}
interface Ev {
  type: string;
  payload: unknown;
}

interface SportDriver {
  sportKey: string;
  variantKey: string;
  /** Overrides merged over the variant preset at division create. */
  config?: Record<string, unknown>;
  /** After core.start: events that decide the fixture with HOME winning. */
  decideEvents(fx: Fx): Ev[];
  /** Sport-specific edge cases on a dedicated fixture. */
  edge(s: Session, fx: Fx, label: string): Promise<void>;
}

async function state(s: Session, fixtureId: string) {
  return data<{ status: string; outcome: { kind?: string; winner?: string } | null; last_seq: number }>(
    await must(s, `/api/v1/fixtures/${fixtureId}/state`),
  );
}

async function append(s: Session, fixtureId: string, ev: Ev, expectedSeq?: number): Promise<V1Res> {
  const seq = expectedSeq ?? (await state(s, fixtureId)).last_seq;
  return v1(s, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: seq,
    type: ev.type,
    payload: ev.payload,
  });
}

/** Append a list sequentially, tracking seq locally; throws on any rejection. */
async function appendAll(s: Session, fixtureId: string, events: Ev[], fromSeq: number): Promise<number> {
  let seq = fromSeq;
  for (const ev of events) {
    const r = await append(s, fixtureId, ev, seq);
    if (!r.json.ok) {
      throw new Error(
        `${ev.type} → ${r.status} ${r.json.error?.code ?? ""} ${r.json.error?.message ?? ""}`,
      );
    }
    seq = data<{ seq: number }>(r).seq;
  }
  return seq;
}

const start: Ev = { type: "core.start", payload: {} };
const note: Ev = { type: "core.note", payload: { text: "smoke" } };

const DRIVERS: SportDriver[] = [
  {
    sportKey: "generic",
    variantKey: "score",
    // The 'score' preset is partial; the module schema requires the rest.
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    decideEvents: () => [{ type: "generic.result", payload: { p1Score: 2, p2Score: 0 } }],
    async edge(s, fx, label) {
      let seq = await appendAll(s, fx.id, [start], 0);
      const bad = await append(s, fx.id, { type: "generic.result", payload: { p1Score: -1 } }, seq);
      check(`${label}: negative score rejected`, bad.status === 422, `got ${bad.status}`);
      seq = await appendAll(s, fx.id, [{ type: "generic.result", payload: { p1Score: 1, p2Score: 1 } }], seq);
      const st = await state(s, fx.id);
      check(`${label}: level score → draw outcome`, st.outcome?.kind === "draw", JSON.stringify(st.outcome));
      const dupe = await append(s, fx.id, { type: "generic.result", payload: { p1Score: 1, p2Score: 0 } }, seq);
      check(`${label}: second result → 422`, dupe.status === 422, `got ${dupe.status}`);
    },
  },
  {
    sportKey: "football",
    variantKey: "11-a-side",
    config: { shootout: true }, // knockout-style decider for the drawn-FT edge
    decideEvents: (fx) => [
      { type: "football.goal", payload: { by: fx.home, minute: 21 } },
      { type: "football.period", payload: { phase: "HT" } },
      { type: "football.period", payload: { phase: "FT" } },
    ],
    async edge(s, fx, label) {
      let seq = await appendAll(s, fx.id, [
        start,
        { type: "football.goal", payload: { by: fx.home, minute: 9 } },
        { type: "football.card", payload: { by: fx.away, color: "red", minute: 30 } },
        // Own goal: struck by home, credited to away → 1-1 at FT.
        { type: "football.goal", payload: { by: fx.home, ownGoal: true, minute: 44 } },
        { type: "football.period", payload: { phase: "HT" } },
        { type: "football.period", payload: { phase: "FT" } },
      ], 0);
      let st = await state(s, fx.id);
      check(`${label}: drawn FT with shootout cfg stays undecided`, st.outcome === null, JSON.stringify(st.outcome));
      // Alternating kicks, home scores / away misses, until unassailable.
      for (let round = 0; round < 6 && st.outcome === null; round++) {
        seq = await appendAll(s, fx.id, [
          { type: "football.shootout.kick", payload: { by: fx.home, scored: true } },
          { type: "football.shootout.kick", payload: { by: fx.away, scored: false } },
        ], seq);
        st = await state(s, fx.id);
      }
      check(
        `${label}: shootout decides for home`,
        st.outcome?.kind === "win" && st.outcome.winner === fx.home,
        JSON.stringify(st.outcome),
      );
      const late = await append(s, fx.id, { type: "football.goal", payload: { by: fx.away } }, seq);
      check(`${label}: goal after decision → 422`, late.status === 422, `got ${late.status}`);
    },
  },
  {
    sportKey: "cricket",
    variantKey: "t20",
    decideEvents: () => [
      // Innings 1 (no toss → home bat first): 120/5 off the full quota.
      { type: "cricket.innings.summary", payload: { runs: 120, wickets: 5, legalBalls: 120 } },
      // Innings 2: away all out 25 short — home win by runs.
      { type: "cricket.innings.summary", payload: { runs: 95, wickets: 10, legalBalls: 104 } },
    ],
    async edge(s, fx, label) {
      // Module-level phase gate: an innings summary before core.start.
      const early = await append(s, fx.id, {
        type: "cricket.innings.summary",
        payload: { runs: 10, wickets: 0, legalBalls: 6 },
      }, 0);
      check(`${label}: summary before start → 422 WRONG_PHASE`, early.status === 422 && early.json.error?.code === "WRONG_PHASE", `got ${early.status} ${early.json.error?.code}`);
      // Toss (pre-start, cricket precedent): away elect to bat → away bat first.
      const seq = await appendAll(s, fx.id, [
        { type: "cricket.toss", payload: { wonBy: fx.away, elected: "bat" } },
        start,
        // Rain: partial innings, interruption, umpire's MANUAL revised target
        // (always allowed — only DLS computation is entitlement-gated).
        { type: "cricket.innings.summary", payload: { runs: 80, wickets: 2, legalBalls: 60, partial: true } },
        { type: "cricket.interruption", payload: { kind: "rain", oversLostEstimate: 5 } },
        { type: "cricket.innings.close", payload: {} },
        { type: "cricket.revise", payload: { oversPerSide: 15, target: 100 } },
        // Chasing side (home) reaches the revised target inside the revised overs.
        { type: "cricket.innings.summary", payload: { runs: 100, wickets: 4, legalBalls: 78 } },
      ], 0);
      void seq;
      const st = await state(s, fx.id);
      check(
        `${label}: rain-revised chase decides for the chasing side`,
        st.outcome?.kind === "win" && st.outcome.winner === fx.home,
        JSON.stringify(st.outcome),
      );
    },
  },
  {
    sportKey: "boardgame",
    variantKey: "blitz",
    decideEvents: (fx) => [{ type: "boardgame.result", payload: { winner: fx.home } }],
    async edge(s, fx, label) {
      let seq = await appendAll(s, fx.id, [
        start,
        { type: "boardgame.result", payload: { winner: null, method: "agreement" } },
      ], 0);
      const st = await state(s, fx.id);
      check(`${label}: null winner → draw`, st.outcome?.kind === "draw", JSON.stringify(st.outcome));
      const dupe = await append(s, fx.id, { type: "boardgame.result", payload: { winner: fx.home } }, seq);
      check(`${label}: result after decision → 422`, dupe.status === 422, `got ${dupe.status}`);
    },
  },
  {
    sportKey: "carrom",
    variantKey: "icf",
    // 9 coins + queen = 12/board (queen capped from 22): three boards win a
    // game to 25, two games win the best-of-3 match.
    decideEvents: (fx) =>
      Array.from({ length: 6 }, () => ({
        type: "carrom.board.summary",
        payload: { winner: fx.home, opponentCoinsLeft: 9, queenTo: fx.home },
      })),
    async edge(s, fx, label) {
      const early = await append(s, fx.id, {
        type: "carrom.board.summary",
        payload: { winner: fx.away, opponentCoinsLeft: 9, queenTo: fx.away },
      }, 0);
      check(`${label}: board before start → 422`, early.status === 422, `got ${early.status}`);
      // Toss is a pre-start sport event (carrom.md §2): away breaks first.
      let seq = await appendAll(s, fx.id, [
        { type: "carrom.toss", payload: { firstBreak: fx.away } },
        start,
      ], 0);
      let st = await state(s, fx.id);
      for (let board = 0; board < 12 && st.outcome === null; board++) {
        seq = await appendAll(s, fx.id, [{
          type: "carrom.board.summary",
          payload: { winner: fx.away, opponentCoinsLeft: 9, queenTo: fx.away },
        }], seq);
        st = await state(s, fx.id);
      }
      check(
        `${label}: board summaries decide for the breaker`,
        st.outcome?.kind === "win" && st.outcome.winner === fx.away,
        JSON.stringify(st.outcome),
      );
    },
  },
  {
    sportKey: "volleyball",
    variantKey: "indoor",
    decideEvents: (fx) => {
      void fx;
      return Array.from({ length: 3 }, () => ({
        type: "volleyball.set.summary",
        payload: { home: 25, away: 20 },
      }));
    },
    async edge(s, fx, label) {
      // Set 1: a completed-set coarse summary.
      let seq = await appendAll(s, fx.id, [
        start,
        { type: "volleyball.set.summary", payload: { home: 25, away: 20 } },
      ], 0);
      // Set 2: partial (live) snapshot, refreshed; a decrease is rejected.
      seq = await appendAll(s, fx.id, [
        { type: "volleyball.set.summary", payload: { home: 10, away: 8, partial: true } },
        { type: "volleyball.set.summary", payload: { home: 15, away: 12, partial: true } },
      ], seq);
      const dec = await append(s, fx.id, {
        type: "volleyball.set.summary", payload: { home: 9, away: 8, partial: true },
      }, seq);
      check(`${label}: decreasing partial snapshot → 422`, dec.status === 422, `got ${dec.status}`);
      // Rally-by-rally (Pro) finishes the open set: 10 home rallies → 25-12.
      seq = await appendAll(
        s, fx.id,
        Array.from({ length: 10 }, () => ({ type: "volleyball.rally", payload: { wonBy: fx.home } })),
        seq,
      );
      let st = await state(s, fx.id);
      check(`${label}: rallies close the snapshot set (2-0, undecided)`, st.outcome === null, `outcome ${JSON.stringify(st.outcome)}`);
      // Set 3: an unreachable final score is rejected, then a real one wins 3-0.
      const bogus = await append(s, fx.id, {
        type: "volleyball.set.summary", payload: { home: 25, away: 24 },
      }, seq);
      check(`${label}: unreachable set score (25-24) → 422`, bogus.status === 422, `got ${bogus.status}`);
      await appendAll(s, fx.id, [
        { type: "volleyball.set.summary", payload: { home: 26, away: 24 } },
      ], seq);
      st = await state(s, fx.id);
      check(
        `${label}: mixed-fidelity 3-0 win`,
        st.outcome?.kind === "win" && st.outcome.winner === fx.home,
        JSON.stringify(st.outcome),
      );
    },
  },
  {
    sportKey: "badminton",
    variantKey: "bwf",
    decideEvents: () => Array.from({ length: 2 }, () => ({
      type: "badminton.game.summary",
      payload: { home: 21, away: 15 },
    })),
    async edge(s, fx, label) {
      let seq = await appendAll(s, fx.id, [start], 0);
      const bad = await append(s, fx.id, {
        type: "badminton.game.summary",
        payload: { home: -1, away: 3 },
      }, seq);
      check(`${label}: negative game score → 422`, bad.status === 422, `got ${bad.status}`);
      seq = await appendAll(s, fx.id, [
        { type: "badminton.game.summary", payload: { home: 21, away: 19 } },
        { type: "badminton.game.summary", payload: { home: 15, away: 21 } },
        { type: "badminton.game.summary", payload: { home: 21, away: 17 } },
      ], seq);
      const st = await state(s, fx.id);
      check(
        `${label}: three-game match decides`,
        st.outcome?.kind === "win" && st.outcome.winner === fx.home,
        JSON.stringify(st.outcome),
      );
    },
  },
  {
    sportKey: "tabletennis",
    variantKey: "bo5",
    decideEvents: () => Array.from({ length: 3 }, () => ({
      type: "tabletennis.game.summary",
      payload: { home: 11, away: 7 },
    })),
    async edge(s, fx, label) {
      const seq = await appendAll(s, fx.id, [
        start,
        { type: "tabletennis.game.summary", payload: { home: 11, away: 9 } },
        { type: "core.abandon", payload: { reason: "venue closed" } },
      ], 0);
      const st = await state(s, fx.id);
      check(`${label}: abandon → status abandoned, no outcome`, st.status === "abandoned" && st.outcome === null, `status ${st.status} outcome ${JSON.stringify(st.outcome)}`);
      const late = await append(s, fx.id, { type: "tabletennis.game.summary", payload: { home: 11, away: 0 } }, seq);
      check(`${label}: scoring after abandon → 422`, late.status === 422, `got ${late.status}`);
    },
  },
];

// ---------------------------------------------------------------------------
// Cross-sport invariants — one dedicated fixture each, per sport
// ---------------------------------------------------------------------------

async function decideFrom(s: Session, d: SportDriver, fx: Fx, fromSeq: number): Promise<void> {
  await appendAll(s, fx.id, d.decideEvents(fx), fromSeq);
}

async function runSport(s: Session, compId: string, d: SportDriver): Promise<void> {
  const label = `${d.sportKey}/${d.variantKey}`;

  const div = await must(s, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: label,
    slug: `${d.sportKey}-${d.variantKey}`.replace(/[^a-z0-9-]/g, "-"),
    sport_key: d.sportKey,
    variant_key: d.variantKey,
    ...(d.config ? { config: d.config } : {}),
  });
  const divId = data<{ id: string }>(div).id;
  check(`${label}: division created (config valid)`, div.status === 201);

  const entrants = await must(s, `/api/v1/divisions/${divId}/entrants`, "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: `${n} ${label}`, seed: i + 1 })));
  check(`${label}: 4 entrants`, data<unknown[]>(entrants).length === 4);

  const stage = await must(s, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1, kind: "league", name: "League",
  });
  const stageId = data<{ id: string }>(stage).id;

  const gen = await must(s, `/api/v1/stages/${stageId}/generate`, "POST");
  const rows = data<{ created: number; fixtures: { id: string; home_entrant_id: string; away_entrant_id: string }[] }>(gen);
  check(`${label}: 6 RR fixtures`, rows.created === 6, `created ${rows.created}`);
  const fx: Fx[] = rows.fixtures.map((f) => ({ id: f.id, home: f.home_entrant_id, away: f.away_entrant_id }));

  // Scoring is closed until the explicit division start (doc 12 §1).
  const closed = await append(s, fx[0].id, start, 0);
  check(`${label}: scoring before division start → 422 WRONG_PHASE`, closed.status === 422 && closed.json.error?.code === "WRONG_PHASE", `got ${closed.status} ${closed.json.error?.code}`);
  await must(s, `/api/v1/divisions/${divId}/start`, "POST");

  // f0 — happy path: start → sport decides → home wins.
  {
    const seq = await appendAll(s, fx[0].id, [start], 0);
    await decideFrom(s, d, fx[0], seq);
    const st = await state(s, fx[0].id);
    check(
      `${label}: happy path decides for home`,
      st.status === "decided" && st.outcome?.kind === "win" && st.outcome.winner === fx[0].home,
      `status ${st.status} outcome ${JSON.stringify(st.outcome)}`,
    );
  }

  // f1 — sport-specific edge cases.
  await d.edge(s, fx[1], label);

  // f2 — forfeit: away forfeits → award to home.
  {
    await appendAll(s, fx[2].id, [
      start,
      { type: "core.forfeit", payload: { by: fx[2].away, reason: "no-show" } },
    ], 0);
    const st = await state(s, fx[2].id);
    // Modules map a forfeit to either an award or a win-by-forfeit; the
    // fixture status is uniformly "forfeited" (engine-db nextStatus).
    check(
      `${label}: forfeit → opponent takes it, status forfeited`,
      st.status === "forfeited" &&
        (st.outcome?.kind === "award" || st.outcome?.kind === "win") &&
        st.outcome.winner === fx[2].home,
      `status ${st.status} outcome ${JSON.stringify(st.outcome)}`,
    );
  }

  // f3 — optimistic concurrency: parallel scorers race on the same seq.
  {
    const seq = await appendAll(s, fx[3].id, [start], 0);
    const race = await Promise.all([
      append(s, fx[3].id, note, seq),
      append(s, fx[3].id, note, seq),
    ]);
    const won = race.filter((r) => r.status === 201);
    const lost = race.filter((r) => r.status === 409);
    check(`${label}: parallel scorers → one 201, one 409`, won.length === 1 && lost.length === 1, race.map((r) => r.status).join("/"));
    check(`${label}: 409 carries current_seq`, lost[0]?.json.error?.current_seq === seq + 1, String(lost[0]?.json.error?.current_seq));
    await decideFrom(s, d, fx[3], seq + 1);
    const st = await state(s, fx[3].id);
    check(`${label}: decided after conflict recovery`, st.outcome?.kind === "win", JSON.stringify(st.outcome));
  }

  // f4 — undo: void a note, then decide normally.
  {
    let seq = await appendAll(s, fx[4].id, [start, note], 0);
    const events = data<{ id: string; seq: number }[]>(await must(s, `/api/v1/fixtures/${fx[4].id}/events`));
    const target = events.find((e) => e.seq === seq);
    const voided = await append(s, fx[4].id, { type: "core.void", payload: { event_id: target?.id } }, seq);
    check(`${label}: core.void accepted`, voided.status === 201, `got ${voided.status}`);
    seq = data<{ seq: number }>(voided).seq;
    await decideFrom(s, d, fx[4], seq);
    const st = await state(s, fx[4].id);
    check(`${label}: decided after void`, st.outcome?.kind === "win" && st.outcome.winner === fx[4].home, JSON.stringify(st.outcome));
  }

  // f5 — idempotent retry, then finalize locks the ledger.
  {
    const first = await v1(s, `/api/v1/fixtures/${fx[5].id}/events`, "POST", {
      expected_seq: 0, type: "core.start", payload: {}, idempotency_key: `smoke-${tag}-${d.sportKey}`,
    });
    const retry = await v1(s, `/api/v1/fixtures/${fx[5].id}/events`, "POST", {
      expected_seq: 0, type: "core.start", payload: {}, idempotency_key: `smoke-${tag}-${d.sportKey}`,
    });
    // With Redis the retry replays the cached 201 (same seq); the cache is
    // fail-open, so without Redis the seq check turns it into a clean 409.
    const replayed = retry.status === 201 && data<{ seq: number }>(first).seq === data<{ seq: number }>(retry).seq;
    const conflicted = retry.status === 409;
    check(
      `${label}: idempotent retry replays (Redis) or conflicts cleanly`,
      first.status === 201 && (replayed || conflicted),
      `${first.status}/${retry.status}`,
    );
    await decideFrom(s, d, fx[5], data<{ seq: number }>(first).seq);
    const st = await state(s, fx[5].id);
    const fin = await v1(s, `/api/v1/fixtures/${fx[5].id}/finalize`, "POST", { expected_seq: st.last_seq });
    check(`${label}: finalize`, fin.json.ok === true, `got ${fin.status}`);
    const after = await append(s, fx[5].id, note);
    check(`${label}: append after finalize rejected`, after.status === 422 || after.status === 403, `got ${after.status}`);
  }

  const standings = await must(s, `/api/v1/stages/${stageId}/standings`);
  check(`${label}: standings rank all 4 entrants`, data<{ rows: unknown[] }>(standings).rows.length === 4);
}

/**
 * Passwordless sign-in: request a magic link, then consume the dev-exposed
 * token (dev returns `login_url`). An unknown email creates the account.
 */
async function signIn(s: Session, email: string): Promise<V1Res> {
  const req = data<{ login_url?: string }>(
    await must(s, "/api/auth/magic-link", "POST", { email }),
  );
  const token = new URL(req.login_url ?? "").searchParams.get("token");
  return must(s, "/api/auth/magic-link/consume", "POST", { token });
}

// ---------------------------------------------------------------------------
// Entitlement gate: fine-fidelity scoring is 402 on community
// ---------------------------------------------------------------------------

async function communityGateSuite(): Promise<void> {
  const s = newSession();
  await signIn(s, `community_${tag}@example.com`);

  const comp = await must(s, "/api/v1/competitions", "POST", { name: `Community Gate ${tag}` });
  const compId = data<{ id: string }>(comp).id;
  const div = await must(s, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Volleyball", sport_key: "volleyball", variant_key: "indoor",
  });
  const divId = data<{ id: string }>(div).id;
  await must(s, `/api/v1/divisions/${divId}/entrants`, "POST",
    ["A", "B"].map((n, i) => ({ kind: "individual", display_name: `${n} gate`, seed: i + 1 })));
  const stage = await must(s, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  const stageId = data<{ id: string }>(stage).id;
  const gen = await must(s, `/api/v1/stages/${stageId}/generate`, "POST");
  const f = data<{ fixtures: { id: string; home_entrant_id: string }[] }>(gen).fixtures[0];
  await must(s, `/api/v1/divisions/${divId}/start`, "POST");
  await appendAll(s, f.id, [start], 0);

  const rally = await append(s, f.id, { type: "volleyball.rally", payload: { wonBy: f.home_entrant_id } }, 1);
  check("community: rally-by-rally → 402 PAYMENT_REQUIRED", rally.status === 402 && rally.json.error?.code === "PAYMENT_REQUIRED", `got ${rally.status} ${rally.json.error?.code}`);

  const coarse = await append(s, f.id, { type: "volleyball.set.summary", payload: { home: 25, away: 12 } }, 1);
  check("community: coarse set summary still allowed (doc 10 §2)", coarse.status === 201, `got ${coarse.status}`);
}

// ---------------------------------------------------------------------------

async function main() {
  await seedCatalog();

  const s = newSession();
  const ver = data<{ org_id: string }>(await signIn(s, `sports_${tag}@example.com`));
  check("owner signed in + org provisioned", !!ver.org_id);

  // Pro BEFORE any division exists: 8 divisions in one competition and the
  // fine-fidelity (rally / ball-by-ball) paths need it. Flipping later would
  // race the 5-min entitlement cache.
  await setPlan(ver.org_id, "pro");

  const comp = await must(s, "/api/v1/competitions", "POST", { name: `Sports Smoke ${tag}` });
  const compId = data<{ id: string }>(comp).id;

  for (const driver of DRIVERS) {
    try {
      await runSport(s, compId, driver);
    } catch (e) {
      check(`${driver.sportKey}/${driver.variantKey}: suite completed`, false,
        e instanceof Error ? e.message : String(e));
    }
  }

  await communityGateSuite();
}

main()
  .then(async () => {
    await cleanup();
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    await cleanup();
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(1);
  });
