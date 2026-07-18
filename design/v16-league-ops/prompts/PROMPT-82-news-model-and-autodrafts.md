# PROMPT-82 — Org news: model, auto-drafts, API

**Goal:** SPEC-2's server side — `org_posts` table + `divisions.auto_posts`,
post CRUD usecases, the two auto-draft triggers on the decided-write seam,
publish/archive lifecycle, and the v1 API. **Server only** — UI + public
pages + OG cards in PROMPT-83.

**Read first:**
- `design/v16-league-ops/SPEC-2-news-social.md` — the spec ("Data model",
  "Auto-drafts", API).
- `db/migration/deltas/V284__official_onboarding.sql` — new-table pattern.
- `db/migration/deltas/V290__pro_plus_plan.sql` — entitlement seed shape.
- `apps/web/src/server/usecases/scoring.ts` — the decided/void seam (same
  hook point PROMPT-78 used; the two hooks coexist — keep them cheap, both
  behind one-query probes).
- `apps/web/src/server/usecases/competitions.ts` — `shouldFireMadePublic`
  (PLG L6) as the event-side-effect precedent; the slugify helper.
- `apps/web/src/server/usecases/player-stats.ts` — how sport modules gate
  per-player detail (`playerStats` presence → scorers list in drafts).
- The standings read used by public division pages (for "moves to 2nd"
  lines) — find via the public division page's data loader.
- v12's `fixtureWhen` venue-tz formatting helper (doc-render work) — reuse
  for the draft body's date line.
- Round completeness: fixtures carry `round_no` (**1-based**, v13 lesson).

**Depends:** nothing in this wave (independent of 78–81).
**Migration: V292 draft — renumber at build.** PROMPT-83 adds no migrations.

## Decisions (from SPEC-2, restated)

- `org_posts` DDL exactly as SPEC-2 (kinds `news|result|round_recap|
  announcement`, statuses `draft|published|archived`, `unique (org_id,
  slug)`, `auto_source` JSONB) + `divisions.auto_posts boolean not null
  default false` in the same migration.
- Entitlement `news.auto`: community/event_pass false, pro/pro_plus true.
  **Manual posts are ungated on every plan** (PLG thesis). The auto_posts
  toggle PUT requires `news.auto`; existing true value in a downgraded org
  simply stops mattering (trigger checks the entitlement live).
- Auto-draft idempotency: skip when a post with the same
  `auto_source->>'trigger'` + `fixture_id` (or `round_no`+`division_id`)
  exists — enforce with a partial unique index, not app logic:
  ```sql
  create unique index org_posts_auto_once on org_posts (
    org_id,
    (auto_source->>'trigger'),
    coalesce(auto_source->>'fixture_id', ''),
    coalesce(auto_source->>'division_id', ''),
    coalesce(auto_source->>'round_no', '')
  ) where auto_source is not null;
  ```
- Void/re-decide after a draft exists → set `auto_source.stale = true` on
  the DRAFT only; published posts are never touched.
- Slug: slugify(title), `-2` suffix on collision; **frozen at first
  publish** (edits after publish keep slug + URL).
- Draft body templates are plain strings built server-side in the org's
  locale at draft time (org locale from the V281 i18n columns); scorers
  line only when the sport has `playerStats` AND events are attributed;
  standings-movement line only for league-stage fixtures.

## Files

- **Create** `db/migration/deltas/V292__org_news.sql`
- **Create** `apps/web/src/server/usecases/org-posts.ts`
- **Create** `apps/web/src/server/usecases/__tests__/org-posts.test.ts`
- **Create** `apps/web/src/server/news/draft-templates.ts` (pure functions —
  unit-testable without DB: `resultDraft(input) → {title, body_md}`,
  `roundRecapDraft(input) → {title, body_md}`)
- **Create** `apps/web/src/server/news/__tests__/draft-templates.test.ts`
- **Create** `apps/web/src/app/api/v1/orgs/[id]/posts/route.ts` (GET?status=, POST)
- **Create** `apps/web/src/app/api/v1/posts/[id]/route.ts` (GET/PATCH/DELETE;
  PATCH body includes `action?: "publish" | "archive"`)
