// LIVE cost/quality bench for the architect's `effort` setting — NOT a unit test.
//
// Output tokens are ~96% of a run's cost (5,212 in / 26,917 out on the
// 2026-07-19 measurement), and `effort` is the direct knob on thinking depth.
// This file measures what dropping high → medium actually costs in plan
// quality, on packs materially larger than that 17-fixture baseline.
//
// Skipped unless AI_AB_LIVE=1 — it makes real, billed Anthropic calls. Run:
//   AI_AB_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts
//
// Both arms see a byte-identical pack (ids are deterministic), so the only
// variable is `effort`. The deterministic referee verifies every proposal, so
// a thinner plan shows up as repair rounds / residual conflicts — never as a
// silently bad schedule.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runAiPlan, schedulingAiModel } from "../schedule-ai";
import type { PackFixture, PackPerson, SchedulePack } from "../schedule-ai";

// vitest does not read .env.local; load just the key we need if absent.
if (!process.env.ANTHROPIC_API_KEY) {
  for (const rel of ["../../../../.env.local", "../../../../../../.env.local"]) {
    const p = path.resolve(__dirname, rel);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m) {
      process.env.ANTHROPIC_API_KEY = m[1].trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
}

const LIVE = process.env.AI_AB_LIVE === "1";

// --- deterministic ids -----------------------------------------------------
const uuid = (tag: string, n: number) =>
  `00000000-0000-4000-8000-${`${tag}${n}`.padStart(12, "0").slice(-12)}`;

// --- Pack A: 15 teams, 3 pools of 5, round robin within pool = 30 fixtures --
function teamsPack(): { pack: SchedulePack; movable: Set<string> } {
  const pools = ["Pool A", "Pool B", "Pool C"];
  const entrants = pools.flatMap((pool, p) =>
    Array.from({ length: 5 }, (_, t) => ({
      id: uuid("e", p * 5 + t),
      name: `${pool} Team ${t + 1}`,
      pool,
      seed: t + 1,
    })),
  );

  const movable: PackFixture[] = [];
  let n = 0;
  pools.forEach((pool, p) => {
    const ids = Array.from({ length: 5 }, (_, t) => uuid("e", p * 5 + t));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        movable.push({
          id: uuid("f", n),
          ext_key: `rr-${p}-${i}-${j}`,
          round: 1,
          seq: n,
          pool,
          home: ids[i],
          away: ids[j],
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        });
        n++;
      }
    }
  });

  const pack: SchedulePack = {
    mode: "generate",
    division: {
      id: "ab-teams",
      name: "Saturday League",
      sport: "generic",
      tz: "Europe/London",
      scheduling_mode: "timed",
    },
    settings: {
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["Court 1", "Court 2", "Court 3"],
      sessionWindows: [{ from: "2026-08-01T09:00:00+01:00", to: "2026-08-01T21:00:00+01:00" }],
      blackouts: [{ court: "Court 3", from: "2026-08-01T12:00:00+01:00", to: "2026-08-01T13:30:00+01:00" }],
      constraints: {
        restMin: 60,
        noBackToBack: true,
        startWindows: [],
        fieldFairness: "balance",
        parallelism: "mixed",
        crossPersonClash: "hard",
      },
    },
    entrants,
    people: [],
    fixtures: { movable, obstacles: [] },
    draft: [],
    instruction:
      "Schedule all pool matches on Saturday. Every team needs at least 60 minutes between its matches, no team plays back-to-back, and Court 3 is unavailable 12:00-13:30 for maintenance. Spread each team's matches across courts where you can.",
    prior: null,
    officials: [],
  };
  return { pack, movable: new Set(movable.map((f) => f.id)) };
}

