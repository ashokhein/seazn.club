// Seed a real FIFA World Cup 2026 demo into a dedicated org owned by SEED_EMAIL.
//
// Group stage is 100% real (teams, 26-man squads, dates, scorelines from
// scripts/data/fifa2026.json — built by scripts/build-fifa2026-data.ts). The
// knockout bracket is engine-generated from the real group standings (the
// engine seeds a standard bracket, not FIFA's fixed-slot one), with simulated
// decisive scorelines so the bracket populates through to a Final.
//
// Drives the app HTTP API on SEED_BASE (like scripts/seed-demo.ts) and uses
// DATABASE_URL to (a) provision/verify the owner account and (b) flip the org's
// subscription to Pro (48 entrants + two stages exceed the free caps).
//
// Usage (dev server must be running on SEED_BASE):
//   SEED_BASE=http://localhost:3000 \
//   DATABASE_URL=postgres://…  SEED_EMAIL=ashokhein@gmail.com SEED_PASSWORD=… \
//   node --experimental-strip-types scripts/seed-fifa2026.ts
//
// Resume-safe: reuses an existing org/competition/division by name and skips
// enrolment if the 48 entrants are already present.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

// ─────────────────────────── config ────────────────────────────
const BASE = process.env.SEED_BASE ?? "http://localhost:3000";
const EMAIL = process.env.SEED_EMAIL ?? "ashokhein@gmail.com";
const PASSWORD = process.env.SEED_PASSWORD ?? "worldcup2026!";
const ORG_NAME = "FIFA World Cup 2026";
const COMP_NAME = "FIFA World Cup 2026";
const DIV_NAME = "Main";
const GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

// ───────────────────────── data types ──────────────────────────
interface Player { n: number; pos: string; name: string }
interface GroupMatch { group: string; date: string; home: string; away: string; hs: number; as: number }
interface Data {
  teams: Record<string, { code: string; iso2: string; group: string }>;
  groupMatches: GroupMatch[];
  squads: Record<string, Player[]>;
}

// ───────────────── pure helpers (exported for tests) ─────────────────

/** League points for a played match: win 3, draw 1. */
export interface StandRow { code: string; pts: number; gd: number; gf: number; ga: number }

/** Rank the four teams of one group from its played matches (pts, gd, gf). */
export function groupStandings(codes: string[], matches: GroupMatch[]): StandRow[] {
  const t = new Map<string, StandRow>(codes.map((c) => [c, { code: c, pts: 0, gd: 0, gf: 0, ga: 0 }]));
  for (const m of matches) {
    const h = t.get(m.home)!, a = t.get(m.away)!;
    h.gf += m.hs; h.ga += m.as; a.gf += m.as; a.ga += m.hs;
    if (m.hs > m.as) h.pts += 3;
    else if (m.hs < m.as) a.pts += 3;
    else { h.pts += 1; a.pts += 1; }
  }
  for (const r of t.values()) r.gd = r.gf - r.ga;
  return [...t.values()].sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf);
}

/** The eight group letters whose third-placed team is among the best 8 thirds. */
export function bestThirdGroups(data: Data): string[] {
  const thirds: { group: string; row: StandRow }[] = [];
  for (const g of GROUPS) {
    const codes = Object.values(data.teams).filter((t) => t.group === g).map((t) => t.code);
    const ms = data.groupMatches.filter((m) => m.group === g);
    const row = groupStandings(codes, ms)[2];
    thirds.push({ group: g, row });
  }
  thirds.sort((x, y) => y.row.pts - x.row.pts || y.row.gd - x.row.gd || y.row.gf - x.row.gf);
  return thirds.slice(0, 8).map((t) => t.group).sort();
}

/** Seed value that snake-distributes team `slot` (0..3) of group `gi` (0..11)
 *  into pool `gi`. Inverse of stages.snakeDistribute for 48→12. */
export function seedForGroup(gi: number, slot: number): number {
  return [gi + 1, 24 - gi, 25 + gi, 48 - gi][slot];
}

/** TakePicks qualification for a 32-team knockout from 12 groups of 4:
 *  all 12 winners + all 12 runners-up + the 8 best third-placed teams. */
