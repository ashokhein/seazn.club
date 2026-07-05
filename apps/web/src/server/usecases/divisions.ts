import "server-only";
// Division use-cases (doc 08 §3, doc 06). Creation snapshots the merged
// variant config and PINS the sport module version (doc 02 §4) so a running
// division always replays under the rules it started with.
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { withinLimit } from "@/lib/entitlements";
import { EngineError } from "@seazn/engine/core";
import { resolveModule } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision, PatchDivision } from "@/server/api-v1/schemas";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { slugify } from "./competitions";

export interface DivisionRow {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  sport_key: string;
  variant_key: string;
  config: unknown;
  module_version: string;
  eligibility: unknown[];
  tiebreakers: string[] | null;
  status: string;
  created_at: string;
}

const COLS = [
  "id", "competition_id", "name", "slug", "sport_key", "variant_key", "config",
  "module_version", "eligibility", "tiebreakers", "status", "created_at",
] as const;

export async function listDivisions(auth: AuthCtx, competitionId: string): Promise<DivisionRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    return tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions
      where competition_id = ${competitionId} order by created_at, id`;
  });
}

export async function createDivision(
  auth: AuthCtx,
  competitionId: string,
  input: CreateDivision,
): Promise<DivisionRow> {
  const slug = input.slug ?? slugify(input.name);
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    await assertCompetitionNotFrozen(auth.orgId, competitionId, tx);

    // Doc 10 §1: `divisions.per_competition.max` (Community's real bite: 1).
    // Count in the same tx as the insert (doc 10 §2 rule 1).
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions where competition_id = ${competitionId}`;
    const quota = await withinLimit(auth.orgId, "divisions.per_competition.max", n + 1);
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

    const [dupe] = await tx`
      select 1 from divisions where competition_id = ${competitionId} and slug = ${slug}`;
    if (dupe) throw new HttpError(409, `slug '${slug}' is already in use in this competition`);

    const [row] = await tx<DivisionRow[]>`
      insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                             module_version, eligibility, tiebreakers)
      values (${competitionId}, ${input.name}, ${slug}, ${input.sport_key}, ${input.variant_key},
              ${tx.json(parsed.data as never)}, ${sport.module_version},
              ${tx.json(input.eligibility as never)},
              ${input.tiebreakers ? tx.json(input.tiebreakers as never) : null})
      returning ${tx(COLS)}`;
    return row;
  });
}

export async function getDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DivisionRow[]>`select ${tx(COLS)} from divisions where id = ${id}`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}

export async function patchDivision(
  auth: AuthCtx,
  id: string,
  patch: PatchDivision,
): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const cols = Object.keys(patch) as (keyof PatchDivision)[];
    const values = {
      ...patch,
      ...(patch.eligibility ? { eligibility: tx.json(patch.eligibility as never) } : {}),
      ...(patch.tiebreakers ? { tiebreakers: tx.json(patch.tiebreakers as never) } : {}),
    };
    const [row] = await tx<DivisionRow[]>`
      update divisions set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}
