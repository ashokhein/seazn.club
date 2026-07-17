import "server-only";
// Officials use-cases (Jul3/02 §4): CRUD + import, auto-propose / apply,
// manual per-fixture set/lock, phased sourcing. The pure pass lives in
// @seazn/engine/officials; fixture_officials is the write source and
// fixtures.officials the denormalized read cache.
import type postgres from "postgres";
import {
  AssignPolicy,
  OfficialSourcing,
  assignOfficials,
  resolveOfficialSourcing,
  type AssignResult,
  type FixtureOfficial,
  type OfficialFixture,
  type OfficialSpec,
} from "@seazn/engine/officials";
import { z } from "zod";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { sendOfficialAssignedEmail } from "@/lib/email";
import { createClaimInvite, type ClaimRow } from "./person-claims";
import { parseUpload } from "./import-parse";

type Tx = postgres.TransactionSql;

export interface OfficialRow {
  id: string;
  person_id: string | null;
  entrant_id: string | null;
  display_name: string;
  email: string | null;
  role_keys: string[];
  home_pool_id: string | null;
  max_per_day: number | null;
  created_at: string;
}

const COLS = [
  "id", "person_id", "entrant_id", "display_name", "email", "role_keys",
  "home_pool_id", "max_per_day", "created_at",
] as const;

export const CreateOfficialInput = z.object({
  display_name: z.string().min(1).max(200),
  person_id: z.string().uuid().optional(),
  entrant_id: z.string().uuid().optional(),
  email: z.email().max(200).nullable().optional(),
  role_keys: z.array(z.string().min(1)).min(1).default(["referee"]),
  home_pool_id: z.string().uuid().nullable().optional(),
  max_per_day: z.number().int().positive().nullable().optional(),
});
export type CreateOfficialInput = z.infer<typeof CreateOfficialInput>;

export const PatchOfficialInput = CreateOfficialInput.partial();
export type PatchOfficialInput = z.infer<typeof PatchOfficialInput>;

// Jul3/02 §5: judge + referee (multi-role officials) are Pro.
async function assertRolesAllowed(orgId: string, roleKeys?: string[]): Promise<void> {
  if (roleKeys && roleKeys.length > 1) {
    await requireFeature(orgId, "officials.roles_multi");
  }
}

export async function listOfficials(auth: AuthCtx): Promise<OfficialRow[]> {
  return withTenant(auth.orgId, (tx) => tx<OfficialRow[]>`
    select ${tx(COLS)} from officials order by display_name, id`);
}

export interface OfficialConsoleRow extends OfficialRow {
  /** person_id is bound to a login — the official sees this org in /me. */
  claimed: boolean;
  /** An open claim invite is out (not yet accepted, not expired). */
  invite_pending: boolean;
}

/** Officials manager read: roster + claim-rail state per official (v11). */
export async function listOfficialsForConsole(auth: AuthCtx): Promise<OfficialConsoleRow[]> {
  return withTenant(auth.orgId, (tx) => tx<OfficialConsoleRow[]>`
    select o.id, o.person_id, o.entrant_id, o.display_name, o.email,
           o.role_keys, o.home_pool_id, o.max_per_day, o.created_at,
           (p.user_id is not null) as claimed,
           exists(select 1 from person_claims pc
                  where pc.person_id = o.person_id
                    and pc.claimed_at is null and pc.revoked_at is null
                    and pc.expires_at > now()) as invite_pending
    from officials o left join persons p on p.id = o.person_id
    order by o.display_name, o.id`);
}

/** Blackout dates for the org's officials (organiser-side read; the console
 *  warns before assigning someone onto a date they marked unavailable). */
export async function listOfficialBlackouts(
  auth: AuthCtx,
): Promise<{ official_id: string; date: string; note: string | null }[]> {
  return withTenant(auth.orgId, (tx) => tx<
    { official_id: string; date: string; note: string | null }[]
  >`
    select official_id, date::text as date, note
    from official_availability order by date, official_id`);
}

