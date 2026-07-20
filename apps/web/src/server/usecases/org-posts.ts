import "server-only";
// SPEC-2 / PROMPT-82 — org news posts. Manual composer posts are FREE on every
// plan (the PLG ad-network thesis); the auto-drafting of result/round_recap
// posts on the decided-write seam is Pro (`news.auto`). CRUD runs on the tenant
// rail (organiser console); public reads go through the superuser sql
// connection filtered status='published' + competition visibility (the
// publicDivisionStats guard chain). Slug is slugify(title) with a `-2` collision
// suffix and FROZEN at first publish (edits after publish keep the URL — a
// data-model invariant enforced here, not just in the UI). Auto-draft
// idempotency is the V295 partial unique index (org_posts_auto_once), never an
// app pre-check; a void/re-decide stamps auto_source.stale on the DRAFT only.
import type postgres from "postgres";
import { aggregatePlayerStats } from "@seazn/engine/stats";
import type { EventEnvelope } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { firePostRevalidate } from "@/server/public-site/revalidate";
import { hasFeature } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";
import { slugify, uniqueSlug } from "./slugs";
import { resultDraft, roundRecapDraft } from "@/server/news/draft-templates";

type Tx = postgres.TransactionSql;
const superuser = sql as unknown as Tx;

export type PostKind = "news" | "result" | "round_recap" | "announcement";
export type PostStatus = "draft" | "published" | "archived";

export interface OrgPost {
  id: string;
  orgId: string;
  competitionId: string | null;
  divisionId: string | null;
  kind: PostKind;
  status: PostStatus;
  slug: string;
  title: string;
  bodyMd: string;
  heroImagePath: string | null;
  autoSource: {
    trigger: string;
    stale?: boolean;
    fixture_id?: string;
    division_id?: string;
    stage_id?: string;
    round_no?: number;
  } | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Decided-seam triggers (auto_source.trigger). The V295 partial unique index
// keys result on fixture_id, round_recap on division_id + stage_id + round_no
// (round numbers restart per stage — fixtures' natural key is stage+round+seq).
const TRIGGER_RESULT = "fixture_decided";
const TRIGGER_RECAP = "round_complete";

/** post_published fires only on the transition INTO published (mirrors
 *  competitions.shouldFireMadePublic): a publish action from any non-published
 *  status. Editing an already-published post (no action) never re-fires. */
export function shouldFirePostPublished(
  prevStatus: PostStatus,
  action: "publish" | "archive" | undefined,
): boolean {
  return action === "publish" && prevStatus !== "published";
}
// League-stage kinds carry a table, so the standings-movement line + recap make
// sense only for these (mirrors scoring.ts TABLE_KINDS).
const TABLE_KINDS = new Set(["league", "group", "swiss"]);
const DECIDED = new Set(["decided", "finalized", "forfeited"]);
const RECAP_STANDINGS_TOP = 5;

interface OrgPostRow {
  id: string;
  org_id: string;
  competition_id: string | null;
  division_id: string | null;
  kind: PostKind;
  status: PostStatus;
  slug: string;
  title: string;
  body_md: string;
  hero_image_path: string | null;
  auto_source: OrgPost["autoSource"];
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = (tx: Tx) => tx`
  id, org_id, competition_id, division_id, kind, status, slug, title, body_md,
  hero_image_path, auto_source, published_at, created_at, updated_at`;

function mapPost(r: OrgPostRow): OrgPost {
  return {
    id: r.id,
    orgId: r.org_id,
    competitionId: r.competition_id,
    divisionId: r.division_id,
    kind: r.kind,
    status: r.status,
    slug: r.slug,
    title: r.title,
    bodyMd: r.body_md,
    heroImagePath: r.hero_image_path,
    autoSource: r.auto_source,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Console CRUD (tenant rail). Manual posts are ungated — free on every plan.
// ---------------------------------------------------------------------------

export async function listPosts(
  auth: AuthCtx,
  orgId: string,
  status?: PostStatus,
): Promise<OrgPost[]> {
  void orgId; // RLS scopes to auth.orgId; the route proved auth against this org.
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<OrgPostRow[]>`
      select ${COLS(tx)} from org_posts
      where org_id = ${auth.orgId}
      ${status ? tx`and status = ${status}` : tx``}
      order by coalesce(published_at, created_at) desc, id`;
    return rows.map(mapPost);
  });
}

/** Assert a competition/division belongs to the auth org (defense-in-depth: FKs
 *  bypass RLS, so a cross-org scope id would otherwise FK-succeed). */
async function assertScope(
  tx: Tx,
  competitionId: string | undefined,
  divisionId: string | undefined,
): Promise<void> {
  if (competitionId) {
    const [c] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!c) throw new HttpError(404, "competition not found");
  }
  if (divisionId) {
    const [d] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!d) throw new HttpError(404, "division not found");
  }
}

