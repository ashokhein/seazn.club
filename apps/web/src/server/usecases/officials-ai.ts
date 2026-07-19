import "server-only";
// v4 AI Schedule Architect — Phase B (officials architect), design/v4/03 §2,§7.
//
// buildOfficialsPack assembles ONE deterministic, JSON-serialisable context pack
// — fixtures (with the dry-run schedule's times), the officials roster with
// role_keys / caps / blackouts / cross-org busy windows, locked assignments, the
// assignment policy, and a deterministic solver draft — that the LLM turns into a
// proposal. refereeOfficialsPlan then VERIFIES that proposal: it runs the pure
// engine pass over (pack.locked + plan.assignments) to catch overlaps the LLM
// created and to spot declared-unfilled slots the solver can actually fill
// (lazy-unfilled), then adds the server-side "ineligible" supplement the engine
// deliberately skips for locked rows (wrong role, maxPerDay, blackout dates,
// busy-elsewhere overlaps, tampered locks).
//
// Determinism is binding (a golden snapshot asserts two builds of an identically
// reseeded board are byte-identical once UUIDs are redacted): every array is
// sorted on stable DOMAIN keys, timestamps are ISO-8601 with the division tz
// offset, and the solver draft is produced through domain-ranked stand-in ids so
// the engine's per-(official, fixture) UUID tiebreak can never leak into it. DB
// reads reuse the officials.ts / schedule.ts loaders — no SQL is re-derived here.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  assignOfficials,
  type AssignPolicy,
  type FixtureOfficial,
  type OfficialConflict,
  type OfficialFixture,
  type OfficialSpec,
} from "@seazn/engine/officials";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { rateLimit } from "@/lib/rate-limit";
import { captureServer, isServerFeatureEnabled } from "@/lib/posthog-server";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AiOfficialsPlanRequest, AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import { AiOfficialsPlan, OFFICIALS_SYSTEM_PROMPT } from "./officials-ai-prompt";
import { anthropicClient, zonedIso } from "./schedule-ai";
import { divisionFixtures, loadSettings } from "./schedule";
import {
  listOfficialBusyElsewhere,
  loadOfficialBlackouts,
  loadOfficialsWithEntrants,
} from "./officials";

const MS_PER_MIN = 60_000;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Pack shape (design/v4/03 §2). JSON-serialisable.
// ---------------------------------------------------------------------------

export interface OfficialsPackFixture {
  id: string;
  /** ISO-8601 with the division tz offset (dry-run schedule time when given). */
  start_at: string;
  court: string | null;
  /** Pool id — the engine's poolLock target. */
  pool: string | null;
  /** Playing entrant ids, ordered by entrant name. */
  entrants: string[];
}

export interface OfficialsPackOfficial {
  id: string;
  name: string;
  role_keys: string[];
  home_pool_id: string | null;
  max_per_day: number | null;
  /** YYYY-MM-DD dates the official marked unavailable. */
  blackout_dates: string[];
  /** ISO instants the official is booked in ANOTHER org (timestamp only). */
  busy_elsewhere: string[];
  /** Entrant ids the official belongs to, ordered by entrant name. */
  entrant_ids: string[];
}

export interface OfficialsPack {
  division: { id: string; name: string; sport: string; tz: string };
  /** Fixed match length — the referee derives each fixture's end from this. */
  match_minutes: number;
  policy: AssignPolicy;
  fixtures: OfficialsPackFixture[];
  officials: OfficialsPackOfficial[];
  /** Pinned assignments the LLM must echo unchanged. */
  locked: FixtureOfficial[];
  /** Deterministic solver draft (echoed locked + proposed fills). */
  draft: FixtureOfficial[];
  instruction: string;
  prior: { instruction: string; assignments: FixtureOfficial[] } | null;
}

export interface BuildOfficialsPackOptions {
  instruction: string;
  policy: AssignPolicy;
  /** Dry-run schedule (Phase A output not yet applied): these times/courts
   *  OVERRIDE each fixture's persisted slot for the officials pass. */
  schedule?: { fixture_id: string; scheduled_at: string; court_label: string }[];
  prior?: { instruction: string; assignments: FixtureOfficial[] };
}

/**
 * Build the deterministic Phase B officials context pack for a division.
 *
 * @throws HttpError 404 (division not found), 422 NO_OFFICIALS (empty roster).
 */
