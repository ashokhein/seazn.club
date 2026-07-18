import "server-only";
// Division use-cases (doc 08 §3, doc 06). Creation snapshots the merged
// variant config and PINS the sport module version (doc 02 §4) so a running
// division always replays under the rules it started with.
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { withinLimit, requireFeature } from "@/lib/entitlements";
import { EngineError } from "@seazn/engine/core";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";
import { resolveModule } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision, PatchDivision } from "@/server/api-v1/schemas";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { slugify, uniqueSlug, recordSlugHistory, RESERVED_ENTITY_SLUGS } from "./slugs";
import { invalidateSlugCache } from "@/server/slug-resolve";

export interface DivisionRow {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  /** Markdown (v3/06 §2), rendered on the public division page. */
  description: string | null;
  sport_key: string;
  variant_key: string;
  config: unknown;
  module_version: string;
  eligibility: unknown[];
  tiebreakers: string[] | null;
  status: string;
  officials_hide_names: boolean;
  scheduling_mode: string;
  auto_progress: boolean;
  schedule_locked: boolean;
  archived_at: string | null;
  created_at: string;
  /** Division event-ledger head — the board's optimistic token (gap 10). */
  seq: number;
  /** Youth privacy (v3/11 gap 8): auto from U-age eligibility, overridable. */
  youth: boolean;
  player_name_display: "full" | "first_initial" | null;
  /** Card identity (V274, v8): uploaded logo; null → monogram tile. */
  logo_url: string | null;
  logo_storage_path: string | null;
}

const COLS = [
  "id", "competition_id", "name", "slug", "description", "sport_key", "variant_key", "config",
  "module_version", "eligibility", "tiebreakers", "status", "officials_hide_names",
  "scheduling_mode", "auto_progress", "schedule_locked", "archived_at", "created_at",
  "seq", "youth", "player_name_display", "logo_url", "logo_storage_path",
] as const;

/** Variant choices for the Settings tab's format editor (v8) — system
 *  presets plus this org's own, deduped per key (org's wins). */
export async function listVariantOptions(
  auth: AuthCtx,
  sportKey: string,
): Promise<{ key: string; name: string }[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<{ key: string; name: string }[]>`
      select distinct on (key) key, name from sport_variants
      where sport_key = ${sportKey}
      order by key, org_id nulls last`,
  );
}

/** U-anything eligibility (maxAgeAt below 18) marks a division youth. */
export function eligibilityIsYouth(rules: unknown[]): boolean {
  return rules.some((raw) => {
    const rule = raw as { kind?: string; maxAgeAt?: number };
    return rule.kind === "age" && (rule.maxAgeAt ?? 99) < 18;
  });
}

