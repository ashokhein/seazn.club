import "server-only";
// Sponsor CRM (v10 PROMPT-56): first-class sponsor rows with tiers +
// per-competition scoping. The branding blob (lib/org-branding) stays a
// read shim — resolveSponsors falls back to it only when the table has no
// rows for the org. Tiers and competition scoping are the Pro line
// (`sponsors.tiers`); the un-tiered partner strip is free on every plan.
import { z } from "zod";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { brandingSponsors } from "@/lib/org-branding";
import type { AuthCtx } from "@/server/api-v1/auth";

export const SPONSOR_TIERS = ["title", "gold", "silver", "partner"] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

export interface SponsorRow {
  id: string;
  competition_id: string | null;
  name: string;
  url: string | null;
  logo_path: string | null;
  tier: SponsorTier;
  display_order: number;
  status: "active" | "pending" | "inactive";
  click_count: number;
  created_at: string;
}

const COLS = [
  "id", "competition_id", "name", "url", "logo_path",
  "tier", "display_order", "status", "click_count", "created_at",
] as const;

export const CreateSponsorInput = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(500).nullish(),
  logo_path: z.string().max(500).nullish(),
  tier: z.enum(SPONSOR_TIERS).default("partner"),
  competition_id: z.string().uuid().nullish(),
  status: z.enum(["active", "pending", "inactive"]).default("active"),
});
export type CreateSponsorInput = z.infer<typeof CreateSponsorInput>;

export const PatchSponsorInput = CreateSponsorInput.partial();
export type PatchSponsorInput = z.infer<typeof PatchSponsorInput>;

export const ReorderSponsorsInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderSponsorsInput = z.infer<typeof ReorderSponsorsInput>;

/** Tiers above `partner` and per-competition scoping are Pro
 *  (`sponsors.tiers`). Passing the competition lets an Event Pass lift the
 *  gate for its own competition, mirroring entry fees. */
async function assertTierAllowed(
  orgId: string,
  tier: SponsorTier | undefined,
  competitionId: string | null | undefined,
): Promise<void> {
  if ((tier && tier !== "partner") || competitionId != null) {
    await requireFeature(orgId, "sponsors.tiers", competitionId ?? undefined);
  }
}

/** Plain read for server pages (settings) — same rows as listSponsors. */
export async function listSponsorRows(orgId: string): Promise<SponsorRow[]> {
  return withTenant(orgId, (tx) => tx<SponsorRow[]>`
    select ${tx(COLS)} from sponsors
    order by array_position(array['title','gold','silver','partner'], tier),
             display_order, created_at, id`);
}

export async function listSponsors(auth: AuthCtx): Promise<SponsorRow[]> {
  return listSponsorRows(auth.orgId);
}

export async function createSponsor(
  auth: AuthCtx,
  input: CreateSponsorInput,
): Promise<SponsorRow> {
  await assertTierAllowed(auth.orgId, input.tier, input.competition_id);
  return withTenant(auth.orgId, async (tx) => {
    if (input.competition_id) {
      const [comp] = await tx`select 1 from competitions where id = ${input.competition_id}`;
      if (!comp) throw new HttpError(404, "competition not found");
    }
    const [row] = await tx<SponsorRow[]>`
      insert into sponsors (org_id, competition_id, name, url, logo_path,
                            tier, display_order, status)
      values (${auth.orgId}, ${input.competition_id ?? null}, ${input.name},
              ${input.url ?? null}, ${input.logo_path ?? null}, ${input.tier},
              (select coalesce(max(display_order), -1) + 1 from sponsors
               where competition_id is not distinct from ${input.competition_id ?? null}
                 and tier = ${input.tier}),
              ${input.status})
      returning ${tx(COLS)}`;
    return row!;
  });
}