export async function buildOfficialsPack(
  auth: AuthCtx,
  divisionId: string,
  opts: BuildOfficialsPackOptions,
): Promise<OfficialsPack> {
  // Cross-org "booked elsewhere" straddles tenants by design — it runs on the
  // superuser connection, so it is gathered outside the tenant transaction.
  const busyElsewhere = await listOfficialBusyElsewhere(auth);

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ id: string; name: string; sport_key: string }[]>`
      select id, name, sport_key from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");

    const settings = await loadSettings(tx, divisionId);
    const tz = settings.tz;
    const matchMinutes = settings.config.matchMinutes;

    // Officials roster (soft context). An empty roster cannot be planned.
    const officialRows = await loadOfficialsWithEntrants(tx);
    if (officialRows.length === 0) {
      throw new HttpError(422, "NO_OFFICIALS", "NO_OFFICIALS");
    }

    // Effective schedule: the dry-run `schedule` overrides persisted slots.
    const scheduleOverride = new Map(
      (opts.schedule ?? []).map((s) => [s.fixture_id, s] as const),
    );
    const included = divisionFixtures(tx, divisionId).then((rows) =>
      rows
        .map((f) => {
          const ov = scheduleOverride.get(f.id);
          const persisted =
            f.scheduled_at !== null ? new Date(f.scheduled_at as string | Date).toISOString() : null;
          const atIso = ov?.scheduled_at ?? persisted;
          const court = ov?.court_label ?? f.court_label;
          return { f, atIso, court, startMs: atIso !== null ? new Date(atIso).getTime() : NaN };
        })
        // Fixtures still needing officials — must have a time, and not be over.
        .filter((x) => x.atIso !== null && x.f.status !== "decided"),
    );
    const fixtures = await included;
    const includedIds = new Set(fixtures.map((x) => x.f.id));

    // Entrant names power every stable ordering; officials may link entrants
    // outside this division, so backfill those names too.
    const entrantNameById = new Map<string, string>();
    const divEntrants = await tx<{ id: string; display_name: string }[]>`
      select id, display_name from entrants where division_id = ${divisionId}`;
    for (const e of divEntrants) entrantNameById.set(e.id, e.display_name);
    const extraEntrantIds = [...new Set(officialRows.flatMap((o) => o.entrant_ids))].filter(
      (e) => !entrantNameById.has(e),
    );
    if (extraEntrantIds.length > 0) {
      const extra = await tx<{ id: string; display_name: string }[]>`
        select id, display_name from entrants where id in ${tx(extraEntrantIds)}`;
      for (const e of extra) entrantNameById.set(e.id, e.display_name);
    }
    // Entrants expose only their display name as domain data in this pack, so two
    // entrants that share a name are true clones for ordering — the raw-id fallback
    // merely fixes a stable total order, and the determinism contract's UUID
    // redaction makes the two reseeds equivalent regardless of which id sorts first.
    const byEntrantName = (a: string, b: string): number =>
      cmp(entrantNameById.get(a) ?? "", entrantNameById.get(b) ?? "") || cmp(a, b);
    const entrantNameKey = (ids: readonly string[]): string =>
      ids.map((e) => entrantNameById.get(e) ?? e).join("|");

    // Officials are ordered by their DOMAIN identity, never a raw UUID: display
    // name, then role_keys, per-day cap, linked entrant NAMES, and blackout dates.
    // Two officials that tie on ALL of these are true clones — only then may id
    // order (redacted away in the determinism contract) decide, so a reseed with
    // fresh UUIDs yields an equivalent pack. Sharing just a display_name (e.g. two
    // "Sam Whistle" officials, one referee one umpire) no longer leaks id order.
    const sortedKey = (xs: readonly string[]): string => [...xs].sort(cmp).join(",");
    const entrantNamesKey = (ids: readonly string[]): string =>
      sortedKey([...new Set(ids)].map((e) => entrantNameById.get(e) ?? e));
    interface OfficialDomain {
      name: string;
      roleKeys: readonly string[];
      maxPerDay: number | null;
      entrantIds: readonly string[];
      blackouts: readonly string[];
      id: string;
    }
    const byOfficialDomain = (a: OfficialDomain, b: OfficialDomain): number =>
      cmp(a.name, b.name) ||
      cmp(sortedKey(a.roleKeys), sortedKey(b.roleKeys)) ||
      (a.maxPerDay ?? -1) - (b.maxPerDay ?? -1) ||
      cmp(entrantNamesKey(a.entrantIds), entrantNamesKey(b.entrantIds)) ||
      cmp(sortedKey(a.blackouts), sortedKey(b.blackouts)) ||
      cmp(a.id, b.id);

    // Locked assignments on the included fixtures.
    const lockedRows = await tx<{ fixture_id: string; official_id: string; role_key: string }[]>`
      select fo.fixture_id, fo.official_id, fo.role_key
      from fixture_officials fo
      join fixtures f on f.id = fo.fixture_id
      where f.division_id = ${divisionId} and fo.locked`;
    const locked: FixtureOfficial[] = lockedRows
      .filter((r) => includedIds.has(r.fixture_id))
      .map((r) => ({
        fixtureId: r.fixture_id,
        officialId: r.official_id,
        roleKey: r.role_key,
        locked: true,
      }));

    // Engine inputs (real ids) for the solver draft.
    const engineFixtures: OfficialFixture[] = fixtures.map((x) => ({
      id: x.f.id,
      startAt: x.startMs,
      endAt: x.startMs + matchMinutes * MS_PER_MIN,
      ...(x.court !== null ? { court: x.court } : {}),
      ...(x.f.pool_id !== null ? { poolId: x.f.pool_id } : {}),
      divisionId,
      stageId: x.f.stage_id,
      entrants: [x.f.home_entrant_id, x.f.away_entrant_id].filter((e): e is string => e !== null),
    }));
    const engineOfficials: OfficialSpec[] = officialRows.map((o) => ({
      id: o.id,
      roleKeys: o.role_keys,
      ...(o.home_pool_id !== null ? { homePoolId: o.home_pool_id } : {}),
      ...(o.max_per_day !== null ? { maxPerDay: o.max_per_day } : {}),
      ...(o.entrant_ids.length > 0 ? { entrantIds: [...new Set(o.entrant_ids)] } : {}),
      homeDivisionId: divisionId,
    }));

    const startById = new Map(engineFixtures.map((f) => [f.id, f.startAt]));
    const officialNameById = new Map(officialRows.map((o) => [o.id, o.display_name]));

    // Blackout dates per official — loaded before the draft so they can feed the
    // official domain ordering (a tiebreaker for same-name officials).
    const blackoutByOfficial = new Map<string, string[]>();
    for (const r of await loadOfficialBlackouts(tx)) {
      (blackoutByOfficial.get(r.official_id) ?? blackoutByOfficial.set(r.official_id, []).get(r.official_id)!).push(
        r.date,
      );
    }
    // Domain-RANKED stand-in ids (fixtures by start/court/entrant-names, officials
    // by domain identity — no UUID fallback) drive BOTH the solver draft below and
    // the assignment ordering. Computed here, above sortAssignments, so that its
    // final tiebreak keys off these reseed-stable ranks rather than raw UUIDs (a
    // Task-8 review residual: two assignments that tied on start/role/official-name
    // fell back to fixture/official UUID, flipping order across reseeds).
    const rankedFixtures = [...engineFixtures].sort(
      (a, b) =>
        a.startAt - b.startAt ||
        cmp(a.court ?? "", b.court ?? "") ||
        cmp(entrantNameKey(a.entrants), entrantNameKey(b.entrants)),
    );
    const fRank = new Map(rankedFixtures.map((f, i) => [f.id, `f${String(i).padStart(6, "0")}`]));
    const rankedOfficials = [...officialRows].sort((a, b) =>
      byOfficialDomain(
        { name: a.display_name, roleKeys: a.role_keys, maxPerDay: a.max_per_day, entrantIds: a.entrant_ids, blackouts: blackoutByOfficial.get(a.id) ?? [], id: a.id },
        { name: b.display_name, roleKeys: b.role_keys, maxPerDay: b.max_per_day, entrantIds: b.entrant_ids, blackouts: blackoutByOfficial.get(b.id) ?? [], id: b.id },
      ),
    );
    const oRank = new Map(rankedOfficials.map((o, i) => [o.id, `o${String(i).padStart(6, "0")}`]));
    const realFByRank = new Map([...fRank].map(([real, rk]) => [rk, real]));
    const realOByRank = new Map([...oRank].map(([real, rk]) => [rk, real]));

    // Assignment ordering keys off DOMAIN values (fixture start, role, official
    // name) — never a bare UUID. The final tiebreak (needed when two assignments
    // share start/role/official-name, e.g. two same-named officials on two
    // simultaneous fixtures) uses the domain RANKS, so a reseeded board yields the
    // same order; only a genuine clone-vs-clone tie falls through to the raw id.
    const sortAssignments = (list: FixtureOfficial[]): FixtureOfficial[] =>
      [...list].sort(
        (a, b) =>
          (startById.get(a.fixtureId) ?? 0) - (startById.get(b.fixtureId) ?? 0) ||
          cmp(a.roleKey, b.roleKey) ||
          cmp(officialNameById.get(a.officialId) ?? "", officialNameById.get(b.officialId) ?? "") ||
          cmp(fRank.get(a.fixtureId) ?? a.fixtureId, fRank.get(b.fixtureId) ?? b.fixtureId) ||
          cmp(oRank.get(a.officialId) ?? a.officialId, oRank.get(b.officialId) ?? b.officialId),
      );

    // Solver draft (design/v4/03 §2 "a draft assignment from a deterministic
    // solver"). The engine breaks candidate ties on mulberry32(rngSeed | officialId
    // | fixtureId) — both raw UUIDs — so on an identical reseeded board the draft
    // would diverge. Feed the solver the domain-RANKED stand-in ids built above and
    // map its result back to real ids afterwards. The engine stays untouched.
    const solved = assignOfficials({
      fixtures: engineFixtures.map((f) => ({ ...f, id: fRank.get(f.id)! })),
      officials: engineOfficials.map((o) => ({ ...o, id: oRank.get(o.id)! })),
      locked: locked.map((l) => ({
        ...l,
        fixtureId: fRank.get(l.fixtureId) ?? l.fixtureId,
        officialId: oRank.get(l.officialId) ?? l.officialId,
      })),
      policy: opts.policy,
      rngSeed: "officials-draft",
    });
    const draft = sortAssignments(
      solved.assignments.map((a) => ({
        fixtureId: realFByRank.get(a.fixtureId) ?? a.fixtureId,
        officialId: realOByRank.get(a.officialId) ?? a.officialId,
        roleKey: a.roleKey,
        ...(a.locked ? { locked: true } : {}),
      })),
    );

    // ---- pack output, every array sorted on stable domain keys ---------------
    const packFixtures: OfficialsPackFixture[] = fixtures
      .map((x) => ({
        startMs: x.startMs,
        fixture: {
          id: x.f.id,
          start_at: zonedIso(x.startMs, tz),
          court: x.court,
          pool: x.f.pool_id,
          entrants: [x.f.home_entrant_id, x.f.away_entrant_id]
            .filter((e): e is string => e !== null)
            .sort(byEntrantName),
        },
      }))
      .sort(
        (a, b) =>
          a.startMs - b.startMs ||
          cmp(a.fixture.court ?? "", b.fixture.court ?? "") ||
          cmp(entrantNameKey(a.fixture.entrants), entrantNameKey(b.fixture.entrants)) ||
          cmp(a.fixture.id, b.fixture.id),
      )
      .map((x) => x.fixture);

    const busyByOfficial = new Map<string, string[]>();
    for (const r of busyElsewhere) {
      (busyByOfficial.get(r.official_id) ?? busyByOfficial.set(r.official_id, []).get(r.official_id)!).push(
        zonedIso(r.scheduled_at, tz),
      );
    }
    const packOfficials: OfficialsPackOfficial[] = officialRows
      .map((o) => ({
        id: o.id,
        name: o.display_name,
        role_keys: [...o.role_keys],
        home_pool_id: o.home_pool_id,
        max_per_day: o.max_per_day,
        blackout_dates: [...(blackoutByOfficial.get(o.id) ?? [])].sort(cmp),
        busy_elsewhere: [...(busyByOfficial.get(o.id) ?? [])].sort(cmp),
        entrant_ids: [...new Set(o.entrant_ids)].sort(byEntrantName),
      }))
      .sort((a, b) =>
        byOfficialDomain(
          { name: a.name, roleKeys: a.role_keys, maxPerDay: a.max_per_day, entrantIds: a.entrant_ids, blackouts: a.blackout_dates, id: a.id },
          { name: b.name, roleKeys: b.role_keys, maxPerDay: b.max_per_day, entrantIds: b.entrant_ids, blackouts: b.blackout_dates, id: b.id },
        ),
      );

    return {
      division: { id: division.id, name: division.name, sport: division.sport_key, tz },
      match_minutes: matchMinutes,
      policy: opts.policy,
      fixtures: packFixtures,
      officials: packOfficials,
      locked: sortAssignments(locked),
      draft,
      instruction: opts.instruction,
      prior: opts.prior
        ? { instruction: opts.prior.instruction, assignments: sortAssignments(opts.prior.assignments) }
        : null,
    };
  });
}

// ===========================================================================
// Proposal referee (design/v4/03 §7 decision 8). Pure over the pack — no DB, no
// wall clock. The engine is the source of truth for physical conflicts; the
// server supplement covers what the engine deliberately skips for locked rows.
// ===========================================================================

/** The engine's conflict taxonomy plus the web-only "ineligible" verdict the
 *  server verifier raises for a locked/proposed row the engine can't judge
 *  (role eligibility, per-day caps, blackout dates, busy-elsewhere, tampered
 *  locks). The engine itself is untouched. */
export type WebOfficialConflict =
  | OfficialConflict
  | {
      kind: "ineligible";
      severity: "block";
      fixtureId: string;
      officialId: string;
      roleKey: string;
      detail: string;
    };

export interface LazyUnfilled {
  fixture_id: string;
  role_key: string;
  candidate_official_id: string;
}

const SEP = " ";
const slotKey = (fixtureId: string, roleKey: string): string => `${fixtureId}${SEP}${roleKey}`;
const rowKey = (a: { fixtureId: string; roleKey: string; officialId: string }): string =>
  `${a.fixtureId}${SEP}${a.roleKey}${SEP}${a.officialId}`;

/**
 * Verify an LLM officials proposal against a pack.
 *
 * 1. Engine pass over `[...pack.locked, ...plan.assignments]` (deduped): each
 *    proposal row is validated for overlap / team-ref-self / pool-leak, and the
 *    greedy pass fills only slots the plan left uncovered.
 * 2. A declared-unfilled slot the greedy pass CAN fill → `lazyUnfilled` with the
 *    solver's candidate (dropped when that candidate is on a blackout / busy
 *    elsewhere — signals the engine cannot see). A declared-unfilled slot the
 *    pass also cannot fill surfaces as the engine's `role_unfilled` (confirmed).
 * 3. Supplement (`ineligible`, block): wrong role, maxPerDay exceeded (recounted
 *    per official per UTC day over locked+plan), assignment on a blackout date,
 *    assignment overlapping a busy-elsewhere time, and any locked row missing /
 *    altered in the proposal.
 */
export function refereeOfficialsPlan(
  pack: OfficialsPack,
  plan: AiOfficialsPlan,
): { conflicts: WebOfficialConflict[]; lazyUnfilled: LazyUnfilled[] } {
  const matchMs = pack.match_minutes * MS_PER_MIN;
  const fixtureById = new Map(pack.fixtures.map((f) => [f.id, f]));
  const officialById = new Map(pack.officials.map((o) => [o.id, o]));

  const engineFixtures: OfficialFixture[] = pack.fixtures.map((f) => {
    const startAt = new Date(f.start_at).getTime();
    return {
      id: f.id,
      startAt,
      endAt: startAt + matchMs,
      ...(f.court !== null ? { court: f.court } : {}),
      ...(f.pool !== null ? { poolId: f.pool } : {}),
      divisionId: pack.division.id,
      entrants: f.entrants,
    };
  });
  const engineOfficials: OfficialSpec[] = pack.officials.map((o) => ({
    id: o.id,
    roleKeys: o.role_keys,
    ...(o.home_pool_id !== null ? { homePoolId: o.home_pool_id } : {}),
    ...(o.max_per_day !== null ? { maxPerDay: o.max_per_day } : {}),
    ...(o.entrant_ids.length > 0 ? { entrantIds: o.entrant_ids } : {}),
    homeDivisionId: pack.division.id,
  }));

  const planAssignments: FixtureOfficial[] = plan.assignments.map((a) => ({
    fixtureId: a.fixture_id,
    officialId: a.official_id,
    roleKey: a.role_key,
  }));
  // The plan is expected to echo locked rows exactly; dedupe so a valid echo is
  // not validated (or counted) twice. The validated SET is the union.
  const lockedRowKeys = new Set(pack.locked.map(rowKey));
  const proposalOnly = planAssignments.filter((a) => !lockedRowKeys.has(rowKey(a)));
  const engineLocked = [...pack.locked, ...proposalOnly];

  const { assignments: solved, conflicts: engineConflicts } = assignOfficials({
    fixtures: engineFixtures,
    officials: engineOfficials,
    locked: engineLocked,
    policy: pack.policy,
    rngSeed: "referee",
  });

  // Greedy fills = the solver's assignments on slots the plan left uncovered.
  const greedyBySlot = new Map<string, string>();
  for (const a of solved) {
    if (a.locked) continue;
    greedyBySlot.set(slotKey(a.fixtureId, a.roleKey), a.officialId);
  }

  const onBlackout = (o: OfficialsPackOfficial, f: OfficialsPackFixture): boolean =>
    // start_at carries the division offset, so its date is the local calendar day.
    o.blackout_dates.includes(f.start_at.slice(0, 10));
  const busyOverlap = (o: OfficialsPackOfficial, f: OfficialsPackFixture): boolean => {
    const fStart = new Date(f.start_at).getTime();
    const fEnd = fStart + matchMs;
    return o.busy_elsewhere.some((b) => {
      const bStart = new Date(b).getTime();
      return bStart < fEnd && fStart < bStart + matchMs;
    });
  };

  const conflicts: WebOfficialConflict[] = [];
  // Engine findings pass through, EXCEPT ones tied to a greedy (hypothetical)
  // fill of a declared-unfilled slot — those describe a placement the plan never
  // made. Confirmed role_unfilled (slot the greedy also could not fill) survives.
  for (const c of engineConflicts) {
    const slot = c.fixtureId && c.roleKey ? slotKey(c.fixtureId, c.roleKey) : null;
    if (slot !== null && greedyBySlot.has(slot)) continue;
    conflicts.push(c);
  }

  // Lazy-unfilled: a declared-unfilled slot the greedy filled with a candidate
  // that is NOT on a blackout / busy elsewhere (else the fill is spurious).
  const lazyUnfilled: LazyUnfilled[] = [];
  for (const u of plan.unfilled) {
    const candidate = greedyBySlot.get(slotKey(u.fixture_id, u.role_key));
    if (candidate === undefined) continue;
    const o = officialById.get(candidate);
    const f = fixtureById.get(u.fixture_id);
    if (o && f && (onBlackout(o, f) || busyOverlap(o, f))) continue;
    lazyUnfilled.push({
      fixture_id: u.fixture_id,
      role_key: u.role_key,
      candidate_official_id: candidate,
    });
  }

  const ineligible = (
    fixtureId: string,
    officialId: string,
    roleKey: string,
    detail: string,
  ): void => {
    conflicts.push({ kind: "ineligible", severity: "block", fixtureId, officialId, roleKey, detail });
  };

  // ---- server supplement over the union (engine skips these for locked) ------
  for (const a of engineLocked) {
    const o = officialById.get(a.officialId);
    const f = fixtureById.get(a.fixtureId);
    if (!o || !f) continue; // unknown ids are a structural failure (Task 9 gate)
    if (!o.role_keys.includes(a.roleKey)) {
      ineligible(a.fixtureId, a.officialId, a.roleKey, `official does not hold role "${a.roleKey}"`);
    }
    if (onBlackout(o, f)) {
      ineligible(a.fixtureId, a.officialId, a.roleKey, `assignment on ${o.name}'s blackout date`);
    }
    if (busyOverlap(o, f)) {
      ineligible(a.fixtureId, a.officialId, a.roleKey, "assignment overlaps a busy-elsewhere time");
    }
  }

  // maxPerDay recount per official per UTC day (the engine never checks locked).
  const byOfficialDay = new Map<string, FixtureOfficial[]>();
  for (const a of engineLocked) {
    const o = officialById.get(a.officialId);
    const f = fixtureById.get(a.fixtureId);
    if (!o || !f || o.max_per_day === null) continue;
    const day = new Date(f.start_at).toISOString().slice(0, 10); // UTC day
    const k = `${a.officialId}${SEP}${day}`;
    (byOfficialDay.get(k) ?? byOfficialDay.set(k, []).get(k)!).push(a);
  }
  for (const [k, list] of byOfficialDay) {
    const officialId = k.slice(0, k.indexOf(SEP));
    const day = k.slice(k.indexOf(SEP) + 1);
    const cap = officialById.get(officialId)!.max_per_day!;
    if (list.length <= cap) continue;
    const overflow = list
      .sort(
        (a, b) =>
          new Date(fixtureById.get(a.fixtureId)!.start_at).getTime() -
            new Date(fixtureById.get(b.fixtureId)!.start_at).getTime() ||
          cmp(a.roleKey, b.roleKey) ||
          cmp(a.fixtureId, b.fixtureId),
      )
      .slice(cap);
    for (const a of overflow) {
      ineligible(a.fixtureId, a.officialId, a.roleKey, `official exceeds max_per_day ${cap} on ${day}`);
    }
  }

  // Locked-row tamper: every pack.locked row must reappear unchanged.
  const planRowKeys = new Set(planAssignments.map(rowKey));
  for (const l of pack.locked) {
    if (!planRowKeys.has(rowKey(l))) {
      ineligible(l.fixtureId, l.officialId, l.roleKey, "locked assignment changed");
    }
  }

  conflicts.sort(
    (a, b) =>
      cmp(a.kind, b.kind) ||
      cmp(a.fixtureId ?? "", b.fixtureId ?? "") ||
      cmp(a.roleKey ?? "", b.roleKey ?? "") ||
      cmp(a.officialId ?? "", b.officialId ?? "") ||
      cmp(a.detail ?? "", b.detail ?? ""),
  );
  lazyUnfilled.sort((a, b) => cmp(a.fixture_id, b.fixture_id) || cmp(a.role_key, b.role_key));

  return { conflicts, lazyUnfilled };
}

