# v13 wave build — deep-dive design (amendments over design/v13)

Date: 2026-07-18. Base: main `40de2a4` (post v12 #121, me-lane #122, PLG #123 — all merged, zero open PRs).
This spec does not replace `design/v13/` — it locks decisions, patches gaps found by
verifying every prompt against current code, and defines the build shape.

## Decisions (locked with user 2026-07-18)

1. **One wave branch, single PR.** `feat/v13-real-competition-fidelity` in its own
   worktree off `40de2a4`. PROMPT-61 is built **first in-branch** (no separate hotfix PR).
2. **Build order:** 61 → 59 → 66 → 60 → 62 → 63 → 64 → 65 → closing pass → FIFA capstone.
   Rationale: 61/59/66 share `stages.ts`/`schemas.ts`/overlay plumbing; 62 before 64
   (bracket slide); 63/65 independent.
3. **PROMPT-65 pricing:** public profile stat block = **free for consented players, all
   tiers**; the leaderboard *table* stays Pro (`stats.player`, V112). Mirrors the
   `community.exports` philosophy — free surfaces carry attribution.
4. **PROMPT-60 badge:** `badge_url` column **plus** an upload path reusing the existing
   assets-bucket pipeline (persons-photo pattern). URL-only would be inert for real orgs.
5. **One migration for the wave: `V286__v13_fidelity.sql`** — `entrants.badge_url text null`
   + `plan_entitlements` rows for `scoring.audit_export` (community false / pro true /
   business true). Lands with the first task that needs it; every later task assumes it.
   (V285 = `community_exports`, taken by v12.)

## Verified state (2026-07-18, against `40de2a4`)

- Corpus is design-only; **nothing built**: `supportsDraws` invoked nowhere;
  `QualificationSpec` still `TakePicks | TopN | BestOfRank` (`qualification.ts:39`);
  `CreateStage.qualification` still free `z.record` (`schemas.ts`); no `slotOrder` in
  `SingleElimOptions`; zero `badge_url` hits; `getPublicPlayer` stat-less
  (`public-site/data.ts`); `me/persons/[id]/` has only `consent/`; no
  `stages/[id]/fixtures` route (`issueChallenge` now at `stages.ts:1349`); public
  `bracket.tsx` connector-less columns; no `/present` route.
- **v12 merged ⇒ PROMPT-62/63 PDF soft-deps satisfied** — full scope day one, no staging.
- v14 (visual-flow help) = design-only. Build **after** v13 — its screenshots would rot.
- v15 design pins V285 — **stale**; renumber when v15 builds.

## Prompt amendments (deltas; prompts otherwise stand as written)

- **61** — as written. Post-deploy stg repair: re-record the 4 stuck FIFA R32 fixtures
  (Curaçao–Paraguay abandoned; Egypt–BIH, Belgium–Australia, Uzbekistan–Canada draws)
  decisively; confirm the bracket unstalls.
- **59** — document explicitly: `slotOrder` seed numbers index into the **combined
  qualification order** (seed *i* = *i*-th entry of the resolved seed list).
- **66** — ADD a minimal console "Add match" action on the stage panel for
  league/group/swiss (API-only ships an invisible feature).
- **60** — migration folded into V286. ADD upload: `POST /api/v1/entrants/[id]/badge`
  (multipart → assets bucket, reuse the persons-photo helper shape). `badge_url` stores
  an external URL **or** a storage path; resolver uses `publicStorageUrl` for paths
  (public bucket + fetch, null on fail, never throw — v12 `resolveLogo` pattern).
  Precedence `badge_url` > `teams.logo` > monogram unchanged.
- **62** — **tests rewrite: no jsdom.** `apps/web` vitest is node-env (no
  @testing-library). Geometry = pure golden tests (primary); React surfaces =
  `renderToStaticMarkup` assertions; interactions via smoke. PDF builder goldens must
  assert every node/connector coordinate sits **inside the content box**
  (`page.height − MARGIN`) — pdfkit silently suppresses text at the bottom edge and the
  draw-call spy cannot detect clipping (v12 gotchas). `BracketPanel` co-locates with the
  v12 Documents menu in `stages-panel.tsx`.
- **63** — (a) `community.exports=true` now: test matrix must prove `exports/audit`
  402s `scoring.audit_export` for a free org **while sibling kinds succeed free-plain**.
  (b) Ops: `AUDIT_SIGNING_KEY` fly secret on stg+prod **before** deploy; keygen recipe +
  `key_id` rotation (publish current+previous at `/.well-known/seazn-audit-keys`,
  explicit cache-control); runbook in `docs/superpowers/runbooks/`. (c) Entitlement row
  in V286. (d) In-play fixtures are exportable — signature pins head at `issued_at`;
  document partial-ledger semantics.
- **64** — build after 62. Same no-jsdom rewrite: deck builder = pure tests; extract a
  pure slide-advance helper (`nextSlide(state, now)`) for timer/pin/pause logic;
  `renderToStaticMarkup` for markup. `robots: noindex` on both `/present` routes
  (duplicate of public pages). Wake-lock/fullscreen API = out of scope.
- **65** — free-basic-totals decision locked (above); rest as written.

## Standing rules (every task; corpus predates their codification)

- i18n **en/fr/es/nl parity** for all new UI strings (catalog gate enforces).
- `scripts/smoke.ts` pro+free extensions: badge render, bracket panel, audit 402/200,
  present route, profile stats, addFixture — placed **after** the data they need is
  seeded (empty-doc false-green gotcha).
- Regression test per change (fails without it).
- Help closing pass (same PR): formats/qualification+slotOrder, entrant crest + bulk
  enrol, knockout deciders, bracket surfaces, audit trail + independent verify recipe,
  presentation mode, player stats + self photo, ad-hoc fixture. Markdown prose now;
  v14 flows later.
- Own worktree; never checkout branches in the main repo dir.

## Wave-close checklist

- README status table: mark v10/v11/v12 ✅ (stale today), v13 ✅, add v14/v15 rows.
- `design/v13/README.md` status line flip.
- HANDOFF.md rewrite.
- Deploy backlog: stg/prod still owe **V284+V285**; V286 joins the run. Include v10
  webhook event subscriptions + `AUDIT_SIGNING_KEY` secret in the deploy notes.
- **FIFA capstone (post-merge, stg):** re-seed with engine-combined qualification
  (12W+12RU+8 best-thirds), the real slot map, flags via `badge_url`; verify knockout
  cannot draw; export the 62 poster of the real bracket. Closes all 6 original demo
  gaps end-to-end and doubles as a marketing asset.

## Process improvements (adopt from this wave on)

1. Prompts cite **symbols, not line numbers**; migrations always "next free V###" with a
   build-time check (line/`V#` rot observed within 48h of writing).
2. **`design/GOTCHAS.md`** living file, referenced by every prompt — subagents don't read
   session memory; prompts are their contract. Seed with: pdfkit bottom-margin + spy
   blindness, no-jsdom test patterns, public-bucket asset resolver, smoke-after-seed.
3. The wave-close checklist above becomes standard (status-table rot found today).
4. Demo-driven acceptance: the richest seed re-run ends every wave.
5. v14 builds after v13; v15 renumbers its migration at build time.

## Out of scope (unchanged from corpus)

Named format presets ("wc48"); double-elim/stepladder two-sided layout; audit anchoring
service; per-event signing; slideshow deck editor; badge CDN/resize pipeline.