export async function patchSponsor(
  auth: AuthCtx,
  id: string,
  patch: PatchSponsorInput,
): Promise<SponsorRow> {
  const cols = Object.keys(patch);
  if (cols.length === 0) throw new HttpError(400, "empty patch");
  // Gate only what the patch introduces: promoting to a paid tier or scoping
  // to a competition needs sponsors.tiers. Editing name/url/logo on an
  // existing tiered sponsor stays allowed after a downgrade.
  await assertTierAllowed(auth.orgId, patch.tier, patch.competition_id);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorRow[]>`
      update sponsors set ${tx(patch as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "sponsor not found");
    return row;
  });
}

export async function deleteSponsor(auth: AuthCtx, id: string): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      delete from sponsors where id = ${id} returning id`;
    if (!row) throw new HttpError(404, "sponsor not found");
  });
}

/** Persist a new display order: `ids` in the order they should render.
 *  Order is scoped per (scope, tier) group by the reads, so indices are
 *  simply assigned in sequence — groups keep their relative order. */
export async function reorderSponsors(
  auth: AuthCtx,
  input: ReorderSponsorsInput,
): Promise<{ reordered: number }> {
  return withTenant(auth.orgId, async (tx) => {
    let reordered = 0;
    for (let i = 0; i < input.ids.length; i++) {
      const [row] = await tx<{ id: string }[]>`
        update sponsors set display_order = ${i}
        where id = ${input.ids[i]!} returning id`;
      if (!row) throw new HttpError(422, "reorder references an unknown sponsor");
      reordered++;
    }
    return { reordered };
  });
}

// ---------------------------------------------------------------------------
// Public resolver (placement) — DB rows first, blob shim as fallback
// ---------------------------------------------------------------------------

export interface ResolvedSponsor {
  id: string | null; // null = blob-shim entry (no tracked redirect)
  name: string;
  url: string | null;
  logo: string | null;
  tier: SponsorTier;
}

/**
 * Sponsors for a public surface: competition-scoped rows first, then
 * org-wide, deduped by name, ordered tier rank → display_order. Falls back
 * to the branding blobs ONLY when the org has no table rows at all
 * (belt-and-braces during rollout — the backfill normally seeds them).
 * Runs on the privileged connection: public pages have no tenant context.
 * Orgs without `sponsors.tiers` get the un-tiered free strip — every row
 * collapses to `partner` so tier grouping stays a Pro-visible feature.
 */
export async function resolveSponsors(
  orgId: string,
  competitionId?: string,
  opts: { tiered?: boolean } = {},
): Promise<ResolvedSponsor[]> {
  const rows = await sql<
    (Pick<SponsorRow, "id" | "name" | "url" | "tier"> & { logo_path: string | null })[]
  >`
    select id, name, url, logo_path, tier from sponsors
    where org_id = ${orgId} and status = 'active'
      and (competition_id is null or competition_id = ${competitionId ?? null})
    order by (competition_id is null),
             array_position(array['title','gold','silver','partner'], tier),
             display_order, created_at, id`;

  let resolved: ResolvedSponsor[];
  if (rows.length > 0) {
    resolved = rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      logo: r.logo_path,
      tier: r.tier,
    }));
  } else {
    // Blob shim: competition blob first then org blob, like the old render.
    const [org] = await sql<{ branding: unknown }[]>`
      select branding from organizations where id = ${orgId}`;
    const comp = competitionId
      ? await sql<{ branding: unknown }[]>`
          select branding from competitions where id = ${competitionId}`
      : [];
    resolved = [...brandingSponsors(comp[0]?.branding), ...brandingSponsors(org?.branding)].map(
      (s) => ({
        id: null,
        name: s.name,
        url: s.url ?? null,
        logo: s.logo ?? null,
        tier: "partner" as const,
      }),
    );
  }

  const seen = new Set<string>();
  const deduped = resolved.filter((s) => !seen.has(s.name) && seen.add(s.name));
  if (opts.tiered === false) {
    return deduped.map((s) => ({ ...s, tier: "partner" as const }));
  }
  return deduped;
}