export interface OfficialBusyRow {
  /** MY org's officials.id — never the other org's official/person id. */
  official_id: string;
  scheduled_at: string;
}

/**
 * Cross-org "booked elsewhere" read (v11.1): blackout dates already fan out
 * person-wide (V284 official_availability, written through /me), but an
 * actual match assignment is tenant-isolated — org B assigns blind when org A
 * already booked the same official. This surfaces ONLY a timestamp for each
 * of MY org's officials, never which org/competition/fixture/role — the
 * organiser gets a warning, not a leak of a rival's roster. Cross-org
 * identity is persons.user_id (only CLAIMED officials — person linked to a
 * user — can have a busy signal). Runs on the superuser connection, same
 * reasoning as me-officiating.ts's cross-org aggregation: withTenant scopes
 * to one org and this read straddles two by design.
 */
export async function listOfficialBusyElsewhere(auth: AuthCtx): Promise<OfficialBusyRow[]> {
  return sql<OfficialBusyRow[]>`
    select distinct o.id as official_id, f.scheduled_at
    from officials o
    join persons p on p.id = o.person_id and p.user_id is not null
    join persons p2 on p2.user_id = p.user_id and p2.org_id <> ${auth.orgId}
    join officials o2 on o2.person_id = p2.id
    join fixture_officials fo on fo.official_id = o2.id and fo.response <> 'declined'
    join fixtures f on f.id = fo.fixture_id
      and f.scheduled_at is not null and f.scheduled_at >= now() - interval '1 day'
    where o.org_id = ${auth.orgId}
    order by o.id, f.scheduled_at`;
}

/**
 * Invite an official to claim their profile (v11): ensure a linked person
 * (creating one mirrors how player invites need a person row to bind), stamp
 * officials.email, then mint the claim through the SHARED person-claim rail —
 * same tokens, same 14-day TTL, same email-bound accept. No parallel system.
 */
export async function inviteOfficial(
  auth: AuthCtx,
  officialId: string,
  email: string,
): Promise<{ official: OfficialRow; claim: ClaimRow; secret: string; person_name: string; org_name: string }> {
  const official = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<OfficialRow[]>`
      select ${tx(COLS)} from officials where id = ${officialId}`;
    if (!row) throw new HttpError(404, "official not found");
    if (!row.person_id) {
      const [person] = await tx<{ id: string }[]>`
        insert into persons (org_id, full_name)
        values (${auth.orgId}, ${row.display_name}) returning id`;
      row.person_id = person!.id;
    }
    const [updated] = await tx<OfficialRow[]>`
      update officials set email = ${email.trim().toLowerCase()}, person_id = ${row.person_id}
      where id = ${officialId} returning ${tx(COLS)}`;
    return updated!;
  });
  const { secret, person_name, org_name, ...claim } = await createClaimInvite(
    auth,
    official.person_id!,
    email.trim().toLowerCase(),
  );
  return { official, claim, secret, person_name, org_name };
}

export async function createOfficial(auth: AuthCtx, input: CreateOfficialInput): Promise<OfficialRow> {
  await assertRolesAllowed(auth.orgId, input.role_keys);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<OfficialRow[]>`
      insert into officials (org_id, person_id, entrant_id, display_name, email,
                             role_keys, home_pool_id, max_per_day)
      values (${auth.orgId}, ${input.person_id ?? null}, ${input.entrant_id ?? null},
              ${input.display_name}, ${input.email ?? null}, ${tx.json(input.role_keys as never)},
              ${input.home_pool_id ?? null}, ${input.max_per_day ?? null})
      returning ${tx(COLS)}`;
    return row!;
  });
}