// ===========================================================================
// Phase B runner — the Anthropic structured-output call + referee verify/repair
// loop (design/v4/03 §2, mirrors the Phase A runner in schedule-ai.ts). Pure
// over the pack: no DB, no wall clock. Reuses schedule-ai.ts's anthropicClient
// (503 when unconfigured, SCHEDULING_AI_BASE_URL escape hatch).
// ===========================================================================

const OFFICIALS_ROUND_TIMEOUT_MS = 120_000;
const OFFICIALS_MAX_REPAIR_ROUNDS = 2;

/** A conflict the LLM can plausibly repair by re-choosing officials. `role_unfilled`
 *  is excluded: the greedy solver already proved no eligible official exists, so a
 *  repair round would only burn tokens — it surfaces to the organiser as a coverage
 *  gap instead. Warnings (pool_leak / fairness / travel) never trigger a repair. */
function isRepairBlocking(c: WebOfficialConflict): boolean {
  return c.severity === "block" && c.kind !== "role_unfilled";
}

const planRowKey = (a: { fixture_id: string; role_key: string; official_id: string }): string =>
  `${a.fixture_id}${SEP}${a.role_key}${SEP}${a.official_id}`;

/** Structural gate run before the referee (design/v4/01 §1 hard rule 1/6, ported
 *  to officials): every required (fixture × policy role) slot appears exactly once
 *  across assignments + unfilled, every id is drawn from the pack, every role is a
 *  policy role, and every locked row is echoed unchanged. Returns a human note on
 *  the first violation, or null when well-formed. Binding decision (project
 *  ledger): unknown fixture/official ids must FAIL here — the referee silently
 *  skips them, so a hallucinated id would otherwise vanish instead of failing. */