export async function listDivisions(
  auth: AuthCtx,
  competitionId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<DivisionRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    // Archived divisions are hidden from the console (v3/09 §4) — only the
    // competition-settings "Archived divisions" list asks for them.
    return tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions
      where competition_id = ${competitionId}
      ${opts.includeArchived ? tx`` : tx`and archived_at is null`}
      order by created_at, id`;
  });
}

export async function createDivision(
  auth: AuthCtx,
  competitionId: string,
  input: CreateDivision,
): Promise<DivisionRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    await assertCompetitionNotFrozen(auth.orgId, competitionId, tx);

    // Doc 10 §1: `divisions.per_competition.max` (Community's real bite: 1).
    // Count in the same tx as the insert (doc 10 §2 rule 1). Archived
    // divisions don't count — archiving frees the slot (v3/09 §4).
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions
      where competition_id = ${competitionId} and archived_at is null`;
    const quota = await withinLimit(auth.orgId, "divisions.per_competition.max", n + 1, competitionId);
    if (!quota.ok) throw new PaymentRequiredError("divisions.per_competition.max");

    // Sport catalog carries the latest shipped module version; the division
    // pins it now and forever (doc 02 §4).
    const [sport] = await tx<{ module_version: string }[]>`
      select module_version from sports where key = ${input.sport_key}`;
    if (!sport) throw new HttpError(422, `unknown sport '${input.sport_key}'`);

    // Variant preset: system (org_id null) or this org's own (RLS scopes it).
    const [variant] = await tx<{ config: Record<string, unknown> }[]>`
      select config from sport_variants
      where sport_key = ${input.sport_key} and key = ${input.variant_key}
      order by org_id nulls last limit 1`;
    if (!variant) {
      throw new HttpError(422, `unknown variant '${input.variant_key}' for ${input.sport_key}`);
    }

    // Merge preset + overrides, then validate the snapshot through the pinned
    // module's own schema — an invalid config never reaches the DB.
    const sportModule = resolveModule(input.sport_key, sport.module_version);
    const merged = { ...variant.config, ...input.config };
    const parsed = sportModule.configSchema.safeParse(merged);
    if (!parsed.success) {
      throw new EngineError("CONFIG_INVALID", `invalid ${input.sport_key} config`, {
        issues: parsed.error.issues,
      });
    }

    // Explicit slugs 409 on collision; generated ones dedupe with "-2"
    // suffixes and skip the reserved "new" (static /d/new route).
    let slug: string;
    if (input.slug) {
      if (RESERVED_ENTITY_SLUGS.has(input.slug)) {
        throw new HttpError(422, `slug '${input.slug}' is reserved`);
      }
      const [dupe] = await tx`
        select 1 from divisions where competition_id = ${competitionId} and slug = ${input.slug}`;
      if (dupe) {
        throw new HttpError(409, `slug '${input.slug}' is already in use in this competition`);
      }
      slug = input.slug;
    } else {
      slug = await uniqueSlug(slugify(input.name), async (s) => {
        const [taken] = await tx`
          select 1 from divisions where competition_id = ${competitionId} and slug = ${s}`;
        return !!taken;
      });
    }

    const [row] = await tx<DivisionRow[]>`
      insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                             module_version, eligibility, tiebreakers, youth)
      values (${competitionId}, ${input.name}, ${slug}, ${input.sport_key}, ${input.variant_key},
              ${tx.json(parsed.data as never)}, ${sport.module_version},
              ${tx.json(input.eligibility as never)},
              ${input.tiebreakers ? tx.json(input.tiebreakers as never) : null},
              ${eligibilityIsYouth(input.eligibility)})
      returning ${tx(COLS)}`;
    return row;
  });
  // Activation funnel (feature 1): step after competition_created.
  await captureServer({
    event: EVENTS.DIVISION_CREATED,
    distinctId: auth.userId ?? `org:${auth.orgId}`,
    orgId: auth.orgId,
    properties: { sport_key: input.sport_key, competition_id: competitionId },
  });
  return row;
}

export async function getDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DivisionRow[]>`select ${tx(COLS)} from divisions where id = ${id}`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}

// ---------------------------------------------------------------------------
// Delete / archive / restore — v3/09 §4 (PROMPT-38). Graduated
// destructiveness: setup divisions hard-delete; started/resulted divisions
// archive (hidden + restorable); archived divisions purge after a 30-day
// cool-off. Owner/admin only (the route enforces the role).
// ---------------------------------------------------------------------------

const PURGE_COOL_OFF_DAYS = 30;

interface DeleteTarget {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  sport_key: string;
  status: string;
  archived_at: string | null;
}

async function auditCompetition(
  tx: postgres.TransactionSql,
  competitionId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  await tx`
    insert into competition_events (competition_id, type, payload, actor_id)
    values (${competitionId}, ${type}, ${tx.json(payload as never)}, ${actorId})`;
}

// Open registration blocks delete AND archive: registrants could still be
// paying into a division that is about to vanish (v3/09 §4).
async function assertRegistrationClosed(
  tx: postgres.TransactionSql,
  divisionId: string,
  action: "delete" | "archive",
): Promise<void> {
  const [settings] = await tx<{ enabled: boolean; closes_at: string | null }[]>`
    select enabled, closes_at from registration_settings where division_id = ${divisionId}`;
  const open =
    settings?.enabled === true &&
    (settings.closes_at === null || new Date(settings.closes_at).getTime() > Date.now());
  if (open) {
    throw new HttpError(
      409,
      `Registration is open for this division — close registration first, then ${action} it`,
      "REGISTRATION_OPEN",
    );
  }
}

