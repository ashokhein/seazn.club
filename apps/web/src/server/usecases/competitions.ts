import "server-only";
// Competition use-cases (doc 08 §3). The service layer both /api/v1 routes and
// Server Components call — the only writer. Auth happens in the route (an
// AuthCtx proves it); tenancy is enforced by withTenant + RLS.
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature, withinLimit } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import type { AuthCtx } from "@/server/api-v1/auth";
import { page, type ListQuery, type Page } from "@/server/api-v1/http";
import type { CreateCompetition, PatchCompetition } from "@/server/api-v1/schemas";
import { fireDiscoveryRevalidate, invalidateDiscoveryCache } from "@/server/public-site/revalidate";
import {
  ACTIVE_COMPETITION_STATUSES,
  assertCompetitionNotFrozen,
  frozenCompetitionIds,
} from "./entitlement-freeze";

export interface CompetitionRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  visibility: string;
  branding: unknown;
  status: string;
  created_at: string;
  /** Doc 15 §1 — opt-in showcase consent + organiser-entered presentation. */
  discoverable: boolean;
  discovery: unknown;
  /** doc 10 §2.4 — over-quota after a downgrade: read-only, never deleted. */
  frozen?: boolean;
}

const COLS = [
  "id", "org_id", "name", "slug", "description", "starts_on", "ends_on",
  "visibility", "branding", "status", "created_at", "discoverable", "discovery",
] as const;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export async function listCompetitions(
  auth: AuthCtx,
  query: ListQuery,
): Promise<Page<CompetitionRow>> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = query.cursor
      ? await tx<CompetitionRow[]>`
          select ${tx(COLS)} from competitions
          where (created_at, id) < (${query.cursor.createdAt}, ${query.cursor.id})
          order by created_at desc, id desc limit ${query.limit + 1}`
      : await tx<CompetitionRow[]>`
          select ${tx(COLS)} from competitions
          order by created_at desc, id desc limit ${query.limit + 1}`;
    const frozen = await frozenCompetitionIds(auth.orgId, tx);
    return page(rows.map((r) => ({ ...r, frozen: frozen.has(r.id) })), query.limit);
  });
}