function officialsStructuralCheck(plan: AiOfficialsPlan, pack: OfficialsPack): string | null {
  const fixtureIds = new Set(pack.fixtures.map((f) => f.id));
  const officialIds = new Set(pack.officials.map((o) => o.id));
  const roles = new Set(pack.policy.roles);
  const seen = new Set<string>();
  for (const a of plan.assignments) {
    if (!fixtureIds.has(a.fixture_id)) return `assignment references a fixture not in the pack: ${a.fixture_id}`;
    if (!officialIds.has(a.official_id)) return `assignment references an official not in the pack: ${a.official_id}`;
    if (!roles.has(a.role_key)) return `assignment uses a role not in policy.roles: ${a.role_key}`;
    const slot = slotKey(a.fixture_id, a.role_key);
    if (seen.has(slot)) return `slot ${slot} appears more than once`;
    seen.add(slot);
  }
  for (const u of plan.unfilled) {
    if (!fixtureIds.has(u.fixture_id)) return `unfilled references a fixture not in the pack: ${u.fixture_id}`;
    if (!roles.has(u.role_key)) return `unfilled uses a role not in policy.roles: ${u.role_key}`;
    const slot = slotKey(u.fixture_id, u.role_key);
    if (seen.has(slot)) return `slot ${slot} appears more than once`;
    seen.add(slot);
  }
  for (const f of pack.fixtures) {
    for (const r of pack.policy.roles) {
      if (!seen.has(slotKey(f.id, r))) return `required slot ${slotKey(f.id, r)} is missing from the plan`;
    }
  }
  // Hard rule 6: every locked row must reappear in assignments exactly.
  const planKeys = new Set(plan.assignments.map(planRowKey));
  for (const l of pack.locked) {
    if (!planKeys.has(rowKey(l))) return `locked assignment for fixture ${l.fixtureId} must be echoed unchanged`;
  }
  return null;
}

