// #396 gap 1, JOINT board (#350) — proof that `CompetitionPack.participants` is
// actually read by BOTH joint consumers: the joint placer (the slots each
// division's greedy pass is fed forward from the divisions drafted before it)
// and `toJointEngineAssignments` (what `verifyJoint` judges).
//
// WHY THIS BOARD. A semi-final and the final it feeds are already separated by
// the `feeds.after` order dependency, so an assertion on that pair passes with
// or without the wiring and proves nothing. Here the clashing pair sits in two
// DIFFERENT divisions, on disjoint court labels, with no feed edge and no shared
// entrant — the participants map is the only thing that can link them:
//
//   Alpha (Court 1, Court 2, window 09:00Z-)   Bravo (Court 3, window 09:30Z-)
//     semi-1 (A-A vs A-B) ─┐
//                          ├─→ final (both slots TBD)      other (B-X vs B-Y)
//     semi-2 (A-C vs A-D) ─┘
//
// One person row ("Zed Shared") is rostered into Alpha's entrant A-A and Bravo's
// entrant B-X. `final` inherits Zed ONLY through the advancer recursion
// (A-A → semi-1 → final); `other` names Zed directly. Disjoint courts mean a
// court clash can never fire, and the two divisions cannot share an entrant.
//
// Bravo's window starts 30 minutes late on purpose: without the wiring its only
// fixture lands at 09:30Z, exactly on top of the TBD final. With it, Zed is
// already committed and `other` is pushed clear.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import {
  buildCompetitionPack,
  toJointModelPayload,
  verifyJoint,
} from "../competition-schedule-ai";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// #397: the pack builder reads no clock — `now` is injected, so a frozen
// instant keeps the pack reproducible.
const NOW_W2 = Date.parse("2026-08-06T23:30:00Z");


const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const TZ = "Europe/London";
const MIN = 60_000;

function settingsConfig(courts: string[], windowFrom: string) {
  return {
    startAt: "2026-08-01T09:00:00.000Z",
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 20,
    blackouts: [],
    sessionWindows: [{ from: windowFrom, to: "2026-08-01T18:00:00.000Z" }],
    constraints: {
      restMin: 20,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "balance",
      parallelism: "mixed",
      // A person double-booking rejects the placement outright, so the placer
      // direction is a hard assertion rather than a warning count.
      crossPersonClash: "hard",
    },
  };
}

async function makeDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
  slug: string,
  courts: string[],
  windowFrom: string,
  entrantNames: string[],
): Promise<{ id: string; entrantByName: Map<string, string>; stageId: string }> {
  const division = await createDivision(auth, competitionId, {
    name,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts, windowFrom))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    entrantNames.map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const rows = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "KO",
    config: {},
  });
  return {
    id: division.id,
    entrantByName: new Map(rows.map((r) => [r.display_name, r.id])),
    stageId: stage!.id,
  };
}

async function addPerson(orgId: string, fullName: string, entrantIds: string[]): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, ${fullName}) returning id`;
  for (const e of entrantIds) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${e}, ${p!.id}, ${orgId})`;
  }
  return p!.id;
}

interface RecursionBoard {
  auth: AuthCtx;
  competitionId: string;
  alphaId: string;
  bravoId: string;
  sharedPersonId: string;
  fixtureIds: { semi1: string; semi2: string; final: string; other: string };
}