export async function createPost(
  auth: AuthCtx,
  orgId: string,
  input: {
    title: string;
    bodyMd?: string;
    kind?: PostKind;
    competitionId?: string;
    divisionId?: string;
    heroImagePath?: string;
  },
): Promise<OrgPost> {
  void orgId;
  return withTenant(auth.orgId, async (tx) => {
    await assertScope(tx, input.competitionId, input.divisionId);
    const slug = await uniqueSlug(slugify(input.title), (s) => slugTaken(tx, auth.orgId, s));
    const [row] = await tx<OrgPostRow[]>`
      insert into org_posts
        (org_id, competition_id, division_id, author_user_id, kind, status, slug,
         title, body_md, hero_image_path)
      values (${auth.orgId}, ${input.competitionId ?? null}, ${input.divisionId ?? null},
              ${auth.userId}, ${input.kind ?? "news"}, 'draft', ${slug}, ${input.title},
              ${input.bodyMd ?? ""}, ${input.heroImagePath ?? null})
      returning ${COLS(tx)}`;
    const post = mapPost(row!);
    await captureServer({
      event: EVENTS.POST_CREATED,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { kind: post.kind },
    });
    return post;
  });
}

async function slugTaken(tx: Tx, orgId: string, slug: string, exceptId?: string): Promise<boolean> {
  const [row] = await tx`
    select 1 from org_posts
    where org_id = ${orgId} and slug = ${slug}
    ${exceptId ? tx`and id <> ${exceptId}` : tx``}`;
  return !!row;
}

export async function updatePost(
  auth: AuthCtx,
  id: string,
  input: {
    title?: string;
    bodyMd?: string;
    heroImagePath?: string | null;
    competitionId?: string | null;
    divisionId?: string | null;
    action?: "publish" | "archive";
  },
): Promise<OrgPost> {
  return withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<
      { id: string; status: PostStatus; slug: string; title: string; published_at: Date | null }[]
    >`select id, status, slug, title, published_at from org_posts where id = ${id}`;
    if (!existing) throw new HttpError(404, "post not found");

    await assertScope(
      tx,
      input.competitionId ?? undefined,
      input.divisionId ?? undefined,
    );

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.bodyMd !== undefined) patch.body_md = input.bodyMd;
    if (input.heroImagePath !== undefined) patch.hero_image_path = input.heroImagePath;
    if (input.competitionId !== undefined) patch.competition_id = input.competitionId;
    if (input.divisionId !== undefined) patch.division_id = input.divisionId;

    // Slug freeze (SPEC-2 invariant): the URL regenerates on a title change ONLY
    // while the post has never been published; once published_at is stamped the
    // slug is frozen for good (edits keep the URL), archive included.
    const neverPublished = existing.published_at === null;
    if (input.title !== undefined && input.title !== existing.title && neverPublished) {
      patch.slug = await uniqueSlug(slugify(input.title), (s) => slugTaken(tx, auth.orgId, s, id));
    }

    if (input.action === "publish") {
      patch.status = "published";
      if (neverPublished) patch.published_at = new Date(); // stamp once, then frozen
    } else if (input.action === "archive") {
      patch.status = "archived";
    }

    const cols = Object.keys(patch);
    const [row] = await tx<OrgPostRow[]>`
      update org_posts set ${tx(patch as never, ...(cols as never[]))}
      where id = ${id}
      returning ${COLS(tx)}`;
    const post = mapPost(row!);
    if (input.action) {
      // Status flipped — purge the ISR'd public page so archive/republish
      // takes effect on the next request, not after the 30s window.
      const [org] = await tx<{ slug: string }[]>`
        select slug from organizations where id = ${auth.orgId}`;
      if (org) firePostRevalidate(org.slug, post.slug);
    }
    if (shouldFirePostPublished(existing.status, input.action)) {
      await captureServer({
        event: EVENTS.POST_PUBLISHED,
        distinctId: auth.userId ?? `org:${auth.orgId}`,
        orgId: auth.orgId,
        // { kind, auto }: an auto-draft carries auto_source; a manual post does not.
        properties: { kind: post.kind, auto: post.autoSource !== null },
      });
    }
    return post;
  });
}

