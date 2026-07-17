# PROMPT-67 — Visual Flow help pages: show the feature, one stage at a time

**Read first:**
- **The exemplar (open it):** https://claude.ai/code/artifact/690c4b06-8bfc-482b-8d9d-4833b0bbb137
  — the officials walkthrough. This is the look, structure, and quality bar.
  Also `docs/officials-walkthrough.md` (its stage list).
- `apps/web/src/server/help-content.ts` — how prose articles resolve today
  (`apps/web/content/help/<section>/<article>.md` → `/help/<section>/<article>`;
  `allHelpArticles()` walks the dir, `helpNav()` groups by section, minimal
  frontmatter parse). Flows do NOT go through this — they need their own model.
- `apps/web/src/app/help/page.tsx` (the help index — section cards + `SECTION_ICONS`;
  the new "Visual flows" group attaches here), `apps/web/src/app/help/[...slug]/page.tsx`
  (the prose renderer — do NOT reuse it for flows), `apps/web/src/app/help/layout.tsx`,
  `apps/web/src/components/help-menu.tsx`, `apps/web/src/components/help-search.tsx`.
- `apps/web/src/lib/help.ts` — `HELP_ARTICLE_SLUGS` registry + `helpUrl()`;
  `apps/web/src/server/__tests__/help-content.test.ts` enforces registry↔disk
  agreement **both directions** (the known gotcha: a new page that isn't
  registered — or a registry entry with no page — fails the test).
- `apps/web/content/help/scheduling/officials.md`, `.../scoring/conflicts.md`,
  `.../getting-started/*.md` — the prose articles the first flows pair with.
- Screenshot mechanics precedent: how the officials artifact was captured —
  seed via the v1 HTTP API as an organiser session, then drive Playwright
  (`scripts/smoke.ts` `officialOnboardingSuite` is the closest existing
  seed-over-HTTP recipe; `apps/web/e2e/helpers.ts` for `mintLoginPathBySql`,
  `addEntrantsViaApi`, `createStageAndGenerate`).
- `design/v14/README.md` (scope + non-goals).

