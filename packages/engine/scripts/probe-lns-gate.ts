// DIAGNOSTIC ONLY. Not wired into any test or CI gate — a standalone probe,
// same spirit as `bench-build.ts` in this directory.
//
// Question: on the production board shape that motivated the CP-SAT
// investigation (see `docs/superpowers/specs/2026-08-07-cpsat-scheduler-
// design.md`) — 37 fixtures, 5 courts, matchMinutes=30, gapMinutes=10, ~77k
// fixture-slots, confirmed by
// `apps/web/src/server/usecases/__tests__/schedule-auto-day-spread.test.ts`'s
// own header comment to be past the R18 `canSolveWithin` gate even at the
// 20s wall — does the solve path's own LNS repair pass (`build.ts` section
// "6c. LNS") produce anything better than plain greedy, IF it were ever
// allowed to run?
//
// Answer, recorded here for reproducibility: no. `encodeBuild` + the first
// tier's `solver.push()` alone consume ~15.5s on this board — nearly double
// the 8s wall — before any tier check runs at all; at 20s, tier 1 (makespan)
// starts but never finishes before the wall expires, so LNS's own guard
// (`tiersCompleted < TIER_COUNT && elapsed() < wallMs`) never opens.
// `allowLns=true`/`false` produced BYTE-IDENTICAL boards at both walls in
// the run this script reproduces. z3 cannot even finish encoding this board
// before either wall runs out — LNS is not being skipped unfairly, it
// structurally cannot fire in time.
//
// The `gate`/`gated` cases below run as-is against the shipped public API
// (`buildSchedule`, `canSolveWithin`) and need no code changes. The
// `lns-*`/`nolns-*` cases bypass the R18 gate to call the module-private
// `solveBuild` directly — `build.ts` does not export it, so reproducing
// those two cases requires TEMPORARILY adding a diagnostic export at the
// bottom of `build.ts`:
//
//   export const __diagnosticSolveBuild = solveBuild;
//
// ...and reverting it afterward (`git status` must be clean before
// committing anything else). This script types that export as OPTIONAL on
// the module namespace (`& { __diagnosticSolveBuild?: ... }`) precisely so
// it type-checks in both states without ever changing `build.ts`'s real
// public surface itself.
//
// ONE CASE PER PROCESS (argv[2] selects it) — z3's WASM can abort the whole
// process on an OOM (documented in `build.ts` around `rlimitCount`/
// `withModel`), so isolating each case the way `bench-build.ts` does means a
// crash on one case does not erase the others' results.
//
// Usage: node --experimental-strip-types probe-lns-gate.ts <case>
//   case in: gate | gated | lns-8000 | lns-20000 | nolns-8000 | nolns-20000

import { buildSchedule, canSolveWithin, type BuildInput, type BuildResult } from "../src/scheduling/build.ts";
import { buildGrid } from "../src/scheduling/build-grid.ts";
import type { SchedulableFixture, SlotConfig, VerifyConfig } from "../src/scheduling/calendar.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

// --- the production board shape ---------------------------------------------
const EPOCH = Date.parse("2026-09-01T00:00:00Z");
const COURTS = ["C1", "C2", "C3", "C4", "C5"];
const MATCH_MIN = 30;
const GAP_MIN = 10;
const SESSION_OPEN = 10 * HOUR; // 10:00
const SESSION_CLOSE = 19 * HOUR; // 19:00, a 9h session — matches the real
// report's "Play hours (daily) 10:36-19:36" shape per
// schedule-auto-day-spread.test.ts:35-36.
// step = gcd(30,10) = 10min. slots/court/day = floor((540-30)/10)+1 = 52.
// 5 courts -> 260/day. 8 days -> 2080 slots; 37 fixtures * 2080 = 76,960
// ~= the real board's reported ~77k fixture-slots.
const DAYS_N = 8;

const sessionWindows = Array.from({ length: DAYS_N }, (_, d) => ({
  from: EPOCH + d * DAY + SESSION_OPEN,
  to: EPOCH + d * DAY + SESSION_CLOSE,
}));