export async function getPost(auth: AuthCtx, id: string): Promise<OrgPost> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<OrgPostRow[]>`
      select ${COLS(tx)} from org_posts where id = ${id}`;
    if (!row) throw new HttpError(404, "post not found");
    return mapPost(row);
  });
}

export async function deletePost(auth: AuthCtx, id: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ slug: string }[]>`
      delete from org_posts where id = ${id} returning slug`;
    if (!row) throw new HttpError(404, "post not found");
    const [org] = await tx<{ slug: string }[]>`
      select slug from organizations where id = ${auth.orgId}`;
    if (org) firePostRevalidate(org.slug, row.slug);
  });
}

// ---------------------------------------------------------------------------
// Public reads (superuser sql; published only; competition-visibility guard).
// Org-level posts (no competition) are always public — the org page has no
// visibility gate; a competition-scoped post inherits its competition's gate.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

const PUBLIC_WHERE = (tx: Tx, orgSlug: string) => tx`
  o.slug = ${orgSlug}
  and p.status = 'published'
  and (p.competition_id is null or c.visibility in ('public','unlisted'))`;

export async function publicPosts(
  orgSlug: string,
  page = 0,
): Promise<{ posts: OrgPost[]; hasMore: boolean }> {
  const offset = Math.max(0, Math.trunc(page)) * PAGE_SIZE;
  const rows = await superuser<OrgPostRow[]>`
    select p.*
    from org_posts p
    join organizations o on o.id = p.org_id
    left join competitions c on c.id = p.competition_id
    where ${PUBLIC_WHERE(superuser, orgSlug)}
    order by p.published_at desc, p.id
    limit ${PAGE_SIZE + 1} offset ${offset}`;
  const hasMore = rows.length > PAGE_SIZE;
  return { posts: rows.slice(0, PAGE_SIZE).map(mapPost), hasMore };
}

export async function publicPost(orgSlug: string, postSlug: string): Promise<OrgPost> {
  const [row] = await superuser<OrgPostRow[]>`
    select p.*
    from org_posts p
    join organizations o on o.id = p.org_id
    left join competitions c on c.id = p.competition_id
    where ${PUBLIC_WHERE(superuser, orgSlug)} and p.slug = ${postSlug}`;
  if (!row) throw new HttpError(404, "post not found");
  return mapPost(row);
}

// ---------------------------------------------------------------------------
// Decided-seam auto-draft hook (SPEC-2). Called from scoring.ts on the
// decided/void write. Probes divisions.auto_posts + the live news.auto
// entitlement, builds drafts via the pure templates, inserts on-conflict-do-
// nothing. Never auto-edits/publishes/deletes; a void stamps stale on the DRAFT.
// ---------------------------------------------------------------------------