**Depends:** officials-unify (#115) **and the fixture-page fix (#118)** merged —
without #118 the non-member-official screens 404, so the officials flow can't be
captured. **No migrations.**

## Context

Help today tells; it should also show. Every article is markdown prose. A
first-run organiser reads "generate fixtures" but doesn't know what the button
or the board looks like until they're in it. The officials artifact proved the
opposite is cheap and lands well: numbered real screenshots + one line of
"what happens" per stage. This prompt turns that one-off artifact into a
**first-class, reusable help surface** — `/help/flows/<feature>` — and captures
the first handful of flows.

Two hard constraints shape the design:

1. **Flows are structured, not prose.** The `[...slug]` markdown renderer can't
   express numbered stages, a state-rail, browser-framed images, and persona
   eyebrows. Flows get their own typed model + renderer.
2. **Screenshots must be regenerable.** UI drifts; hand-pasted images rot. The
   pipeline seeds demo data and drives Playwright, so `npm run help:flows` (or
   similar) re-shoots every flow from scratch. A flow whose screenshots are
   stale is worse than no flow.

## Decisions

- **Route:** `/help/flows/[feature]` (a new `flows` group in the help centre),
  rendered by a dedicated `FlowPage` server component — NOT `[...slug]`.
- **Content model (typed, in-repo):** one file per flow at
  `apps/web/content/help/flows/<feature>.ts` (or `.tsx`) exporting a typed
  `Flow`:
  ```ts
  interface FlowStage {
    n: string;                 // "01" — meaningful sequence, not decoration
    persona: "organiser" | "official" | "player" | "viewer";
    title: string;
    lead: string;              // one sentence: what happens
    shot: string;              // /help-flows/<feature>/NN.webp (public asset)
    caption: string;           // the faux browser-chrome URL, e.g. "…/schedule · officials"
    notes: { label: string; body: string }[];  // 2–3
  }
  interface Flow {
    feature: string;           // slug
    title: string; blurb: string;
    pairsWith?: string[];      // help article slugs to cross-link ("Watch the visual flow")
    stages: FlowStage[];
  }
  ```
  A `flows.ts` index exports the registry `FLOWS: Record<string, Flow>` + order.
  Copy strings stay inline for now but are structured so a later pass can lift
  them into the `ui`/help dictionaries — v14 ships **en only** (note it).
- **Design language = the artifact, ported to app tokens.** Reuse the app's
  existing palette (`--mk-*`/`--app-*` night chrome + lime) rather than the
  artifact's standalone hex; keep the artifact's *structure*: stadium-ink hero,
  numbered stages, left **state-rail** colored by `persona`/step
  (amber = pending, lime = done, red = the decline branch), browser-chrome
  screenshot frames, persona eyebrow, `text-wrap: balance` on titles,
  theme-aware (light/dark). The rail is the signature — keep it.
- **Screenshots:** captured to `apps/web/public/help-flows/<feature>/NN.webp`
  (WebP, ~1440px wide, quality tuned so a full flow is well under ~600 KB total).
  Full-page for panels; viewport for overlays (conflict panel). A capture
  script `scripts/capture-help-flows.ts` seeds a **fresh** demo (dedicated DB or
  the demo seed), logs in per persona via `mintLoginPathBySql`, navigates each
  stage's URL, and writes the asset. Deterministic; re-runnable; committed
  assets (they're product docs, not build output).
- **Registry + nav:** add flow slugs to `HELP_ARTICLE_SLUGS` (or a sibling
  `HELP_FLOW_SLUGS` with the same bidirectional test) so `help-content.test.ts`
  keeps disk↔registry honest. Surface a "Visual flows" card on `/help` and an
  entry in `help-menu.tsx`. Each `pairsWith` article gets a prominent
  "▶ Watch the visual flow →" link at the top.
- **Cross-link back:** the flow's persona eyebrow + `pairsWith` also let the
  flow deep-link into the real UI ("Open it yourself →") where safe.

## Initial flows (v14)

Port the exemplar first, then the highest-traffic journeys:

1. **`officials`** — port the artifact 1:1 (onboard → assign → claim → accept →
   score → conflicts). Proves the renderer against known-good content.
2. **`first-run`** — the getting-started spine: create org → competition →
   division → add entrants → generate fixtures → start scoring. Pairs with the
   whole `getting-started/*` section.
3. **`registration`** — open registration → card payment → reference number →
   confirmation. Pairs with `registration/*`.
4. **`scheduling`** — the board: drag to a court, locks, conflicts, undo. Pairs
   with `scheduling/board`.
5. **`player-claim`** — invite → claim profile → availability / check-in.
   Pairs with `players/claim-your-profile`.

Ship 1–2 fully wired (renderer + pipeline + registry + cross-links + tests);
land the rest as content behind the same machinery. Each further flow is then a
`<feature>.ts` + a capture run — no new engineering.

## Screenshot pipeline (the part that must not rot)

- Seed a **fresh** demo per run (never the shared dev/test DB — it pollutes and,
  per the officials chase, can produce inconsistent 200/404 renders). Reuse the
  demo-account seed shape where possible; use demo names only (no real PII).
- One Playwright session per persona (organiser / official / player), navigating
  the exact stage URLs. Dismiss the cookie banner once. WebP output.
- `scripts/capture-help-flows.ts --feature officials` re-shoots one flow;
  no-arg re-shoots all. Print a manifest of written assets. Wire an npm script.
- Assets are committed. A follow-up CI check (out of scope here) could diff
  captured vs committed to flag drift.

## Copy & a11y

- Leads are active voice, user-side vocabulary ("Score the match", not "record a
  scoring event"). Notes: `label` = the concept, `body` = the specific detail.
- Each `<img>` has a real `alt` (the stage title). Visible keyboard focus on the
  "Watch"/"Open" links. `prefers-reduced-motion` respected (any stage reveal is
  optional and motion-gated). Wide images scroll inside their frame — the page
  body never scrolls sideways.

## Non-goals

- Not replacing prose help; flows link to and from it.
- No video, no GIFs, no per-locale screenshots. Copy is structured for i18n but
  ships `en`.
- No in-page live product embeds — static shots + deep-links only.

## Done when

- `/help/flows/officials` renders the ported artifact from `officials.ts` +
  committed WebP assets, matching the exemplar's structure, theme-aware.
- At least one more flow (`first-run`) is fully wired.
- `scripts/capture-help-flows.ts` regenerates every asset from a fresh seed.
- Flow slugs registered; `help-content.test.ts` green (disk↔registry both ways).
- The paired prose articles carry a "Watch the visual flow" link; `/help` shows
  the "Visual flows" group.
- `content/help/*` closing pass done (the standing rule): any article that gains
  a flow references it.