const NUM_FIXTURES = 37;
const POOL = 12;
const perRound = Math.max(1, Math.floor(POOL / 2));
const fixtures: SchedulableFixture[] = [];
for (let f = 0; f < NUM_FIXTURES; f++) {
  const home = `e${(2 * f) % POOL}`;
  const away = `e${(2 * f + 1) % POOL}`;
  fixtures.push({
    id: `f${String(f).padStart(3, "0")}`,
    roundNo: Math.floor(f / perRound) + 1,
    home,
    away,
    people: [`p-${home}`, `p-${away}`],
    divisionId: "d1",
  });
}

type ProbeConfig = SlotConfig & { courts: string[] } & Pick<VerifyConfig, "hard" | "restByDivision">;

const config: ProbeConfig = {
  startAt: EPOCH + SESSION_OPEN,
  matchMinutes: MATCH_MIN,
  gapMinutes: GAP_MIN,
  courts: [...COURTS],
  perEntrantMinRest: 10,
  blackouts: [],
  sessionWindows,
  window: { from: EPOCH, to: EPOCH + DAYS_N * DAY },
  tz: "UTC",
  constraints: { noBackToBack: false, startWindows: [], fieldFairness: "off", parallelism: "mixed", crossPersonClash: "warn" },
  hard: [],
  restByDivision: {},
};

function summarize(label: string, res: BuildResult, wallStart: number): void {
  console.log(`\n=== ${label} ===`);
  console.log(
    JSON.stringify(
      {
        status: res.status,
        engine: res.engine,
        tiersCompleted: res.tiersCompleted,
        budgetExpired: res.budgetExpired,
        placed: res.metrics.placed,
        total: res.metrics.total,
        makespanMinutes: res.metrics.makespanMinutes,
        worstIdleGapMinutes: res.metrics.worstIdleGapMinutes,
        courtImbalanceMinutes: res.metrics.courtImbalanceMinutes,
        elapsedMs_reported: res.elapsedMs,
        wallClockMs_measured: Date.now() - wallStart,
        rlimitSpent: res.rlimitSpent,
        lnsWindowRlimits: res.lnsWindowRlimits,
        moved: res.moved,
        lost: res.lost,
      },
      null,
      2,
    ),
  );
}

const kase = process.argv[2];

if (kase === "gate") {
  const grid = buildGrid({ config, existing: [] });
  console.log("grid.slots.length:", grid.slots.length, "overCap:", grid.overCap);
  console.log("fixtures.length * grid.slots.length:", fixtures.length * grid.slots.length);
  console.log("canSolveWithin(wallMs=8000):", canSolveWithin(fixtures, config, 8000, []));
  console.log("canSolveWithin(wallMs=20000):", canSolveWithin(fixtures, config, 20000, []));
} else if (kase === "gated") {
  const t0 = Date.now();
  const res = await buildSchedule({ fixtures, config, wallMs: 20000 });
  summarize("GATED buildSchedule, wallMs=20000 (today's real behavior)", res, t0);
} else if (kase?.startsWith("lns-") || kase?.startsWith("nolns-")) {
  const mod = (await import("../src/scheduling/build.ts")) as typeof import("../src/scheduling/build.ts") & {
    __diagnosticSolveBuild?: (input: BuildInput, allowLns?: boolean) => Promise<BuildResult>;
  };
  if (!mod.__diagnosticSolveBuild) {
    console.error(
      "build.ts does not currently export __diagnosticSolveBuild — see this file's header for the temporary export needed to run this case.",
    );
    process.exit(1);
  }
  const allowLns = kase.startsWith("lns-");
  const wallMs = Number(kase.split("-")[1]);
  const t0 = Date.now();
  const res = await mod.__diagnosticSolveBuild({ fixtures, config, wallMs }, allowLns);
  summarize(`BYPASSED solveBuild allowLns=${allowLns} wallMs=${wallMs}`, res, t0);
} else {
  console.error("unknown case:", kase);
  process.exit(1);
}

process.exit(0);