/** The deterministic solver draft, expressed as an AiOfficialsPlan — the proposal
 *  returned for an empty instruction (no LLM call). Slots the draft could not fill
 *  are declared unfilled so coverage still surfaces. */
function draftAsPlan(pack: OfficialsPack): AiOfficialsPlan {
  const covered = new Set(pack.draft.map((a) => slotKey(a.fixtureId, a.roleKey)));
  const unfilled: AiOfficialsPlan["unfilled"] = [];
  for (const f of pack.fixtures) {
    for (const r of pack.policy.roles) {
      if (!covered.has(slotKey(f.id, r))) {
        unfilled.push({ fixture_id: f.id, role_key: r, reason: "no eligible official available" });
      }
    }
  }
  return {
    assignments: pack.draft.map((a) => ({ fixture_id: a.fixtureId, official_id: a.officialId, role_key: a.roleKey })),
    unfilled,
    explanations: [],
    summary: "Default duty spread from the deterministic solver (no instruction given).",
  };
}

/** Assignment diff vs the prior proposal (refine mode). Each element is a
 *  `fixtureId:roleKey` slot: `unchanged` kept the same official, `changed` did
 *  not (or is new). With no prior every assignment is `changed`. */
function officialsDiff(pack: OfficialsPack, plan: AiOfficialsPlan): AiOfficialsPlanResponse["diff"] {
  const dslot = (f: string, r: string): string => `${f}:${r}`;
  const priorBySlot = new Map<string, string>();
  if (pack.prior) {
    for (const a of pack.prior.assignments) priorBySlot.set(dslot(a.fixtureId, a.roleKey), a.officialId);
  }
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const a of plan.assignments) {
    const key = dslot(a.fixture_id, a.role_key);
    if (priorBySlot.get(key) === a.official_id) unchanged.push(key);
    else changed.push(key);
  }
  changed.sort(cmp);
  unchanged.sort(cmp);
  return {
    changed,
    unchanged,
    unfilled: plan.unfilled.map((u) => ({ fixture_id: u.fixture_id, role_key: u.role_key, reason: u.reason })),
  };
}