/**
 * DELETE semantics: setup division (never started, nothing decided) → hard
 * delete; archived ≥30 days → purge (hard delete); anything else → 409
 * DIVISION_HAS_RESULTS with the `{archive: true}` hint. Frozen competitions
 * are NOT blocked: deleting reduces usage, which is the honest way out of an
 * over-quota freeze.
 */
export async function deleteDivision(auth: AuthCtx, id: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<DeleteTarget[]>`
      select id, competition_id, name, slug, sport_key, status, archived_at
      from divisions where id = ${id}`;
    if (!division) throw new HttpError(404, "division not found");
    await assertRegistrationClosed(tx, id, "delete");

    // Money records must outlive mistakes (spec 2026-07-12 issue #10): a hard
    // delete cascades the registrations away, so block it while any card
    // payment on this division is not fully refunded. Archive stays open.
    const [{ live_payments }] = await tx<{ live_payments: number }[]>`
      select count(*)::int as live_payments from registrations
      where division_id = ${id} and payment_intent_id is not null
        and refunded_cents < amount_cents`;
    if (live_payments > 0) {
      throw new HttpError(
        409,
        "Registrations here hold card payments — refund them before deleting, or archive instead",
        "REGISTRATION_PAYMENTS",
        { archive: true },
      );
    }

    const [{ decided }] = await tx<{ decided: number }[]>`
      select count(*)::int as decided from fixtures
      where division_id = ${id} and status in ('decided', 'finalized', 'forfeited')`;

    if (division.archived_at !== null) {
      // Purge path: archived divisions hard-delete after the cool-off.
      const ageMs = Date.now() - new Date(division.archived_at).getTime();
      const coolOffMs = PURGE_COOL_OFF_DAYS * 24 * 60 * 60 * 1000;
      if (ageMs < coolOffMs) {
        const daysLeft = Math.ceil((coolOffMs - ageMs) / (24 * 60 * 60 * 1000));
        throw new HttpError(
          409,
          `An archived division can be purged ${PURGE_COOL_OFF_DAYS} days after archiving — ${daysLeft} day(s) to go`,
          "ARCHIVE_COOL_OFF",
        );
      }
    } else if (division.status !== "setup" || decided > 0) {
      throw new HttpError(
        409,
        "This division has started or has recorded results — archive it instead (restorable), or purge it 30 days after archiving",
        "DIVISION_HAS_RESULTS",
        { archive: true },
      );
    }

    const [{ entrants }] = await tx<{ entrants: number }[]>`
      select count(*)::int as entrants from entrants where division_id = ${id}`;
    const [{ fixtures }] = await tx<{ fixtures: number }[]>`
      select count(*)::int as fixtures from fixtures where division_id = ${id}`;

    // The division ledger dies with the row (ON DELETE CASCADE); the audit
    // fact lives on the competition ledger, which survives (v3/09 §4).
    // Persons/teams/clubs are org-level rows — untouched by design.
    await auditCompetition(
      tx,
      division.competition_id,
      division.archived_at !== null ? "division_purged" : "division_deleted",
      {
        division_id: id,
        name: division.name,
        slug: division.slug,
        sport_key: division.sport_key,
        entrants,
        fixtures,
        decided_fixtures: decided,
      },
      auth.userId,
    );
    await tx`delete from divisions where id = ${id}`;
  });
}