export async function patchOfficial(
  auth: AuthCtx,
  id: string,
  patch: PatchOfficialInput,
): Promise<OfficialRow> {
  await assertRolesAllowed(auth.orgId, patch.role_keys);
  return withTenant(auth.orgId, async (tx) => {
    const cols = Object.keys(patch);
    if (cols.length === 0) throw new HttpError(400, "empty patch");
    const values = {
      ...patch,
      ...(patch.role_keys ? { role_keys: tx.json(patch.role_keys as never) } : {}),
    };
    const [row] = await tx<OfficialRow[]>`
      update officials set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "official not found");
    return row;
  });
}

export async function deleteOfficial(auth: AuthCtx, id: string): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      delete from officials where id = ${id} returning id`;
    if (!row) throw new HttpError(404, "official not found");
  });
}

/** Bulk officials import (Jul3/02 §4) — reuses the Jul3/01 parser: columns
 *  Name, Roles (comma/space separated), MaxPerDay. Simple direct creates,
 *  idempotent on folded display_name. */
export async function importOfficials(
  auth: AuthCtx,
  filename: string,
  contentType: string | null,
  buffer: Buffer,
): Promise<{ created: number; skipped: number }> {
  const table = await parseUpload(filename, contentType, buffer);
  const [header, ...data] = table;
  if (!header) throw new HttpError(422, "The file has no header row");
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const nameCol = norm.findIndex((h) => ["name", "official", "displayname"].includes(h));
  const rolesCol = norm.findIndex((h) => ["roles", "role", "rolekeys"].includes(h));
  const capCol = norm.findIndex((h) => ["maxperday", "cap", "max"].includes(h));
  if (nameCol < 0) throw new HttpError(422, "No Name column found");

  return withTenant(auth.orgId, async (tx) => {
    const existing = await tx<{ display_name: string }[]>`select display_name from officials`;
    const seen = new Set(existing.map((r) => r.display_name.trim().toLowerCase()));
    let created = 0;
    let skipped = 0;
    for (const cells of data) {
      const name = cells[nameCol]?.trim();
      if (!name) continue;
      if (seen.has(name.toLowerCase())) {
        skipped++;
        continue;
      }
      const roles =
        rolesCol >= 0 && cells[rolesCol]?.trim()
          ? cells[rolesCol]!.split(/[,;\s]+/).filter(Boolean).map((r) => r.toLowerCase())
          : ["referee"];
      if (roles.length > 1) await requireFeature(auth.orgId, "officials.roles_multi");
      const cap = capCol >= 0 ? Number.parseInt(cells[capCol] ?? "", 10) : Number.NaN;
      await tx`
        insert into officials (org_id, display_name, role_keys, max_per_day)
        values (${auth.orgId}, ${name}, ${tx.json(roles as never)},
                ${Number.isInteger(cap) && cap > 0 ? cap : null})`;
      seen.add(name.toLowerCase());
      created++;
    }
    return { created, skipped };
  });
}

// ---------------------------------------------------------------------------
// Engine input assembly + auto / apply (Jul3/02 §4)
// ---------------------------------------------------------------------------

const DEFAULT_MATCH_MINUTES = 30;

