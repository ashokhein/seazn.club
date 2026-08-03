// #396 gap 1 — proof that BOTH consumers of `pack.participants` actually read
// it: the greedy placer inside `buildSchedulePack` and `toEngineAssignments`
// inside `runAiPlan`'s verify pass.
//
// WHY A SEPARATE BOARD. A semi-final and the final it feeds are already kept
// apart by the `feeds.after` order dependency, so any assertion on that pair
// passes with or without the participants wiring — it proves nothing. The board
// below puts the clashing pair where NO other rule can separate them:
//
//   semi-1 (A vs B) ─┐
//                    ├─→ final (both slots TBD)
//   semi-2 (C vs D) ─┘
//   other  (X vs Y)      ← no feed edge to anything
//
// One person ("Zed Shared") is rostered into entrant A *and* entrant X. The
// final therefore inherits Zed only through the participants recursion (A → the
// semi → the final), while `other` names Zed directly. `final` and `other` share
// no entrant and no dependency edge: the participants map is the ONLY thing that
// links them. Revert either consumer to the old named-entrant derivation and
// both tests below go red.
//
// Real Postgres required; skipped without DATABASE_URL. The Anthropic SDK is
// mocked so the verifier direction runs the real `runAiPlan` verify path over a
// hand-authored proposal.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Must be declared before importing the module under test.
const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
  },
}));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { buildSchedulePack, runAiPlan } from "../schedule-ai";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// #397: the pack builder reads no clock — `now` is injected, so a frozen
// instant here is what keeps the pack (and its golden snapshot) reproducible.
// 2026-08-06T23:30Z is already Friday the 7th in London, which is the point:
// the pack's "today" is a fact about the ORG zone, not about UTC.
const NOW_W2 = Date.parse("2026-08-06T23:30:00Z");


const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const TZ = "Europe/London";
const MIN = 60_000;

// 2 courts, 30-minute matches, no gap, a 09:00-18:00Z session window and
// crossPersonClash=hard — the placer rejects a person double-booking outright.
const SETTINGS_CONFIG = {
  startAt: "2026-08-01T09:00:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1", "Court 2"],
  perEntrantMinRest: 20,
  blackouts: [],
  sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T18:00:00.000Z" }],
  constraints: {
    restMin: 20,
    noBackToBack: false,
    startWindows: [],
    fieldFairness: "balance",
    parallelism: "mixed",
    crossPersonClash: "hard",
  },
};

interface Board {
  auth: AuthCtx;
  divisionId: string;
  sharedPersonId: string;
  fixtureIds: { semi1: string; semi2: string; final: string; other: string };
}

/** The board drawn at the top of this file. */
async function seedRecursionClashBoard(): Promise<Board> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Wiring ${tag}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Wiring",
    slug: `wiring-${tag}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const divisionId = division.id;
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${divisionId}, ${sql.json(SETTINGS_CONFIG)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;

  // A, B, C, D are the bracket; X, Y play the unrelated fixture.
  const names = ["A", "B", "C", "D", "X", "Y"];
  await createEntrants(
    auth,
    divisionId,
    names.map((n, i) => ({
      kind: "individual" as const,
      display_name: `W-${n}`,
      seed: i + 1,
      members: [],
    })),
  );
  const ents = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${divisionId} order by seed`;
  const entOf = (n: string): string => ents.find((e) => e.display_name === `W-${n}`)!.id;

  // One person per entrant, EXCEPT that A and X are the same human.
  const [shared] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${auth.orgId}, 'Zed Shared') returning id`;
  for (const e of ["A", "X"]) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${entOf(e)}, ${shared!.id}, ${auth.orgId})`;
  }
  for (const n of ["B", "C", "D", "Y"]) {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, ${`Solo ${n}`}) returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${entOf(n)}, ${p!.id}, ${auth.orgId})`;
  }

  const [stage] = await createStages(auth, divisionId, {
    seq: 1,
    kind: "league",
    name: "KO",
    config: {},
  });
  const [final] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    values (${stage!.id}, ${divisionId}, ${auth.orgId}, 2, 0, 'final', 'scheduled') returning id`;
  const semis: string[] = [];
  for (const [i, pair] of [["A", "B"], ["C", "D"]].entries()) {
    const [s] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                            home_entrant_id, away_entrant_id, winner_to_fixture, winner_to_slot)
      values (${stage!.id}, ${divisionId}, ${auth.orgId}, 1, ${i}, ${`semi-${i + 1}`}, 'scheduled',
              ${entOf(pair[0]!)}, ${entOf(pair[1]!)}, ${final!.id}, ${i + 1})
      returning id`;
    semis.push(s!.id);
  }
  const [other] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${stage!.id}, ${divisionId}, ${auth.orgId}, 1, 2, 'other', 'scheduled',
            ${entOf("X")}, ${entOf("Y")})
    returning id`;

  return {
    auth,
    divisionId,
    sharedPersonId: shared!.id,
    fixtureIds: { semi1: semis[0]!, semi2: semis[1]!, final: final!.id, other: other!.id },
  };
}

