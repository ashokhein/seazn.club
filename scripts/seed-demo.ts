// Rich demo seeder: 5 competitions, ≥3 divisions each, every stage format
// (league, league+finals, groups+KO, swiss, knockout, double elim,
// group+stepladder), mixed entrant kinds (individual/team/pair), random
// entrant counts, and results played so standings/fixtures/brackets populate.
//
// Usage (dev server must be running on SEED_BASE, default localhost:3000):
//   npm run seed:demo:setup -- --account=pro         (or --account=community)
//   npm run seed:demo -- --account=pro
//
// Two account flavours: --account=pro gets a real pro subscription row (set
// via DATABASE_URL) and the full 5-competition plan; --account=community
// stays inside the free caps (2 competitions × 1 division) and shows the
// gated/paywalled experience. Accounts land in .seed-demo-state.json
// (gitignored). --phase=seed is resume-safe: rerunning skips competitions/
// divisions that already exist, so tweak the PLANs below and rerun.
import { writeFileSync, readFileSync } from "node:fs";

const BASE = process.env.SEED_BASE ?? "http://localhost:3000";
const STATE = new URL("./.seed-demo-state.json", import.meta.url).pathname;
const PASSWORD = process.env.SEED_PASSWORD ?? "smokepass123";

const jar = new Map<string, string>();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function call(path: string, method = "GET", body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(jar.size ? { cookie: cookieHeader() } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false)
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json.data ?? json;
}

const rnd = (n: number) => Math.floor(Math.random() * n);
const coin = () => Math.random() < 0.5;

// ── name pools ──────────────────────────────────────────────────────────────
const FIRST = ["Aarav","Meera","Ishaan","Priya","Rohan","Anaya","Kabir","Diya","Vihaan","Sara","Arjun","Nisha","Ravi","Tara","Dev","Lila"];
const LAST = ["Sharma","Patel","Khan","Nguyen","Iyer","Fernandes","Das","Reddy","Mehta","Bose","Kapoor","Joshi","Rao","Menon","Gill","Nair"];
const CLUBS = ["Riverside","Lakeside","Northfield","Summit","Harbour","Valley","Meadow","Crestwood","Oakwood","Brookfield","Hillcrest","Seaview"];
let nameCursor = 0;
const person = () => `${FIRST[nameCursor % 16]} ${LAST[(nameCursor++ * 7 + 3) % 16]}`;

function entrantsFor(kind: "individual" | "team" | "pair", n: number) {
  if (kind === "team")
    return CLUBS.slice(0, n).map((c, i) => ({ kind, display_name: `${c} ${coin() ? "FC" : "CC"}`, seed: i + 1 }));
  if (kind === "pair")
    return Array.from({ length: n }, (_, i) => ({
      kind, display_name: `${person().split(" ")[0]} / ${person().split(" ")[0]}`, seed: i + 1,
    }));
  return Array.from({ length: n }, (_, i) => ({ kind, display_name: person(), seed: i + 1 }));
}