/** The board drawn at the top of this file. */
async function seedJointRecursionBoard(): Promise<RecursionBoard> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Joint Wiring ${tag}`,
    visibility: "public",
    branding: {},
  });

  const alpha = await makeDivision(
    auth,
    comp.id,
    "Alpha",
    `alpha-${tag}`,
    ["Court 1", "Court 2"],
    "2026-08-01T09:00:00.000Z",
    ["A-A", "A-B", "A-C", "A-D"],
  );
  const bravo = await makeDivision(
    auth,
    comp.id,
    "Bravo",
    `bravo-${tag}`,
    ["Court 3"],
    "2026-08-01T09:30:00.000Z",
    ["B-X", "B-Y"],
  );

  const shared = await addPerson(auth.orgId, "Zed Shared", [
    alpha.entrantByName.get("A-A")!,
    bravo.entrantByName.get("B-X")!,
  ]);
  for (const n of ["A-B", "A-C", "A-D"]) {
    await addPerson(auth.orgId, `Solo ${n}`, [alpha.entrantByName.get(n)!]);
  }
  await addPerson(auth.orgId, "Solo B-Y", [bravo.entrantByName.get("B-Y")!]);

  const [final] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    values (${alpha.stageId}, ${alpha.id}, ${auth.orgId}, 2, 0, 'final', 'scheduled') returning id`;
  const semis: string[] = [];
  for (const [i, pair] of [["A-A", "A-B"], ["A-C", "A-D"]].entries()) {
    const [s] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                            home_entrant_id, away_entrant_id, winner_to_fixture, winner_to_slot)
      values (${alpha.stageId}, ${alpha.id}, ${auth.orgId}, 1, ${i}, ${`semi-${i + 1}`}, 'scheduled',
              ${alpha.entrantByName.get(pair[0]!)!}, ${alpha.entrantByName.get(pair[1]!)!},
              ${final!.id}, ${i + 1})
      returning id`;
    semis.push(s!.id);
  }
  const [other] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${bravo.stageId}, ${bravo.id}, ${auth.orgId}, 1, 0, 'other', 'scheduled',
            ${bravo.entrantByName.get("B-X")!}, ${bravo.entrantByName.get("B-Y")!})
    returning id`;

  return {
    auth,
    competitionId: comp.id,
    alphaId: alpha.id,
    bravoId: bravo.id,
    sharedPersonId: shared,
    fixtureIds: { semi1: semis[0]!, semi2: semis[1]!, final: final!.id, other: other!.id },
  };
}

interface SameNameBoard {
  auth: AuthCtx;
  competitionId: string;
  divisionIds: string[];
  personIds: [string, string];
  fixtureIds: { f1: string; f2: string };
}

/** Two divisions, one fixture each, and the SAME HUMAN entered in both under two
 *  separate `persons` rows. Single-division scoping cannot see it: each row is
 *  alone inside its own division. Only the joint pack has the whole person set. */
