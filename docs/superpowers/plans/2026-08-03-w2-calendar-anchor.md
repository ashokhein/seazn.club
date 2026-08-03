# W2 — calendar anchor (org timezone, clock, resolved window, kill epoch drafts)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI scheduling pack a real calendar anchor — one organisation
timezone, an injected clock, a resolved window and daily session hours — so the model
stops receiving 1970 draft times and an out-of-window assignment becomes a reported
(not yet blocking) conflict.

**Architecture:** A new pure `packages/engine/src/scheduling/tz.ts` supplies the
inverse of the existing `zonedIso` (wall-clock → instant) plus day/weekday extraction,
built on a DST-safe `Intl` fixpoint with zero dependencies. `calendar.ts` gains a
`window` `ConflictReason` driven by an optional `window` field on the verifier config.
The two pack builders (`schedule-ai.ts`, `competition-schedule-ai.ts`) grow `tz`,
`clock`, `window` and `sessionHours`, take `now` as a required injected option, and
render every timestamp in the **organisation** zone. `J6` — which currently tells the
joint model that each division is in its own clock — is rewritten.

**Tech Stack:** TypeScript (ESM, `.ts` import extensions inside `packages/engine`),
zod 4, vitest 4, Next.js (App Router), postgres.js.

Issue: #397 · Design: `docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md`
(§2.1, §3, §4.1, §6, §7.1, §7.2) · Programme index: #395 · Gate: #396 merged
(`39660d5e` on `main`) ✅.

---

## Global Constraints

- **`now` is injected, never read.** No `Date.now()` and no argless `new Date()` in
  `packages/engine/src/scheduling/**` or in either pack builder. Exactly **two** new
  `Date.now()` call sites are permitted in this wave, both at an impure runner entry:
  `runAiPlan` (`schedule-ai.ts`) and the joint runner (`competition-schedule-ai.ts`).
  `new Date(x)` / `Date.parse(x)` on an injected value stays fine.
- **ONE organisation timezone governs all temporal math** (day boundaries, weekday
  targets, session hours, output offsets). Per-division `tz` becomes display metadata.
  The pack keeps `division.tz` unchanged and adds a top-level `tz` = org zone.
- **`SYSTEM_PROMPT` stays byte-frozen.** `schedule-ai-prompt.test.ts` snapshot must not
  change. No new prompt constant in this wave — the five additive sentences are W3's
  job (design §7.3).
