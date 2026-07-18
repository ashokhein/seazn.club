import "server-only";
// Player discipline & suspensions (SPEC-1 / PROMPT-78): the read-side fold over
// the score-event ledger. Card events (football.card, {hockey,icehockey}.
// suspension.start) are projected by the sport module's discipline descriptor,
// accumulated per person against configurable thresholds, and raised as
// *pending* suspensions the organiser confirms/waives/adjusts. Everything is
// recompute-on-read (the `suspensions` table IS the snapshot) + a hook on the
// scoring decided/void seam. Idempotent under the partial unique index
// (suspensions_auto_once), never via application-side pre-checks. Zero engine
// reducer/replay/golden change (D2).
import type postgres from "postgres";
import type { DisciplineModel, EventEnvelope } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";

type Tx = postgres.TransactionSql;

const FEATURE = "discipline.enforced";

export type SuspensionStatus = "pending" | "active" | "served" | "waived";
export type SuspensionSource = "auto_accumulation" | "auto_dismissal" | "manual" | "report";

export interface DisciplineRules {
  accumulation: { key: string; color: string; count: number; ban_matches: number }[];
  dismissal: { key: string; color: string; ban_matches: number }[];
}

export interface Suspension {
  id: string;
  divisionId: string;
  personId: string;
  personName: string;
  entrantId: string | null;
  entrantName: string | null;
  status: SuspensionStatus;
  source: SuspensionSource;
  reason: string;
  matchesTotal: number;
  matchesServed: number;
  fixtureId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** true when a trigger event is now voided (the console shows a hint chip;
   *  the row itself is never auto-deleted once decided). */
  triggerVoided: boolean;
}

