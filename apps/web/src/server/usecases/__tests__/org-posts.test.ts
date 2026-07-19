// PROMPT-82 — org news CRUD + decided-seam auto-drafts (SPEC-2). DB-backed;
// skipped without DATABASE_URL. Seeds orgs/divisions/fixtures with raw SQL and
// exercises: slug collision + publish freeze, archive/delete, ungated manual
// posts on community, listPosts filter, RLS isolation, public visibility guard,
// and the auto-draft hook (result draft, idempotency, void→stale, live
// entitlement probe, round recap, opt-in gate, scoring seam).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";

import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  createPost,
  updatePost,
  deletePost,
  getPost,
  listPosts,
  publicPosts,
  publicPost,
  draftPostsForDecidedFixture,
} from "../org-posts";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;
// Full parsed football config — the module's fold needs it to initialize state
// (an empty {} makes applyForfeit read undefined score fields).
const FOOTBALL_CFG = builtinModules.find((m) => m.key === "football")!.configSchema.parse({});

interface Ctx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
  orgSlug: string;
}

async function seedOrg(plan: "pro" | "community" = "pro"): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`news-${suffix}@test.local`}, 'News', true) returning id`;
  const orgSlug = "news-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, default_locale)
    values (${"News " + suffix}, ${orgSlug}, ${userId}, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  if (plan === "pro") {
    await sql`
      insert into subscriptions (org_id, plan_key, status) values (${orgId}, 'pro', 'active')
      on conflict (org_id) do update set plan_key = 'pro'`;
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 11, benchMax: 12 } })})
    on conflict (key) do nothing`;
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId,
    userId,
    orgSlug,
  };
}

interface DivCtx {
  compId: string;
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
}

async function seedDivision(
  ctx: Ctx,
  opts: { autoPosts?: boolean; visibility?: string } = {},
): Promise<DivCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${ctx.orgId}, 'Cup', ${"cup-" + suffix}, ${opts.visibility ?? "public"}, ${ctx.userId})
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key,
      config, module_version, auto_posts)
    values (${compId}, ${ctx.orgId}, 'Premier', ${"prem-" + suffix}, 'football', '11-a-side',
      ${sql.json(FOOTBALL_CFG as never)}, '1.0.0', ${opts.autoPosts ?? false})
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${ctx.orgId}, 1, 'league', 'League') returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'team', 'Riverside', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'team', 'Northside', 2) returning id`;
  return { compId, divisionId, stageId, entrantA, entrantB };
}

async function seedDecidedFixture(
  ctx: Ctx,
  div: DivCtx,
  opts: { round?: number; homeLine?: string; awayLine?: string; status?: string; stageId?: string } = {},
): Promise<string> {
  const round = opts.round ?? 1;
  const stageId = opts.stageId ?? div.stageId;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
      home_entrant_id, away_entrant_id, status, outcome)
    values (${stageId}, ${div.divisionId}, ${ctx.orgId}, ${round}, 1,
      ${div.entrantA}, ${div.entrantB}, ${opts.status ?? "decided"},
      ${sql.json({ kind: "win", winner: div.entrantA, loser: div.entrantB })})
    returning id`;
  await sql`
    insert into match_states (fixture_id, org_id, last_seq, state, summary)
    values (${id}, ${ctx.orgId}, 1, ${sql.json({})},
      ${sql.json({
        headline: `${opts.homeLine ?? "2"}–${opts.awayLine ?? "1"}`,
        perSide: [
          { entrantId: div.entrantA, line: opts.homeLine ?? "2" },
          { entrantId: div.entrantB, line: opts.awayLine ?? "1" },
        ],
      })})
    on conflict (fixture_id) do update set summary = excluded.summary`;
  return id;
}

async function draft(ctx: Ctx, fixtureId: string): Promise<void> {
  await withTenant(ctx.orgId, (tx) => draftPostsForDecidedFixture(tx, fixtureId));
}