export function knockoutPicks(data: Data): { pool: string; rank: number }[] {
  const thirds = bestThirdGroups(data);
  return [
    ...GROUPS.map((g) => ({ pool: g, rank: 1 })),
    ...GROUPS.map((g) => ({ pool: g, rank: 2 })),
    ...thirds.map((g) => ({ pool: g, rank: 3 })),
  ];
}

/** Football event stream for a final scoreline (goals attributed by entrant id). */
export function goalEvents(homeId: string, awayId: string, hs: number, as: number) {
  const ev: { type: string; payload: unknown }[] = [{ type: "core.start", payload: {} }];
  for (let i = 0; i < hs; i++) ev.push({ type: "football.goal", payload: { by: homeId, minute: 5 + i * 7 } });
  for (let i = 0; i < as; i++) ev.push({ type: "football.goal", payload: { by: awayId, minute: 9 + i * 7 } });
  ev.push({ type: "football.period", payload: { phase: "HT" } });
  ev.push({ type: "football.period", payload: { phase: "FT" } });
  return ev;
}

/** Deterministic small int from a string (stable knockout scorelines). */
export function hashInt(s: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % mod;
}

// ─────────────────────── HTTP client (cookie jar) ───────────────────────
const cookies = new Map<string, string>();
function cookieHeader(): string { return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
/** Unwrap a v1 list response: bare array or a paginated { items }. */
function asList<T>(x: any): T[] { return Array.isArray(x) ? x : (x?.items ?? []); }
async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", cookie: cookieHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const idx = pair.indexOf("=");
    cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : ({} as any);
  if (!res.ok || json?.ok === false)
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  return (json?.data ?? json) as T;
}

// ─────────────────────────────── main ───────────────────────────────
// DB client + data are created inside runSeed() so importing the pure helpers
// above (for tests) stays side-effect free.
let sql!: ReturnType<typeof postgres>;
let data: Data;

async function ensureOwnerAndLogin() {
  // Register (idempotent: ignore "already exists"), force-verify via DB so we
  // never depend on email delivery, then password-login for the session cookie.
  try {
    await call("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD });
  } catch (e) {
    if (!/exists|registered|taken|in use|already/i.test(String(e))) throw e;
  }
  await sql`update users set email_verified = true where email = ${EMAIL}`;
  await call("/api/auth/login", "POST", { email: EMAIL, password: PASSWORD });
}

async function setPro(orgId: string) {
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'pro', 'active')
    on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
}

async function ensureOrg(): Promise<string> {
  const orgs = await call<{ id: string; name: string }[]>("/api/orgs");
  let org = orgs.find((o) => o.name === ORG_NAME);
  if (!org) {
    try {
      org = await call("/api/orgs", "POST", { name: ORG_NAME });
    } catch (e) {
      // Free plan caps orgs owned per user (orgs.max_owned, judged on the best
      // owned-org plan). Lift the cap by making an existing owned org Pro, retry.
      if (/max_owned|402/.test(String(e)) && orgs[0]) {
        await setPro(orgs[0].id);
        org = await call("/api/orgs", "POST", { name: ORG_NAME });
      } else throw e;
    }
  }
  await setPro(org!.id);
  await call("/api/orgs/active", "POST", { org_id: org!.id }).catch(() => call("/api/orgs/active", "POST", { id: org!.id }));
  return org!.id;
}