interface FixtureCtx {
  fixture_id: string;
  org_id: string;
  division_id: string;
  competition_id: string;
  stage_id: string;
  stage_kind: string;
  round_no: number | null;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_name: string | null;
  away_name: string | null;
  scheduled_at: Date | null;
  venue: string | null;
  venue_tz: string | null;
  division_name: string;
  competition_name: string;
  sport_key: string;
  module_version: string;
  auto_posts: boolean;
  default_locale: string | null;
}

interface SideSummary {
  entrantId: string;
  line: string;
}

function sideLine(summary: unknown, entrantId: string | null): string {
  if (!entrantId) return "";
  const perSide = (summary as { perSide?: SideSummary[] } | null)?.perSide;
  return perSide?.find((s) => s.entrantId === entrantId)?.line ?? "";
}

export async function draftPostsForDecidedFixture(tx: Tx, fixtureId: string): Promise<void> {
  const [fx] = await tx<FixtureCtx[]>`
    select f.id as fixture_id, f.org_id, f.division_id, d.competition_id, f.stage_id,
           st.kind as stage_kind, f.round_no, f.status,
           f.home_entrant_id, f.away_entrant_id,
           h.display_name as home_name, a.display_name as away_name,
           f.scheduled_at, f.venue, coalesce(ss.tz, vorg.timezone, 'UTC') as venue_tz,
           d.name as division_name, c.name as competition_name,
           d.sport_key, d.module_version, d.auto_posts, o.default_locale
    from fixtures f
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = f.org_id
    join stages st on st.id = f.stage_id
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations vorg on vorg.id = d.org_id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where f.id = ${fixtureId}`;
  // Cheap probe: opt-in division only, and Pro news.auto live (a community org
  // whose toggle somehow reads true still gets no draft).
  if (!fx || !fx.auto_posts) return;
  if (!(await hasFeature(fx.org_id, "news.auto"))) return;

  const locale: Locale = toLocale(fx.default_locale);
  const decided = DECIDED.has(fx.status);

  if (!decided) {
    // A void erased the decision → stamp stale on the DRAFT(s) for this fixture /
    // round; published posts are never touched (SPEC-2). Re-decide re-enters via
    // the decided branch and the unique index keeps the count at one.
    await staleDrafts(tx, fx);
    return;
  }

  await draftResult(tx, fx, locale);
  if (fx.round_no !== null && TABLE_KINDS.has(fx.stage_kind)) {
    await maybeDraftRecap(tx, fx, locale);
  }
}

async function staleDrafts(tx: Tx, fx: FixtureCtx): Promise<void> {
  await tx`
    update org_posts
    set auto_source = coalesce(auto_source, '{}'::jsonb) || jsonb_build_object('stale', true),
        updated_at = now()
    where org_id = ${fx.org_id} and status = 'draft'
      and auto_source->>'trigger' = ${TRIGGER_RESULT}
      and auto_source->>'fixture_id' = ${fx.fixture_id}`;
  if (fx.round_no !== null) {
    await tx`
      update org_posts
      set auto_source = coalesce(auto_source, '{}'::jsonb) || jsonb_build_object('stale', true),
          updated_at = now()
      where org_id = ${fx.org_id} and status = 'draft'
        and auto_source->>'trigger' = ${TRIGGER_RECAP}
        and auto_source->>'division_id' = ${fx.division_id}
        and auto_source->>'stage_id' = ${fx.stage_id}
        and auto_source->>'round_no' = ${String(fx.round_no)}`;
  }
}