- **Modify** division settings API/usecase — accept `auto_posts` (gated)
- **Modify** `apps/web/src/server/usecases/scoring.ts` — draft hooks on the
  decided seam
- **Modify** `schemas.ts` + `openapi.ts` (drift gate)

## Interfaces (produced — PROMPT-83 consumes these exact names)

```ts
// org-posts.ts
export type PostKind = "news" | "result" | "round_recap" | "announcement";
export type PostStatus = "draft" | "published" | "archived";
export interface OrgPost {
  id: string; orgId: string; competitionId: string | null;
  divisionId: string | null; kind: PostKind; status: PostStatus;
  slug: string; title: string; bodyMd: string;
  heroImagePath: string | null;
  autoSource: { trigger: string; stale?: boolean;
    fixture_id?: string; division_id?: string; round_no?: number } | null;
  publishedAt: string | null; createdAt: string; updatedAt: string;
}
export function listPosts(auth: AuthCtx, orgId: string,
  status?: PostStatus): Promise<OrgPost[]>;
export function createPost(auth: AuthCtx, orgId: string, input: {
  title: string; bodyMd?: string; kind?: PostKind;
  competitionId?: string; divisionId?: string; heroImagePath?: string
}): Promise<OrgPost>;
export function updatePost(auth: AuthCtx, id: string,
  input: Partial<Pick<OrgPost, "title" | "bodyMd" | "heroImagePath" |
  "competitionId" | "divisionId">> & { action?: "publish" | "archive" }
): Promise<OrgPost>;
export function deletePost(auth: AuthCtx, id: string): Promise<void>;

/** Public reads (superuser sql, published + org/comp visibility guard): */
export function publicPosts(orgSlug: string, page?: number):
  Promise<{ posts: OrgPost[]; hasMore: boolean }>;   // 20/page
export function publicPost(orgSlug: string, postSlug: string): Promise<OrgPost>;

/** Decided-seam hook (scoring.ts): probes divisions.auto_posts + news.auto
 *  live, builds drafts via draft-templates, inserts on conflict do nothing. */
export function draftPostsForDecidedFixture(tx: Tx, fixtureId: string): Promise<void>;
```

## Build steps (TDD)

- [ ] **Step 1 — Migration.** V292 per Files + Decisions (table, division
  column, auto-once index, `news.auto` seed). `db:apply` clean.
- [ ] **Step 2 — Template tests first** (pure, no DB): result title
  `"Riverside 3–1 Northside"`, body contains competition line, venue-tz
  date, scorers only when provided, movement line only when provided;
  round recap contains every result line + top-3 standings block; locale
  parameter switches the static strings (en/fr/es/nl from the emails.json
  or a new `news` dictionary namespace — follow how compose.ts localizes).
  FAIL → implement `draft-templates.ts` → PASS.
- [ ] **Step 3 — CRUD tests first** (DB-backed): slug collision `-2`,
  publish stamps `published_at` + freezes slug (title edit after publish
  keeps slug), archive, delete, manual posts on a community org succeed
  (ungated), listPosts status filter, RLS org isolation, publicPosts never
  returns drafts nor posts of a private org. FAIL → implement → PASS.
- [ ] **Step 4 — Auto-draft tests first**: decided fixture in an opted-in
  pro division → one result draft; re-decide → still one (index); void →
  draft's `auto_source.stale = true`, published post untouched; community
  org with toggle somehow true → no draft (live entitlement probe); last
  fixture of round decided → recap draft (1-based round_no); fixture
  without division opt-in → nothing. FAIL.
- [ ] **Step 5 — Implement `draftPostsForDecidedFixture`** + the scoring.ts
  seam call (probe: `select auto_posts from divisions where id = …` inside
  the existing decided branch — no extra query on non-decided writes).
  PASS.
- [ ] **Step 6 — Routes + schemas + openapi** (drift green). `auto_posts`
  division-settings gate: PUT with true requires `news.auto` (403 shape
  for PlusReveal).
- [ ] **Step 7 — Verify + commit.** `tsc` + unit. Commit:
  `feat(news): org posts model, auto-drafts on decided seam, API (V292)`.

## Out of scope

Console tab, public pages, OG/story cards, share, analytics events, i18n
keys for UI, help, smoke — all PROMPT-83.