/** Archive: hide from console/public/quota, restorable. Idempotent. */
export async function archiveDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions where id = ${id}`;
    if (!existing) throw new HttpError(404, "division not found");
    if (existing.archived_at !== null) return existing;
    await assertRegistrationClosed(tx, id, "archive");

    const [row] = await tx<DivisionRow[]>`
      update divisions set archived_at = now() where id = ${id} returning ${tx(COLS)}`;
    await auditCompetition(
      tx,
      existing.competition_id,
      "division_archived",
      { division_id: id, name: existing.name, slug: existing.slug },
      auth.userId,
    );
    return row as DivisionRow;
  });
}

/** Restore an archived division. Re-checks the divisions quota — restoring
 *  must not smuggle a competition back over its plan limit. */
export async function restoreDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions where id = ${id}`;
    if (!existing) throw new HttpError(404, "division not found");
    if (existing.archived_at === null) return existing;

    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions
      where competition_id = ${existing.competition_id} and archived_at is null`;
    const quota = await withinLimit(
      auth.orgId,
      "divisions.per_competition.max",
      n + 1,
      existing.competition_id,
    );
    if (!quota.ok) throw new PaymentRequiredError("divisions.per_competition.max");

    const [row] = await tx<DivisionRow[]>`
      update divisions set archived_at = null where id = ${id} returning ${tx(COLS)}`;
    await auditCompetition(
      tx,
      existing.competition_id,
      "division_restored",
      { division_id: id, name: existing.name, slug: existing.slug },
      auth.userId,
    );
    return row as DivisionRow;
  });
}

// Structural comparison for the format-lock exemption below. Sorts object keys
// so two configs compare equal regardless of insertion order (pragmatic
// deep-equal — no shared helper exists). Arrays keep their order.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

function withoutEntrants(config: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) if (k !== "entrants") rest[k] = v;
  return rest;
}

export async function patchDivision(
  auth: AuthCtx,
  id: string,
  patch: PatchDivision,
): Promise<DivisionRow> {
  // Jul3/08 §8: auto-advance is part of the advanced-formats Pro layer (or
  // an Event Pass on this division's competition, v3/07 §3).
  if (patch.auto_progress === true) {
    const [d] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${id}`;
    await requireFeature(auth.orgId, "formats.advanced", d?.competition_id);
  }
  let previousSlug: string | null = null;
  let previousCompetitionId: string | null = null;
  const row = await withTenant(auth.orgId, async (tx) => {
    const effective: Record<string, unknown> = { ...patch };
    // Format edits (v8 spec §2): allowed only while no stage owns fixtures,
    // then re-validated exactly like create — variant preset merged with the
    // override and parsed by the PINNED module's schema.
    if (patch.variant_key !== undefined || patch.config !== undefined) {
      const [current] = await tx<
        {
          sport_key: string;
          module_version: string;
          variant_key: string;
          config: Record<string, unknown> | null;
        }[]
      >`select sport_key, module_version, variant_key, config from divisions where id = ${id}`;
      if (!current) throw new HttpError(404, "division not found");
      const variantKey = patch.variant_key ?? current.variant_key;
      const [variant] = await tx<{ config: Record<string, unknown> }[]>`
        select config from sport_variants
        where sport_key = ${current.sport_key} and key = ${variantKey}
        order by org_id nulls last limit 1`;
      if (!variant) {
        throw new HttpError(422, `unknown variant '${variantKey}' for ${current.sport_key}`);
      }
      const sportModule = resolveModule(current.sport_key, current.module_version);
      const merged = { ...variant.config, ...(patch.config ?? {}) };
      const parsed = sportModule.configSchema.safeParse(merged);
      if (!parsed.success) {
        throw new EngineError("CONFIG_INVALID", `invalid ${current.sport_key} config`, {
          issues: parsed.error.issues,
        });
      }
      // The entrant-shape override (spec 2026-07-18) rides in `config.entrants`
      // but is NOT part of the sport's configSchema, which strips unknown keys —
      // so carry it through the parse explicitly. Absent from the incoming
      // config → the override is cleared back to the module default.
      const finalConfig = parsed.data as Record<string, unknown>;
      const incomingEntrants = (patch.config as { entrants?: unknown } | undefined)?.entrants;
      if (incomingEntrants != null && typeof incomingEntrants === "object") {
        finalConfig.entrants = incomingEntrants;
      }
      // Format lock (v8 spec §2): once a stage owns fixtures the format is
      // immutable — EXCEPT an entrants-only change. Entrant shapes are not
      // format; organisers may legitimately widen kinds or flip captain/№
      // mid-season, and the ENTRANT_KIND_IN_USE guard below already blocks a
      // narrowing that would orphan an entrant. So when locked, allow the patch
      // only if the variant is unchanged and the merged config differs from the
      // stored one solely in `entrants`; anything else → 409 FORMAT_LOCKED.
      const [{ locked }] = await tx<{ locked: boolean }[]>`
        select exists(
          select 1 from fixtures f
          join stages s on s.id = f.stage_id
          where s.division_id = ${id}
        ) as locked`;
      if (locked) {
        const variantChanged =
          patch.variant_key !== undefined && patch.variant_key !== current.variant_key;
        const nonEntrantsChanged =
          canonicalJson(withoutEntrants(finalConfig)) !==
          canonicalJson(withoutEntrants((current.config ?? {}) as Record<string, unknown>));
        if (variantChanged || nonEntrantsChanged) {
          throw new HttpError(409, "Format is locked — fixtures exist", "FORMAT_LOCKED");
        }
      }
      // Narrowing the allowed kinds must not orphan entrants that already exist:
      // an active entrant of a kind the new model no longer accepts would become
      // unschedulable. Reject with 422 ENTRANT_KIND_IN_USE — withdraw first.
      const nextModel = effectiveEntrantModel(sportModule.entrantModel ?? null, finalConfig);
      const inUse = await tx<{ kind: string }[]>`
        select distinct kind from entrants
        where division_id = ${id} and status not in ('withdrawn', 'disqualified')`;
      for (const { kind } of inUse) {
        if (!nextModel.kinds.includes(kind as EntrantKind)) {
          throw new HttpError(
            422,
            `entrants of kind '${kind}' already exist — withdraw them first`,
            "ENTRANT_KIND_IN_USE",
          );
        }
      }
      effective.variant_key = variantKey;
      effective.config = tx.json(finalConfig as never);
    }
    // Eligibility edits re-derive the youth flag unless the same patch sets
    // it explicitly (v3/11 gap 8 — auto with organiser override).
    if (patch.eligibility !== undefined && patch.youth === undefined) {
      effective.youth = eligibilityIsYouth(patch.eligibility);
    }
    // Rename regenerates the slug (v3/01 §2); old slug keeps redirecting.
    if (patch.name) {
      const [before] = await tx<{ name: string; slug: string; competition_id: string }[]>`
        select name, slug, competition_id from divisions where id = ${id}`;
      if (!before) throw new HttpError(404, "division not found");
      if (patch.name !== before.name) {
        const regenerated = await uniqueSlug(slugify(patch.name), async (s) => {
          const [taken] = await tx`
            select 1 from divisions
            where competition_id = ${before.competition_id} and slug = ${s} and id <> ${id}`;
          return !!taken;
        });
        if (regenerated !== before.slug) {
          effective.slug = regenerated;
          await recordSlugHistory(tx, "division", before.competition_id, before.slug, id);
          previousSlug = before.slug;
          previousCompetitionId = before.competition_id;
        }
      }
    }
    const cols = Object.keys(effective);
    const values = {
      ...effective,
      ...(patch.eligibility ? { eligibility: tx.json(patch.eligibility as never) } : {}),
      ...(patch.tiebreakers ? { tiebreakers: tx.json(patch.tiebreakers as never) } : {}),
    };
    const [row] = await tx<DivisionRow[]>`
      update divisions set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
  // A rename busts the cached slug resolution (old + new key) — outside the
  // tx, matching the pattern in patchCompetition.
  if (previousSlug) {
    await invalidateSlugCache("division", previousCompetitionId, previousSlug, row.slug);
  }
  return row;
}