- **`J6` is rewritten, not extended.** It is the one non-additive prompt change.
- **`window` is warning-only this wave.** `isBlocking` must keep returning `false` for
  it; delta-based blocking is W4 (#399).
- **Golden pack snapshot is updated exactly once**, as one reviewed diff, at the end of
  Task 5.
- Every change ships a test that fails without it, and the two real payloads
  (badminton double-elimination, Stepladder Showcase) are exercised in **both**
  directions — accept a legal board, reject an illegal one.
- Verify vitest counts from `--reporter=json --outputFile` (`numPassedTests` /
  `numTotalTests`), never from an `rtk` summary, and never with positional path
  filters on `npm test --workspace apps/web`.
- **DB-backed suites need `DATABASE_URL`.** `apps/web/vitest.config.ts` loads the
  repo-root `.env.local`; every DB suite guards on `describe.skipIf(!HAS_DB)`, so
  without it ~700 tests silently skip and the run still prints green. The worktree
  has `.env.local` and `apps/web/.env.local` symlinked to the main repo's. Confirm
  a DB suite actually ran by reading `numTotalTests`, not the exit code.
- **The web test harness is `__tests__/_seed.ts` + each suite's own seeder.**
  `schedule-ai-pack.test.ts` has `seedOrg("pro")`, `seedRrBoard()`,
  `setSettings(divisionId)`, `redact(pack)`, `TZ = "Europe/London"` and
  `SETTINGS_CONFIG`. Extend those; do not add a second harness.
- Always `grep -a` — this repo reports source files as `Binary file … matches`.
- New/changed user-facing strings go into **all four** locale dictionaries
  (`apps/web/src/dictionaries/{en,nl,fr,es}/ui.json`); `content/help/**` is English-only.
- Work stays in the worktree `.claude/worktrees/w2-calendar-anchor` on branch
  `feat/w2-calendar-anchor`. Ship a PR — smoke CI runs on PRs only.

### Locked constants (decided here, referenced by every task)

| Constant | Value | Where | Why |
|---|---|---|---|
| `DEFAULT_WINDOW_DAYS` | `7` | `schedule-ai.ts` | The programme's implicit unit — design §6 freezes a "badminton golden 7-day schedule" and a "extends a week" assumption. |
| `DEFAULT_SESSION_HOURS` | `{ start: "08:00", end: "22:00" }` | `schedule-ai.ts` | `ScheduleConfig` has no daily-hours field; this is the fallback the pack advertises when a division has no `sessionWindows`. Only advisory in W2. |
| `EPOCH_SENTINEL_BEFORE_MS` | `Date.UTC(1971, 0, 1)` = `31_536_000_000` | `engine/scheduling/tz.ts` | Timezone-independent sentinel test. `startsWith("1970-")` is wrong: in `America/New_York` the epoch renders `1969-12-31T19:00:00-05:00`. |

### Window resolution (the rule every task refers to)

All arithmetic in the **org** zone `tz`.

```
baseStartMs = config.startAt ? ms(config.startAt) : zonedTimeToUtc(clock.today, "00:00", tz)
baseEndYmd  = config.endAt   ? dayKeyInTz(ms(config.endAt), tz)
                             : ymdAddDays(dayKeyInTz(baseStartMs, tz), DEFAULT_WINDOW_DAYS - 1)
baseEndMs   = zonedTimeToUtc(ymdAddDays(baseEndYmd, 1), "00:00", tz) - 1000

// widen — never narrow — to cover what is already explicit or already scheduled
startMs = min(baseStartMs, ...sessionWindows.from, ...currentTimes)
endMs   = max(baseEndMs,   ...sessionWindows.to,   ...(currentTimes + matchMinutes*60000))
// then floor startMs to its day start in tz, and ceil endMs to its day end in tz
```

where `currentTimes` = the `scheduled_at` of every **movable** fixture, **excluding
epoch sentinels** (`ms < EPOCH_SENTINEL_BEFORE_MS`). Excluding sentinels is what makes
the 13-violation test possible: include them and the window swallows 1970.

Widening is deliberate and one-directional. A repair round re-emits a board the
organiser already scheduled; a window that excludes that board would report a
violation on every card and teach the organiser to ignore the reason. `sessionWindows`
are explicit organiser calendar statements and must never contradict the window.

**Do not re-zone `sessionWindows` or `blackouts`** — they are absolute instants
(design §gotchas). Only "which calendar day is this?" needs one answer.

**Do not build the end by adding `86_400_000`** — DST days are 23 or 25 hours long.

### File structure

| File | State | Responsibility |
|---|---|---|
| `packages/engine/src/scheduling/tz.ts` | new | Pure zone math: `zonedTimeToUtc`, `dayKeyInTz`, `hhmmInTz`, `ymdAddDays`, `weekdayOfYmd`, `makeClock`, `isEpochSentinel`. No wall-clock read. |
| `packages/engine/src/scheduling/tz.test.ts` | new | DST both directions, the `24:00` guard, gap/ambiguous local times, half-hour and 45-minute zones, clock determinism. |
| `packages/engine/src/scheduling/index.ts` | modify | Re-export `tz.ts`. |
| `packages/engine/src/scheduling/calendar.ts` | modify | `window` `ConflictReason`; optional `window` on the verifier config; the check. |
| `packages/engine/src/scheduling/calendar-window.test.ts` | new | Both-directions window proof over the frozen badminton payload, incl. the 13-violation epoch case. |
| `apps/web/src/server/usecases/schedule.ts` | modify | `ScheduleSettingsOut.orgTz` — the organisation zone, resolved and validated. |
| `apps/web/src/server/usecases/schedule-ai.ts` | modify | `BuildPackOptions.now`; pack `tz`/`clock`/`window`/`sessionHours`; org-zoned rendering; real draft anchor; sentinel kill; `verifyConfig` window. |
| `apps/web/src/server/usecases/competition-schedule-ai.ts` | modify | Joint twin of all of the above; `canonicalTz` → org zone; `verifyConfigFor` takes the window. |
| `apps/web/src/server/usecases/schedule-ai-prompt.ts` | modify | `J6` rewritten. `SYSTEM_PROMPT` untouched. |
| `apps/web/src/server/api-v1/schemas.ts` | modify | `ScheduleConflict.code` gains `"warn.window"`. |
| `apps/web/src/components/v2/board/types.ts` | modify | `CONFLICT_LABEL` / `CONFLICT_HELP` gain the `warn.window` entry. |
| `apps/web/src/dictionaries/{en,nl,fr,es}/ui.json` | modify | Two new keys each. |
| `content/help/**` | modify | Closing pass — document the org-clock rule and the window. |
| `scripts/smoke.ts` | modify | Assert the pack carries a non-epoch anchor. |

---

## Task 1: Pure zone math in the engine

**Files:**
- Create: `packages/engine/src/scheduling/tz.ts`
- Test: `packages/engine/src/scheduling/tz.test.ts`
- Modify: `packages/engine/src/scheduling/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Ymd = string;      // "YYYY-MM-DD"
  export type Hhmm = string;     // "HH:MM", 24-hour
  export type Weekday = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
  export interface Clock {
    now: string;                          // ISO-8601 UTC, from the injected instant
    today: Ymd;                           // in the governing zone
    tomorrow: Ymd;
    nextWeekday: Record<Weekday, Ymd>;    // next occurrence strictly after today
  }
  export const EPOCH_SENTINEL_BEFORE_MS: number;
  export function isEpochSentinel(instantMs: number): boolean;
  export function ymdAddDays(ymd: Ymd, days: number): Ymd;
  export function weekdayOfYmd(ymd: Ymd): Weekday;
  export function dayKeyInTz(instantMs: number, tz: string): Ymd;
  export function hhmmInTz(instantMs: number, tz: string): Hhmm;
  export function zonedTimeToUtc(ymd: Ymd, hhmm: Hhmm, tz: string): number;
  export function makeClock(nowMs: number, tz: string): Clock;
  ```

`nowMs` is epoch ms, matching `calendar.ts`'s stated unit rule ("all times are
injected — the same unit throughout, e.g. epoch ms"). `Clock.now` is the ISO
rendering of that same instant, because it is pack/wire material.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/scheduling/tz.test.ts`:

```ts
// Zone math is the one place a scheduler is allowed to know about calendars, so
// it is tested against real DST transitions rather than a mocked offset. Every
// expectation below was checked against Node's own ICU before being written.
import { describe, expect, it } from "vitest";
import {
  dayKeyInTz,
  hhmmInTz,
  isEpochSentinel,
  makeClock,
  weekdayOfYmd,
  ymdAddDays,
  zonedTimeToUtc,
} from "./tz";

const iso = (ms: number): string => new Date(ms).toISOString();

describe("zonedTimeToUtc", () => {
  it("resolves a wall clock through a DST change in both directions", () => {
    // The acceptance criterion on #397: same wall time, one hour apart.
    expect(iso(zonedTimeToUtc("2026-08-07", "10:00", "America/New_York")))
      .toBe("2026-08-07T14:00:00.000Z");
    expect(iso(zonedTimeToUtc("2026-01-09", "10:00", "America/New_York")))
      .toBe("2026-01-09T15:00:00.000Z");
  });

  it("handles zones whose offset is not a whole hour", () => {
    expect(iso(zonedTimeToUtc("2026-08-07", "09:15", "Asia/Kathmandu")))
      .toBe("2026-08-07T03:30:00.000Z"); // +05:45
    expect(iso(zonedTimeToUtc("2026-08-07", "09:15", "Pacific/Chatham")))
      .toBe("2026-08-06T20:30:00.000Z"); // +12:45
  });

  it("terminates on a local time that does not exist (spring-forward gap)", () => {
    // 02:30 never happens in New York on 2026-03-08. The fixpoint must land on a
    // real instant rather than loop or return NaN.
    const ms = zonedTimeToUtc("2026-03-08", "02:30", "America/New_York");
    expect(Number.isFinite(ms)).toBe(true);
    expect(iso(ms)).toBe("2026-03-08T06:30:00.000Z");
  });

  it("picks one instant for an ambiguous local time (fall-back repeat)", () => {
    const ms = zonedTimeToUtc("2026-11-01", "01:30", "America/New_York");
    expect(iso(ms)).toBe("2026-11-01T05:30:00.000Z");
  });

  it("round-trips midnight — never formats it as 24:00", () => {
    // The ICU quirk the design calls out: some hourCycles render midnight as
    // "24:00", which sorts after every other time and silently breaks a
    // sessionHours comparison.
    for (const tz of ["UTC", "Europe/London", "America/New_York", "Asia/Kolkata"]) {
      const ms = zonedTimeToUtc("2026-08-07", "00:00", tz);
      expect(hhmmInTz(ms, tz)).toBe("00:00");
      expect(dayKeyInTz(ms, tz)).toBe("2026-08-07");
    }
  });
});

describe("dayKeyInTz / hhmmInTz", () => {
  it("reports the local calendar day, not the UTC one", () => {
    // 2026-08-07T01:00Z is still 2026-08-06 in New York.
    const ms = Date.parse("2026-08-07T01:00:00Z");
    expect(dayKeyInTz(ms, "UTC")).toBe("2026-08-07");
    expect(dayKeyInTz(ms, "America/New_York")).toBe("2026-08-06");
    expect(hhmmInTz(ms, "America/New_York")).toBe("21:00");
  });
});

describe("ymdAddDays / weekdayOfYmd", () => {
  it("crosses a DST boundary without losing or gaining a day", () => {
    expect(ymdAddDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(ymdAddDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(ymdAddDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("names the weekday", () => {
    expect(weekdayOfYmd("2026-08-07")).toBe("FRI");
    expect(weekdayOfYmd("2026-08-09")).toBe("SUN");
  });
});

describe("makeClock", () => {
  it("is a pure function of the instant it is handed", () => {
    const nowMs = Date.parse("2026-08-06T23:30:00Z");
    const a = makeClock(nowMs, "Europe/London");
    const b = makeClock(nowMs, "Europe/London");
    expect(a).toEqual(b);
    expect(a.now).toBe("2026-08-06T23:30:00.000Z");
    // 23:30Z is already 2026-08-07 in London (BST).
    expect(a.today).toBe("2026-08-07");
    expect(a.tomorrow).toBe("2026-08-08");
  });

  it("resolves each weekday to its next occurrence strictly after today", () => {
    const c = makeClock(Date.parse("2026-08-07T12:00:00Z"), "UTC"); // a Friday
    expect(c.today).toBe("2026-08-07");
    expect(c.nextWeekday.SAT).toBe("2026-08-08");
    expect(c.nextWeekday.FRI).toBe("2026-08-14"); // never today
    expect(new Set(Object.values(c.nextWeekday)).size).toBe(7);
  });
});

describe("isEpochSentinel", () => {
  it("catches an epoch draft time in any zone", () => {
    // The reason this is not `startsWith("1970-")`: in New York the epoch
    // renders as 1969-12-31.
    expect(isEpochSentinel(0)).toBe(true);
    expect(isEpochSentinel(Date.parse("1970-06-01T00:00:00Z"))).toBe(true);
    expect(isEpochSentinel(Date.parse("1969-12-31T19:00:00Z"))).toBe(true);
    expect(isEpochSentinel(Date.parse("2026-08-07T10:00:00Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/tz.test.ts`
Expected: FAIL — `Failed to resolve import "./tz"`.

- [ ] **Step 3: Write the implementation**

Create `packages/engine/src/scheduling/tz.ts`:

```ts
// Zone math for the scheduler — the inverse of the pack's `zonedIso` plus the
// day/weekday extraction the window, per-day caps and weekday targets need.
// Built as a fixpoint over `Intl` so it is DST-correct with zero dependencies.
//
// No wall-clock reads, same as calendar.ts: `makeClock` takes the instant as a
// parameter. Reading the clock here would unfreeze every golden pack test.

export type Ymd = string; // "YYYY-MM-DD"
export type Hhmm = string; // "HH:MM", 24-hour
export type Weekday = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";

export interface Clock {
  /** ISO-8601 UTC rendering of the injected instant. */
  now: string;
  /** The calendar day that instant falls on, in the governing zone. */
  today: Ymd;
  tomorrow: Ymd;
  /** Each weekday's next occurrence, strictly after `today`. */
  nextWeekday: Record<Weekday, Ymd>;
}

const WEEKDAYS: readonly Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const MS_PER_DAY = 86_400_000;

/** Anything before 1971 is a sentinel, not a fixture. Zone-independent on
 *  purpose: `startsWith("1970-")` misses the epoch rendered west of UTC, where
 *  it reads 1969-12-31. */
export const EPOCH_SENTINEL_BEFORE_MS = Date.UTC(1971, 0, 1);

export function isEpochSentinel(instantMs: number): boolean {
  return instantMs < EPOCH_SENTINEL_BEFORE_MS;
}

/** Calendar arithmetic on a bare date — done in UTC on purpose. A YMD carries
 *  no zone, so adding a day is 24h here and stays exact; the zone only enters
 *  when a YMD is turned back into an instant by `zonedTimeToUtc`. */
export function ymdAddDays(ymd: Ymd, days: number): Ymd {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function weekdayOfYmd(ymd: Ymd): Weekday {
  return WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()]!;
}

/** The calendar day an instant falls on, in `tz`. `en-CA` formats YYYY-MM-DD. */
export function dayKeyInTz(instantMs: number, tz: string): Ymd {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/** The wall-clock time of an instant, in `tz`. The `^24` guard is the known ICU
 *  quirk: some hour cycles render midnight as "24:00", which sorts after every
 *  other time and would silently invert a session-hours comparison. */
export function hhmmInTz(instantMs: number, tz: string): Hhmm {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(instantMs))
    .replace(/^24/, "00");
}

/**
 * Wall clock `(ymd, hh:mm)` in `tz` → UTC epoch ms. The inverse of `zonedIso`.
 *
 * Two correction passes are enough for every real zone: the first lands within
 * the offset error, the second fixes the case where that correction itself
 * crossed a DST boundary. A local time that does not exist (the spring-forward
 * gap) has no exact answer — the fixpoint stops on the closest real instant
 * rather than looping.
 */
export function zonedTimeToUtc(ymd: Ymd, hhmm: Hhmm, tz: string): number {
  const target = Date.parse(`${ymd}T${hhmm}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const wall = Date.parse(`${dayKeyInTz(guess, tz)}T${hhmmInTz(guess, tz)}:00Z`);
    if (wall === target) break;
    guess += target - wall;
  }
  return guess;
}

/** The calendar anchor, from an instant the caller supplies. */
export function makeClock(nowMs: number, tz: string): Clock {
  const today = dayKeyInTz(nowMs, tz);
  const nextWeekday = {} as Record<Weekday, Ymd>;
  for (let i = 1; i <= 7; i++) {
    const day = ymdAddDays(today, i);
    const wd = weekdayOfYmd(day);
    if (nextWeekday[wd] === undefined) nextWeekday[wd] = day;
  }
  return {
    now: new Date(nowMs).toISOString(),
    today,
    tomorrow: ymdAddDays(today, 1),
    nextWeekday,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run src/scheduling/tz.test.ts --reporter=json --outputFile=/tmp/w2-tz.json`
Expected: `numFailedTests: 0`, `numTotalTests: 11`.

- [ ] **Step 5: Export from the scheduling barrel**

Read `packages/engine/src/scheduling/index.ts` and add, matching the existing
`export * from "./x.ts";` style:

```ts
export * from "./tz.ts";
```

Run: `cd packages/engine && npx tsc --noEmit`
Expected: no errors. If `Clock` or `Weekday` collides with an existing export,
stop and report — do not rename silently.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/scheduling/tz.ts packages/engine/src/scheduling/tz.test.ts packages/engine/src/scheduling/index.ts
git commit -m "feat(engine): DST-safe zone math for the scheduler calendar anchor

zonedTimeToUtc is the inverse of the pack's zonedIso, which did not exist:
converting a wall clock in an IANA zone to an instant is what window
construction, per-day caps and weekday targets all need. A fixpoint over Intl
does it DST-correctly with no dependency, guarding the ICU quirk that renders
midnight as 24:00.

now is injected, never read — makeClock takes the instant as a parameter, so
the golden pack tests stay byte-stable.

Refs #397"
```

---

## Task 2: The `window` conflict reason

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts:97-104` (union),
  `:419-425` (signature), `:451` (the per-assignment loop)
- Test: `packages/engine/src/scheduling/calendar-window.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1 (the engine check works in epoch ms; the zone
  math lives at the pack edge).
- Produces:
  ```ts
  export type ConflictReason = /* … existing … */ | "window";
  // validateAssignments' config parameter gains:
  //   window?: { from: number; to: number }   // epoch ms, `to` inclusive
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/scheduling/calendar-window.test.ts`:

```ts
// Both-directions proof for the pack window (#397 / design §7.2). The payload is
// the frozen badminton double-elimination board — the same 13 fixtures
// participants-rules.test.ts uses — so the two waves cannot drift apart.
//
// Every REJECT case here puts its fixtures on DIFFERENT courts and leaves rest
// at zero, so a `window` conflict can never be a mis-labelled court or rest
// clash.
import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment } from "./calendar";

const MIN = 60_000;
const at = (iso: string): number => Date.parse(iso);

// 13 fixtures, ids only — the window rule does not care who is playing.
const IDS = [
  "wb-r0-i1", "wb-r0-i2", "wb-r0-i3", "wb-r1-i0", "wb-r1-i1", "wb-r2-i0",
  "lb-r0-i0", "lb-r0-i1", "lb-r1-i0", "lb-r1-i1", "lb-r2-i0", "lb-r3-i0", "gf",
];

const BASE = {
  matchMinutes: 40,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [] as { from: number; to: number }[],
  sessionWindows: [] as { from: number; to: number }[],
};

/** One fixture per hour from `startIso`, each on its own court so nothing but
 *  the window can fire. */
function board(startIso: string, ids: readonly string[] = IDS): Assignment[] {
  const t0 = at(startIso);
  return ids.map((id, i) => ({
    fixtureId: id,
    court: `Court ${i + 1}`,
    startAt: t0 + i * 60 * MIN,
    endAt: t0 + i * 60 * MIN + 40 * MIN,
    entrants: [],
    people: [],
  }));
}

const WINDOW = {
  from: at("2026-08-01T00:00:00Z"),
  to: at("2026-08-07T23:59:59Z"),
};

describe("pack window (payload A: badminton, 13 fixtures)", () => {
  it("ACCEPTS a board that sits inside the window", () => {
    const conflicts = validateAssignments(board("2026-08-03T10:00:00Z"), {
      ...BASE,
      window: WINDOW,
    });
    expect(conflicts).toEqual([]);
  });

  it("ACCEPTS the board when no window is configured at all", () => {
    // Absent window means unbounded — the pre-W2 behaviour, unchanged.
    expect(validateAssignments(board("1970-01-01T00:00:00Z"), BASE)).toEqual([]);
  });

  it("REJECTS an epoch draft — every one of the 13 fixtures is out of window", () => {
    // The exact case #397 exists to kill: with no configured startAt the draft
    // was built at epoch and 1970 verified clean.
    const conflicts = validateAssignments(board("1970-01-01T00:00:00Z"), {
      ...BASE,
      window: WINDOW,
    });
    expect(conflicts.filter((c) => c.reason === "window")).toHaveLength(13);
    expect(new Set(conflicts.map((c) => c.fixtureId))).toEqual(new Set(IDS));
    expect(conflicts.every((c) => c.reason === "window")).toBe(true);
  });

  it("REJECTS a fixture that starts inside the window but ends after it", () => {
    // The bound is the OCCUPANCY, not the start — a match may not run past the
    // last day of the competition.
    const late: Assignment[] = [
      {
        fixtureId: "gf",
        court: "Court 1",
        startAt: at("2026-08-07T23:40:00Z"),
        endAt: at("2026-08-08T00:20:00Z"),
        entrants: [],
        people: [],
      },
    ];
    const conflicts = validateAssignments(late, { ...BASE, window: WINDOW });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe("window");
    expect(conflicts[0]!.fixtureId).toBe("gf");
  });

  it("REJECTS a single fixture before the window and leaves the rest alone", () => {
    const b = board("2026-08-03T10:00:00Z");
    b[4]!.startAt = at("2026-07-30T10:00:00Z");
    b[4]!.endAt = at("2026-07-30T10:40:00Z");
    const conflicts = validateAssignments(b, { ...BASE, window: WINDOW });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ fixtureId: "wb-r1-i1", reason: "window" });
  });

  it("does not report obstacles — only the assignments under review", () => {
    // `existing` is other divisions' board and outside-the-run bookings. It is
    // court occupancy, not something this run is being asked to fix.
    const conflicts = validateAssignments(
      board("2026-08-03T10:00:00Z", ["gf"]),
      { ...BASE, window: WINDOW },
      board("1970-01-01T00:00:00Z"),
    );
    expect(conflicts.filter((c) => c.reason === "window")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/calendar-window.test.ts`
Expected: FAIL — `window` is not assignable to the config parameter (tsc/vitest
type error), and the epoch cases return `[]`.

- [ ] **Step 3: Extend the reason union**

In `packages/engine/src/scheduling/calendar.ts`, replace the union at `:97-104`:

```ts
export type ConflictReason =
  | "no_slot" // no court/time within the horizon satisfies the hard constraints
  | "court" // two matches share a court+time (blocks — physically impossible)
  | "rest" // an entrant is below perEntrantMinRest (warn)
  | "blackout" // inside a blackout window / outside every session window (warn)
  | "person_overlap" // a person plays in two overlapping matches (warn — doc 06 §4.3)
  | "start_window" // Jul3/04 §3: no feasible slot inside the target's window (hard)
  | "window" // outside the pack's resolved calendar window (#397 — warn; W4 blocks)
  | "order"; // scheduled before a fixture that feeds it (doc 12 §2; blocks when direct)
```

- [ ] **Step 4: Add the window to the verifier config and check it**

In the same file, extend the `SlotConfig` interface at `:26-37` with the window,
directly under `sessionWindows`:

```ts
  /** The competition's resolved calendar window (#397). Absent means unbounded,
   *  which is every pre-W2 caller. `to` is inclusive: it is the last instant a
   *  fixture may still be occupying. Constructed from wall-clock day boundaries
   *  in ONE zone at the pack edge — never by adding 86_400_000, because a DST
   *  day is 23 or 25 hours long. */
  window?: { from: number; to: number };
```

Widen the `validateAssignments` signature at `:419-425`:

```ts
export function validateAssignments(
  assignments: readonly Assignment[],
  config: Pick<SlotConfig, "perEntrantMinRest" | "gapMinutes" | "blackouts" | "sessionWindows"> &
    Partial<Pick<SlotConfig, "matchMinutes" | "constraints" | "window">>,
  existing: readonly Assignment[] = [],
  dependencies: readonly OrderDependency[] = [],
): Conflict[] {
```

Add the check as the first thing in the per-assignment loop at `:451`, immediately
after `for (const a of assignments) {` and before the `windowFor(a)` line:

```ts
    // The pack window (#397): the whole occupancy must fall inside the days the
    // competition actually runs. Only `assignments` are bound — `existing` is
    // other divisions' board and outside bookings, which this run is not being
    // asked to move. Warn-only until W4 makes it delta-blocking (#399).
    const pw = config.window;
    if (pw !== undefined && (a.startAt < pw.from || a.endAt > pw.to)) {
      conflicts.push({
        fixtureId: a.fixtureId,
        reason: "window",
        detail: "outside the competition window",
      });
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/engine && npx vitest run src/scheduling/calendar-window.test.ts --reporter=json --outputFile=/tmp/w2-cw.json`
Expected: `numFailedTests: 0`, `numTotalTests: 6`.

- [ ] **Step 6: Run the whole engine scheduling suite — nothing else may move**

Run: `cd packages/engine && npx vitest run src/scheduling --reporter=json --outputFile=/tmp/w2-engine.json`
Expected: `numFailedTests: 0`, `numTotalTests: 148` (131 baseline + 11 + 6).
`numTotalTestSuites` is not the number to read — see the vitest counting rule.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/scheduling/calendar.ts packages/engine/src/scheduling/calendar-window.test.ts
git commit -m "feat(engine): report an assignment outside the competition window

ConflictReason gains window. With no window configured nothing changes — the
field is optional and every pre-W2 caller passes none — but a pack that resolves
one now bounds its output dates, which nothing did before: a 1970 draft, or a
match at 03:00 three weeks after the final, verified clean.

Warn-only. isBlocking still covers court and direct order only; delta-based
blocking is W4 (#399).

Refs #397"
```

---

## Task 3: The organisation zone reaches the pack builder

**Files:**
- Modify: `apps/web/src/server/usecases/schedule.ts:74-80` (`ScheduleSettingsOut`),
  `:136-160` (`loadSettings`)
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts`

**Interfaces:**
- Produces: `ScheduleSettingsOut.orgTz: string` — the organisation timezone,
  `isValidIana`-validated, falling back to the same default as `resolveVenueTz`.
  `ScheduleSettingsOut.tz` is unchanged and keeps winning for display.

The query at `:147` already selects `o.timezone as org_tz`. This is one derived
field, no new round trip, and no existing caller changes behaviour.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/server/usecases/__tests__/schedule.test.ts`, following the
file's existing tenant/seed helpers (read them first — do not invent a harness):

```ts
describe("loadSettings resolves the organisation zone separately (#397)", () => {
  it("returns the org zone in orgTz even when the division overrides tz", async () => {
    // W2's locked decision: ONE org timezone governs all temporal math, while a
    // division that already holds its own tz keeps winning for DISPLAY. Both
    // answers have to be available or the pack cannot honour the rule.
    const { auth, divisionId } = await seedDivisionWithOrgTz("Europe/London");
    await setDivisionScheduleTz(divisionId, "Europe/Madrid");

    const settings = await getScheduleSettings(auth, divisionId);
    expect(settings.tz).toBe("Europe/Madrid"); // display lane, unchanged
    expect(settings.orgTz).toBe("Europe/London"); // governing lane, new
  });

  it("falls back to UTC when the organisation has no timezone", async () => {
    const { auth, divisionId } = await seedDivisionWithOrgTz(null);
    const settings = await getScheduleSettings(auth, divisionId);
    expect(settings.orgTz).toBe("UTC");
  });

  it("falls back to UTC when the organisation timezone is not a valid IANA id", async () => {
    const { auth, divisionId } = await seedDivisionWithOrgTz("Pacific/Atlantis");
    const settings = await getScheduleSettings(auth, divisionId);
    expect(settings.orgTz).toBe("UTC");
  });
});
```

If `seedDivisionWithOrgTz` / `setDivisionScheduleTz` do not already exist in that
file, write them there from the file's existing seeding style. Confirm the
`resolveVenueTz` fallback constant is actually `"UTC"` by reading
`apps/web/src/lib/tz.ts:44-51` — if `DEFAULT_TZ` is something else, use that value
in the assertions instead and note it in the commit body.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts`
Expected: FAIL — `Property 'orgTz' does not exist on type 'ScheduleSettingsOut'`.
An unprovisioned `DB_SCHEMA` under-reports; if the suite reports 0 tests, fix the
schema before believing anything.

- [ ] **Step 3: Implement**

In `apps/web/src/server/usecases/schedule.ts`, add to `ScheduleSettingsOut`
(`:74-80`), directly under `tz`:

```ts
  /** The ORGANISATION zone, resolved independently of the division's own. #397
   *  makes this the one clock all temporal math runs in — day boundaries,
   *  weekday targets, session hours, output offsets — while `tz` above stays
   *  the display lane a division may override. */
  orgTz: string;
```

and in `loadSettings` (`:152-159`), beside the existing `tz:` line:

```ts
    tz: resolveVenueTz(row?.tz, row?.org_tz),
    // Deliberately NOT resolveVenueTz(row?.tz, ...) — the division override must
    // not leak into the governing clock, or two divisions of one competition
    // would disagree about which day a fixture is on.
    orgTz: resolveVenueTz(null, row?.org_tz),
```

Confirm `resolveVenueTz` accepts `null` for its first argument; if its signature
is `(divisionTz: string | null | undefined, orgTz: string | null | undefined)`
this is a no-op, otherwise pass `undefined`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule.test.ts --reporter=json --outputFile=/tmp/w2-settings.json`
Expected: `numFailedTests: 0`, and 3 more tests than before.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/schedule.ts apps/web/src/server/usecases/__tests__/schedule.test.ts
git commit -m "feat(schedule): expose the organisation zone alongside the venue zone

W2 makes ONE organisation timezone govern every temporal decision, so the pack
builder needs the org zone as a fact rather than as whatever survived the
division override. The existing query already joins organizations — this is a
second derived field, not a second round trip, and tz keeps its display meaning
untouched.

Refs #397"
```

---

## Task 4: The single-division pack grows a calendar anchor

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts` —
  `:263-267` (`PackAssignment` → a nullable draft twin), `:269-289` (`SchedulePack`),
  `:312-325` (`toModelPayload`), `:327-355` (`BuildPackOptions`),
  `:422-426` + body (`buildSchedulePack`), `:732` (`toSlotConfig(settings, 0)`),
  `:737-758` (draft branches), `:777` (`current.at`), `:785-805` (obstacles),
  `:1232-1270` (`verifyConfig`), `:1948` (runner injection point)
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts`
- Snapshot: `apps/web/src/server/usecases/__tests__/__snapshots__/schedule-ai-pack.test.ts.snap`

**Interfaces:**
- Consumes: `makeClock`, `zonedTimeToUtc`, `dayKeyInTz`, `ymdAddDays`,
  `isEpochSentinel` from `@seazn/engine/scheduling` (Task 1);
  `ScheduleSettingsOut.orgTz` (Task 3); `window` on the verifier config (Task 2).
- Produces:
  ```ts
  export interface PackDraftAssignment {
    fixture_id: string;
    scheduled_at: string | null;   // null = unplaced; never an epoch sentinel
    court_label: string;
  }
  export interface SchedulePack {
    // … existing fields, unchanged …
    /** The ORGANISATION zone. Governs every temporal decision in this pack.
     *  `division.tz` is display metadata and no longer drives anything. */
    tz: string;
    clock: Clock;                                  // from @seazn/engine/scheduling
    window: { start: string; end: string };        // zoned ISO in `tz`, end inclusive
    sessionHours: { start: string; end: string };  // "HH:MM" in `tz`
    draft: PackDraftAssignment[];                  // was PackAssignment[]
  }
  export interface BuildPackOptions {
    // … existing fields …
    /** Epoch ms. REQUIRED and always injected — the pack builder must never
     *  read the clock or the golden pack tests stop being reproducible. */
    now: number;
  }
  export const DEFAULT_WINDOW_DAYS = 7;
  export const DEFAULT_SESSION_HOURS = { start: "08:00", end: "22:00" };
  ```
  `PackAssignment` itself is **not** widened — `prior.assignments` keeps
  `scheduled_at: string`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts`, on top
of that file's real harness — `seedOrg("pro")`, `seedRrBoard()`,
`setSettings(divisionId)`, `redact()`. `NOW` below must be a frozen constant,
never `Date.now()`.

**First, one harness change that keeps the golden diff readable.** `seedRrBoard`
sets `schedule_settings.tz = 'Europe/London'` but never sets
`organizations.timezone`, so today's org zone resolves to `UTC`. Left alone, this
wave would re-render every timestamp in the golden snapshot from `+01:00` to
`+00:00` and bury the four added keys in offset churn. Set the org zone to match,
so the snapshot diff is exactly the four new keys:

```ts
// The pack's ONE clock is the ORGANISATION zone (#397). This board has always
// been a London board — it just said so on the division row. Saying it on the
// org row too keeps the golden pack's offsets where they were, so the W2
// snapshot diff is the four added keys and nothing else.
await sql`update organizations set timezone = ${TZ} where id = ${auth.orgId}`;
```

inside `seedRrBoard`, right after `seedOrg("pro")`. The divergent-zone case gets
its own dedicated test below rather than being smeared across the golden pack.

Helpers the new tests need and the file does not have yet — write them beside
`setSettings`, in the same style:

```ts
/** Override the org and/or division zone for one board. */
async function setZones(
  auth: AuthCtx,
  divisionId: string,
  zones: { org?: string | null; division?: string | null },
): Promise<void> {
  if ("org" in zones) {
    await sql`update organizations set timezone = ${zones.org} where id = ${auth.orgId}`;
  }
  if ("division" in zones) {
    await sql`update schedule_settings set tz = ${zones.division} where division_id = ${divisionId}`;
  }
}

/** Replace the settings config wholesale — used to drop startAt/endAt. */
async function setConfig(divisionId: string, config: Record<string, unknown>): Promise<void> {
  await sql`
    update schedule_settings set config = ${sql.json(config)} where division_id = ${divisionId}`;
}

/** The division's fixtures in board order, so a test can name one. */
async function fixtureIds(divisionId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from fixtures where division_id = ${divisionId}
    order by round_no, seq_in_round`;
  return rows.map((r) => r.id);
}
```

```ts
// --- W2 (#397): the calendar anchor ---------------------------------------
// A frozen instant: 2026-08-06T23:30Z is already Friday 2026-08-07 in London,
// which is the whole point — the pack's "today" is a fact about the ORG zone,
// not about UTC.
const NOW = Date.parse("2026-08-06T23:30:00Z");

const OPTS = { mode: "generate" as const, instruction: "", now: NOW };

// A settings config with no startAt and no endAt — the state that produced the
// 1970 drafts. Everything else stays as SETTINGS_CONFIG so only the anchor moves.
const NO_ANCHOR_CONFIG = (() => {
  const { startAt: _s, ...rest } = SETTINGS_CONFIG as Record<string, unknown>;
  return { ...rest, sessionWindows: [] };
})();

describe("pack calendar anchor (#397)", () => {
  it("carries the ORG zone, a clock, a window and session hours", async () => {
    const { auth, divisionId } = await seedRrBoard();
    await setConfig(divisionId, NO_ANCHOR_CONFIG);
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);

    expect(pack.tz).toBe("Europe/London");
    expect(pack.clock.now).toBe("2026-08-06T23:30:00.000Z");
    // 23:30Z is already Friday the 7th in London — the point of the org clock.
    expect(pack.clock.today).toBe("2026-08-07");
    expect(pack.clock.tomorrow).toBe("2026-08-08");
    expect(pack.clock.nextWeekday.FRI).toBe("2026-08-14"); // never today
    expect(pack.sessionHours).toEqual({ start: "08:00", end: "22:00" });
    // No configured startAt/endAt: today plus the default 7-day horizon, in the
    // org zone — 00:00 BST is 23:00Z the day before.
    expect(pack.window.start).toBe("2026-08-07T00:00:00+01:00");
    expect(pack.window.end).toBe("2026-08-13T23:59:59+01:00");
  });

  it("keeps the division zone as display metadata and renders in the org zone", async () => {
    // The accepted cost of the one-clock decision (design §2.1): a Madrid
    // division under a London org is written in London time. division.tz stays
    // in the pack because the console still labels the board with it.
    const { auth, divisionId } = await seedRrBoard();
    await setZones(auth, divisionId, { division: "Europe/Madrid" });
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);

    expect(pack.division.tz).toBe("Europe/Madrid");
    expect(pack.tz).toBe("Europe/London");
    for (const d of pack.draft) expect(d.scheduled_at).toMatch(/\+01:00$/);
    for (const f of pack.fixtures.movable) {
      if (f.current.at !== null) expect(f.current.at).toMatch(/\+01:00$/);
    }
  });

  it("no longer emits 1970 draft times for a division with no configured start", async () => {
    // The bug #397 exists to kill: toSlotConfig(settings, 0) anchored the greedy
    // draft at the epoch, so the model was handed 1970-01-01 for every fixture.
    const { auth, divisionId } = await seedRrBoard();
    await setConfig(divisionId, NO_ANCHOR_CONFIG);
    await sql`update fixtures set scheduled_at = null, court_label = null
              where division_id = ${divisionId}`;
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);

    expect(pack.draft.length).toBeGreaterThan(0);
    for (const d of pack.draft) {
      expect(d.scheduled_at).not.toBeNull();
      expect(d.scheduled_at!.slice(0, 3)).not.toBe("197");
      expect(d.scheduled_at!.slice(0, 3)).not.toBe("196");
    }
    // The anchor is the first session hour of the window's first day in the org
    // zone — not midnight, and not the epoch.
    expect(pack.draft[0]!.scheduled_at).toBe("2026-08-07T08:00:00+01:00");
  });

  it("nulls an epoch sentinel already persisted on a fixture", async () => {
    // A repair round over a board written before this fix. A null draft time is
    // an honest 'unplaced'; 1970-01-01 is a lie the model anchors on.
    const { auth, divisionId } = await seedRrBoard();
    const ids = await fixtureIds(divisionId);
    await sql`update fixtures set scheduled_at = ${new Date(0).toISOString()}
              where id = ${ids[0]!}`;

    const { pack } = await buildSchedulePack(auth, divisionId, {
      ...OPTS,
      mode: "repair",
    });

    const row = pack.draft.find((d) => d.fixture_id === ids[0]);
    expect(row === undefined || row.scheduled_at === null).toBe(true);
    const fixture = pack.fixtures.movable.find((f) => f.id === ids[0]);
    expect(fixture!.current.at).toBeNull();
    // …and the sentinel must not have dragged the window back to 1970.
    expect(pack.window.start.slice(0, 4)).toBe("2026");
  });

  it("widens the window to cover a board already scheduled beyond the horizon", async () => {
    // A repair round must not report every card it was asked to keep. Widening
    // is one-directional: the default horizon can only grow.
    const { auth, divisionId } = await seedRrBoard();
    await setConfig(divisionId, NO_ANCHOR_CONFIG);
    const ids = await fixtureIds(divisionId);
    await sql`update fixtures set scheduled_at = '2026-09-20T10:00:00Z'
              where id = ${ids[0]!}`;

    const { pack } = await buildSchedulePack(auth, divisionId, {
      ...OPTS,
      mode: "repair",
    });
    expect(pack.window.start).toBe("2026-08-07T00:00:00+01:00");
    expect(pack.window.end).toBe("2026-09-20T23:59:59+01:00");
  });

  it("is byte-identical for two builds at the same injected instant", async () => {
    // The determinism contract: `now` is a parameter, so the pack does not move
    // between two builds a millisecond apart.
    const { auth, divisionId } = await seedRrBoard();
    const a = await buildSchedulePack(auth, divisionId, OPTS);
    const b = await buildSchedulePack(auth, divisionId, OPTS);
    expect(JSON.stringify(a.pack)).toBe(JSON.stringify(b.pack));
  });

  it("sends the anchor to the model but never the enforcement inputs", async () => {
    const { auth, divisionId } = await seedRrBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);
    const payload = toModelPayload(pack) as Record<string, unknown>;
    expect(payload.tz).toBe("Europe/London");
    expect(payload.clock).toEqual(pack.clock);
    expect(payload.window).toEqual(pack.window);
    expect(payload.sessionHours).toEqual(pack.sessionHours);
    expect("participants" in payload).toBe(false);
    expect("assumptions" in payload).toBe(false);
  });
});
```

The verify-side proof belongs where the AI verify path is already exercised —
`schedule-ai-run.test.ts` if that is where a plan is fed through
`validateAssignments`, otherwise `schedule-ai-pack.test.ts` with `verifyConfig`
exported. Read both before choosing; do not loosen a module's visibility if a
public path already reaches the check.

```ts
describe("verifyConfig carries the pack window (#397)", () => {
  it("reports a model assignment outside the window, without blocking it", async () => {
    const { auth, divisionId } = await seedRrBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);
    const conflicts = validateAssignments(
      [
        {
          fixtureId: pack.fixtures.movable[0]!.id,
          court: pack.settings.courts[0]!,
          startAt: Date.parse("2027-03-01T10:00:00Z"),
          endAt: Date.parse("2027-03-01T10:30:00Z"),
          entrants: [],
          people: [],
        },
      ],
      verifyConfig(pack),
    );
    const windowed = conflicts.filter((c) => c.reason === "window");
    expect(windowed).toHaveLength(1);
    // Warn-only until W4 (#399) makes it delta-blocking.
    expect(windowed.some(isBlocking)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'now'
does not exist in type 'BuildPackOptions'`.

- [ ] **Step 3: Add the constants, the option and the pack fields**

In `apps/web/src/server/usecases/schedule-ai.ts`:

```ts
import {
  dayKeyInTz,
  isEpochSentinel,
  makeClock,
  ymdAddDays,
  zonedTimeToUtc,
  type Clock,
} from "@seazn/engine/scheduling";

/** No configured `endAt`: the window runs a week from its start. Seven is the
 *  programme's unit — design §6 freezes a 7-day badminton golden schedule and a
 *  "read the end as the following week" assumption on top of it. */
export const DEFAULT_WINDOW_DAYS = 7;

/** `ScheduleConfig` has no daily-hours field, so the pack advertises this as the
 *  fallback shape of a day for a division with no explicit `sessionWindows`.
 *  Advisory in W2 — it anchors the draft and tells the model what a normal day
 *  looks like; nothing enforces it until the typed rules land in W3/W4. */
export const DEFAULT_SESSION_HOURS = { start: "08:00", end: "22:00" } as const;
```

Split the draft's assignment type out of `PackAssignment` at `:263-267`:

```ts
export interface PackAssignment {
  fixture_id: string;
  scheduled_at: string;
  court_label: string;
}

/** The draft's own row shape. `scheduled_at` is nullable here and nowhere else:
 *  a fixture whose persisted time is an epoch sentinel reaches the model as
 *  UNPLACED rather than as 1970-01-01, which the model would anchor on. `prior`
 *  keeps `PackAssignment` — a prior proposal is by definition placed. */
export interface PackDraftAssignment {
  fixture_id: string;
  scheduled_at: string | null;
  court_label: string;
}
```

Add to `SchedulePack` (`:269-289`), after `division`:

```ts
  /** The ORGANISATION zone (design §2.1). ONE zone governs every temporal
   *  decision in this pack — day boundaries, weekday targets, session hours and
   *  the offset every timestamp below is written in. `division.tz` above is
   *  display metadata and drives nothing. */
  tz: string;
  /** The calendar anchor, built from an instant the caller injected. Without it
   *  "from tomorrow till Friday" has two readings a week apart and nothing
   *  downstream can tell which one happened. */
  clock: Clock;
  /** The days this competition runs, resolved and never absent. `end` is
   *  inclusive — the last instant a fixture may still be occupying. */
  window: { start: string; end: string };
  /** The daily fallback for a division with no `sessionWindows`, as "HH:MM" in
   *  `tz`. */
  sessionHours: { start: string; end: string };
```

and change `draft: PackAssignment[]` to `draft: PackDraftAssignment[]`.

Add to `BuildPackOptions` (`:327-355`):

```ts
  /** The instant this run is happening, epoch ms. REQUIRED and always injected:
   *  the pack builder reads no clock, so two builds at the same `now` are
   *  byte-identical and the golden pack tests stay reproducible. The only
   *  `Date.now()` in this file is at the runner entry. */
  now: number;
```

Extend `toModelPayload` (`:312-325`) — field-by-field, as its comment demands:

```ts
export function toModelPayload(pack: SchedulePack): Omit<SchedulePack, "participants" | "assumptions"> {
  return {
    mode: pack.mode,
    division: pack.division,
    // #397: the calendar anchor IS prompt material — it is the wave that moves
    // the prompt boundary. Enforcement inputs (participants, assumptions) stay
    // server-side.
    tz: pack.tz,
    clock: pack.clock,
    window: pack.window,
    sessionHours: pack.sessionHours,
    settings: pack.settings,
    entrants: pack.entrants,
    people: pack.people,
    fixtures: pack.fixtures,
    draft: pack.draft,
    instruction: pack.instruction,
    prior: pack.prior,
    officials: pack.officials,
  };
}
```

- [ ] **Step 4: Resolve the anchor inside `buildSchedulePack`**

Inside the `withTenant` callback, right after `const tz = settings.tz;` (`:440`):

```ts
    // ONE clock (design §2.1). The division zone stays available for display —
    // it is what `pack.division.tz` carries — but every instant below is
    // rendered in, and every calendar question answered in, the org zone.
    const orgTz = settings.orgTz;
    const clock = makeClock(opts.now, orgTz);
```

Replace every `zonedIso(…, tz)` inside this function with `zonedIso(…, orgTz)`
(`:739`, `:747`, `:755`, `:777`, `:790-791`, `:799-800`, and any other in the
same body — `grep -na "zonedIso" apps/web/src/server/usecases/schedule-ai.ts` and
change the ones inside `buildSchedulePack` only; `officials-ai.ts` and any other
caller are out of scope).

After `packMovable` is built and before the pack is returned, resolve the window:

```ts
    // The window, in the org zone. Every boundary is a wall-clock day boundary
    // converted with zonedTimeToUtc — NOT startMs + 86_400_000, because a DST
    // day is 23 or 25 hours long.
    const dayStart = (ymd: string): number => zonedTimeToUtc(ymd, "00:00", orgTz);
    const dayEnd = (ymd: string): number => zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", orgTz) - 1000;

    const baseStartMs = config.startAt ? new Date(config.startAt).getTime() : dayStart(clock.today);
    const baseEndYmd = config.endAt
      ? dayKeyInTz(new Date(config.endAt).getTime(), orgTz)
      : ymdAddDays(dayKeyInTz(baseStartMs, orgTz), DEFAULT_WINDOW_DAYS - 1);

    // Widen — never narrow — to cover what the organiser has already stated
    // explicitly (sessionWindows) or already scheduled. A repair round that
    // reported every card it was handed would teach the organiser to ignore the
    // reason. Epoch sentinels are excluded, or the window swallows 1970 and the
    // bug this wave exists to kill becomes invisible again.
    const occupied = movable
      .filter((f) => f.scheduled_at !== null)
      .map((f) => new Date(f.scheduled_at as string | Date).getTime())
      .filter((t) => !isEpochSentinel(t));
    const startMs = Math.min(
      baseStartMs,
      ...config.sessionWindows.map((w) => new Date(w.from).getTime()),
      ...occupied,
    );
    const endMs = Math.max(
      dayEnd(baseEndYmd),
      ...config.sessionWindows.map((w) => new Date(w.to).getTime()),
      ...occupied.map((t) => t + matchMinutes * MS_PER_MIN),
    );
    const window = {
      start: zonedIso(dayStart(dayKeyInTz(startMs, orgTz)), orgTz),
      end: zonedIso(dayEnd(dayKeyInTz(endMs, orgTz)), orgTz),
    };
```

`Math.min`/`Math.max` with a spread of an empty array is safe here because
`baseStartMs` / `dayEnd(baseEndYmd)` are always present as the first argument.

- [ ] **Step 5: Anchor the greedy draft on a real instant and kill the sentinels**

Replace `toSlotConfig(settings, 0)` at `:732`:

```ts
        // Was `0` — the epoch. With no configured startAt, `toSlotConfig` used
        // it as the anchor and the model received 1970-01-01 as the draft time
        // for every fixture (#397). The honest fallback is the first session
        // hour of the window's first day, in the org zone.
        config: toSlotConfig(settings, zonedTimeToUtc(dayKeyInTz(startMs, orgTz), DEFAULT_SESSION_HOURS.start, orgTz)),
```

This line needs `startMs`, so move the window resolution from Step 4 to **before**
the draft branches (before `:713`). Keep the comment blocks with it.

Add the sentinel filter to the draft, immediately before `draft.sort(byAssignment)`
at `:759`:

```ts
    // Sentinel kill (#397). A time that predates 1971 is not a fixture time — it
    // is a division that was drafted at the epoch, or a row written before this
    // fix. Null is an honest 'unplaced'; 1970-01-01 is a lie, and the model
    // anchors on it. Zone-independent on purpose: west of UTC the epoch renders
    // as 1969-12-31, so a `startsWith("1970-")` test would miss it.
    draft = draft.map((d) =>
      d.scheduled_at !== null && isEpochSentinel(new Date(d.scheduled_at).getTime())
        ? { ...d, scheduled_at: null }
        : d,
    );
```

and the same treatment for the fixture's own `current.at` at `:777`:

```ts
          at:
            f.scheduled_at !== null && !isEpochSentinel(new Date(f.scheduled_at).getTime())
              ? zonedIso(f.scheduled_at, orgTz)
              : null,
```

- [ ] **Step 6: Return the new fields and give `verifyConfig` the window**

Add `tz: orgTz, clock, window, sessionHours: { ...DEFAULT_SESSION_HOURS }` to the
returned pack object, and extend `verifyConfig` (`:1232-1270`):

```ts
function verifyConfig(
  pack: SchedulePack,
): Pick<SlotConfig, "perEntrantMinRest" | "gapMinutes" | "blackouts" | "sessionWindows"> &
  Partial<Pick<SlotConfig, "matchMinutes" | "constraints" | "window">> {
  return {
    // … unchanged …
    // #397: the resolved window, in the engine's epoch-ms unit. Warn-only —
    // `isBlocking` still covers court and direct order alone, and W4 (#399) is
    // what turns this into a delta-based block.
    window: { from: toMs(pack.window.start), to: toMs(pack.window.end) },
  };
}
```

- [ ] **Step 7: Inject `now` at the runner, and fix every other caller**

At `schedule-ai.ts:1948`:

```ts
  // The one wall-clock read on this path. Everything downstream — the pack
  // builder, the clock, the window — takes the instant as a parameter, so a run
  // is reproducible from its inputs alone (#397).
  const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
    ...input,
    now: Date.now(),
  });
```

Then run `cd apps/web && npx tsc --noEmit` and fix **every** reported call site.
The compiler's error list is the authoritative consumer list — for `now`, and for
the `draft` element type becoming nullable. For each nullable-draft error, decide
deliberately: a consumer that needs a placed time must skip unplaced rows, never
coerce them to `new Date(null)`. Do **not** widen `PackAssignment` to make an
error go away.

In the ~75 test call sites across
`schedule-ai-pack.test.ts`, `schedule-ai-participants-wiring.test.ts`,
`schedule-ai-guarded-existing.test.ts`, `competition-schedule-*.test.ts`, add a
frozen `now` (a module-level `const NOW = Date.parse("2026-08-06T23:30:00Z")`),
never `Date.now()` — a live clock there would make the golden pack snapshot churn
on every run.

- [ ] **Step 8: Run the pack suite and update the golden snapshot once**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts --reporter=json --outputFile=/tmp/w2-pack.json`
Expected: one snapshot failure (the pack gained four fields).

**Read the snapshot diff before accepting it.** It must show exactly: four added
top-level keys (`tz`, `clock`, `window`, `sessionHours`), and — only if the
fixture's division zone differs from its org zone — a changed offset on the
timestamps. Anything else is a bug, not churn. Then:

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-pack.test.ts -u --reporter=json --outputFile=/tmp/w2-pack2.json`
Expected: `numFailedTests: 0`.

Check the token-budget test at `schedule-ai-pack.test.ts:296` is still green — the
four fields are ~200 proxy tokens against the 60,000 ceiling, but confirm rather
than assume.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/usecases/schedule-ai.ts apps/web/src/server/usecases/__tests__/
git commit -m "feat(schedule-ai): give the pack a calendar anchor, in the org zone

The pack carried no clock and no window, so nothing bounded the model's output
dates and a division with no configured startAt was drafted at
toSlotConfig(settings, 0) — the epoch — and handed 1970-01-01 as the draft time
for every fixture. A schedule at 03:00, or one that simply kept those 1970
times, passed every check in force.

Now: tz is the ORGANISATION zone and governs all temporal math (division.tz
becomes display metadata); clock/window/sessionHours are resolved deterministically
from an INJECTED now; the greedy draft anchors on the first session hour of the
window's first day; and any time predating 1971 reaches the model as null —
unplaced — rather than as a date it would anchor on.

The window widens, never narrows, to cover explicit sessionWindows and an
already-scheduled board, so a repair round does not report every card it was
asked to keep.

Golden pack snapshot updated once, deliberately: four added keys.

Refs #397"
```

---

## Task 5: The joint pack, and rewriting J6

**Files:**
- Modify: `apps/web/src/server/usecases/competition-schedule-ai.ts` —
  `:202-230` (`CompetitionPack`), `:251` (`toJointModelPayload`),
  `BuildCompetitionPackOptions`, `:289-294` (`buildCompetitionPack`),
  `:527` (per-division delegation), `:710` (`canonicalTz`),
  `:1057-1059` (`verifyConfigFor`), `:1184-1186` (`verifyJoint`), `:1865` (runner)
- Modify: `apps/web/src/server/usecases/schedule-ai-prompt.ts:168-177` (J6) and the
  ruling comment at `:104-113`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-pack.test.ts`,
  `apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1–4 produce.
- Produces: `CompetitionPack` gains the same `tz` / `clock` / `window` /
  `sessionHours`, with `draft: PackDraftAssignment[]`-shaped rows;
  `BuildCompetitionPackOptions.now: number`;
  `verifyConfigFor(division, window?: { from: number; to: number })`.

- [ ] **Step 1: Write the failing prompt test**

Replace the J6 test at `schedule-ai-prompt.test.ts:302-315` with:

```ts
  it("J6 tells the model there is ONE clock, and names it", () => {
    // Rewritten, not extended (#397, design §2.1). The old J6 told the model
    // each division's times were written in that division's own zone and that
    // it had to compare instants rather than strings. Under one organisation
    // clock that instruction is wrong, and a model acting on it would convert
    // times that need no conversion.
    const j6 = rule("J6.", "J7.");
    expect(j6.length).toBeGreaterThan(0);
    expect(j6).toMatch(/one clock/i);
    expect(j6).toContain("tz");
    expect(j6).toContain("scheduled_at");
    expect(j6).toMatch(/window/i);
    // The claims that are no longer true must be gone, not merely contradicted.
    expect(j6).not.toMatch(/different timezones/i);
    expect(j6).not.toMatch(/first listed division/i);
    expect(j6).not.toMatch(/in its own division's zone/i);
  });

  it("leaves the single-division system prompt byte-frozen", () => {
    // The locked decision: J6 is the ONE non-additive prompt change in this
    // wave. SYSTEM_PROMPT stays behind its snapshot.
    expect(SYSTEM_PROMPT).toMatchSnapshot();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-prompt.test.ts`
Expected: FAIL on `/one clock/i` and on the two `not.toMatch` assertions.

- [ ] **Step 3: Rewrite J6**

In `apps/web/src/server/usecases/schedule-ai-prompt.ts`, replace `:168-177`:

```
J6. The pack is in ONE clock. tz is the organisation timezone, and every instant
    in the pack — each division's settings and windows, every obstacle's from/to,
    the scheduled_at of every draft and prior proposal entry, and the window
    bounds — is written in it. A division's own tz is a display label and governs
    nothing: two equal-looking wall clock times are the same moment. Write every
    assignment's scheduled_at in tz as well. clock.today, clock.tomorrow and
    clock.nextWeekday resolve the organiser's relative dates in that same zone,
    and window.start..window.end are the days this competition runs — a fixture
    must start and finish inside them.
```

and update the ruling comment at `:104-113` so it stops describing the old
behaviour:

```ts
//   CONVENTION                 J6's write-in-tz clause. `AiAssignment` accepts
//                              any UTC offset and everything downstream parses
//                              to instants, so it is unenforceable; the rest of
//                              J6 is a READING instruction about the pack.
//
// J5 and J6 exist because of properties of the joint pack the model cannot infer
// from the pack itself:
//   J5 — the draft is built division by division, so it is biased toward whichever
//        division was built first (ruling R4) and may be partial (ruling R5).
//   J6 — #397 replaced the per-division clocks with ONE organisation clock
//        (design §2.1), superseding ruling R8. Every instant in the pack, and the
//        window bounds, are written in `tz`; a division's own tz is display
//        metadata. The model cannot tell that from the pack, which still carries
//        a per-division tz field for the console's benefit.
```

- [ ] **Step 4: Run the prompt suite and update the JOINT_RULES snapshot only**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/schedule-ai-prompt.test.ts`
Expected: the `JOINT_RULES` "is frozen" snapshot fails; the `SYSTEM_PROMPT` one
does **not**. If `SYSTEM_PROMPT`'s snapshot moved, revert — something edited the
wrong template literal.

Run with `-u`, then read the snapshot diff and confirm only the J6 paragraph moved.

- [ ] **Step 5: Write the failing joint-pack tests**

Append to `competition-schedule-pack.test.ts`. That file already has
`seedCompetition(...)` (`:111`), `seedBigDivision(...)` (`:182`),
`settingsConfig(...)` (`:41`), `redact()` (`:65`), `TZ = "Europe/London"` and a
`BOARD: DivSpec[]` fixture — **read its real signatures first** and adapt the
calls below rather than replacing the harness. The zone overrides go in with the
same `update organizations set timezone` / `update schedule_settings set tz`
statements Task 4 introduced. As in Task 4, set the org zone to `TZ` in the shared
seeder so the joint golden diff is the four added keys and not offset churn.

```ts
const NOW = Date.parse("2026-08-06T23:30:00Z");

describe("joint pack calendar anchor (#397)", () => {
  it("resolves ONE clock and ONE window across divisions in different zones", async () => {
    // Payload B shape: two divisions of one competition. Under the one-clock
    // decision the org zone wins for both, whatever each division's own tz says.
    const { auth, competitionId, divisionIds } = await seedCompetition({
      orgTz: "Europe/London",
      divisionTzs: ["Europe/Madrid", "America/New_York"],
    });
    const { pack } = await buildCompetitionPack(auth, competitionId, divisionIds, {
      mode: "generate",
      instruction: "",
      now: NOW,
    });

    expect(pack.tz).toBe("Europe/London");
    expect(pack.clock.today).toBe("2026-08-07");
    expect(pack.window.start).toBe("2026-08-07T00:00:00+01:00");
    expect(pack.sessionHours).toEqual({ start: "08:00", end: "22:00" });
    // Divisions keep their own tz as a display label…
    expect(pack.divisions.map((d) => d.tz)).toEqual(["Europe/Madrid", "America/New_York"]);
    // …and every instant in the pack is nonetheless written in the org zone.
    for (const d of pack.draft) {
      if (d.scheduled_at !== null) expect(d.scheduled_at).toMatch(/\+01:00$/);
    }
    for (const o of pack.fixtures.obstacles) expect(o.from).toMatch(/\+01:00$/);
  });

  it("renders foreign obstacles in the org zone, not the first division's", async () => {
    // canonicalTz = divisions[0].tz was the old rule (ruling R8) and it made the
    // pack's zone depend on sort order.
    const { auth, competitionId, divisionIds } = await seedCompetition({
      orgTz: "UTC",
      divisionTzs: ["Asia/Kolkata", "Europe/London"],
      withOutsideObstacle: true,
    });
    const { pack } = await buildCompetitionPack(auth, competitionId, divisionIds, {
      mode: "generate",
      instruction: "",
      now: NOW,
    });
    for (const o of pack.fixtures.obstacles) expect(o.from).toMatch(/\+00:00$/);
  });

  it("verifies each division against the SHARED window", async () => {
    const { auth, competitionId, divisionIds } = await seedCompetition({
      orgTz: "Europe/London",
      divisionTzs: ["Europe/London", "Europe/London"],
    });
    const { pack } = await buildCompetitionPack(auth, competitionId, divisionIds, {
      mode: "generate",
      instruction: "",
      now: NOW,
    });
    const conflicts = verifyJointForTest(pack, [
      { fixture_id: pack.fixtures.movable[0]!.id,
        scheduled_at: "2027-03-01T10:00:00+00:00",
        court_label: pack.courts[0]! },
    ]);
    expect(conflicts.filter((c) => c.reason === "window")).toHaveLength(1);
  });

  it("is byte-identical for two builds at the same injected instant", async () => {
    const { auth, competitionId, divisionIds } = await seedCompetition({
      orgTz: "Europe/London",
      divisionTzs: ["Europe/London", "Europe/London"],
    });
    const opts = { mode: "generate" as const, instruction: "", now: NOW };
    const a = await buildCompetitionPack(auth, competitionId, divisionIds, opts);
    const b = await buildCompetitionPack(auth, competitionId, divisionIds, opts);
    expect(JSON.stringify(a.pack)).toBe(JSON.stringify(b.pack));
  });
});
```

- [ ] **Step 6: Run to verify failure, then implement the joint side**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/competition-schedule-pack.test.ts`
Expected: FAIL — `now` is not in `BuildCompetitionPackOptions`.

Implement:

1. `BuildCompetitionPackOptions` gains `now: number`, with the same comment as
   `BuildPackOptions.now`.
2. `buildCompetitionPack` loads the org zone once — the competition has one org,
   so read it from the first division's `loadSettings(...).orgTz` (or the same
   `organizations.timezone` join, if the joint builder already has one) and build
   `clock = makeClock(opts.now, orgTz)`.
3. `:527` forwards `now: opts.now` into the per-division `buildSchedulePack` call.
4. `:710` — replace `const canonicalTz = divisions[0]!.tz;` with:
   ```ts
   // #397: ONE organisation clock (design §2.1). The old rule — canonicalTz =
   // divisions[0].tz — made the pack's zone depend on how the divisions happened
   // to sort, so adding a division could re-render every foreign obstacle.
   const canonicalTz = orgTz;
   ```
5. The joint window is the union of the per-division windows: `start` = the
   earliest, `end` = the latest, both already day-aligned in the org zone by
   Task 4's rule. Take them from the sub-packs rather than recomputing, so the
   two builders cannot drift.
6. `verifyConfigFor(division, window?)` takes the pack window as an optional
   second parameter and puts it on the returned config; `verifyJoint` passes
   `pack.window` converted to epoch ms. `competition-schedule-apply.ts:494` keeps
   calling it with one argument — apply-time blocking is W4 (#399), and passing a
   window there now would turn a pre-existing board into a wall of warnings.
7. `toJointModelPayload` gains `tz`, `clock`, `window`, `sessionHours`,
   field-by-field.
8. `:1865` injects `now: Date.now()` at the runner, with the same comment.

- [ ] **Step 7: Run the joint suites**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/competition-schedule-pack.test.ts src/server/usecases/__tests__/competition-schedule-verify.test.ts src/server/usecases/__tests__/competition-schedule-apply.test.ts --reporter=json --outputFile=/tmp/w2-joint.json`
Expected: `numFailedTests: 0`. Read the determinism test at
`competition-schedule-pack.test.ts:680` explicitly — it is the one that catches a
clock leak.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/usecases/competition-schedule-ai.ts apps/web/src/server/usecases/schedule-ai-prompt.ts apps/web/src/server/usecases/__tests__/
git commit -m "feat(competition-schedule-ai): one organisation clock for the joint pack

canonicalTz = divisions[0].tz made the pack's zone depend on how the divisions
happened to sort, and J6 told the model each division's times were written in
that division's own zone. Under the one-clock decision (design §2.1) both are
wrong: the organisation zone governs every temporal decision and a division's tz
is a display label.

J6 is REWRITTEN rather than extended — the one non-additive prompt change in this
wave. SYSTEM_PROMPT stays byte-frozen behind its snapshot.

The joint window is the union of the per-division windows, taken from the
sub-packs so the two builders cannot drift, and verifyConfigFor carries it.
competition-schedule-apply.ts deliberately does not pass one: apply-time blocking
is W4 (#399), and a window there today would turn every pre-existing board into a
wall of warnings.

Refs #397"
```

---

## Task 6: Surface the reason — wire enum, labels, four locales

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:748-758` (`ScheduleConflict.code`)
- Modify: `apps/web/src/components/v2/board/types.ts:66-83`
  (`CONFLICT_LABEL`, `CONFLICT_HELP`)
- Modify: `apps/web/src/dictionaries/{en,nl,fr,es}/ui.json`
- Test: the board/AI-console test that already covers `CONFLICT_LABEL` (find it
  with `grep -rna "CONFLICT_LABEL" apps/web/src`), plus `npm run i18n:check`

A `window` conflict reaches the organiser through `ai-diff-panel.tsx:63-67` and
`conflicts-panel.tsx:117-125`, both of which look the reason up in
`CONFLICT_LABEL`. Without an entry it renders the raw code.

**Found, not fixed:** `"conflict.start_window"` is already a valid wire code
(`schemas.ts:752`) with no entry in `CONFLICT_LABEL`, `CONFLICT_HELP` or any of
the four dictionaries — it renders raw today. That is a pre-existing bug outside
#397's scope; note it in the PR body and file it, do not fix it here.

- [ ] **Step 1: Write the failing test**

```ts
it("labels a window conflict rather than rendering its raw code (#397)", () => {
  expect(CONFLICT_LABEL["warn.window"]).toBeDefined();
  expect(CONFLICT_HELP["warn.window"]).toBeDefined();
});
```

and a parity assertion in whichever suite already asserts dictionary parity — or
rely on `npm run i18n:check`, which is the repo's gate.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run <that test file>`
Expected: FAIL — `undefined`.

- [ ] **Step 3: Add the code, the labels and the four locales**

1. `schemas.ts:748-758` — add `"warn.window"` to the `z.enum([...])`, keeping the
   file's existing `warn.` / `conflict.` prefix convention. Confirm which prefix
   a warn-level reason uses by reading the neighbouring entries; `window` is a
   warning this wave.
2. `types.ts` — add to both maps, following the existing key style:
   ```ts
   "warn.window": "board.conflict.warn.window",
   // and in CONFLICT_HELP
   "warn.window": "board.conflictHelp.warn.window",
   ```
3. All four dictionaries get both keys. English:
   ```json
   "board.conflict.warn.window": "Outside the competition dates",
   "board.conflictHelp.warn.window": "This match falls outside the days this competition runs. Change the schedule dates in Settings, or move the match inside them."
   ```
   Then `nl`, `fr`, `es` — real translations, never English placeholders. The
   dictionaries are FLAT dotted-key JSON; add the keys at the top level, in the
   same position as their neighbours in each file.

- [ ] **Step 4: Verify**

```bash
npm run i18n:gen-keys
npm run i18n:check
```
Expected: no `[i18n] missing key` line naming `board.conflict.warn.window` or
`board.conflictHelp.warn.window`. Pre-existing stub-dictionary noise is benign.

Run the board test file again — expected PASS.

- [ ] **Step 5: Screenshot-verify the surface at desktop and 375px**

The only user-facing surface this wave touches is the AI console's conflict list.
Bring the app up against the local dev DB, drive it with Playwright MCP to a
division whose AI plan produces a window warning, and capture:

- desktop (1440×900)
- 375px wide — **no horizontal page scroll**

Follow `superpowers:frontend-design` for anything that needs visual judgement.
`/admin` is not involved here, so the full polish bar applies. Attach both shots
to the PR.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/api-v1/schemas.ts apps/web/src/components/v2/board/types.ts apps/web/src/dictionaries
git commit -m "feat(board): label the new window conflict in all four locales

A window warning reaches the organiser through the AI diff panel and the
conflicts panel, both of which look the reason up in CONFLICT_LABEL. Without an
entry it renders the raw code.

Refs #397"
```

---

## Task 7: Closing pass and full verification

**Files:**
- Modify: `content/help/**` (the scheduling articles — English tree only)
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Help pages**

`grep -rna "timezone\|schedule" content/help --include=*.md` and update the
scheduling article(s) to state, in the organiser's language: the competition runs
on the organisation's timezone; a division's own timezone is a display label; the
schedule's start and end dates define the window the AI plans inside; a match
outside those dates is flagged. Keep the copy-truth checker happy — read
`scripts/**/copy-truth.ts` if the article carries assertions. English only:
`content/help/**` owes no i18n work.

- [ ] **Step 2: Extend the smoke script**

In `scripts/smoke.ts`, on the existing pro path, assert the built pack's anchor is
real:

```ts
// #397: a division with no configured startAt used to be drafted at the epoch.
assert(pack.tz.length > 0, "pack carries an org timezone");
assert(!pack.window.start.startsWith("197"), "pack window is not anchored at the epoch");
for (const d of pack.draft) {
  assert(d.scheduled_at === null || !d.scheduled_at.startsWith("197"), "no 1970 draft times");
}
```

Match the file's existing assertion helper rather than importing a new one.

Run: `npm run test:smoke`
Expected: pass on both the pro and free paths.

- [ ] **Step 3: The full gate — run it yourself, read the raw numbers**

```bash
npm run typecheck
cd apps/web && npx eslint . --format stylish 2>&1 | tail -20   # NOT via rtk
cd packages/engine && npx vitest run --reporter=json --outputFile=/tmp/w2-engine-all.json
cd apps/web && npx vitest run --reporter=json --outputFile=/tmp/w2-web-all.json
npm run i18n:check
npm run test:smoke
```

Record `numPassedTests` / `numTotalTests` / `numFailedTests` from **both** JSON
files. Do not claim green from an `rtk` summary — `PASS(0) FAIL(0)` there can mean
a suite failed to collect. Do not pass positional paths to
`npm test --workspace apps/web` — they are filename filters and silently run a
subset.

- [ ] **Step 4: Prove the constraint that is easiest to break by accident**

```bash
grep -rna "Date\.now()" packages/engine/src/scheduling apps/web/src/server/usecases/schedule-ai.ts apps/web/src/server/usecases/competition-schedule-ai.ts
```
Expected: exactly two hits, both at a runner entry (`schedule-ai.ts` ~`:1948`,
`competition-schedule-ai.ts` ~`:1865`). Any hit inside `buildSchedulePack`,
`buildCompetitionPack` or the engine is a failure of this wave's core contract.

```bash
grep -rna "new Date()" packages/engine/src/scheduling apps/web/src/server/usecases/schedule-ai.ts apps/web/src/server/usecases/competition-schedule-ai.ts
```
Expected: no hits.

- [ ] **Step 5: Local e2e against a production build**

Per the standing rule, `e2e.yml` stays disabled — verify locally: production
build, `E2E_PROD_TARGET` on `:3100`, `whsec_e2e_payments` set. Report the raw
pass/fail counts.

- [ ] **Step 6: Code review, then open the PR**

Use `superpowers:requesting-code-review` on the full branch diff. Then push and
open a PR (smoke CI runs on PRs only). PR body: what changed, the four acceptance
criteria with their evidence, the snapshot diffs and why each moved, the two
screenshots, and the `start_window` label gap found-not-fixed.

- [ ] **Step 7: Finish**

Use `superpowers:finishing-a-development-branch`.

---

## Acceptance criteria → task map (#397)

| Criterion | Task | Test |
|---|---|---|
| `zonedTimeToUtc('2026-08-07','10:00','America/New_York')` = 14:00Z; January = 15:00Z | 1 | `tz.test.ts` "resolves a wall clock through a DST change" |
| Midnight does not format as `24:00` | 1 | `tz.test.ts` "round-trips midnight" |
| No 1970 draft times; unplaced fixtures carry `scheduled_at: null` | 4 | `schedule-ai-pack.test.ts` "no longer emits 1970 draft times", "nulls an epoch sentinel" |
| An assignment outside the pack window produces a `window` conflict | 2, 4 | `calendar-window.test.ts`, `verifyConfig carries the pack window` |
| Epoch draft over the badminton payload → 13 window violations | 2 | `calendar-window.test.ts` "REJECTS an epoch draft" |
| `now` in `BuildPackOptions`; no `Date.now()`/bare `new Date()` in engine or pack-builder paths | 4, 5, 7 | Task 7 Step 4 grep |
| Double-seed determinism green; golden pack updated once, reviewed | 4, 5 | `schedule-ai-pack.test.ts:151`, `competition-schedule-pack.test.ts:680` |
| `J6` rewritten; single-division `SYSTEM_PROMPT` snapshot unchanged | 5 | `schedule-ai-prompt.test.ts` "J6 tells the model there is ONE clock", "byte-frozen" |

## Explicitly out of scope

- **Blocking on `window`.** W4 (#399), delta-based. `isBlocking` is unchanged and
  a test asserts it.
- **Any new prompt constant / the five additive sentences.** W3 (design §7.3).
  `SYSTEM_PROMPT` gains nothing, even though the pack now carries fields it does
  not describe — the locked decision keeps it byte-frozen and W3 teaches them.
- **`resolveParsed`, the instruction compiler, symbolic dates, per-day caps.**
  W3 (#398). This wave resolves the *default* window only; there is nothing to
  parse yet.
- **Enforcing `sessionHours`.** Advisory in W2 — it anchors the draft and tells
  the model the shape of a day. The typed-rule verify lands in W3/W4.
- **The missing `conflict.start_window` label.** Pre-existing; reported, not fixed.
- **Feeder rest, per-day caps, cross-division rest as MAX.** W4.