async function engineInput(
  tx: Tx,
  divisionId: string,
): Promise<{ fixtures: OfficialFixture[]; officials: OfficialSpec[]; locked: FixtureOfficial[] }> {
  const [settings] = await tx<{ config: { matchMinutes?: number } }[]>`
    select config from schedule_settings where division_id = ${divisionId}`;
  const matchMinutes = settings?.config?.matchMinutes ?? DEFAULT_MATCH_MINUTES;

  const fixtureRows = await tx<{
    id: string; scheduled_at: string; court_label: string | null; pool_id: string | null;
    stage_id: string; division_id: string; home_entrant_id: string | null; away_entrant_id: string | null;
  }[]>`
    select id, scheduled_at, court_label, pool_id, stage_id, division_id,
           home_entrant_id, away_entrant_id
    from fixtures
    where division_id = ${divisionId} and scheduled_at is not null
      and status <> 'decided'
    order by scheduled_at, id`;
  const fixtures: OfficialFixture[] = fixtureRows.map((f) => {
    const start = new Date(f.scheduled_at).getTime();
    return {
      id: f.id,
      startAt: start,
      endAt: start + matchMinutes * 60_000,
      court: f.court_label ?? undefined,
      poolId: f.pool_id ?? undefined,
      divisionId: f.division_id,
      stageId: f.stage_id,
      entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
    };
  });

  // Officials + the entrant map that powers team-ref-self and plays-while-
  // reffing (Jul3/02 §3): the team-as-ref entrant plus every entrant the
  // official's person is rostered into.
  const officialRows = await tx<(OfficialRow & { person_entrants: string[] | null })[]>`
    select ${tx(COLS)},
           case when person_id is not null then
             (select array_agg(em.entrant_id) from entrant_members em
              where em.person_id = officials.person_id)
           end as person_entrants
    from officials order by display_name, id`;
  const officials: OfficialSpec[] = officialRows.map((o) => {
    const entrantIds = [
      ...(o.entrant_id ? [o.entrant_id] : []),
      ...(o.person_entrants ?? []),
    ];
    return {
      id: o.id,
      roleKeys: o.role_keys,
      homePoolId: o.home_pool_id ?? undefined,
      maxPerDay: o.max_per_day ?? undefined,
      entrantIds: entrantIds.length > 0 ? entrantIds : undefined,
      homeDivisionId: divisionId,
    };
  });

  const lockedRows = await tx<{ fixture_id: string; official_id: string; role_key: string }[]>`
    select fo.fixture_id, fo.official_id, fo.role_key
    from fixture_officials fo
    join fixtures f on f.id = fo.fixture_id
    where f.division_id = ${divisionId} and fo.locked`;
  const locked: FixtureOfficial[] = lockedRows.map((r) => ({
    fixtureId: r.fixture_id,
    officialId: r.official_id,
    roleKey: r.role_key,
    locked: true,
  }));
  return { fixtures, officials, locked };
}

export const AutoAssignInput = z.object({
  policy: AssignPolicy,
  rng_seed: z.string().default("officials"),
});
export type AutoAssignInput = z.infer<typeof AutoAssignInput>;

/** POST /divisions/{id}/officials/auto — propose only, writes nothing. */
export async function autoAssignOfficials(
  auth: AuthCtx,
  divisionId: string,
  input: AutoAssignInput,
): Promise<AssignResult> {
  await requireFeature(auth.orgId, "officials.auto");
  if (input.policy.roles.length > 1) {
    await requireFeature(auth.orgId, "officials.roles_multi");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const { fixtures, officials, locked } = await engineInput(tx, divisionId);
    return assignOfficials({
      fixtures,
      officials,
      locked,
      policy: input.policy,
      rngSeed: input.rng_seed,
    });
  });
}