/** Shape a verified plan into the API response: assignments (locked rows flagged),
 *  the referee's conflicts + lazy-unfilled, the prior diff, and usage. */
function finalizeOfficials(
  pack: OfficialsPack,
  plan: AiOfficialsPlan,
  usage: AiOfficialsPlanResponse["usage"],
): AiOfficialsPlanResponse {
  const { conflicts, lazyUnfilled } = refereeOfficialsPlan(pack, plan);
  const lockedKeys = new Set(pack.locked.map(rowKey));
  const assignments = plan.assignments.map((a) => ({
    fixtureId: a.fixture_id,
    officialId: a.official_id,
    roleKey: a.role_key,
    ...(lockedKeys.has(planRowKey(a)) ? { locked: true } : {}),
  }));
  return {
    assignments,
    conflicts,
    diff: officialsDiff(pack, plan),
    lazy_unfilled: lazyUnfilled,
    explanations: plan.explanations,
    summary: plan.summary,
    usage,
  };
}

/** Echo an assistant turn back into the conversation unchanged (thinking blocks
 *  included). Response ContentBlocks are valid input blocks at runtime. */
function officialsAssistantTurn(response: { content?: unknown } | null | undefined): Anthropic.MessageParam {
  return { role: "assistant", content: (response?.content ?? []) as Anthropic.ContentBlockParam[] };
}