// Sport defaults prefilled in the rules editor on first open (editable). Kept
// in the usecase — the engine descriptor supplies only the offerable colours.
const SPORT_DEFAULT_RULES: Record<string, DisciplineRules> = {
  football: {
    accumulation: [
      { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
      { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
    ],
    dismissal: [
      { key: "second_yellow", color: "second_yellow", ban_matches: 1 },
      { key: "red", color: "red", ban_matches: 1 },
    ],
  },
  // Field hockey / ice hockey: dismissal-only (red / match penalty → 1 match).
  hockey: { accumulation: [], dismissal: [{ key: "red", color: "red", ban_matches: 1 }] },
  icehockey: {
    accumulation: [],
    dismissal: [
      { key: "game_misconduct", color: "game_misconduct", ban_matches: 1 },
      { key: "match", color: "match", ban_matches: 1 },
    ],
  },
};

function defaultRules(sportKey: string): DisciplineRules {
  return SPORT_DEFAULT_RULES[sportKey] ?? { accumulation: [], dismissal: [] };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// ---------------------------------------------------------------------------
// The fold + detection + serving (recompute-on-read; idempotent).
// ---------------------------------------------------------------------------

interface EventRow {
  fixture_id: string;
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  voids_event_id: string | null;
}

interface ExtractedCard {
  personId?: string;
  color: string;
  eventId: string;
  recordedAt: Date;
  seq: number;
  fixtureId: string;
}

interface WantRow {
  personId: string;
  source: "auto_accumulation" | "auto_dismissal";
  ruleKey: string;
  bucket: number;
  reason: string;
  matchesTotal: number;
  triggerEventIds: string[];
  fixtureId: string;
}

/** Recompute-on-read fold + detection + serving. Idempotent. Safe on divisions
 *  with no rules row and no active suspensions (no-op). */
export async function detectSuspensions(tx: Tx, divisionId: string): Promise<void> {
  const [rules] = await tx<
    { org_id: string; enabled: boolean; rules: DisciplineRules; sport_key: string; module_version: string }[]
  >`
    select dr.org_id, dr.enabled, dr.rules, d.sport_key, d.module_version
    from discipline_rules dr join divisions d on d.id = dr.division_id
    where dr.division_id = ${divisionId}`;
  const enabled = rules?.enabled ?? false;
  if (!enabled) {
    // No auto-detection to run; only touch the DB further if there is an active
    // ban whose serving counter might need advancing (manual bans included).
    const [active] = await tx`
      select 1 from suspensions where division_id = ${divisionId} and status = 'active' limit 1`;
    if (!active) return;
  }

  // Ledger — the recomputePlayerStats query, per fixture, void-aware.
  const events = await tx<EventRow[]>`
    select se.fixture_id, se.id, se.seq, se.type, se.payload, se.recorded_at, se.voids_event_id
    from score_events se join fixtures f on f.id = se.fixture_id
    where f.division_id = ${divisionId}
    order by se.fixture_id, se.seq`;

  if (enabled) {
    const model = resolveModule(rules!.sport_key, rules!.module_version).discipline;
    if (model) await detect(tx, divisionId, rules!.org_id, rules!.rules, model, events);
  }
  await updateServing(tx, divisionId, events);
}

async function detect(
  tx: Tx,
  divisionId: string,
  orgId: string,
  rules: DisciplineRules,
  model: DisciplineModel,
  events: EventRow[],
): Promise<void> {
  const byFixture = new Map<string, EventEnvelope[]>();
  const meta = new Map<string, { recordedAt: Date; seq: number; fixtureId: string }>();
  for (const e of events) {
    meta.set(e.id, { recordedAt: e.recorded_at, seq: e.seq, fixtureId: e.fixture_id });
    const env = {
      id: e.id,
      fixtureId: e.fixture_id,
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      recordedAt: e.recorded_at.toISOString(),
      recordedBy: null,
      ...(e.voids_event_id !== null ? { voids: e.voids_event_id } : {}),
    } as EventEnvelope;
    (byFixture.get(e.fixture_id) ?? byFixture.set(e.fixture_id, []).get(e.fixture_id)!).push(env);
  }

  const cards: ExtractedCard[] = [];
  for (const ledger of byFixture.values()) {
    for (const c of model.extractCards(ledger)) {
      const m = meta.get(c.eventId);
      if (!m) continue;
      cards.push({
        ...(c.personId !== undefined ? { personId: c.personId } : {}),
        color: c.color,
        eventId: c.eventId,
        recordedAt: m.recordedAt,
        seq: m.seq,
        fixtureId: m.fixtureId,
      });
    }
  }
  // Anonymous cards accumulate nothing (SPEC-1). Global chronological order
  // drives bucket assignment and the trigger audit trail.
  const attributed = cards
    .filter((c): c is ExtractedCard & { personId: string } => c.personId !== undefined)
    .sort(
      (a, b) =>
        a.recordedAt.getTime() - b.recordedAt.getTime() ||
        a.fixtureId.localeCompare(b.fixtureId) ||
        a.seq - b.seq,
    );

  const colorLabel = new Map(model.colors.map((c) => [c.key, c.label]));
  const wants: WantRow[] = [];

  // Accumulation — per colour, rules sorted by count asc; bucket = its rank.
  const byColor = new Map<string, DisciplineRules["accumulation"]>();
  for (const r of rules.accumulation ?? []) {
    (byColor.get(r.color) ?? byColor.set(r.color, []).get(r.color)!).push(r);
  }
  for (const [color, colorRules] of byColor) {
    const sorted = [...colorRules].sort((a, b) => a.count - b.count);
    const byPerson = groupByPerson(attributed.filter((c) => c.color === color));
    for (const [personId, personCards] of byPerson) {
      sorted.forEach((rule, idx) => {
        if (personCards.length < rule.count) return;
        const trigger = personCards.slice(0, rule.count);
        wants.push({
          personId,
          source: "auto_accumulation",
          ruleKey: rule.key,
          bucket: idx + 1,
          reason: `${ordinal(rule.count)} ${(colorLabel.get(color) ?? color).toLowerCase()}`,
          matchesTotal: rule.ban_matches,
          triggerEventIds: trigger.map((c) => c.eventId),
          fixtureId: trigger[trigger.length - 1]!.fixtureId,
        });
      });
    }
  }

  // Dismissal — each matching card is one incident; bucket = its Nth occurrence.
  for (const rule of rules.dismissal ?? []) {
    const byPerson = groupByPerson(attributed.filter((c) => c.color === rule.color));
    for (const [personId, personCards] of byPerson) {
      personCards.forEach((card, i) => {
        wants.push({
          personId,
          source: "auto_dismissal",
          ruleKey: rule.key,
          bucket: i + 1,
          reason: colorLabel.get(rule.color) ?? rule.color,
          matchesTotal: rule.ban_matches,
          triggerEventIds: [card.eventId],
          fixtureId: card.fixtureId,
        });
      });
    }
  }

  // Insert wanted rows; the partial unique index makes this idempotent.
  for (const w of wants) {
    await tx`
      insert into suspensions
        (org_id, division_id, person_id, status, source, rule_key, bucket, reason,
         matches_total, trigger_event_ids, fixture_id)
      values (${orgId}, ${divisionId}, ${w.personId}, 'pending', ${w.source}, ${w.ruleKey},
              ${w.bucket}, ${w.reason}, ${w.matchesTotal}, ${w.triggerEventIds}, ${w.fixtureId})
      on conflict do nothing`;
  }

  // Delete PENDING auto rows whose trigger no longer holds (voided card dropped
  // the total below the threshold). Confirmed rows are the organiser's.
  const wantKeys = new Set(wants.map((w) => `${w.personId}|${w.ruleKey}|${w.bucket}`));
  const pendingAuto = await tx<{ id: string; person_id: string; rule_key: string; bucket: number }[]>`
    select id, person_id, rule_key, bucket from suspensions
    where division_id = ${divisionId} and status = 'pending'
      and source in ('auto_accumulation', 'auto_dismissal')`;
  for (const row of pendingAuto) {
    if (!wantKeys.has(`${row.person_id}|${row.rule_key}|${row.bucket}`)) {
      await tx`delete from suspensions where id = ${row.id}`;
    }
  }
}

function groupByPerson<T extends { personId: string }>(cards: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const c of cards) (map.get(c.personId) ?? map.set(c.personId, []).get(c.personId)!).push(c);
  return map;
}

// Serving — matches_served is derived, stored and monotonic (SPEC-1). No lineup
// entity exists, so a match is "served" per decided/finalized fixture of the
// suspended entrant that elapsed after the ban's decided_at. A forfeit BY the
// suspended entrant counts; abandoned/cancelled and forfeits by anyone else
// never do. A fixture's elapsed time = its latest recorded event.
async function updateServing(tx: Tx, divisionId: string, events: EventRow[]): Promise<void> {
  const active = await tx<
    { id: string; entrant_id: string | null; decided_at: Date | null; matches_total: number }[]
  >`
    select id, entrant_id, decided_at, matches_total from suspensions
    where division_id = ${divisionId} and status = 'active'`;
  if (active.length === 0) return;

  const fixtures = await tx<
    { id: string; status: string; home_entrant_id: string | null; away_entrant_id: string | null }[]
  >`
    select id, status, home_entrant_id, away_entrant_id from fixtures where division_id = ${divisionId}`;

  const elapsedAt = new Map<string, Date>();
  const forfeitBy = new Map<string, string>();
  for (const e of events) {
    const cur = elapsedAt.get(e.fixture_id);
    if (!cur || e.recorded_at > cur) elapsedAt.set(e.fixture_id, e.recorded_at);
    if (e.type === "core.forfeit") {
      const by = (e.payload as { by?: string } | null)?.by;
      if (typeof by === "string") forfeitBy.set(e.fixture_id, by);
    }
  }

  for (const s of active) {
    if (!s.entrant_id || !s.decided_at) continue;
    let served = 0;
    for (const f of fixtures) {
      if (f.home_entrant_id !== s.entrant_id && f.away_entrant_id !== s.entrant_id) continue;
      const when = elapsedAt.get(f.id);
      if (!when || when <= s.decided_at) continue;
      if (f.status === "decided" || f.status === "finalized") served++;
      else if (f.status === "forfeited" && forfeitBy.get(f.id) === s.entrant_id) served++;
    }
    const capped = Math.min(served, s.matches_total);
    const status = capped >= s.matches_total ? "served" : "active";
    await tx`
      update suspensions set matches_served = ${capped}, status = ${status}, updated_at = now()
      where id = ${s.id}`;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface SuspensionRow {
  id: string;
  division_id: string;
  person_id: string;
  person_name: string;
  entrant_id: string | null;
  entrant_name: string | null;
  status: SuspensionStatus;
  source: SuspensionSource;
  reason: string;
  matches_total: number;
  matches_served: number;
  fixture_id: string | null;
  trigger_event_ids: string[] | null;
  created_at: Date;
  decided_at: Date | null;
}

function mapRow(row: SuspensionRow, voided: Set<string>): Suspension {
  return {
    id: row.id,
    divisionId: row.division_id,
    personId: row.person_id,
    personName: row.person_name,
    entrantId: row.entrant_id,
    entrantName: row.entrant_name,
    status: row.status,
    source: row.source,
    reason: row.reason,
    matchesTotal: row.matches_total,
    matchesServed: row.matches_served,
    fixtureId: row.fixture_id,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    triggerVoided: (row.trigger_event_ids ?? []).some((id) => voided.has(id)),
  };
}

const SELECT_SUSPENSION = (tx: Tx) => tx`
  s.id, s.division_id, s.person_id, p.full_name as person_name,
  s.entrant_id, e.display_name as entrant_name, s.status, s.source, s.reason,
  s.matches_total, s.matches_served, s.fixture_id, s.trigger_event_ids,
  s.created_at, s.decided_at`;

async function voidedSet(tx: Tx, divisionId: string): Promise<Set<string>> {
  const rows = await tx<{ voids_event_id: string }[]>`
    select se.voids_event_id from score_events se join fixtures f on f.id = se.fixture_id
    where f.division_id = ${divisionId} and se.voids_event_id is not null`;
  return new Set(rows.map((r) => r.voids_event_id));
}

async function loadSuspension(tx: Tx, divisionId: string, id: string): Promise<Suspension> {
  const [row] = await tx<SuspensionRow[]>`
    select ${SELECT_SUSPENSION(tx)}
    from suspensions s
    join persons p on p.id = s.person_id
    left join entrants e on e.id = s.entrant_id
    where s.id = ${id} and s.division_id = ${divisionId}`;
  if (!row) throw new HttpError(404, "suspension not found");
  return mapRow(row, await voidedSet(tx, divisionId));
}

/** Rules doc + enabled flag + the sport's offerable colours. null when the
 *  division's sport module has no discipline model (tab hidden). Free orgs hit
 *  the requireFeature 402 (PlusReveal) before any rules are returned. */
export async function getDisciplineRules(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ enabled: boolean; rules: DisciplineRules; sportColors: { key: string; label: string }[] } | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ sport_key: string; module_version: string }[]>`
      select sport_key, module_version from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const model = resolveModule(division.sport_key, division.module_version).discipline;
    if (!model) return null; // no model → hide the tab (ungated, so free orgs learn nothing extra)
    await requireFeature(auth.orgId, FEATURE);
    const [row] = await tx<{ enabled: boolean; rules: DisciplineRules }[]>`
      select enabled, rules from discipline_rules where division_id = ${divisionId}`;
    return {
      enabled: row?.enabled ?? false,
      rules: row?.rules ?? defaultRules(division.sport_key),
      sportColors: model.colors,
    };
  });
}

export async function putDisciplineRules(
  auth: AuthCtx,
  divisionId: string,
  body: { enabled: boolean; rules: DisciplineRules },
): Promise<void> {
  await requireFeature(auth.orgId, FEATURE);
  await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ sport_key: string; module_version: string }[]>`
      select sport_key, module_version from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const model = resolveModule(division.sport_key, division.module_version).discipline;
    if (!model) throw new HttpError(422, "this sport does not track discipline");
    // Validate colours against the module's declared keys (not in zod, SPEC-1).
    const allowed = new Set(model.colors.map((c) => c.key));
    for (const r of [...body.rules.accumulation, ...body.rules.dismissal]) {
      if (!allowed.has(r.color)) throw new HttpError(422, `unknown card colour "${r.color}"`);
    }
    await tx`
      insert into discipline_rules (org_id, division_id, enabled, rules)
      values (${auth.orgId}, ${divisionId}, ${body.enabled}, ${tx.json(body.rules as never)})
      on conflict (division_id)
        do update set enabled = excluded.enabled, rules = excluded.rules, updated_at = now()`;
    await detectSuspensions(tx, divisionId);
  });
}