async function seedCrossDivisionSameNameBoard(): Promise<SameNameBoard> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Same Name ${tag}`,
    visibility: "public",
    branding: {},
  });
  const one = await makeDivision(
    auth,
    comp.id,
    "Ones",
    `ones-${tag}`,
    ["Court 1"],
    "2026-08-01T09:00:00.000Z",
    ["O-1", "O-2"],
  );
  const two = await makeDivision(
    auth,
    comp.id,
    "Twos",
    `twos-${tag}`,
    ["Court 2"],
    "2026-08-01T09:00:00.000Z",
    ["T-1", "T-2"],
  );
  // Same human, two rows, one per division — and the spellings differ only in
  // whitespace/case, which `personKeyResolver` normalises.
  const p1 = await addPerson(auth.orgId, "Bobby Fischer", [one.entrantByName.get("O-1")!]);
  const p2 = await addPerson(auth.orgId, "bobby  fischer", [two.entrantByName.get("T-1")!]);
  await addPerson(auth.orgId, "Solo O-2", [one.entrantByName.get("O-2")!]);
  await addPerson(auth.orgId, "Solo T-2", [two.entrantByName.get("T-2")!]);

  const [f1] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${one.stageId}, ${one.id}, ${auth.orgId}, 1, 0, 'ones-1', 'scheduled',
            ${one.entrantByName.get("O-1")!}, ${one.entrantByName.get("O-2")!}) returning id`;
  const [f2] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${two.stageId}, ${two.id}, ${auth.orgId}, 1, 0, 'twos-1', 'scheduled',
            ${two.entrantByName.get("T-1")!}, ${two.entrantByName.get("T-2")!}) returning id`;

  return {
    auth,
    competitionId: comp.id,
    divisionIds: [one.id, two.id],
    personIds: [p1, p2],
    fixtureIds: { f1: f1!.id, f2: f2!.id },
  };
}

/** Two round-robin divisions with a real person on every entrant — big enough
 *  for the payload measurement to mean something. */
async function seedMeasurementBoard(
  entrantsPerDivision: number,
): Promise<{ auth: AuthCtx; competitionId: string; divisionIds: string[] }> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Measure ${tag}`,
    visibility: "public",
    branding: {},
  });
  const divisionIds: string[] = [];
  for (const name of ["Measure A", "Measure B"]) {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag}`;
    const d = await makeDivision(
      auth,
      comp.id,
      name,
      slug,
      ["Court 1", "Court 2"],
      "2026-08-01T09:00:00.000Z",
      Array.from({ length: entrantsPerDivision }, (_, i) => `${slug}-E${String(i + 1).padStart(3, "0")}`),
    );
    for (const [displayName, entrantId] of d.entrantByName) {
      await addPerson(auth.orgId, `Player ${displayName}`, [entrantId]);
    }
    await generateStageFixtures(auth, d.stageId);
    divisionIds.push(d.id);
  }
  return { auth, competitionId: comp.id, divisionIds };
}

const overlaps = (aFrom: number, aTo: number, bFrom: number, bTo: number): boolean =>
  aFrom < bTo && bFrom < aTo;

const plan = (
  assignments: { fixture_id: string; scheduled_at: string; court_label: string }[],
): AiSchedulePlan => ({ assignments, unschedulable: [], explanations: [], summary: "ok" });

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("CompetitionPack.participants is wired into both joint consumers (#396)", () => {
  it("the board itself links final↔other ONLY through the participants recursion", async () => {
    // Guards the guard: if a later edit gives these two a feed edge or puts them
    // on a shared court, the two tests below would pass for the wrong reason.
    const board = await seedJointRecursionBoard();
    const { pack } = await buildCompetitionPack(
      board.auth,
      board.competitionId,
      [board.alphaId, board.bravoId],
      { now: NOW_W2, mode: "generate", instruction: "Two rounds." },
    );
    const byId = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
    const final = byId.get(board.fixtureIds.final)!;
    const other = byId.get(board.fixtureIds.other)!;

    // Different divisions, so no shared entrant is even possible…
    expect(final.division_id).toBe(board.alphaId);
    expect(other.division_id).toBe(board.bravoId);
    expect(final.home).toBeNull();
    expect(final.away).toBeNull();
    // …no feed edge in either direction…
    expect(final.feeds.after).not.toContain(other.id);
    expect(other.feeds.after).toEqual([]);
    // …and disjoint court labels, so a court clash can never separate them.
    const courtsOf = (divisionId: string): string[] =>
      pack.divisions.find((d) => d.id === divisionId)!.settings.courts;
    expect(
      courtsOf(board.alphaId).filter((c) => courtsOf(board.bravoId).includes(c)),
    ).toEqual([]);

    // The ONLY link: the same human in both, in the final only by recursion.
    expect(pack.participants[final.id]).toContain(board.sharedPersonId);
    expect(pack.participants[other.id]).toContain(board.sharedPersonId);
    expect(pack.participants[board.fixtureIds.semi1]).toContain(board.sharedPersonId);
    // Keyed for every movable fixture, in the pack's own movable order.
    expect(Object.keys(pack.participants)).toEqual(pack.fixtures.movable.map((f) => f.id));
  }, 120_000);

  it("PLACER: the joint draft never co-schedules the TBD final with the other division's fixture", async () => {
    const board = await seedJointRecursionBoard();
    const { pack } = await buildCompetitionPack(
      board.auth,
      board.competitionId,
      [board.alphaId, board.bravoId],
      { now: NOW_W2, mode: "generate", instruction: "Two rounds." },
    );
    const minutesOf = (divisionId: string): number =>
      pack.divisions.find((d) => d.id === divisionId)!.settings.matchMinutes;
    const slot = (id: string): { from: number; to: number; court: string } => {
      const a = pack.draft.find((d) => d.fixture_id === id);
      expect(a, `joint draft is missing fixture ${id}`).toBeDefined();
      const from = Date.parse(a!.scheduled_at!);
      return { from, to: from + minutesOf(a!.division_id) * MIN, court: a!.court_label };
    };
    const final = slot(board.fixtureIds.final);
    const other = slot(board.fixtureIds.other);

    // Feed the divisions drafted so far forward WITHOUT their participants and
    // Bravo's placer sees an empty person list on everything Alpha just took —
    // `other` then lands at 09:30Z, exactly on the TBD final.
    expect(
      overlaps(final.from, final.to, other.from, other.to),
      `final (${new Date(final.from).toISOString()} ${final.court}) overlaps other ` +
        `(${new Date(other.from).toISOString()} ${other.court}) — they share a person ` +
        `through the participants recursion and must not be co-scheduled`,
    ).toBe(false);
  }, 120_000);

  it("VERIFIER: a proposal that DOES co-schedule them comes back with person_overlap", async () => {
    const board = await seedJointRecursionBoard();
    const { pack } = await buildCompetitionPack(
      board.auth,
      board.competitionId,
      [board.alphaId, board.bravoId],
      { now: NOW_W2, mode: "generate", instruction: "Two rounds." },
    );
    // Legal on every other axis: no court double-book (disjoint courts), both
    // semis finish before the final starts, everything inside its own division's
    // session window. The only defect is that `final` and `other` run at the same
    // instant while sharing one human.
    const conflicts = verifyJoint(
      plan([
        { fixture_id: board.fixtureIds.semi1, scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1" },
        { fixture_id: board.fixtureIds.semi2, scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 2" },
        { fixture_id: board.fixtureIds.final, scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 1" },
        { fixture_id: board.fixtureIds.other, scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 3" },
      ]),
      pack,
    );
    const onFinal = conflicts.filter(
      (c) => c.reason === "person_overlap" && c.fixtureId === board.fixtureIds.final,
    );
    expect(
      onFinal.length,
      `expected a person_overlap on the TBD final; got ${JSON.stringify(conflicts)}`,
    ).toBeGreaterThan(0);
    // It is the recursed human, named in the detail.
    expect(onFinal.some((c) => (c.detail ?? "").includes(board.sharedPersonId))).toBe(true);
    // …and reported from the other side too, so either fixture can be the one
    // that moves.
    expect(
      conflicts.some(
        (c) => c.reason === "person_overlap" && c.fixtureId === board.fixtureIds.other,
      ),
    ).toBe(true);
  }, 120_000);

  it("CROSS-DIVISION: one human entered twice under two person rows collapses, and the clash fires", async () => {
    const board = await seedCrossDivisionSameNameBoard();
    const { pack } = await buildCompetitionPack(
      board.auth,
      board.competitionId,
      board.divisionIds,
      { now: NOW_W2, mode: "generate", instruction: "One round each." },
    );
    const KEY = "name:bobby fischer";
    // Neither row is in `pack.people` (it keeps persons in 2+ entrants), and no
    // single-division pack could see the pair at all — each row is alone inside
    // its own division.
    expect(pack.people.map((p) => p.person_id)).not.toContain(board.personIds[0]);
    expect(pack.people.map((p) => p.person_id)).not.toContain(board.personIds[1]);
    expect(pack.participants[board.fixtureIds.f1]).toContain(KEY);
    expect(pack.participants[board.fixtureIds.f2]).toContain(KEY);
    // The organiser is told, once, in the pack's assumptions.
    expect(pack.assumptions).toContain(
      "'Bobby Fischer' matches 2 person records by name — " +
        "treated as one player for scheduling only; no records were merged",
    );

    const conflicts = verifyJoint(
      plan([
        { fixture_id: board.fixtureIds.f1, scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1" },
        { fixture_id: board.fixtureIds.f2, scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 2" },
      ]),
      pack,
    );
    const overlapsFound = conflicts.filter((c) => c.reason === "person_overlap");
    expect(
      new Set(overlapsFound.map((c) => c.fixtureId)),
      `expected person_overlap on both sides; got ${JSON.stringify(conflicts)}`,
    ).toEqual(new Set([board.fixtureIds.f1, board.fixtureIds.f2]));
    expect(overlapsFound.every((c) => (c.detail ?? "").includes(KEY))).toBe(true);

    // The synthetic key is a scheduling-only device: it never reaches the model,
    // and nothing was merged in the database.
    expect(JSON.stringify(toJointModelPayload(pack))).not.toContain("name:");
    const rows = await sql<{ id: string }[]>`
      select id from persons where id in ${sql([board.personIds[0], board.personIds[1]])}`;
    expect(rows).toHaveLength(2);
  }, 120_000);

  it("a WITHIN-division same-name pair is reported once, by the joint resolver", async () => {
    // Both source packs already ran the same-name guard over their own persons,
    // so a pair inside one division raises an assumption twice — once in that
    // division's pack, once in the run-wide resolver — and the two disagree on
    // the count as soon as a third row elsewhere joins the bucket. The joint
    // pack keeps the run-wide one. Pins the pattern the drop is keyed on.
    const { auth } = await seedOrg("pro");
    const tag = randomUUID().slice(0, 6);
    const comp = await createCompetition(auth, {
      name: `Twin Rows ${tag}`,
      visibility: "public",
      branding: {},
    });
    const one = await makeDivision(
      auth, comp.id, "Ones", `ones-${tag}`, ["Court 1"], "2026-08-01T09:00:00.000Z",
      ["O-1", "O-2"],
    );
    const two = await makeDivision(
      auth, comp.id, "Twos", `twos-${tag}`, ["Court 2"], "2026-08-01T09:00:00.000Z",
      ["T-1", "T-2"],
    );
    // Two rows in ONE division (Ones) — plus a third of the same name in Twos,
    // so the per-division message ("2 person records") and the run-wide one
    // ("3 person records") cannot both be right.
    await addPerson(auth.orgId, "Ada Twin", [one.entrantByName.get("O-1")!]);
    await addPerson(auth.orgId, "ada twin", [one.entrantByName.get("O-2")!]);
    await addPerson(auth.orgId, "Ada  Twin", [two.entrantByName.get("T-1")!]);
    await addPerson(auth.orgId, "Solo T-2", [two.entrantByName.get("T-2")!]);
    for (const [d, ext, home, away] of [
      [one, "ones-1", one.entrantByName.get("O-1")!, one.entrantByName.get("O-2")!],
      [two, "twos-1", two.entrantByName.get("T-1")!, two.entrantByName.get("T-2")!],
    ] as const) {
      await sql`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                              home_entrant_id, away_entrant_id)
        values (${d.stageId}, ${d.id}, ${auth.orgId}, 1, 0, ${ext}, 'scheduled', ${home}, ${away})`;
    }

    const { pack } = await buildCompetitionPack(auth, comp.id, [one.id, two.id], {
      now: NOW_W2,
      mode: "generate",
      instruction: "One round each.",
    });
    const identityLines = pack.assumptions.filter((a) => a.includes("no records were merged"));
    expect(identityLines).toEqual([
      "'Ada  Twin' matches 3 person records by name — " +
        "treated as one player for scheduling only; no records were merged",
    ]);
  }, 120_000);

  it("toJointModelPayload strips participants and assumptions, and that is what keeps the joint pack inside the token budget", async () => {
    const board = await seedMeasurementBoard(20);
    const { pack } = await buildCompetitionPack(
      board.auth,
      board.competitionId,
      board.divisionIds,
      { now: NOW_W2, mode: "generate", instruction: "Pack the day." },
    );
    const payload = toJointModelPayload(pack) as Record<string, unknown>;
    expect("participants" in payload).toBe(false);
    expect("assumptions" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("participants");
    // `poolIds` (#449) is stripped for the same reason: the model schedules by
    // pool LABEL, which `fixtures.movable[].pool` still carries.
    expect("poolIds" in payload).toBe(false);
    // Everything else survives the trim byte-for-byte.
    expect(payload).toEqual(
      Object.fromEntries(
        Object.entries(pack).filter(
          ([k]) => k !== "participants" && k !== "assumptions" && k !== "poolIds",
        ),
      ),
    );
    // …while the map the placer and the referee read is still complete.
    expect(Object.keys(pack.participants)).toEqual(pack.fixtures.movable.map((f) => f.id));
    expect(pack.fixtures.movable.length).toBe(2 * ((20 * 19) / 2));

    // The measurement the trim exists for. Proxy tokens = JSON bytes / 4.
    // Measured 2026-08-02 on this board (380 of the 500-fixture joint cap, one
    // person per entrant, every slot named so nothing is inherited): the pack
    // with `participants` inlined is 49,794.5 proxy tokens against the 60,000
    // ceiling; the payload is 38,481. A board that fills the cap, or a bracket
    // where TBD slots inherit whole sub-trees, scales that gap up — which is why
    // the field is stripped rather than trimmed.
    const withParticipants = JSON.stringify(pack).length / 4;
    const trimmed = JSON.stringify(payload).length / 4;
    expect(withParticipants - trimmed).toBeGreaterThan(10_000);
    expect(trimmed).toBeLessThan(60_000);
  }, 240_000);
});