async function callOfficialsModel(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFFICIALS_ROUND_TIMEOUT_MS);
  try {
    return await client.messages.parse(
      {
        model,
        max_tokens: 32_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: zodOutputFormat(AiOfficialsPlan) },
        system: [{ type: "text", text: OFFICIALS_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [...messages],
      },
      { signal: controller.signal },
    );
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpError(422, "AI officials assignment timed out; please retry", "AI_PLAN_TIMEOUT");
    }
    // Genuine transport/API failures propagate (→ 5xx). The SDK throws on
    // schema-invalid structured output instead of returning parsed_output: null —
    // fold that into the null-parsed path so the corrective retry runs.
    if (err instanceof HttpError || (Anthropic.APIError && err instanceof Anthropic.APIError)) {
      throw err;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the officials architect over a pre-built pack: call the model, referee the
 * proposal, and repair blocking conflicts up to twice before returning best-so-far.
 * Pure over the pack — never touches the DB.
 *
 * An empty instruction short-circuits: the deterministic solver draft is returned
 * as the proposal with zero LLM calls and all-zero usage (design/v4/03 §2 — the
 * "sensible spread" costs nothing).
 *
 * @throws HttpError 503 (no ANTHROPIC_API_KEY), 422 AI_PLAN_FAILED (model refusal
 *   or an un-correctable structural violation), 422 AI_PLAN_TIMEOUT.
 */
export async function runOfficialsAiPlan(pack: OfficialsPack): Promise<AiOfficialsPlanResponse> {
  if (pack.instruction.trim() === "") {
    return finalizeOfficials(pack, draftAsPlan(pack), { input_tokens: 0, output_tokens: 0, repair_rounds: 0 });
  }

  const client = anthropicClient(); // 503 before any network if unconfigured
  const model = process.env.SCHEDULING_AI_MODEL ?? "claude-opus-4-8";

  const conversation: Anthropic.MessageParam[] = [{ role: "user", content: JSON.stringify(pack) }];
  let inputTokens = 0;
  let outputTokens = 0;
  let repairRounds = 0;
  let correctiveUsed = false; // one non-repair retry for a malformed plan

  // Best-so-far across repair rounds: round 2 can leave MORE blocking conflicts
  // than round 1, so keep the fewest-blocking plan (ties resolve to the later
  // round) rather than blindly the last round.
  let best: { plan: AiOfficialsPlan; blocking: number } | null = null;
  const usageNow = (): AiOfficialsPlanResponse["usage"] => ({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    repair_rounds: repairRounds,
  });

  for (;;) {
    const response = await callOfficialsModel(client, model, conversation);
    inputTokens += response?.usage?.input_tokens ?? 0;
    outputTokens += response?.usage?.output_tokens ?? 0;

    // Refusal: bail before reading content.
    if (response?.stop_reason === "refusal") {
      throw new HttpError(
        422,
        "AI officials assignment could not produce a usable plan; please retry",
        "AI_PLAN_FAILED",
        { usage: usageNow() },
      );
    }

    const plan = response?.parsed_output ?? null;
    const structuralError =
      plan === null ? "the model returned no parseable plan" : officialsStructuralCheck(plan, pack);
    if (structuralError !== null) {
      if (correctiveUsed) {
        throw new HttpError(
          422,
          "AI officials assignment could not produce a usable plan; please retry",
          "AI_PLAN_FAILED",
          { usage: usageNow() },
        );
      }
      correctiveUsed = true;
      conversation.push(officialsAssistantTurn(response));
      conversation.push({
        role: "user",
        content: JSON.stringify({
          structural_error: structuralError,
          note: "Your previous output was rejected before verification. Resend the full plan: every required role slot (each fixture x each role in policy.roles) exactly once across assignments and unfilled, only fixture and official ids from the pack, and echo every locked row unchanged.",
        }),
      });
      continue;
    }

    const { conflicts } = refereeOfficialsPlan(pack, plan!);
    const blocking = conflicts.filter(isRepairBlocking);

    // Keep the fewest-blocking plan; `<=` lets a later round win an exact tie.
    if (best === null || blocking.length <= best.blocking) {
      best = { plan: plan!, blocking: blocking.length };
    }

    if (blocking.length === 0 || repairRounds >= OFFICIALS_MAX_REPAIR_ROUNDS) {
      return finalizeOfficials(pack, best.plan, usageNow());
    }

    // Blocking conflicts remain and rounds are left — send the report back and
    // ask for minimal fixes.
    repairRounds++;
    conversation.push(officialsAssistantTurn(response));
    conversation.push({
      role: "user",
      content: JSON.stringify({
        verifier_conflicts: blocking,
        note: "Fix only these conflicts. Change as few assignments as possible, never move a locked row, and do not reintroduce earlier conflicts.",
      }),
    });
  }
}

// ===========================================================================
// Phase B endpoint orchestrator (design/v4/03 §2). Gates → pack → run →
// telemetry. NO run cap (the V291 scheduling.ai.runs_per_division.max cap is
// Phase A only). Gate order per corpus 00 §6: kill-switch → officials.auto →
// officials.roles_multi (only when >1 role) → rate limit.
// ===========================================================================

/**
 * POST /divisions/{id}/officials/ai-plan orchestrator. Telemetry `ai_plan_run`
 * (phase "officials") fires on success AND on a 422 AI_PLAN_FAILED (usage rides
 * on the error's extra) so refused spend is still metered.
 *
 * @throws HttpError 403 FEATURE_DISABLED (kill switch), 402 (officials.auto /
 *   officials.roles_multi), 429 (rate limit), plus everything
 *   buildOfficialsPack/runOfficialsAiPlan raise (404/422/503).
 */
export async function officialsAiPlanForDivision(
  auth: AuthCtx,
  divisionId: string,
  input: AiOfficialsPlanRequest,
): Promise<AiOfficialsPlanResponse> {
  const distinctId = auth.userId ?? `org:${auth.orgId}`;
  // Kill switch (feature-flag rollout, not billing): fail-open so an unconfigured
  // or unreachable PostHog never blocks a paying customer.
  if (!(await isServerFeatureEnabled("ai-scheduling", distinctId, { orgId: auth.orgId, fallback: true }))) {
    throw new HttpError(403, "AI scheduling is currently turned off", "FEATURE_DISABLED");
  }
  await requireFeature(auth.orgId, "officials.auto");
  if (input.policy.roles.length > 1) {
    await requireFeature(auth.orgId, "officials.roles_multi");
  }
  await rateLimit(`ai-officials:${divisionId}`, { max: 5, windowSeconds: 3600 });

  const pack = await buildOfficialsPack(auth, divisionId, {
    instruction: input.instruction,
    policy: input.policy,
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.prior
      ? { prior: { instruction: input.prior.instruction, assignments: input.prior.assignments } }
      : {}),
  });

  let result: AiOfficialsPlanResponse;
  try {
    result = await runOfficialsAiPlan(pack);
  } catch (err) {
    // Meter a refused / un-correctable run's token spend too — usage rides on the
    // 422 extra so a failed architect call is not invisible in analytics.
    if (err instanceof HttpError && err.code === "AI_PLAN_FAILED") {
      const usage = (err.extra?.usage ?? {}) as {
        input_tokens?: number;
        output_tokens?: number;
        repair_rounds?: number;
      };
      await captureServer({
        event: "ai_plan_run",
        distinctId,
        orgId: auth.orgId,
        properties: {
          phase: "officials",
          fixtures: pack.fixtures.length,
          repair_rounds: usage.repair_rounds ?? 0,
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          blocking: 0,
          outcome: "failed",
        },
      });
    }
    throw err;
  }

  await captureServer({
    event: "ai_plan_run",
    distinctId,
    orgId: auth.orgId,
    properties: {
      phase: "officials",
      fixtures: pack.fixtures.length,
      repair_rounds: result.usage.repair_rounds,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      blocking: result.conflicts.filter((c) => c.severity === "block").length,
      outcome: "ok",
    },
  });

  return result;
}