export async function listSuspensions(
  auth: AuthCtx,
  divisionId: string,
  status?: SuspensionStatus,
): Promise<Suspension[]> {
  await requireFeature(auth.orgId, FEATURE);
  return withTenant(auth.orgId, async (tx) => {
    await detectSuspensions(tx, divisionId);
    const rows = await tx<SuspensionRow[]>`
      select ${SELECT_SUSPENSION(tx)}
      from suspensions s
      join persons p on p.id = s.person_id
      left join entrants e on e.id = s.entrant_id
      where s.division_id = ${divisionId}
      ${status ? tx`and s.status = ${status}` : tx``}
      order by s.created_at desc, s.id`;
    const voided = await voidedSet(tx, divisionId);
    return rows.map((r) => mapRow(r, voided));
  });
}

export async function createManualSuspension(
  auth: AuthCtx,
  divisionId: string,
  input: { personId: string; matchesTotal: number; reason: string },
): Promise<Suspension> {
  await requireFeature(auth.orgId, FEATURE);
  return withTenant(auth.orgId, async (tx) => {
    // Defense-in-depth: the division must belong to the auth org (the tenant
    // rail scopes it; the route also wraps this in requireResourceAuth).
    const [division] = await tx`
      select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [person] = await tx`
      select 1 from persons where id = ${input.personId} and org_id = ${auth.orgId}`;
    if (!person) throw new HttpError(404, "person not found");
    const [{ id }] = await tx<{ id: string }[]>`
      insert into suspensions
        (org_id, division_id, person_id, status, source, reason, matches_total, created_by)
      values (${auth.orgId}, ${divisionId}, ${input.personId}, 'pending', 'manual',
              ${input.reason}, ${input.matchesTotal}, ${auth.userId})
      returning id`;
    return loadSuspension(tx, divisionId, id);
  });
}

export async function decideSuspension(
  auth: AuthCtx,
  id: string,
  action:
    | { kind: "confirm" }
    | { kind: "waive" }
    | { kind: "adjust"; matchesTotal?: number; reason?: string },
): Promise<Suspension> {
  await requireFeature(auth.orgId, FEATURE);
  return withTenant(auth.orgId, async (tx) => {
    const [s] = await tx<
      { division_id: string; person_id: string; entrant_id: string | null; status: SuspensionStatus }[]
    >`
      select division_id, person_id, entrant_id, status from suspensions where id = ${id}`;
    if (!s) throw new HttpError(404, "suspension not found");

    if (action.kind === "confirm") {
      // Resolve the serving entrant now and stamp it (SPEC-1): the person's
      // entrant in this division, when not already known.
      let entrantId = s.entrant_id;
      if (!entrantId) {
        const [em] = await tx<{ id: string }[]>`
          select e.id from entrant_members em join entrants e on e.id = em.entrant_id
          where em.person_id = ${s.person_id} and e.division_id = ${s.division_id} limit 1`;
        entrantId = em?.id ?? null;
      }
      await tx`
        update suspensions set status = 'active', entrant_id = ${entrantId},
          decided_by = ${auth.userId}, decided_at = now(), updated_at = now()
        where id = ${id}`;
    } else if (action.kind === "waive") {
      await tx`
        update suspensions set status = 'waived', decided_by = ${auth.userId},
          decided_at = now(), updated_at = now()
        where id = ${id}`;
    } else {
      await tx`
        update suspensions set
          matches_total = coalesce(${action.matchesTotal ?? null}, matches_total),
          reason = coalesce(${action.reason ?? null}, reason), updated_at = now()
        where id = ${id}`;
    }
    await detectSuspensions(tx, s.division_id);
    return loadSuspension(tx, s.division_id, id);
  });
}

// ---------------------------------------------------------------------------
// Cross-surface helpers (PROMPT-79/80)
// ---------------------------------------------------------------------------

/** entrant_id → active suspensions among its members, for the entrant chip. */
export async function activeSuspensionsByEntrant(
  tx: Tx,
  divisionId: string,
): Promise<Map<string, { personId: string; personName: string; remaining: number }[]>> {
  await detectSuspensions(tx, divisionId);
  const rows = await tx<
    { entrant_id: string; person_id: string; person_name: string; remaining: number }[]
  >`
    select s.entrant_id, s.person_id, p.full_name as person_name,
           (s.matches_total - s.matches_served) as remaining
    from suspensions s join persons p on p.id = s.person_id
    where s.division_id = ${divisionId} and s.status = 'active' and s.entrant_id is not null`;
  const map = new Map<string, { personId: string; personName: string; remaining: number }[]>();
  for (const r of rows) {
    const entry = { personId: r.person_id, personName: r.person_name, remaining: r.remaining };
    (map.get(r.entrant_id) ?? map.set(r.entrant_id, []).get(r.entrant_id)!).push(entry);
  }
  return map;
}

/** Public "Suspensions" strip: active bans, names via public_person_name
 *  consent (exactly the publicDivisionStats pattern). Ungated read. */
export async function publicSuspensions(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
): Promise<{ name: string; remaining: number }[]> {
  const [division] = await sql<{ id: string; org_id: string }[]>`
    select d.id, d.org_id
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${competitionSlug} and d.slug = ${divisionSlug}
      and c.visibility in ('public','unlisted')`;
  if (!division) throw new HttpError(404, "division not found");
  await withTenant(division.org_id, (tx) => detectSuspensions(tx, division.id));
  return sql<{ name: string; remaining: number }[]>`
    select public_person_name(p.full_name, p.consent) as name,
           (s.matches_total - s.matches_served) as remaining
    from suspensions s join persons p on p.id = s.person_id
    where s.division_id = ${division.id} and s.status = 'active'
    order by name`;
}