// ── stage templates (mirror division-builder) ───────────────────────────────
type StageSpec = { kind: string; name: string; config: Record<string, unknown>; qualification: Record<string, unknown> | null };
const TEMPLATES: Record<string, (q: number) => StageSpec[]> = {
  league: () => [{ kind: "league", name: "League", config: { legs: 1 }, qualification: null }],
  league_ko: (q) => [
    { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
    { kind: "knockout", name: "Finals", config: {}, qualification: { topN: q } },
  ],
  groups_ko: (q) => [
    { kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 2 } }, qualification: null },
    { kind: "knockout", name: "Knockout", config: {},
      qualification: { take: Array.from({ length: q }, (_, i) => ({ pool: i % 2 === 0 ? "A" : "B", rank: Math.floor(i / 2) + 1 })) } },
  ],
  swiss: () => [{ kind: "swiss", name: "Swiss", config: { rounds: 5 }, qualification: null }],
  knockout: () => [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
  double_elim: () => [{ kind: "double_elim", name: "Double elimination", config: {}, qualification: null }],
  group_stepladder: (q) => [
    { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
    { kind: "stepladder", name: "Stepladder finals", config: {}, qualification: { topN: q } },
  ],
  // Jul3/08 formats
  triple_rr: () => [{ kind: "league", name: "Triple RR", config: { legs: 3 }, qualification: null }],
};

// ── per-sport result events (winner side chosen by us) ─────────────────────
type Ev = { type: string; payload: unknown };
function resultEvents(sport: string, variant: string, fx: { home: string; away: string }, homeWins: boolean): Ev[] {
  const w = homeWins ? fx.home : fx.away;
  const l = homeWins ? fx.away : fx.home;
  const events: Ev[] = [{ type: "core.start", payload: {} }];
  switch (sport) {
    case "football": {
      const wg = 1 + rnd(4), lg = rnd(wg);
      for (let i = 0; i < wg; i++) events.push({ type: "football.goal", payload: { by: w, minute: 5 + rnd(85) } });
      for (let i = 0; i < lg; i++) events.push({ type: "football.goal", payload: { by: l, minute: 5 + rnd(85) } });
      events.push({ type: "football.period", payload: { phase: "HT" } });
      events.push({ type: "football.period", payload: { phase: "FT" } });
      return events;
    }
    case "cricket": {
      // Innings quota per variant: t20 120 balls, hundred 100, odi 300.
      const quota = variant === "hundred" ? 100 : variant === "odi" ? 300 : 120;
      const bpo = variant === "hundred" ? 5 : 6;
      const first = 100 + rnd(80);
      // home wins the toss and bats; homeWins ⇒ chase falls short. Toss must
      // precede core.start, and a progressive innings needs a real open innings.
      events.unshift({ type: "cricket.toss", payload: { wonBy: fx.home, elected: "bat" } });
      const chase = homeWins ? first - (5 + rnd(40)) : first + 1 + rnd(20);
      // Over-by-over: a few progressive innings.summary updates (engine
      // enforces monotone growth) — the same event the over-by-over pad emits
      // — then close. Stepped in quarters to keep the seed fast.
      const overBuild = (total: number, wkts: number) => {
        for (let step = 1; step <= 4; step++) {
          events.push({
            type: "cricket.innings.summary",
            payload: {
              runs: Math.round((total * step) / 4),
              wickets: Math.round((wkts * step) / 4),
              legalBalls: Math.round((quota * step) / 4 / bpo) * bpo,
              // progressive; the final step reaches the quota and auto-closes
              // the innings (overs done) — the next innings opens on demand.
              partial: step < 4,
            },
          });
        }
      };
      overBuild(first, 3 + rnd(7));
      overBuild(Math.max(chase, 10), homeWins ? 10 : 3 + rnd(6));
      return events;
    }
    case "boardgame":
      events.push({ type: "boardgame.result", payload: { winner: w, method: coin() ? "checkmate" : "resign" } });
      return events;
    case "generic":
      events.push({ type: "generic.result", payload: homeWins ? { p1Score: 2 + rnd(3), p2Score: rnd(2) } : { p1Score: rnd(2), p2Score: 2 + rnd(3) } });
      return events;
    default: {
      // Set-based — targets depend on sport AND variant; straight sets keep us
      // clear of deciding-set target differences (e.g. beach final set to 15).
      const params: Record<string, { setTo: number; need: number }> = {
        "volleyball:indoor": { setTo: 25, need: 3 },
        "volleyball:beach": { setTo: 21, need: 2 },
        "badminton:bwf": { setTo: 21, need: 2 },
        "badminton:short": { setTo: 11, need: 2 },
        "tabletennis:bo5": { setTo: 11, need: 3 },
        "tabletennis:bo7": { setTo: 11, need: 4 },
        "tabletennis:hardbat-21": { setTo: 21, need: 3 },
      };
      const { setTo, need } = params[`${sport}:${variant}`] ?? { setTo: 21, need: 2 };
      const evType =
        sport === "volleyball" ? "volleyball.set.summary" : `${sport}.game.summary`;
      for (let i = 0; i < need; i++) {
        const losing = Math.max(0, setTo - 2 - rnd(setTo - 2));
        events.push({
          type: evType,
          payload: homeWins ? { home: setTo, away: losing } : { home: losing, away: setTo },
        });
      }
      return events;
    }
  }
}

async function decideFixture(fixtureId: string, sport: string, variant: string, fx: { home: string; away: string }) {
  let seq = 0;
  for (const ev of resultEvents(sport, variant, fx, coin())) {
    const r = await call(`/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: seq, type: ev.type, payload: ev.payload });
    seq = r.seq;
  }
}

interface GenFx { id: string; round_no?: number; home_entrant_id: string | null; away_entrant_id: string | null }

/** Decide fixtures round by round, refetching feeds (brackets fill as rounds decide). */
async function playStage(stageId: string, sport: string, variant: string, ratio: number) {
  const gen = await call(`/api/v1/stages/${stageId}/generate`, "POST");
  let fixtures: GenFx[] = gen.fixtures;
  const total = fixtures.length;
  const target = Math.ceil(total * ratio);
  let played = 0;
  const rounds = [...new Set(fixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
  for (const round of rounds) {
    for (const f of fixtures.filter((x) => (x.round_no ?? 0) === round)) {
      if (played >= target) return { total, played };
      const cur = (await call(`/api/v1/fixtures/${f.id}`)) as GenFx & { status: string };
      if (!cur.home_entrant_id || !cur.away_entrant_id) continue; // unresolved feed / bye
      if (cur.status !== "scheduled") continue; // bye already awarded
      await decideFixture(f.id, sport, variant, { home: cur.home_entrant_id, away: cur.away_entrant_id });
      played++;
    }
  }
  return { total, played };
}

// ── competition plan ────────────────────────────────────────────────────────
interface DivPlan {
  name: string; sport: string; variant: string; kind: "individual" | "team" | "pair";
  n: number; template: keyof typeof TEMPLATES; q?: number; ratio: number;
  config?: Record<string, unknown>;
}
const GENERIC_CFG = { resultMode: "score", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };

// Pro account: the full spread — every format, mixed kinds, 5 competitions.
const PLAN_PRO: { name: string; divisions: DivPlan[] }[] = [
  { name: "Spring Football League", divisions: [
    { name: "Premier Division", sport: "football", variant: "11-a-side", kind: "team", n: 6 + rnd(3), template: "league", ratio: 1 },
    { name: "U16 Cup", sport: "football", variant: "youth", kind: "team", n: 8, template: "league_ko", q: 4, ratio: 1 },
    { name: "Sunday 5s", sport: "football", variant: "small-sided", kind: "team", n: 5 + rnd(3), template: "league", ratio: 0.5 },
  ]},
  { name: "Racquet Masters", divisions: [
    { name: "Badminton Singles", sport: "badminton", variant: "bwf", kind: "individual", n: 7 + rnd(4), template: "league", ratio: 0.7 },
    { name: "TT Doubles", sport: "tabletennis", variant: "bo5", kind: "pair", n: 8, template: "groups_ko", q: 4, ratio: 1 },
    { name: "Badminton Juniors", sport: "badminton", variant: "short", kind: "individual", n: 8, template: "knockout", ratio: 1 },
  ]},
  { name: "Chess Open 2026", divisions: [
    { name: "Open Swiss", sport: "boardgame", variant: "classical", kind: "individual", n: 10 + rnd(3), template: "swiss", ratio: 0.6 },
    { name: "Blitz Knockout", sport: "boardgame", variant: "blitz", kind: "individual", n: 8, template: "knockout", ratio: 0.8 },
    { name: "Rapid League", sport: "boardgame", variant: "rapid", kind: "individual", n: 5 + rnd(3), template: "league", ratio: 1 },
  ]},
  { name: "Cricket Cup", divisions: [
    { name: "T20 Groups", sport: "cricket", variant: "t20", kind: "team", n: 8, template: "groups_ko", q: 4, ratio: 1 },
    { name: "Village League", sport: "cricket", variant: "t20", kind: "team", n: 5, template: "league", ratio: 0.8 },
    { name: "Hundred Bash", sport: "cricket", variant: "hundred", kind: "team", n: 6, template: "league", ratio: 0.4 },
  ]},
  { name: "Community Games", divisions: [
    { name: "Carrom Ladder", sport: "generic", variant: "score", kind: "individual", n: 6, template: "group_stepladder", q: 4, ratio: 1, config: GENERIC_CFG },
    { name: "Darts Double Elim", sport: "generic", variant: "score", kind: "individual", n: 8, template: "double_elim", ratio: 0.7, config: GENERIC_CFG },
    { name: "Volleyball League", sport: "volleyball", variant: "indoor", kind: "team", n: 6, template: "league_ko", q: 4, ratio: 1 },
    { name: "Beach Pairs", sport: "volleyball", variant: "beach", kind: "pair", n: 5 + rnd(3), template: "league", ratio: 0.6 },
  ]},
  // Jul3/08 new formats (triple RR here; americano + ladder seeded separately
  // by seedAdvancedFormats since they need linked persons / on-demand fixtures).
  { name: "Padel & Ladder Club", divisions: [
    { name: "Triple Round Robin", sport: "generic", variant: "score", kind: "individual", n: 4, template: "triple_rr", ratio: 1, config: GENERIC_CFG },
  ]},
];

// Community account: stays INSIDE the free caps (2 active competitions,
// 1 division each, ≤16 entrants, ≤2 stages, no double elim) — shows the real
// free experience including the Pro badges on gated controls.
const PLAN_COMMUNITY: { name: string; divisions: DivPlan[] }[] = [
  { name: "Friday Night Football", divisions: [
    { name: "League", sport: "football", variant: "small-sided", kind: "team", n: 6, template: "league", ratio: 0.7 },
  ]},
  { name: "Office Table Tennis", divisions: [
    { name: "Singles Championship", sport: "tabletennis", variant: "bo5", kind: "individual", n: 8, template: "league_ko", q: 4, ratio: 1 },
  ]},
];

function loadState(): Record<string, { email: string }> {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const phase = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "seed";
  const account = (process.argv.find((a) => a.startsWith("--account="))?.split("=")[1] ?? "pro") as
    | "community"
    | "pro";
  const PLAN = account === "community" ? PLAN_COMMUNITY : PLAN_PRO;

  if (phase === "setup") {
    const email = `smoke-${account}-${1000 + rnd(9000)}@example.com`;
    const reg = await call("/api/auth/signup", "POST", { email, password: PASSWORD });
    await call("/api/auth/verify-email", "POST", { token: reg.verify_token });
    await call("/api/onboarding/complete", "POST");
    await call("/api/tour", "POST");
    writeFileSync(STATE, JSON.stringify({ ...loadState(), [account]: { email } }));
    console.log(`${account} account: ${email} / ${PASSWORD}`);

    // Pro account gets a real pro subscription row — entitlements resolve from
    // plan_entitlements exactly like a paying org (no piecemeal overrides).
    if (account === "pro") {
      if (!process.env.DATABASE_URL) {
        console.log("DATABASE_URL not set — set the org's subscription to 'pro' manually before seeding");
        return;
      }
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL, {
        connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
        ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : "require",
        max: 1,
        prepare: !process.env.DATABASE_URL.includes(":6543"),
      });
      await sql`
        with org as (
          select m.org_id from org_members m join users u on u.id = m.user_id
          where u.email = ${email} limit 1)
        insert into subscriptions (org_id, plan_key, status)
        select org_id, 'pro', 'active' from org
        on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
      await sql.end();
      console.log("subscription set to pro/active");
    }
    return;
  }

  const state = loadState();
  const email = state[account]?.email;
  if (!email) throw new Error(`no ${account} account in ${STATE} — run --phase=setup --account=${account} first`);
  await call("/api/auth/login", "POST", { email, password: PASSWORD });

  for (const comp of PLAN) {
    // Resume-safe: on a slug conflict reuse the existing competition and skip
    // any division that already exists.
    let c: { id: string };
    try {
      c = await call("/api/v1/competitions", "POST", { name: comp.name });
    } catch (e) {
      if (!String(e).includes("already in use")) throw e;
      const list = await call("/api/v1/competitions?limit=100");
      c = (list.items ?? list).find((x: { name: string }) => x.name === comp.name);
      console.log(`${comp.name}: exists, resuming`);
    }
    const existingRes = await call(`/api/v1/competitions/${c.id}/divisions`);
    const existingArr: { name: string }[] = Array.isArray(existingRes)
      ? existingRes
      : (existingRes.items ?? []);
    const existingNames = new Set(existingArr.map((x) => x.name));
    for (const d of comp.divisions) {
      if (existingNames.has(d.name)) {
        console.log(`${comp.name} / ${d.name}: exists, skipped`);
        continue;
      }
      const div = await call(`/api/v1/competitions/${c.id}/divisions`, "POST", {
        name: d.name, sport_key: d.sport, variant_key: d.variant,
        ...(d.config ? { config: d.config } : {}),
      });
      await call(`/api/v1/divisions/${div.id}/entrants`, "POST", entrantsFor(d.kind, d.n));
      const specs = TEMPLATES[d.template](d.q ?? 4).map((s, i) => ({ ...s, seq: i + 1 }));
      const created = await call(`/api/v1/divisions/${div.id}/stages`, "POST", specs);
      const stages: { id: string; kind: string; seq: number }[] = Array.isArray(created) ? created : [created];
      stages.sort((a, b) => a.seq - b.seq);

      const first = await (async () => {
        const gen = await playStageAfterStart(div.id, stages[0].id, d.sport, d.variant, d.ratio);
        return gen;
      })();
      let note = `${first.played}/${first.total}`;
      // Second stage only when the first fully decided. Completing stage 1
      // FIRST is what resolves qualification (topN/take) into the next
      // stage's config.qualified — generating without it would bracket every
      // division entrant instead of the qualifiers.
      if (stages[1] && first.played === first.total) {
        await call(`/api/v1/stages/${stages[0].id}/complete`, "POST");
        const second = await playStage(stages[1].id, d.sport, d.variant, 0.6 + Math.random() * 0.4);
        note += ` + ${stages[1].kind} ${second.played}/${second.total}`;
      }
      console.log(`${comp.name} / ${d.name} (${d.sport}, ${d.kind}×${d.n}, ${d.template}): ${note}`);
    }
  }

  // Jul3/08 formats that need bespoke seeding (linked persons / on-demand
  // fixtures) — only on the Pro account, into the Padel & Ladder Club.
  if (account === "pro") await seedAdvancedFormats();

  console.log("done");
}

/** Seed an americano stage (needs individual entrants backed by persons) and a
 *  ladder stage with a couple of played challenges (reorders the ladder). Both
 *  under the "Padel & Ladder Club" competition created by the main PLAN loop. */
async function seedAdvancedFormats(): Promise<void> {
  const comps = await call("/api/v1/competitions?limit=100");
  const club = ((comps.items ?? comps) as { id: string; name: string }[]).find(
    (c) => c.name === "Padel & Ladder Club",
  );
  if (!club) return;
  const existing = await call(`/api/v1/competitions/${club.id}/divisions`);
  const names = new Set(((existing.items ?? existing) as { name: string }[]).map((d) => d.name));

  // --- Americano: 8 individuals backed by persons, one round played ---
  if (!names.has("Americano Night")) {
    const div = await call(`/api/v1/competitions/${club.id}/divisions`, "POST", {
      name: "Americano Night", sport_key: "generic", variant_key: "score", config: GENERIC_CFG,
    });
    const players = [];
    for (let i = 0; i < 8; i++) {
      const p = (await call("/api/v1/persons", "POST", { full_name: person(), consent: {} })) as { id: string };
      players.push({
        kind: "individual", display_name: `P${i + 1}`, seed: i + 1,
        members: [{ person_id: p.id, is_captain: false, roles: [] }],
      });
    }
    await call(`/api/v1/divisions/${div.id}/entrants`, "POST", players);
    const st = await call(`/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1, kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 5 },
    });
    const gen = await call(`/api/v1/stages/${st.id}/generate`, "POST");
    await call(`/api/v1/divisions/${div.id}/start`, "POST");
    let played = 0;
    for (const f of (gen.fixtures as GenFx[]).filter((x) => (x.round_no ?? 0) === 1)) {
      const cur = (await call(`/api/v1/fixtures/${f.id}`)) as GenFx & { status: string };
      if (cur.home_entrant_id && cur.away_entrant_id && cur.status === "scheduled") {
        await decideFixture(f.id, "generic", "score", { home: cur.home_entrant_id, away: cur.away_entrant_id });
        played++;
      }
    }
    console.log(`Padel & Ladder Club / Americano Night (generic, individual×8, americano): ${played}/${gen.fixtures.length} round 1`);
  }

  // --- Ladder: 6 individuals; play two in-range challenges ---
  if (!names.has("Club Ladder")) {
    const div = await call(`/api/v1/competitions/${club.id}/divisions`, "POST", {
      name: "Club Ladder", sport_key: "generic", variant_key: "score", config: GENERIC_CFG,
    });
    const ents = (await call(`/api/v1/divisions/${div.id}/entrants`, "POST",
      Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: person(), seed: i + 1 })),
    )) as { id: string }[];
    const st = await call(`/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1, kind: "ladder", name: "Ladder", config: { challengeRange: 2 },
    });
    await call(`/api/v1/divisions/${div.id}/start`, "POST").catch(() => null);
    // #3 challenges #1 (in range 2), plays and wins → takes the top spot.
    let challenges = 0;
    for (const [ci, oi] of [[2, 0], [4, 2]] as const) {
      try {
        const ch = (await call(`/api/v1/stages/${st.id}/challenges`, "POST", {
          challenger_id: ents[ci].id, opponent_id: ents[oi].id,
        })) as { fixture_id: string };
        await decideFixture(ch.fixture_id, "generic", "score", { home: ents[ci].id, away: ents[oi].id });
        challenges++;
      } catch { /* range/ordering may reject after the first swap */ }
    }
    console.log(`Padel & Ladder Club / Club Ladder (generic, individual×6, ladder): ${challenges} challenge(s) played`);
  }
}

async function playStageAfterStart(divId: string, stageId: string, sport: string, variant: string, ratio: number) {
  const gen = await call(`/api/v1/stages/${stageId}/generate`, "POST");
  await call(`/api/v1/divisions/${divId}/start`, "POST");
  let fixtures: GenFx[] = gen.fixtures;
  const total = fixtures.length;
  const target = Math.ceil(total * ratio);
  let played = 0;
  const rounds = [...new Set(fixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
  for (const round of rounds) {
    for (const f of fixtures.filter((x) => (x.round_no ?? 0) === round)) {
      if (played >= target) return { total, played };
      const cur = (await call(`/api/v1/fixtures/${f.id}`)) as GenFx & { status: string };
      if (!cur.home_entrant_id || !cur.away_entrant_id) continue;
      if (cur.status !== "scheduled") continue;
      await decideFixture(f.id, sport, variant, { home: cur.home_entrant_id, away: cur.away_entrant_id });
      played++;
    }
  }
  return { total, played };
}

main().catch((e) => { console.error(e); process.exit(1); });
