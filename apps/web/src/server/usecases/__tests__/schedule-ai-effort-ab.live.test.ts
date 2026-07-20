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

type Arm = {
  effort: string;
  thinking?: "adaptive" | "disabled";
  /** Overrides SCHEDULING_AI_MODEL for this arm. */
  model?: string;
  /** Legacy-reasoning models only (haiku): token-precise thinking ceiling. */
  budget?: number;
  /** Cell label — arms must not aggregate together just because they share an
   *  effort value. */
  label: string;
};

async function bench(
  name: string,
  build: () => { pack: SchedulePack; movable: Set<string> },
  arm: Arm,
) {
  const { effort, thinking = "adaptive", model, budget, label: cellEffort } = arm;
  process.env.SCHEDULING_AI_EFFORT = effort;
  process.env.SCHEDULING_AI_THINKING = thinking;
  if (model) process.env.SCHEDULING_AI_MODEL = model;
  else delete process.env.SCHEDULING_AI_MODEL;
  if (budget) process.env.SCHEDULING_AI_THINKING_BUDGET = String(budget);
  else delete process.env.SCHEDULING_AI_THINKING_BUDGET;
  const { pack, movable } = build();
  const t0 = Date.now();
  const row: Row = {
    pack: name,
    effort: cellEffort,
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
  // Rates per the arm's model. Reconciliation against the real account balance
  // on 2026-07-20 ($15 -> $9 over ~$5.6 of list-rate runs) says this account is
  // billed at LIST, not the introductory sonnet rate — so `listUsd` is the
  // column to trust and `introUsd` is kept only for comparison.
  const [inRate, outRate] = model === "claude-haiku-4-5" ? [1, 5] : [3, 15];
  row.listUsd = usd(row.in, row.out, inRate, outRate);
  row.introUsd = usd(row.in, row.out, model === "claude-haiku-4-5" ? 1 : 2, model === "claude-haiku-4-5" ? 5 : 10);
  rows.push(row);
  process.stdout.write(
    `\n[${name} / effort=${cellEffort}] ${row.secs}s  rounds=${row.rounds}  in=${row.in} out=${row.out}  ` +
      `list=$${row.listUsd} intro=$${row.introUsd}  blocking=${row.blocking} warnings=${row.warnings} ` +
      `unsched=${row.unschedulable} placed=${row.placed}${row.error ? `  ERROR: ${row.error}` : ""}\n`,
  );
  // A swallowed error is worse than a red test: it looks like a cheap run.
  expect(row.error, `${name}/${cellEffort} failed`).toBe("");
  return row;
}

// Adaptive thinking is noisy: a repeated cell varied 2.1x run-to-run on
// 2026-07-20 (individuals-50 @ high, 7,911 vs 16,923 output tokens for a
// byte-identical pack). One sample per cell can order the arms but cannot size
// the gap between them, so REPEATS>1 is what turns the cost delta from
// directional into quotable.
const REPEATS = Math.max(1, Number(process.env.AI_AB_REPEATS) || 1);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** mean / min / max of one field across a cell's repeats. */
function agg(cell: Row[], pick: (r: Row) => number) {
  const xs = cell.map(pick);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { mean: round2(mean), min: round2(Math.min(...xs)), max: round2(Math.max(...xs)) };
}

describe.skipIf(!LIVE)("effort A/B (live, billed)", () => {
  // Worst observed cell is ~1095s; leave room for REPEATS of it plus repairs.
  const T = Math.max(3_300_000, REPEATS * 1_400_000);

  const cell = (name: string, build: () => { pack: SchedulePack; movable: Set<string> }, arm: Arm) =>
    it(`${name} @ ${arm.label} x${REPEATS}`, async () => {
      for (let i = 0; i < REPEATS; i++) await bench(name, build, arm);
    }, T);

  // Baseline arms are settled (2026-07-20, n=3): kept here only so a re-run
  // reproduces the full comparison. Enable with AI_AB_BASELINE=1.
  if (process.env.AI_AB_BASELINE === "1") {
    cell("teams-15", teamsPack, { effort: "high", label: "high" });
    cell("teams-15", teamsPack, { effort: "medium", label: "medium" });
    cell("individuals-50", individualsPack, { effort: "high", label: "high" });
    cell("individuals-50", individualsPack, { effort: "medium", label: "medium" });
  }

  // --- The two open questions -------------------------------------------
  //
  // Both test the same hypothesis: does producing a legal schedule from a
  // solver draft actually require a reasoning model? Thinking is ~90% of a
  // run's output tokens, and the engine referee re-checks every proposal, so a
  // thin plan is caught rather than shipped. Watch `rounds` — the trade is
  // fewer thinking tokens per round against possibly MORE rounds, and each
  // repair re-sends the prior round's output as input.

  // 1. Same model, no reasoning. The control: isolates thinking from model.
  cell("teams-15", teamsPack, { effort: "low", thinking: "disabled", label: "low/no-think" });
  cell("individuals-50", individualsPack, { effort: "low", thinking: "disabled", label: "low/no-think" });

  // 2. Cheaper model, token-capped reasoning. haiku-4-5 is $1/$5 against
  //    sonnet-5's $3/$15 and needs no port — same SDK, same zodOutputFormat,
  //    same parsed_output (verified live 2026-07-20). It rejects adaptive and
  //    effort, so it runs on a legacy budget_tokens ceiling instead, which is
  //    the token-precise knob effort never gave us.
  const HAIKU = { model: "claude-haiku-4-5", budget: 8_000, effort: "low" as const };
  cell("teams-15", teamsPack, { ...HAIKU, label: "haiku/budget8k" });
  cell("individuals-50", individualsPack, { ...HAIKU, label: "haiku/budget8k" });

  it("summary", () => {
    const roundMs = Number(process.env.SCHEDULING_AI_ROUND_TIMEOUT_MS) || 300_000;
    process.stdout.write(
      `\n===== effort A/B — model=${schedulingAiModel()} roundTimeout=${roundMs / 1000}s repeats=${REPEATS} =====\n`,
    );
    for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);

    // Per-cell aggregates. Spread (max/min) is the number that says whether the
    // between-effort gap is bigger than the within-effort noise.
    const keys = [...new Set(rows.map((r) => `${r.pack}|${r.effort}`))];
    process.stdout.write(`\n--- per cell (n=${REPEATS}) ---\n`);
    for (const k of keys) {
      const [pack, effort] = k.split("|");
      const c = rows.filter((r) => `${r.pack}|${r.effort}` === k);
      const secs = agg(c, (r) => r.secs);
      const out = agg(c, (r) => r.out);
      const cost = agg(c, (r) => r.introUsd);
      const spread = out.min > 0 ? round2(out.max / out.min) : 0;
      const clean = c.filter((r) => r.blocking === 0 && r.warnings === 0 && r.unschedulable === 0).length;
      process.stdout.write(
        `${pack} @ ${effort}: secs mean=${secs.mean} [${secs.min}-${secs.max}] | ` +
          `out mean=${out.mean} [${out.min}-${out.max}] spread=${spread}x | ` +
          `$intro mean=${cost.mean} [${cost.min}-${cost.max}] | clean ${clean}/${c.length}\n`,
      );
    }

    const total = rows.reduce((s, r) => s + r.introUsd, 0);
    process.stdout.write(`\ntotal spend this bench (intro rates): $${Math.round(total * 10000) / 10000}\n`);
    const expected = (process.env.AI_AB_BASELINE === "1" ? 8 : 4) * REPEATS;
    expect(rows.length).toBe(expected);
    expect(rows.every((r) => r.error === "")).toBe(true);
  });
});
