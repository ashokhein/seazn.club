// assignOfficials (Jul3/02 §3) — pure, deterministic, seeded. Greedy in time
// order with a fairness-first candidate score; hard constraints filter
// candidates (never assigned in violation), locked assignments are validated
// obstacles, soft objectives (fairness, block-stay, travel) order candidates.
import { mulberry32 } from "../core/rng.ts";
import type {
  AssignInput,
  AssignResult,
  FixtureOfficial,
  OfficialConflict,
  OfficialFixture,
  OfficialSpec,
} from "./types.ts";

const MS_PER_MIN = 60_000;

// FNV-1a → 32-bit seed for the per-(official, fixture) deterministic tiebreak.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Busy {
  from: number;
  to: number;
  fixtureId: string;
}

function overlaps(busy: readonly Busy[], from: number, to: number): Busy | undefined {
  return busy.find((b) => b.from < to && from < b.to);
}

// Fairness basis key (Jul3/02 §3, 29 May): whole tournament or per day.
// Days bucket on UTC — times are injected epoch ms, the caller owns zones.
function basisKey(basis: "tournament" | "per_day", startAt: number): string {
  return basis === "tournament" ? "T" : new Date(startAt).toISOString().slice(0, 10);
}

export function assignOfficials(input: AssignInput): AssignResult {
  const { policy, rngSeed } = input;
  const conflicts: OfficialConflict[] = [];
  const byId = new Map<string, OfficialSpec>(input.officials.map((o) => [o.id, o]));
  const fixtureById = new Map<string, OfficialFixture>(input.fixtures.map((f) => [f.id, f]));

  // Deterministic processing order (Jul3/02 §3): time, then court, then id.
  const ordered = [...input.fixtures].sort(
    (a, b) =>
      a.startAt - b.startAt ||
      (a.court ?? "").localeCompare(b.court ?? "") ||
      a.id.localeCompare(b.id),
  );

  // Per-official state. Busy intervals include every fixture the official's
  // entrants PLAY in — reffing while playing is a hard overlap (27 May).
  const busy = new Map<string, Busy[]>();
  const counts = new Map<string, Map<string, number>>(); // official → basis → n
  const lastOnCourt = new Map<string, { court?: string; endAt: number; blockId?: string }>();
  for (const o of input.officials) {
    const playing: Busy[] = [];
    if (o.entrantIds && o.entrantIds.length > 0) {
      const mine = new Set(o.entrantIds);
      for (const f of input.fixtures) {
        if (f.entrants.some((e) => mine.has(e))) {
          playing.push({ from: f.startAt, to: f.endAt, fixtureId: f.id });
        }
      }
    }
    busy.set(o.id, playing);
    counts.set(o.id, new Map());
  }

  const restMs = policy.restMinMinutes * MS_PER_MIN;
  const blockGapMs = policy.blockGapMinutes * MS_PER_MIN;

  // Blocks (29 Jun): contiguous fixtures on a court between two gaps ≥
  // blockGapMinutes. Block-stay optimises within a block only (Jul3/02 §6).
  const blockOf = new Map<string, string>(); // fixtureId → blockId
  {
    const byCourt = new Map<string, OfficialFixture[]>();
    for (const f of ordered) {
      const list = byCourt.get(f.court ?? "") ?? [];
      list.push(f);
      byCourt.set(f.court ?? "", list);
    }
    for (const [court, list] of byCourt) {
      let block = 0;
      let prevEnd: number | null = null;
      for (const f of list) {
        if (prevEnd !== null && f.startAt - prevEnd >= blockGapMs) block++;
        blockOf.set(f.id, `${court}#${block}`);
        prevEnd = Math.max(prevEnd ?? f.endAt, f.endAt);
      }
    }
  }

  // Track both bases: "T" (tournament) for fairness, the day for maxPerDay.
  function bump(officialId: string, startAt: number): void {
    const m = counts.get(officialId)!;
    for (const key of ["T", basisKey("per_day", startAt)]) {
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }

  // ---- validate + install locked assignments as obstacles ------------------
  const lockedByFixtureRole = new Map<string, FixtureOfficial[]>();
  const assignments: FixtureOfficial[] = [];
  const lockedSorted = [...input.locked].sort(
    (a, b) =>
      (fixtureById.get(a.fixtureId)?.startAt ?? 0) - (fixtureById.get(b.fixtureId)?.startAt ?? 0) ||
      a.fixtureId.localeCompare(b.fixtureId) ||
      a.roleKey.localeCompare(b.roleKey) ||
      a.officialId.localeCompare(b.officialId),
  );
  for (const lock of lockedSorted) {
    const fixture = fixtureById.get(lock.fixtureId);
    const official = byId.get(lock.officialId);
    assignments.push({ ...lock, locked: true });
    if (!fixture || !official) continue;
    const b = busy.get(official.id)!;
    const hit = overlaps(b, fixture.startAt - restMs, fixture.endAt + restMs);
    if (hit && hit.fixtureId !== fixture.id) {
      conflicts.push({
        kind: "official_overlap",
        severity: "block",
        fixtureId: fixture.id,
        officialId: official.id,
        roleKey: lock.roleKey,
        detail: `locked assignment overlaps fixture ${hit.fixtureId}`,
      });
    }
    if (official.entrantIds?.some((e) => fixture.entrants.includes(e))) {
      conflicts.push({
        kind: "team_ref_self",
        severity: "block",
        fixtureId: fixture.id,
        officialId: official.id,
        roleKey: lock.roleKey,
      });
    }
    if (
      policy.poolLock &&
      official.homePoolId !== undefined &&
      fixture.poolId !== undefined &&
      official.homePoolId !== fixture.poolId
    ) {
      conflicts.push({
        kind: "pool_leak",
        severity: "warn",
        fixtureId: fixture.id,
        officialId: official.id,
        roleKey: lock.roleKey,
      });
    }
    if (!b.some((x) => x.fixtureId === fixture.id)) {
      b.push({ from: fixture.startAt, to: fixture.endAt, fixtureId: fixture.id });
    }
    bump(official.id, fixture.startAt);
    const last = lastOnCourt.get(official.id);
    if (!last || fixture.endAt > last.endAt) {
      lastOnCourt.set(official.id, {
        court: fixture.court,
        endAt: fixture.endAt,
        blockId: blockOf.get(fixture.id),
      });
    }
  }
  for (const lock of input.locked) {
    const key = `${lock.fixtureId} ${lock.roleKey}`;
    const list = lockedByFixtureRole.get(key) ?? [];
    list.push(lock);
    lockedByFixtureRole.set(key, list);
  }

  // ---- greedy assignment ----------------------------------------------------
  for (const fixture of ordered) {
    for (const roleKey of policy.roles) {
      if (lockedByFixtureRole.has(`${fixture.id} ${roleKey}`)) continue;

      let best: { official: OfficialSpec; score: [number, number, number, number] } | null = null;
      for (const official of input.officials) {
        if (!official.roleKeys.includes(roleKey)) continue;
        // hard: team-ref never officiates its own fixture (27 May)
        if (official.entrantIds?.some((e) => fixture.entrants.includes(e))) continue;
        // hard: poolLock (20 Jun)
        if (
          policy.poolLock &&
          official.homePoolId !== undefined &&
          fixture.poolId !== undefined &&
          official.homePoolId !== fixture.poolId
        ) {
          continue;
        }
        // hard: no overlap (incl. playing) + rest widening
        if (overlaps(busy.get(official.id)!, fixture.startAt - restMs, fixture.endAt + restMs)) {
          continue;
        }
        // hard: max assignments per day (29 May) — always day-based,
        // independent of the fairness distribution basis
        if (official.maxPerDay !== undefined) {
          const dayKey = basisKey("per_day", fixture.startAt);
          const dayCount = counts.get(official.id)!.get(dayKey) ?? 0;
          if (dayCount >= official.maxPerDay) continue;
        }

        // soft score, minimised lexicographically:
        // [fairness count, block-stay miss, travel penalty, seeded tiebreak]
        const count =
          counts.get(official.id)!.get(basisKey(policy.fairness, fixture.startAt)) ?? 0;
        const last = lastOnCourt.get(official.id);
        // stay = the official's previous assignment sits in the SAME
        // court-block as this fixture (29 Jun "before break", not across it)
        const blockMiss = policy.blockStay
          ? last?.blockId !== undefined && last.blockId === blockOf.get(fixture.id)
            ? 0
            : 1
          : 0;
        const travel =
          policy.teamRefKeepDivision &&
          official.homeDivisionId !== undefined &&
          fixture.divisionId !== undefined &&
          official.homeDivisionId !== fixture.divisionId
            ? 1
            : 0;
        const tiebreak = mulberry32(fnv1a(`${rngSeed}|${official.id}|${fixture.id}`))();
        const score: [number, number, number, number] = [count, blockMiss, travel, tiebreak];
        if (
          best === null ||
          score[0] < best.score[0] ||
          (score[0] === best.score[0] &&
            (score[1] < best.score[1] ||
              (score[1] === best.score[1] &&
                (score[2] < best.score[2] ||
                  (score[2] === best.score[2] && score[3] < best.score[3])))))
        ) {
          best = { official, score };
        }
      }

      if (best === null) {
        conflicts.push({
          kind: "role_unfilled",
          severity: "block",
          fixtureId: fixture.id,
          roleKey,
          detail: "no eligible official — slot left empty (Jul3/02 §6)",
        });
        continue;
      }
      const official = best.official;
      assignments.push({ fixtureId: fixture.id, officialId: official.id, roleKey });
      busy.get(official.id)!.push({
        from: fixture.startAt,
        to: fixture.endAt,
        fixtureId: fixture.id,
      });
      bump(official.id, fixture.startAt);
      if (best.score[2] === 1) {
        conflicts.push({
          kind: "travel",
          severity: "warn",
          fixtureId: fixture.id,
          officialId: official.id,
          roleKey,
          detail: "team-referee assigned outside its division",
        });
      }
      lastOnCourt.set(official.id, {
        court: fixture.court,
        endAt: fixture.endAt,
        blockId: blockOf.get(fixture.id),
      });
    }
  }

  // ---- fairness spread warning (soft objective visibility) ------------------
  // Only the fairness basis's keys count: "T" for tournament, days otherwise.
  const spreadByBasis = new Map<string, number[]>();
  for (const [officialId, m] of counts) {
    void officialId;
    for (const [key, n] of m) {
      if (policy.fairness === "tournament" ? key !== "T" : key === "T") continue;
      const list = spreadByBasis.get(key) ?? [];
      list.push(n);
      spreadByBasis.set(key, list);
    }
  }
  for (const [key, values] of spreadByBasis) {
    if (values.length < input.officials.length) {
      // officials with zero assignments in this basis count as 0
      values.push(...Array(input.officials.length - values.length).fill(0));
    }
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > 1) {
      conflicts.push({
        kind: "fairness",
        severity: "warn",
        detail: `assignment spread ${spread} within basis ${key}`,
      });
    }
  }

  return { assignments, conflicts };
}