export const ApplyAssignmentsInput = z.object({
  assignments: z.array(
    z.object({
      fixture_id: z.string().uuid(),
      official_id: z.string().uuid(),
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
});
export type ApplyAssignmentsInput = z.infer<typeof ApplyAssignmentsInput>;

/** POST /divisions/{id}/officials/apply — transactional persist: replaces the
 *  division's UNLOCKED assignments with the given set (locked rows survive),
 *  refreshes the fixtures.officials cache, emits `officials_assigned`. */
export async function applyOfficialAssignments(
  auth: AuthCtx,
  divisionId: string,
  input: ApplyAssignmentsInput,
): Promise<{ applied: number }> {
  await requireFeature(auth.orgId, "officials.auto");
  return withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");

    const fixtureIds = [...new Set(input.assignments.map((a) => a.fixture_id))];
    if (fixtureIds.length > 0) {
      const owned = await tx<{ id: string }[]>`
        select id from fixtures where division_id = ${divisionId} and id in ${tx(fixtureIds)}`;
      if (owned.length !== fixtureIds.length) {
        throw new HttpError(422, "assignment references a fixture outside this division");
      }
    }

    // Response carry-over (v11): re-running auto must not reset an official's
    // accept/decline on assignments that come back identical — the deleted
    // rows are the memory, keyed (fixture, official, role).
    const touched = await tx<PriorAssignment[]>`
      delete from fixture_officials
      where not locked and fixture_id in (select id from fixtures where division_id = ${divisionId})
      returning fixture_id, official_id, role_key, response, responded_at, decline_reason`;
    const prior = new Map(touched.map((t) => [assignmentKey(t.fixture_id, t.official_id, t.role_key), t]));
    let applied = 0;
    const fresh: { fixture_id: string; official_id: string; role_key: string }[] = [];
    for (const a of input.assignments) {
      const prev = prior.get(assignmentKey(a.fixture_id, a.official_id, a.role_key));
      if (!prev) fresh.push(a);
      await tx`
        insert into fixture_officials (fixture_id, official_id, role_key, source, locked,
                                       response, responded_at, decline_reason)
        values (${a.fixture_id}, ${a.official_id}, ${a.role_key}, 'auto', ${a.locked},
                ${prev?.response ?? "pending"}, ${prev?.responded_at ?? null},
                ${prev?.decline_reason ?? null})
        on conflict (fixture_id, role_key, official_id) do nothing`;
      applied++;
    }
    const allTouched = [...new Set([...touched.map((t) => t.fixture_id), ...fixtureIds])];
    await refreshOfficialsCache(tx, allTouched);

    const [{ seq }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${divisionId}`;
    await tx`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${divisionId}, ${seq + 1}, 'officials_assigned',
              ${tx.json({ applied } as never)}, ${auth.userId})`;
    const notices = await assignedNotices(tx, auth.orgId, fresh);
    return { applied, notices };
  }).then(({ applied, notices }) => {
    sendAssignedNotices(notices);
    return { applied };
  });
}

export const PatchFixtureOfficialsInput = z.object({
  set: z.array(
    z.object({
      official_id: z.string().uuid(),
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
});
export type PatchFixtureOfficialsInput = z.infer<typeof PatchFixtureOfficialsInput>;

/** PATCH /fixtures/{id}/officials — manual set/move/lock (7 Jan drag-drop).
 *  Replaces the fixture's assignments. Manual single-role stays free on every
 *  plan (Jul3/02 §5); a multi-role set needs officials.roles_multi. */
export async function patchFixtureOfficials(
  auth: AuthCtx,
  fixtureId: string,
  input: PatchFixtureOfficialsInput,
): Promise<{ officials: unknown }> {
  const roleCount = new Set(input.set.map((s) => s.role_key)).size;
  if (roleCount > 1) await requireFeature(auth.orgId, "officials.roles_multi");
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<{ id: string }[]>`select id from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    // Same carry-over rule as the auto path: a re-set that keeps the same
    // (official, role) must not reset the official's response or re-notify.
    const priorRows = await tx<PriorAssignment[]>`
      delete from fixture_officials where fixture_id = ${fixtureId}
      returning fixture_id, official_id, role_key, response, responded_at, decline_reason`;
    const prior = new Map(priorRows.map((t) => [assignmentKey(t.fixture_id, t.official_id, t.role_key), t]));
    const fresh: { fixture_id: string; official_id: string; role_key: string }[] = [];
    for (const s of input.set) {
      const prev = prior.get(assignmentKey(fixtureId, s.official_id, s.role_key));
      if (!prev) fresh.push({ fixture_id: fixtureId, official_id: s.official_id, role_key: s.role_key });
      await tx`
        insert into fixture_officials (fixture_id, official_id, role_key, source, locked,
                                       response, responded_at, decline_reason)
        values (${fixtureId}, ${s.official_id}, ${s.role_key}, 'manual', ${s.locked},
                ${prev?.response ?? "pending"}, ${prev?.responded_at ?? null},
                ${prev?.decline_reason ?? null})`;
    }
    const cache = await refreshOfficialsCache(tx, [fixtureId]);
    const notices = await assignedNotices(tx, auth.orgId, fresh);
    return { officials: cache.get(fixtureId) ?? [], notices };
  }).then(({ officials, notices }) => {
    sendAssignedNotices(notices);
    return { officials };
  });
}

// ---------------------------------------------------------------------------
// Assignment notifications (v11): who newly got a fixture, with enough detail
// for the official-assigned email. Assembled inside the tx, sent after commit
// (fire-and-forget — a mail hiccup must not fail the assignment).
// ---------------------------------------------------------------------------

interface PriorAssignment {
  fixture_id: string;
  official_id: string;
  role_key: string;
  response: string;
  responded_at: string | null;
  decline_reason: string | null;
}

function assignmentKey(fixtureId: string, officialId: string, roleKey: string): string {
  return `${fixtureId}:${officialId}:${roleKey}`;
}

export interface AssignedNotice {
  email: string;
  official_name: string;
  org_name: string;
  fixtures: {
    label: string;
    role_key: string;
    scheduled_at: string | null;
    venue_tz: string | null;
    venue: string | null;
    court_label: string | null;
  }[];
}

async function assignedNotices(
  tx: Tx,
  orgId: string,
  fresh: { fixture_id: string; official_id: string; role_key: string }[],
): Promise<AssignedNotice[]> {
  if (fresh.length === 0) return [];
  const officialIds = [...new Set(fresh.map((f) => f.official_id))];
  const fixtureIds = [...new Set(fresh.map((f) => f.fixture_id))];
  const officials = await tx<{ id: string; display_name: string; email: string | null }[]>`
    select id, display_name, email from officials
    where id in ${tx(officialIds)} and email is not null`;
  if (officials.length === 0) return [];
  const [org] = await tx<{ name: string }[]>`
    select name from organizations where id = ${orgId}`;
  const fixtures = await tx<{
    id: string; scheduled_at: string | null; venue: string | null;
    court_label: string | null; venue_tz: string | null;
    home_name: string | null; away_name: string | null;
  }[]>`
    select f.id, f.scheduled_at, f.venue, f.court_label, ss.tz as venue_tz,
           h.display_name as home_name, a.display_name as away_name
    from fixtures f
    left join schedule_settings ss on ss.division_id = f.division_id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where f.id in ${tx(fixtureIds)}`;
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return officials.map((o) => ({
    email: o.email!,
    official_name: o.display_name,
    org_name: org?.name ?? "",
    fixtures: fresh
      .filter((f) => f.official_id === o.id)
      .map((f) => {
        const fx = byId.get(f.fixture_id);
        return {
          label: `${fx?.home_name ?? "TBD"} vs ${fx?.away_name ?? "TBD"}`,
          role_key: f.role_key,
          scheduled_at: fx?.scheduled_at ?? null,
          venue_tz: fx?.venue_tz ?? null,
          venue: fx?.venue ?? null,
          court_label: fx?.court_label ?? null,
        };
      }),
  }));
}

function sendAssignedNotices(notices: AssignedNotice[]): void {
  for (const n of notices) {
    void sendOfficialAssignedEmail(n.email, {
      orgName: n.org_name,
      officialName: n.official_name,
      fixtures: n.fixtures,
    }).catch(() => {});
  }
}

/** Rebuild fixtures.officials (the read cache) from fixture_officials.
 *  Exported for the official-side response write (me-officiating.ts), which
 *  runs on the superuser connection. */
export async function refreshOfficialsCache(
  tx: Tx,
  fixtureIds: string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (fixtureIds.length === 0) return out;
  const rows = await tx<{ fixture_id: string; officials: unknown }[]>`
    select f.id as fixture_id,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'official_id', fo.official_id,
                       'name', o.display_name,
                       'role', fo.role_key,
                       'locked', fo.locked,
                       'response', fo.response,
                       'decline_reason', fo.decline_reason)
                      order by fo.role_key, o.display_name)
                     from fixture_officials fo
                     join officials o on o.id = fo.official_id
                     where fo.fixture_id = f.id), '[]'::jsonb) as officials
    from fixtures f where f.id in ${tx(fixtureIds)}`;
  for (const r of rows) {
    await tx`update fixtures set officials = ${tx.json(r.officials as never)}
             where id = ${r.fixture_id}`;
    out.set(r.fixture_id, r.officials);
  }
  return out;
}

export const SourceOfficialsInput = z.object({
  sources: z.array(OfficialSourcing).min(1),
});
export type SourceOfficialsInput = z.infer<typeof SourceOfficialsInput>;

/** POST /stages/{id}/officials/source — resolve rank/result sourcing into
 *  entrant specs (pure resolver; propose-only, Jul3/02 §3). */
export async function sourceOfficials(
  auth: AuthCtx,
  stageId: string,
  input: SourceOfficialsInput,
): Promise<{
  resolved: { entrant_id: string; display_name: string; official_id: string | null }[];
  pending: { reason: string }[];
}> {
  await requireFeature(auth.orgId, "officials.auto");
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string }[]>`
      select division_id from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");

    // standings snapshots: decided = stage completed (rows frozen at complete)
    const standingsRows = await tx<{ stage_id: string; pool_id: string | null; rows: unknown; final: boolean }[]>`
      select ss.stage_id, ss.pool_id, ss.rows,
             (s.status = 'completed') as final
      from standings_snapshots ss join stages s on s.id = ss.stage_id
      where s.division_id = (select division_id from stages where id = ${stageId})`;
    const fixturesRows = await tx<{ id: string; status: string; outcome: { kind?: string; winner?: string; loser?: string } | null }[]>`
      select id, status, outcome from fixtures
      where division_id = ${stage.division_id}`;
    const withdrawn = await tx<{ id: string }[]>`
      select id from entrants
      where division_id = ${stage.division_id} and status in ('withdrawn','disqualified')`;

    const result = resolveOfficialSourcing(input.sources, {
      // snapshot rows are engine StandingsRow[] (camelCase, `rank` from the
      // ranking pass)
      standings: standingsRows.map((s) => ({
        stageId: s.stage_id,
        poolId: s.pool_id ?? undefined,
        decided: s.final,
        rows: ((s.rows as { entrantId: string; rank?: number }[]) ?? [])
          .filter((r) => r.rank !== undefined)
          .map((r) => ({ entrantId: r.entrantId, rank: r.rank! })),
      })),
      fixtures: fixturesRows.map((f) => ({
        id: f.id,
        decided: f.status === "decided",
        winnerId: f.outcome?.winner,
        loserId: f.outcome?.loser,
      })),
      withdrawnEntrantIds: withdrawn.map((w) => w.id),
    });

    const entrantIds = result.resolved.map((r) => r.entrantId);
    const names = entrantIds.length
      ? await tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where id in ${tx(entrantIds)}`
      : [];
    const nameById = new Map(names.map((n) => [n.id, n.display_name]));
    const existing = entrantIds.length
      ? await tx<{ id: string; entrant_id: string }[]>`
          select id, entrant_id from officials where entrant_id in ${tx(entrantIds)}`
      : [];
    const officialByEntrant = new Map(existing.map((o) => [o.entrant_id, o.id]));

    return {
      resolved: result.resolved.map((r) => ({
        entrant_id: r.entrantId,
        display_name: nameById.get(r.entrantId) ?? r.entrantId,
        official_id: officialByEntrant.get(r.entrantId) ?? null,
      })),
      pending: result.pending.map((p) => ({ reason: p.reason })),
    };
  });
}