// --- Pack B: 50 individual entrants, R1 knockout = 25 fixtures -------------
//     10 people are entered twice (multi-event), so crossPersonClash bites.
function individualsPack(): { pack: SchedulePack; movable: Set<string> } {
  const entrants = Array.from({ length: 50 }, (_, i) => ({
    id: uuid("e", i),
    name: `Player ${i + 1}`,
    pool: null,
    seed: i + 1,
  }));

  const movable: PackFixture[] = Array.from({ length: 25 }, (_, i) => ({
    id: uuid("f", i),
    ext_key: `r1-${i + 1}`,
    round: 1,
    seq: i,
    pool: null,
    home: uuid("e", 2 * i),
    away: uuid("e", 2 * i + 1),
    feeds: { winner_to: null, after: [] },
    current: { at: null, court: null },
    pinned: false,
  }));

  // Ten dual-entered people: entrant k and entrant k+25 are the same human, so
  // fixture floor(k/2) and fixture floor((k+25)/2) must not overlap.
  const people: PackPerson[] = Array.from({ length: 10 }, (_, k) => ({
    person_id: uuid("p", k),
    entrant_ids: [uuid("e", k), uuid("e", k + 25)],
  }));

  const pack: SchedulePack = {
    mode: "generate",
    division: {
      id: "ab-individuals",
      name: "Club Championship",
      sport: "generic",
      tz: "Europe/London",
      scheduling_mode: "timed",
    },
    settings: {
      matchMinutes: 45,
      gapMinutes: 0,
      courts: ["Court 1", "Court 2", "Court 3", "Court 4"],
      sessionWindows: [{ from: "2026-08-01T09:00:00+01:00", to: "2026-08-01T18:00:00+01:00" }],
      blackouts: [],
      constraints: {
        restMin: 30,
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "balance",
        parallelism: "mixed",
        crossPersonClash: "hard",
      },
    },
    entrants,
    people,
    fixtures: { movable, obstacles: [] },
    draft: [],
    instruction:
      "Schedule all 25 first-round matches in one day across four courts. Ten players are entered in two events each and must never be double-booked; give every player at least 30 minutes between matches. Finish as early in the day as possible.",
    prior: null,
    officials: [],
  };
  return { pack, movable: new Set(movable.map((f) => f.id)) };
}

// --- cost -------------------------------------------------------------------
// Sonnet 5 list is $3/$15 per MTok; introductory $2/$10 runs through
// 2026-08-31, so today's real spend is the `intro` column.
const usd = (i: number, o: number, inRate: number, outRate: number) =>
  Math.round(((i * inRate + o * outRate) / 1_000_000) * 10_000) / 10_000;

type Row = {
  pack: string;
  effort: string;
  secs: number;
  rounds: number;
  in: number;
  out: number;
  listUsd: number;
  introUsd: number;
  blocking: number;
  warnings: number;
  unschedulable: number;
  placed: number;
  error: string;
};

const rows: Row[] = [];

async function bench(name: string, build: () => { pack: SchedulePack; movable: Set<string> }, effort: string) {
  process.env.SCHEDULING_AI_EFFORT = effort;
  const { pack, movable } = build();
  const t0 = Date.now();
  const row: Row = {
    pack: name,
    effort,
    secs: 0,
    rounds: 0,
    in: 0,
    out: 0,
    listUsd: 0,
    introUsd: 0,
    blocking: -1,
    warnings: -1,
    unschedulable: -1,
    placed: -1,
    error: "",
  };
  try {
    const res = await runAiPlan(pack, movable);
    row.rounds = res.usage.repair_rounds;
    row.in = res.usage.input_tokens;
    row.out = res.usage.output_tokens;
    row.blocking = res.blocking.length;
    row.warnings = res.warnings.length;
    row.unschedulable = res.unschedulable.length;
    row.placed = res.proposal.length;
  } catch (err) {
    row.error = err instanceof Error ? `${(err as { code?: string }).code ?? ""} ${err.message}`.trim() : String(err);
  }
  row.secs = Math.round((Date.now() - t0) / 100) / 10;
  row.listUsd = usd(row.in, row.out, 3, 15);
  row.introUsd = usd(row.in, row.out, 2, 10);
  rows.push(row);
  process.stdout.write(
    `\n[${name} / effort=${effort}] ${row.secs}s  rounds=${row.rounds}  in=${row.in} out=${row.out}  ` +
      `list=$${row.listUsd} intro=$${row.introUsd}  blocking=${row.blocking} warnings=${row.warnings} ` +
      `unsched=${row.unschedulable} placed=${row.placed}${row.error ? `  ERROR: ${row.error}` : ""}\n`,
  );
  // A swallowed error is worse than a red test: it looks like a cheap run.
  expect(row.error, `${name}/${effort} failed`).toBe("");
  return row;
}

describe.skipIf(!LIVE)("effort A/B (live, billed)", () => {
  const T = 3_300_000; // up to 3 rounds at the configured round timeout, plus slack

  it("teams-15 @ high", async () => { await bench("teams-15", teamsPack, "high"); }, T);
  it("teams-15 @ medium", async () => { await bench("teams-15", teamsPack, "medium"); }, T);
  it("individuals-50 @ high", async () => { await bench("individuals-50", individualsPack, "high"); }, T);
  it("individuals-50 @ medium", async () => { await bench("individuals-50", individualsPack, "medium"); }, T);

  it("summary", () => {
    const roundMs = Number(process.env.SCHEDULING_AI_ROUND_TIMEOUT_MS) || 300_000;
    process.stdout.write(`\n===== effort A/B — model=${schedulingAiModel()} roundTimeout=${roundMs / 1000}s =====\n`);
    for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
    const total = rows.reduce((s, r) => s + r.introUsd, 0);
    process.stdout.write(`total spend this bench (intro rates): $${Math.round(total * 10000) / 10000}\n`);
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.error === "")).toBe(true);
  });
});