async function draftResult(tx: Tx, fx: FixtureCtx, locale: Locale): Promise<void> {
  const [state] = await tx<{ summary: unknown }[]>`
    select summary from match_states where fixture_id = ${fx.fixture_id}`;
  const scorers = await extractScorers(tx, fx);
  const movement = TABLE_KINDS.has(fx.stage_kind)
    ? await winnerMovement(tx, fx)
    : null;

  const { title, bodyMd } = resultDraft({
    locale,
    homeName: fx.home_name ?? "TBD",
    awayName: fx.away_name ?? "TBD",
    homeScore: sideLine(state?.summary, fx.home_entrant_id),
    awayScore: sideLine(state?.summary, fx.away_entrant_id),
    competitionName: fx.competition_name,
    divisionName: fx.division_name,
    venue: fx.venue,
    scheduledAt: fx.scheduled_at ? fx.scheduled_at.toISOString() : null,
    venueTz: fx.venue_tz,
    ...(scorers.length > 0 ? { scorers } : {}),
    movement,
  });

  const autoSource = {
    trigger: TRIGGER_RESULT,
    fixture_id: fx.fixture_id,
    division_id: fx.division_id,
    ...(fx.round_no !== null ? { round_no: fx.round_no } : {}),
    stale: false,
  };
  await insertDraft(tx, fx, "result", title, bodyMd, autoSource);
}

async function maybeDraftRecap(tx: Tx, fx: FixtureCtx, locale: Locale): Promise<void> {
  const roundNo = fx.round_no!;
  // Round numbers restart per stage (natural key stage+round+seq) — scope the
  // completeness probe to THIS stage, else a scheduled knockout round 1 blocks
  // the group round 1 recap forever.
  const [{ open }] = await tx<{ open: number }[]>`
    select count(*) filter (where status not in ('decided','finalized','forfeited'))::int as open
    from fixtures
    where division_id = ${fx.division_id} and stage_id = ${fx.stage_id} and round_no = ${roundNo}`;
  if (open > 0) return; // round not complete yet

  const resultRows = await tx<
    { home_name: string | null; away_name: string | null; home_id: string | null; away_id: string | null; summary: unknown }[]
  >`
    select h.display_name as home_name, a.display_name as away_name,
           f.home_entrant_id as home_id, f.away_entrant_id as away_id, m.summary
    from fixtures f
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    left join match_states m on m.fixture_id = f.id
    where f.division_id = ${fx.division_id} and f.stage_id = ${fx.stage_id} and f.round_no = ${roundNo}
    order by f.fixture_no nulls last, f.id`;
  const results = resultRows.map((r) => ({
    homeName: r.home_name ?? "TBD",
    awayName: r.away_name ?? "TBD",
    homeScore: sideLine(r.summary, r.home_id),
    awayScore: sideLine(r.summary, r.away_id),
  }));

  const standings = await topStandings(tx, fx.stage_id);

  const { title, bodyMd } = roundRecapDraft({
    locale,
    competitionName: fx.competition_name,
    divisionName: fx.division_name,
    roundNo,
    results,
    standings,
  });
  const autoSource = {
    trigger: TRIGGER_RECAP,
    division_id: fx.division_id,
    stage_id: fx.stage_id,
    round_no: roundNo,
    stale: false,
  };
  await insertDraft(tx, fx, "round_recap", title, bodyMd, autoSource);
}

async function insertDraft(
  tx: Tx,
  fx: FixtureCtx,
  kind: PostKind,
  title: string,
  bodyMd: string,
  autoSource: Record<string, unknown>,
): Promise<void> {
  const slug = await uniqueSlug(slugify(title), (s) => slugTaken(tx, fx.org_id, s));
  await tx`
    insert into org_posts
      (org_id, competition_id, division_id, author_user_id, kind, status, slug,
       title, body_md, auto_source)
    values (${fx.org_id}, ${fx.competition_id}, ${fx.division_id}, null, ${kind}, 'draft',
            ${slug}, ${title}, ${bodyMd}, ${tx.json(autoSource as never)})
    on conflict do nothing`;
}

/** Scorers list for the result draft: the fixture's ledger folded through the
 *  sport's playerStats model on the "goals" metric (best-effort — a fold hiccup
 *  yields no scorers line, never a failed draft). */