async function ensureCompetitionDivision(): Promise<{ compId: string; divId: string; fresh: boolean }> {
  const comps = asList<{ id: string; name: string }>(await call("/api/v1/competitions?limit=200"));
  let comp = comps.find((c) => c.name === COMP_NAME);
  if (!comp) comp = await call("/api/v1/competitions", "POST", { name: COMP_NAME });
  const divs = asList<{ id: string; name: string }>(await call(`/api/v1/competitions/${comp!.id}/divisions`));
  let div = divs.find((d) => d.name === DIV_NAME);
  let fresh = false;
  if (!div) {
    div = await call(`/api/v1/competitions/${comp!.id}/divisions`, "POST", {
      name: DIV_NAME, sport_key: "football", variant_key: "11-a-side", config: {}, tiebreakers: ["fifa2026"],
    });
    fresh = true;
  }
  return { compId: comp!.id, divId: div!.id, fresh };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  data = JSON.parse(readFileSync(join(here, "data", "fifa2026.json"), "utf8"));
  const DB = process.env.DATABASE_URL;
  if (!DB) throw new Error("DATABASE_URL is required (owner provisioning + Pro flip).");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DB);
  sql = postgres(DB, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !DB.includes(":6543"),
    max: 1,
  });

  await ensureOwnerAndLogin();
  await ensureOrg();
  const { divId } = await ensureCompetitionDivision();

  // 1) Entrants + rosters (skip if already enrolled).
  const existing = asList<{ id: string; display_name: string }>(await call(`/api/v1/divisions/${divId}/entrants`));
  const codeToEntrant = new Map<string, string>();
  if (existing.length >= 48) {
    console.log(`Entrants already present (${existing.length}); reusing.`);
    for (const e of existing) {
      const t = Object.values(data.teams).find((x) => nameFor(x.code) === e.display_name);
      if (t) codeToEntrant.set(t.code, e.id);
    }
  } else {
    for (const g of GROUPS) {
      const codes = Object.values(data.teams).filter((t) => t.group === g).map((t) => t.code);
      for (let slot = 0; slot < codes.length; slot++) {
        const code = codes[slot];
        const squad = data.squads[code] ?? [];
        const members = [];
        for (const p of squad) {
          const person = await call<{ id: string }>("/api/v1/persons", "POST", { full_name: p.name, consent: {} });
          members.push({ person_id: person.id, squad_number: p.n, default_position_key: p.pos, is_captain: false, roles: [] });
        }
        const entrant = await call<{ id: string }>(`/api/v1/divisions/${divId}/entrants`, "POST", {
          kind: "team", display_name: nameFor(code), seed: seedForGroup(GROUPS.indexOf(g), slot), members,
        });
        codeToEntrant.set(code, entrant.id);
        console.log(`  enrolled ${code} (${members.length} squad) seed=${seedForGroup(GROUPS.indexOf(g), slot)}`);
      }
    }
  }

  // 2) Stages: group (12 pools) → knockout (32 via TakePicks).
  const stages = await call<{ id: string; kind: string; seq: number }[]>(`/api/v1/divisions/${divId}/stages`);
  let groupStage = stages.find((s) => s.kind === "group");
  let koStage = stages.find((s) => s.kind === "knockout");
  if (!groupStage || !koStage) {
    const created = await call<any>(`/api/v1/divisions/${divId}/stages`, "POST", [
      { seq: 1, kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 12 } }, qualification: null },
      { seq: 2, kind: "knockout", name: "Knockout", config: { shootout: true }, qualification: { take: knockoutPicks(data) } },
    ]);
    const arr: { id: string; kind: string; seq: number }[] = Array.isArray(created) ? created : [created];
    groupStage = arr.find((s) => s.kind === "group")!;
    koStage = arr.find((s) => s.kind === "knockout")!;
  }

  // 3) Start + generate group fixtures.
  await call(`/api/v1/divisions/${divId}/start`, "POST").catch((e) => { if (!/already|started/i.test(String(e))) throw e; });
  const gen = await call<{ fixtures: any[] }>(`/api/v1/stages/${groupStage!.id}/generate`, "POST");

  // 4) Apply real group scores + dates. Map each real match to its fixture by
  //    unordered entrant pair; goals attributed by entrant id (orientation-free).
  const entrantToCode = new Map([...codeToEntrant.entries()].map(([c, id]) => [id, c]));
  const fxByPair = new Map<string, any>();
  for (const f of gen.fixtures) {
    if (!f.home_entrant_id || !f.away_entrant_id) continue;
    fxByPair.set([f.home_entrant_id, f.away_entrant_id].sort().join("|"), f);
  }
  let applied = 0;
  for (const m of data.groupMatches) {
    const hId = codeToEntrant.get(m.home), aId = codeToEntrant.get(m.away);
    if (!hId || !aId) continue;
    const f = fxByPair.get([hId, aId].sort().join("|"));
    if (!f) { console.log(`  ⚠ no fixture for ${m.home}-${m.away}`); continue; }
    await call(`/api/v1/fixtures/${f.id}`, "PATCH", { scheduled_at: `${m.date}T18:00:00+00:00` }).catch(() => {});
    let seq = 0;
    for (const ev of goalEvents(hId, aId, m.hs, m.as)) {
      const r = await call<{ seq: number }>(`/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: seq, type: ev.type, payload: ev.payload });
      seq = r.seq;
    }
    applied++;
  }
  console.log(`Applied ${applied}/${data.groupMatches.length} real group results.`);

  // 5) Complete group stage → knockout bracket seeds from real standings.
  await call(`/api/v1/stages/${groupStage!.id}/complete`, "POST").catch((e) => { if (!/complete/i.test(String(e))) throw e; });

  // 6) Simulate knockout round by round: higher seed (lower seed number) wins.
  const seedOf = new Map<string, number>();
  for (const g of GROUPS) {
    const codes = Object.values(data.teams).filter((t) => t.group === g).map((t) => t.code);
    codes.forEach((c, slot) => { const id = codeToEntrant.get(c); if (id) seedOf.set(id, seedForGroup(GROUPS.indexOf(g), slot)); });
  }
  const kgen = await call<{ fixtures: any[] }>(`/api/v1/stages/${koStage!.id}/generate`, "POST");
  let koFixtures: any[] = kgen.fixtures;
  const rounds = [...new Set(koFixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
  let koPlayed = 0;
  for (const round of rounds) {
    for (const f of koFixtures.filter((x) => (x.round_no ?? 0) === round)) {
      const cur = await call<any>(`/api/v1/fixtures/${f.id}`);
      if (!cur.home_entrant_id || !cur.away_entrant_id || cur.status !== "scheduled") continue;
      const hSeed = seedOf.get(cur.home_entrant_id) ?? 99, aSeed = seedOf.get(cur.away_entrant_id) ?? 99;
      const homeWins = hSeed <= aSeed;
      const winMargin = 1 + hashInt(f.id, 2); // 1..2
      const hs = homeWins ? 1 + winMargin : hashInt(f.id + "a", 2);
      const as = homeWins ? hashInt(f.id + "a", 2) : 1 + winMargin; // loser 0..1, always < winner
      let seq = 0;
      for (const ev of goalEvents(cur.home_entrant_id, cur.away_entrant_id, hs, as)) {
        const r = await call<{ seq: number }>(`/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: seq, type: ev.type, payload: ev.payload });
        seq = r.seq;
      }
      koPlayed++;
    }
  }
  console.log(`Simulated ${koPlayed} knockout fixtures.`);
  console.log(`\n✅ Seeded "${COMP_NAME}" — open ${BASE} and switch to the "${ORG_NAME}" org.`);
}