// Doc 10 §1: `competitions.max_active` — draft/published/live competitions
// count; completed/archived don't. Enforced at the write (doc 10 §2 rule 1).
async function assertActiveQuota(auth: AuthCtx): Promise<void> {
  const count = await withTenant(auth.orgId, async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from competitions
      where status in ${tx([...ACTIVE_COMPETITION_STATUSES])}`;
    return n;
  });
  const { ok } = await withinLimit(auth.orgId, "competitions.max_active", count + 1);
  if (!ok) throw new PaymentRequiredError("competitions.max_active");
}

// Doc 10 §1: `dashboard.public.max` — Community holds 1 public competition at
// a time. Enforced here, at the write (doc 10 §2 rule 1), not in the UI.
async function assertPublicQuota(auth: AuthCtx, excludeId?: string): Promise<void> {
  const count = await withTenant(auth.orgId, async (tx) => {
    const rows = excludeId
      ? await tx<{ n: string }[]>`
          select count(*) as n from competitions
          where visibility = 'public' and id <> ${excludeId}`
      : await tx<{ n: string }[]>`
          select count(*) as n from competitions where visibility = 'public'`;
    return Number(rows[0]?.n ?? 0);
  });
  const { ok } = await withinLimit(auth.orgId, "dashboard.public.max", count + 1);
  if (!ok) throw new PaymentRequiredError("dashboard.public.max");
}

export async function createCompetition(
  auth: AuthCtx,
  input: CreateCompetition,
): Promise<CompetitionRow> {
  const slug = input.slug ?? slugify(input.name);
  await assertActiveQuota(auth);
  if (input.visibility === "public") await assertPublicQuota(auth);
  const row = await withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx`select 1 from competitions where slug = ${slug}`;
    if (existing) throw new HttpError(409, `slug '${slug}' is already in use`);
    const [created] = await tx<CompetitionRow[]>`
      insert into competitions (org_id, name, slug, description, starts_on, ends_on,
                                visibility, branding, created_by)
      values (${auth.orgId}, ${input.name}, ${slug}, ${input.description ?? null},
              ${input.starts_on ?? null}, ${input.ends_on ?? null}, ${input.visibility},
              ${tx.json(input.branding as never)}, ${auth.userId})
      returning ${tx(COLS)}`;
    return created;
  });
  // Activation event (feature 1) — first competition is the "aha" moment.
  await captureServer({
    event: EVENTS.COMPETITION_CREATED,
    distinctId: auth.userId ?? `org:${auth.orgId}`,
    orgId: auth.orgId,
    properties: { visibility: input.visibility },
  });
  return row;
}

export async function getCompetition(auth: AuthCtx, id: string): Promise<CompetitionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<CompetitionRow[]>`
      select ${tx(COLS)} from competitions where id = ${id}`;
    if (!row) throw new HttpError(404, "competition not found");
    const frozen = await frozenCompetitionIds(auth.orgId, tx);
    return { ...row, frozen: frozen.has(row.id) };
  });
}

// A frozen competition is read-only — but retiring it (status → completed/
// archived) must stay possible, or the org could never get back under quota.
function isRetirePatch(patch: PatchCompetition): boolean {
  const keys = Object.keys(patch);
  return (
    keys.length === 1 &&
    keys[0] === "status" &&
    (patch.status === "completed" || patch.status === "archived")
  );
}

export async function patchCompetition(
  auth: AuthCtx,
  id: string,
  patch: PatchCompetition,
): Promise<CompetitionRow> {
  if (!isRetirePatch(patch)) await assertCompetitionNotFrozen(auth.orgId, id);
  if (patch.visibility === "public") await assertPublicQuota(auth, id);
  // Doc 15 §5: listing is free on every tier, but the gate stays server-side
  // so a plan without the key (or a staff override) can switch it off.
  if (patch.discoverable === true) await requireFeature(auth.orgId, "discovery.listed");
  // Presentation depth is the paid layer (doc 15 §1): tagline/hero → 402.
  if (patch.discovery?.tagline || patch.discovery?.hero_image_path) {
    await requireFeature(auth.orgId, "discovery.branding");
  }
  let statusChangedTo: string | null = null;
  const { row, discoveryTouched } = await withTenant(auth.orgId, async (tx) => {
    if (patch.slug) {
      const [taken] = await tx`
        select 1 from competitions where slug = ${patch.slug} and id <> ${id}`;
      if (taken) throw new HttpError(409, `slug '${patch.slug}' is already in use`);
    }
    const [before] = await tx<{ visibility: string; discoverable: boolean; status: string }[]>`
      select visibility, discoverable, status from competitions where id = ${id}`;
    if (!before) throw new HttpError(404, "competition not found");
    if (patch.status && patch.status !== before.status) statusChangedTo = patch.status;

    const effective = { ...patch };
    const nextVisibility = patch.visibility ?? before.visibility;
    // Hard coupling (doc 15 §1): never leak a non-public competition to
    // discovery. Turning it on needs `public`; dropping visibility
    // auto-disables it in the SAME tx.
    if (effective.discoverable === true && nextVisibility !== "public") {
      throw new HttpError(422, "Only public competitions can be showcased on seazn.club");
    }
    if (nextVisibility !== "public" && before.discoverable && effective.discoverable !== false) {
      effective.discoverable = false;
    }

    const cols = Object.keys(effective) as (keyof PatchCompetition)[];
    const values = {
      ...effective,
      ...(effective.branding ? { branding: tx.json(effective.branding as never) } : {}),
      ...(effective.discovery ? { discovery: tx.json(effective.discovery as never) } : {}),
    };
    const [row] = await tx<CompetitionRow[]>`
      update competitions set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "competition not found");

    // Opt-in/out is org-level content consent — recorded as a division-
    // independent competition event in the same tx (doc 15 §1 "audited
    // who/when"; competition_events is append-only by grants).
    if (before.discoverable !== row.discoverable) {
      await tx`
        insert into competition_events (competition_id, org_id, type, payload, actor_id)
        values (${id}, ${auth.orgId},
                ${row.discoverable ? "discovery.opt_in" : "discovery.opt_out"},
                ${tx.json({ auto: effective.discoverable !== patch.discoverable } as never)},
                ${auth.userId})`;
    }

    const discoveryTouched =
      before.discoverable !== row.discoverable ||
      (row.discoverable &&
        Boolean(patch.discovery ?? patch.name ?? patch.starts_on ?? patch.ends_on ?? patch.status));
    return { row, discoveryTouched };
  });
  // Toggle-off is immediate (doc 15 §1): drop the Redis window and fire the
  // `discovery` ISR tag. Outside the tx — invalidation never rolls back a write.
  if (discoveryTouched) {
    await invalidateDiscoveryCache();
    fireDiscoveryRevalidate();
  }
  // Lifecycle events (feature 1): tournament start/finish. `active` = play is on;
  // `complete` = it's wrapped up.
  if (statusChangedTo === "active" || statusChangedTo === "complete") {
    await captureServer({
      event: statusChangedTo === "active" ? EVENTS.COMPETITION_STARTED : EVENTS.COMPETITION_COMPLETED,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { competition_id: id },
    });
  }
  return row;
}

export async function deleteCompetition(auth: AuthCtx, id: string): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    // Guard: no deleting a competition with recorded play (ledger is precious).
    const [scored] = await tx`
      select 1 from score_events e
      join fixtures f on f.id = e.fixture_id
      join divisions d on d.id = f.division_id
      where d.competition_id = ${id} limit 1`;
    if (scored) {
      throw new HttpError(409, "competition has recorded score events — archive it instead");
    }
    const deleted = await tx`delete from competitions where id = ${id} returning id`;
    if (deleted.length === 0) throw new HttpError(404, "competition not found");
  });
}