async function extractScorers(
  tx: Tx,
  fx: FixtureCtx,
): Promise<{ name: string; count: number }[]> {
  try {
    const model = resolveModule(fx.sport_key, fx.module_version).playerStats;
    if (!model) return [];
    const metric =
      model.metrics.find((m) => m.key === "goals") ?? model.metrics[0];
    if (!metric) return [];
    const events = await tx<
      { id: string; seq: number; type: string; payload: unknown; voids_event_id: string | null }[]
    >`
      select id, seq, type, payload, voids_event_id from score_events
      where fixture_id = ${fx.fixture_id} order by seq`;
    const ledger = events.map(
      (e) =>
        ({
          id: e.id,
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          recordedAt: new Date().toISOString(),
          ...(e.voids_event_id !== null ? { voids: e.voids_event_id } : {}),
        }) as EventEnvelope,
    );
    const rows = aggregatePlayerStats(ledger, model)
      .filter((r) => (r.stats[metric.key] ?? 0) > 0)
      .sort((a, b) => (b.stats[metric.key] ?? 0) - (a.stats[metric.key] ?? 0));
    if (rows.length === 0) return [];
    const names = new Map(
      (
        await tx<{ id: string; full_name: string }[]>`
          select id, full_name from persons where id = any(${rows.map((r) => r.personId)})`
      ).map((p) => [p.id, p.full_name]),
    );
    return rows
      .filter((r) => names.has(r.personId))
      .map((r) => ({ name: names.get(r.personId)!, count: r.stats[metric.key] ?? 0 }));
  } catch {
    return [];
  }
}

/** The just-won entrant's current table position, for the "moves up to Nth"
 *  line (league stages only; best-effort). */
async function winnerMovement(
  tx: Tx,
  fx: FixtureCtx,
): Promise<{ team: string; position: number } | null> {
  try {
    const [state] = await tx<{ outcome: unknown }[]>`
      select outcome from fixtures where id = ${fx.fixture_id}`;
    const outcome = state?.outcome as { kind?: string; winner?: string } | null;
    if (!outcome || (outcome.kind !== "win" && outcome.kind !== "award") || !outcome.winner) {
      return null;
    }
    const rows = await topStandings(tx, fx.stage_id, Number.MAX_SAFE_INTEGER);
    const [row] = await tx<{ display_name: string }[]>`
      select display_name from entrants where id = ${outcome.winner}`;
    const idx = rows.findIndex((r) => r.entrantId === outcome.winner);
    if (idx < 0 || !row) return null;
    return { team: row.display_name, position: rows[idx]!.position };
  } catch {
    return null;
  }
}

interface StandingRow {
  entrantId: string;
  position: number;
  name: string;
  played: number;
  points: number;
}

/** Top of the stage table from standings_snapshots (JSON rows), entrant names
 *  resolved, ranked by the engine's `rank` (falls back to array order). */
async function topStandings(tx: Tx, stageId: string, top = RECAP_STANDINGS_TOP): Promise<StandingRow[]> {
  const rows = await tx<
    { rows: { entrantId: string; played: number; points: number; rank?: number }[] }[]
  >`
    select rows from standings_snapshots where stage_id = ${stageId} and pool_id is null`;
  const table = rows[0]?.rows;
  if (!table || table.length === 0) return [];
  const sorted = [...table].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
  const wanted = sorted.slice(0, top);
  const names = new Map(
    (
      await tx<{ id: string; display_name: string }[]>`
        select id, display_name from entrants where id = any(${wanted.map((r) => r.entrantId)})`
    ).map((e) => [e.id, e.display_name]),
  );
  return wanted.map((r, i) => ({
    entrantId: r.entrantId,
    position: r.rank ?? i + 1,
    name: names.get(r.entrantId) ?? "—",
    played: r.played,
    points: r.points,
  }));
}