function nameFor(code: string): string {
  return NAMES[code] ?? code;
}
// Display names (from the real draw).
const NAMES: Record<string, string> = {
  MEX: "Mexico", RSA: "South Africa", KOR: "South Korea", CZE: "Czech Republic",
  SUI: "Switzerland", CAN: "Canada", BIH: "Bosnia and Herzegovina", QAT: "Qatar",
  BRA: "Brazil", MAR: "Morocco", SCO: "Scotland", HAI: "Haiti",
  USA: "United States", AUS: "Australia", PAR: "Paraguay", TUR: "Turkey",
  GER: "Germany", CIV: "Ivory Coast", ECU: "Ecuador", CUW: "Curaçao",
  NED: "Netherlands", JPN: "Japan", SWE: "Sweden", TUN: "Tunisia",
  BEL: "Belgium", EGY: "Egypt", IRN: "Iran", NZL: "New Zealand",
  ESP: "Spain", CPV: "Cape Verde", URU: "Uruguay", KSA: "Saudi Arabia",
  FRA: "France", NOR: "Norway", SEN: "Senegal", IRQ: "Iraq",
  ARG: "Argentina", AUT: "Austria", ALG: "Algeria", JOR: "Jordan",
  COL: "Colombia", POR: "Portugal", COD: "DR Congo", UZB: "Uzbekistan",
  ENG: "England", CRO: "Croatia", GHA: "Ghana", PAN: "Panama",
};

// Run only when executed directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => sql?.end()).catch(async (e) => { console.error(e); await sql?.end(); process.exit(1); });
}
