import "server-only";
// Start-a-competition funnel (v3/07 §6): a visitor configures a competition
// BEFORE authenticating; the draft rides a single-use emailed token that both
// proves email ownership (like login_links) and carries the payload. Claiming
// creates the org (if none), the competition and a division, then lands the
// new organiser inside it.
import crypto from "node:crypto";
import { z } from "zod";
import { sql } from "@/lib/db";
import { createOrgForUser, getUserOrgs } from "@/lib/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";

const DRAFT_TTL_DAYS = 7;

export const funnelPayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    sport: z.string().min(1).max(60),
    entrants: z.number().int().min(2).max(256),
    start_date: z.string().max(10).optional(),
    format: z.string().max(40).optional(),
  })
  .strict();

export type FunnelPayload = z.infer<typeof funnelPayloadSchema>;

export interface FunnelDraft {
  id: string;
  email: string;
  payload: FunnelPayload;
}

/** Create a draft and return its single-use claim token. */
export async function createFunnelDraft(
  email: string,
  payload: FunnelPayload,
): Promise<{ id: string; token: string }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000).toISOString();
  const [row] = await sql<{ id: string }[]>`
    insert into funnel_drafts (token, email, payload, expires_at)
    values (${token}, ${email}, ${sql.json(payload)}, ${expiresAt})
    returning id`;
  return { id: row.id, token };
}

/**
 * Consume a claim token: mark it used and return the draft if it was valid,
 * unexpired and unused — otherwise null. Single-use inside one transaction,
 * exactly like login-link consumption (clicking proves email ownership).
 */
export async function consumeFunnelDraft(token: string): Promise<FunnelDraft | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<
      { id: string; email: string; payload: unknown; expires_at: string; used_at: string | null }[]
    >`
      select id, email, payload, expires_at, used_at
      from funnel_drafts where token = ${token}
      for update limit 1`;
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }
    const parsed = funnelPayloadSchema.safeParse(row.payload);
    if (!parsed.success) return null;
    await tx`update funnel_drafts set used_at = now() where id = ${row.id}`;
    return { id: row.id, email: row.email, payload: parsed.data };
  });
}

/** Map the funnel's free-text sport onto the engine catalog: an exact-name
 *  sport with its first system variant, else the generic score module. */
async function resolveSport(
  sport: string,
): Promise<{ sport_key: string; variant_key: string }> {
  const [match] = await sql<{ sport_key: string; variant_key: string }[]>`
    select s.key as sport_key, v.key as variant_key
    from sports s
    join sport_variants v on v.sport_key = s.key and v.is_system
    where lower(s.name) = ${sport.toLowerCase()}
    order by v.key
    limit 1`;
  if (match) return match;
  const [generic] = await sql<{ variant_key: string }[]>`
    select key as variant_key from sport_variants
    where sport_key = 'generic' and is_system
    order by key limit 1`;
  return { sport_key: "generic", variant_key: generic?.variant_key ?? "score" };
}

/**
 * Turn a claimed draft into real structure for `userId` and return where to
 * land: inside the new competition on the division's entrants tab. Uses the
 * standard use-cases, so quotas/slugs/audit all apply as if typed by hand.
 * Cookie work (active org) stays in the route — this is request-scope free.
 */
export async function createFromDraft(
  userId: string,
  draft: FunnelDraft,
): Promise<{ redirect: string; orgId: string }> {
  const orgs = await getUserOrgs(userId);
  const org =
    orgs[0] ?? (await createOrgForUser(userId, `${draft.payload.name} organisers`));

  const auth: AuthCtx = { orgId: org.id, via: "session", userId, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    name: draft.payload.name,
    visibility: "private",
    branding: {},
    ...(draft.payload.start_date ? { starts_on: draft.payload.start_date } : {}),
  } as never);

  const { sport_key, variant_key } = await resolveSport(draft.payload.sport);
  const division = await createDivision(auth, competition.id, {
    name: draft.payload.sport,
    sport_key,
    variant_key,
    config: {},
    eligibility: [],
  } as never);

  return {
    redirect: routes.division(org.slug, competition.slug, division.slug, "entrants"),
    orgId: org.id,
  };
}