const overlaps = (aFrom: number, aTo: number, bFrom: number, bTo: number): boolean =>
  aFrom < bTo && bFrom < aTo;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  parse.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AI_PROVIDER;
});

describe.skipIf(!HAS_DB)("pack.participants is wired into both consumers (#396)", () => {
  it("the board itself links final↔other ONLY through the participants recursion", async () => {
    // Guards the guard: if a later edit gives these two a shared entrant or a
    // feed edge, the two tests below would pass for the wrong reason.
    const { auth, divisionId, sharedPersonId, fixtureIds } = await seedRecursionClashBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate",
      instruction: "Two rounds.",
    });
    const byId = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
    const final = byId.get(fixtureIds.final)!;
    const other = byId.get(fixtureIds.other)!;

    expect(final.home).toBeNull();
    expect(final.away).toBeNull();
    // No feed edge in either direction.
    expect(final.feeds.after).not.toContain(other.id);
    expect(other.feeds.after).toEqual([]);
    // No shared named entrant (the final names none at all).
    expect([final.home, final.away].filter((e) => e !== null)).toEqual([]);
    // …and yet the participants map puts the same human in both.
    expect(pack.participants[final.id]).toContain(sharedPersonId);
    expect(pack.participants[other.id]).toContain(sharedPersonId);
    // The final inherited them from semi-1 by recursion, not by naming them.
    expect(pack.participants[fixtureIds.semi1]).toContain(sharedPersonId);
  });

  it("PLACER: the generated draft never co-schedules the TBD final with the unrelated fixture", async () => {
    const { auth, divisionId, fixtureIds } = await seedRecursionClashBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate",
      instruction: "Two rounds.",
    });
    const durMs = pack.settings.matchMinutes * MIN;
    const slot = (id: string): { from: number; to: number; court: string } => {
      const a = pack.draft.find((d) => d.fixture_id === id);
      expect(a, `draft is missing fixture ${id}`).toBeDefined();
      const from = Date.parse(a!.scheduled_at!);
      return { from, to: from + durMs, court: a!.court_label };
    };
    const final = slot(fixtureIds.final);
    const other = slot(fixtureIds.other);

    // The old named-entrant derivation gives the final an EMPTY people list, so
    // `crossPersonClash: "hard"` cannot see the clash and the greedy placer puts
    // the final on the free court at the same instant as `other`.
    expect(
      overlaps(final.from, final.to, other.from, other.to),
      `final (${new Date(final.from).toISOString()} ${final.court}) overlaps other ` +
        `(${new Date(other.from).toISOString()} ${other.court}) — they share a person ` +
        `through the participants recursion and must not be co-scheduled`,
    ).toBe(false);
  });

  it("VERIFIER: a proposal that DOES co-schedule them comes back with a person_overlap conflict", async () => {
    const { auth, divisionId, sharedPersonId, fixtureIds } = await seedRecursionClashBoard();
    const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate",
      instruction: "Two rounds.",
    });

    // Legal on every OTHER axis: no court double-book, both semis finish before
    // the final starts, everything inside the session window. The only defect is
    // that `final` and `other` run at the same time on different courts while
    // sharing one human.
    const proposal = {
      assignments: [
        { fixture_id: fixtureIds.semi1, scheduled_at: "2026-08-01T10:00:00+01:00", court_label: "Court 1" },
        { fixture_id: fixtureIds.semi2, scheduled_at: "2026-08-01T10:00:00+01:00", court_label: "Court 2" },
        { fixture_id: fixtureIds.other, scheduled_at: "2026-08-01T11:00:00+01:00", court_label: "Court 1" },
        { fixture_id: fixtureIds.final, scheduled_at: "2026-08-01T11:00:00+01:00", court_label: "Court 2" },
      ],
      unschedulable: [],
      explanations: [],
      summary: "ok",
    };
    parse.mockResolvedValueOnce({
      parsed_output: proposal,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [],
    });

    const out = await runAiPlan(pack, movableIds);
    // Nothing blocking — so the run returns after one round and `warnings`
    // carries the verifier's full non-blocking report.
    expect(out.blocking).toEqual([]);
    const overlapsOnFinal = out.warnings.filter(
      (c) => c.reason === "person_overlap" && c.fixtureId === fixtureIds.final,
    );
    expect(
      overlapsOnFinal.length,
      `expected a person_overlap on the TBD final; got ${JSON.stringify(out.warnings)}`,
    ).toBeGreaterThan(0);
    // It is the recursed human, named in the detail.
    expect(overlapsOnFinal.some((c) => (c.detail ?? "").includes(sharedPersonId))).toBe(true);
  });
});