describe.skipIf(!HAS_DB)("org-posts CRUD", () => {
  it("slugifies the title and suffixes -2 on collision", async () => {
    const ctx = await seedOrg();
    const a = await createPost(ctx.auth, ctx.orgId, { title: "Match Day Report" });
    const b = await createPost(ctx.auth, ctx.orgId, { title: "Match Day Report" });
    expect(a.slug).toBe("match-day-report");
    expect(b.slug).toBe("match-day-report-2");
    expect(a.status).toBe("draft");
    expect(a.kind).toBe("news");
  });

  it("publish stamps published_at and freezes the slug across title edits", async () => {
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, { title: "Opening Weekend" });
    const published = await updatePost(ctx.auth, post.id, { action: "publish" });
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
    expect(published.slug).toBe("opening-weekend");
    // A title edit AFTER publish keeps the URL frozen (SPEC-2 invariant).
    const renamed = await updatePost(ctx.auth, post.id, { title: "Totally New Headline" });
    expect(renamed.title).toBe("Totally New Headline");
    expect(renamed.slug).toBe("opening-weekend");
  });

  it("regenerates the slug on a title edit while still a draft", async () => {
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, { title: "First Draft" });
    const edited = await updatePost(ctx.auth, post.id, { title: "Second Draft" });
    expect(edited.slug).toBe("second-draft");
  });

  it("archives and deletes", async () => {
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, { title: "Notice" });
    const archived = await updatePost(ctx.auth, post.id, { action: "archive" });
    expect(archived.status).toBe("archived");
    await deletePost(ctx.auth, post.id);
    await expect(getPost(ctx.auth, post.id)).rejects.toMatchObject({ status: 404 });
  });

  it("manual posts succeed on a community org (ungated PLG surface)", async () => {
    const ctx = await seedOrg("community");
    const post = await createPost(ctx.auth, ctx.orgId, { title: "Free Club News" });
    const published = await updatePost(ctx.auth, post.id, { action: "publish" });
    expect(published.status).toBe("published");
  });

  it("listPosts filters by status", async () => {
    const ctx = await seedOrg();
    const p1 = await createPost(ctx.auth, ctx.orgId, { title: "Draft One" });
    const p2 = await createPost(ctx.auth, ctx.orgId, { title: "Live One" });
    await updatePost(ctx.auth, p2.id, { action: "publish" });
    const drafts = await listPosts(ctx.auth, ctx.orgId, "draft");
    const published = await listPosts(ctx.auth, ctx.orgId, "published");
    expect(drafts.map((p) => p.id)).toContain(p1.id);
    expect(drafts.map((p) => p.id)).not.toContain(p2.id);
    expect(published.map((p) => p.id)).toEqual([p2.id]);
  });

  it("RLS isolates posts between orgs (non-vacuous raw count)", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const post = await createPost(a.auth, a.orgId, { title: "Org A Only" });

    // Sanity: the superuser connection DOES see org A's row — the tenant check
    // below is meaningful, not vacuously zero.
    const [{ raw }] = await sql<{ raw: number }[]>`
      select count(*)::int as raw from org_posts where id = ${post.id}`;
    expect(raw).toBe(1);

    const seen = await withTenant(b.orgId, async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from org_posts where id = ${post.id}`;
      return n;
    });
    expect(seen).toBe(0);
    expect(await listPosts(b.auth, b.orgId)).toEqual([]);
  });

  it("public reads never return drafts or private-competition posts", async () => {
    const ctx = await seedOrg();
    const pub = await seedDivision(ctx, { visibility: "public" });
    const priv = await seedDivision(ctx, { visibility: "private" });

    const orgPost = await createPost(ctx.auth, ctx.orgId, { title: "Org Wide" });
    await updatePost(ctx.auth, orgPost.id, { action: "publish" });
    const draftPost = await createPost(ctx.auth, ctx.orgId, { title: "Hidden Draft" });
    void draftPost;
    const pubScoped = await createPost(ctx.auth, ctx.orgId, {
      title: "Public Comp Post",
      competitionId: pub.compId,
    });
    await updatePost(ctx.auth, pubScoped.id, { action: "publish" });
    const privScoped = await createPost(ctx.auth, ctx.orgId, {
      title: "Private Comp Post",
      competitionId: priv.compId,
    });
    await updatePost(ctx.auth, privScoped.id, { action: "publish" });

    const { posts } = await publicPosts(ctx.orgSlug);
    const slugs = posts.map((p) => p.slug);
    expect(slugs).toContain("org-wide");
    expect(slugs).toContain("public-comp-post");
    expect(slugs).not.toContain("hidden-draft");
    expect(slugs).not.toContain("private-comp-post");
    // Direct fetch of a draft / private-scoped post 404s.
    await expect(publicPost(ctx.orgSlug, "hidden-draft")).rejects.toMatchObject({ status: 404 });
    await expect(publicPost(ctx.orgSlug, "private-comp-post")).rejects.toMatchObject({ status: 404 });
  });

  it("paginates public posts 20/page with hasMore", async () => {
    const ctx = await seedOrg();
    for (let i = 0; i < 22; i++) {
      const p = await createPost(ctx.auth, ctx.orgId, { title: `Post ${i}` });
      await updatePost(ctx.auth, p.id, { action: "publish" });
    }
    const page0 = await publicPosts(ctx.orgSlug, 0);
    const page1 = await publicPosts(ctx.orgSlug, 1);
    expect(page0.posts).toHaveLength(20);
    expect(page0.hasMore).toBe(true);
    expect(page1.posts).toHaveLength(2);
    expect(page1.hasMore).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("org-posts auto-drafts", () => {
  it("drafts one result post for a decided fixture in an opted-in pro division", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div, { homeLine: "3", awayLine: "1" });
    await draft(ctx, fx);

    const posts = await listPosts(ctx.auth, ctx.orgId);
    const results = posts.filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Riverside 3–1 Northside");
    expect(results[0]!.status).toBe("draft");
    expect(results[0]!.autoSource).toMatchObject({
      trigger: "fixture_decided",
      fixture_id: fx,
      stale: false,
    });
  });

  it("is idempotent under the auto-once index (re-run keeps one)", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx);
    await draft(ctx, fx);
    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
  });

  it("void stamps stale on the DRAFT only; a published post is untouched", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div, { round: 1 });
    await draft(ctx, fx);

    // A published auto post on a DIFFERENT fixture (unique index bars two auto
    // rows per fixture) — it must never be staled.
    const fxP = await seedDecidedFixture(ctx, div, { round: 2 });
    await draft(ctx, fxP);
    const published = (await listPosts(ctx.auth, ctx.orgId)).find(
      (p) => p.autoSource?.fixture_id === fxP,
    )!;
    await updatePost(ctx.auth, published.id, { action: "publish" });

    // Void erases fx's decision → its draft goes stale.
    await sql`update fixtures set status = 'in_play' where id = ${fx}`;
    await draft(ctx, fx);

    const posts = await listPosts(ctx.auth, ctx.orgId);
    const staledDraft = posts.find((p) => p.autoSource?.fixture_id === fx)!;
    const untouched = posts.find((p) => p.id === published.id)!;
    expect(staledDraft.autoSource?.stale).toBe(true);
    expect(untouched.status).toBe("published");
    expect(untouched.autoSource?.stale).toBe(false);
  });

  it("does not draft for a community org even if the toggle reads true", async () => {
    const ctx = await seedOrg("community");
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx);
    expect(await listPosts(ctx.auth, ctx.orgId)).toEqual([]);
  });

  it("drafts a round recap when the last fixture of a round is decided", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx1 = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "3", awayLine: "1" });
    const fx2 = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "0", awayLine: "0" });
    void fx1;
    await sql`
      insert into standings_snapshots (stage_id, org_id, pool_id, rows, computed_through_seq)
      values (${div.stageId}, ${ctx.orgId}, null,
        ${sql.json([
          { entrantId: div.entrantA, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {}, rank: 1 },
          { entrantId: div.entrantB, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 2 },
        ])}, 2)`;
    await draft(ctx, fx2);

    const posts = await listPosts(ctx.auth, ctx.orgId);
    const recap = posts.filter((p) => p.kind === "round_recap");
    expect(recap).toHaveLength(1);
    expect(recap[0]!.autoSource).toMatchObject({ trigger: "round_complete", round_no: 1 });
    expect(recap[0]!.bodyMd).toContain("Riverside");
  });

  it("round recaps are stage-scoped: a sibling stage's open round 1 neither blocks the recap nor shares its auto-once key", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true }); // stage A: kind 'league', round numbers restart per stage
    // A second table stage in the SAME division, also carrying a round 1.
    const [{ id: stageB }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${div.divisionId}, ${ctx.orgId}, 2, 'group', 'Group') returning id`;

    // Stage B round 1 has an OPEN (scheduled) fixture — under a division-wide
    // completeness count this scheduled fixture blocks stage A's recap forever.
    const [{ id: b1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status)
      values (${stageB}, ${div.divisionId}, ${ctx.orgId}, 1, 1,
        ${div.entrantA}, ${div.entrantB}, 'scheduled') returning id`;

    // Stage A round 1: two decided fixtures → its recap should fire even though
    // stage B's round 1 is still open.
    const a1 = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "3", awayLine: "1" });
    const a2 = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "0", awayLine: "0" });
    void a1;
    await draft(ctx, a2);

    let recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap).toHaveLength(1); // pre-fix: stage B's scheduled fixture keeps the round "open"
    expect(recap[0]!.autoSource).toMatchObject({
      trigger: "round_complete",
      round_no: 1,
      stage_id: div.stageId,
    });

    // Complete stage B's round 1 → its OWN recap, keyed on stage_id so the
    // auto-once index does not treat it as a dup of stage A's division+round row.
    await sql`
      update fixtures set status = 'decided',
        outcome = ${sql.json({ kind: "win", winner: div.entrantA, loser: div.entrantB })}
      where id = ${b1}`;
    await draft(ctx, b1);

    recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap).toHaveLength(2);
    expect(new Set(recap.map((r) => r.autoSource?.stage_id))).toEqual(
      new Set([div.stageId, stageB]),
    );

    // Voiding a stage A result stales stage A's recap draft only — stage B's
    // same-numbered round is a different competition phase.
    await sql`update fixtures set status = 'scheduled', outcome = null where id = ${a1}`;
    await draft(ctx, a1);
    recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap.find((r) => r.autoSource?.stage_id === div.stageId)?.autoSource?.stale).toBe(true);
    expect(recap.find((r) => r.autoSource?.stage_id === stageB)?.autoSource?.stale).toBeFalsy();
  });

  it("drafts nothing when the division has not opted in", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: false });
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx);
    expect(await listPosts(ctx.auth, ctx.orgId)).toEqual([]);
  });

  it("the scoring decided seam drafts a result post (awaited but swallowed, isolated)", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    await sql`update divisions set status = 'active' where id = ${div.divisionId}`;
    const [{ id: fx }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 1, 1,
        ${div.entrantA}, ${div.entrantB}, 'scheduled') returning id`;
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 0,
      type: "core.forfeit",
      payload: { by: div.entrantB, reason: "walkover" },
    });
    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.autoSource?.fixture_id).toBe(fx);
  });
});
