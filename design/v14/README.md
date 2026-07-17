# v14 — Visual Flows in Help

**Theme:** the help centre learns to *show*, not only tell. Today every article
is markdown prose (`apps/web/content/help/<section>/<article>.md`). v14 adds a
second, complementary surface: **Visual Flow** pages — an interactive,
screenshot-driven walk of a feature end to end, one numbered stage at a time,
so a first-time organiser (or official, or player) can see exactly what each
step looks like before they do it.

## The exemplar

The officials walkthrough artifact is the canonical look and the quality bar
for this wave — build the in-app pages to match it:

**https://claude.ai/code/artifact/690c4b06-8bfc-482b-8d9d-4833b0bbb137**

Its design language: stadium-ink hero + lime accent, numbered stages down a
left **state-rail** (amber → lime → red, echoing the assignment-response rail),
each stage a real screenshot in a browser-chrome frame with a persona eyebrow
(Organiser / Official) and 2–3 tight annotations. Theme-aware. Numbering is
meaningful — a flow is a genuine sequence.

## Scope

- One reusable **Flow renderer** + a typed content model, mounted under
  `/help/flows/<feature>`, linked from the help index and cross-linked from the
  matching prose articles.
- A **repeatable screenshot pipeline** (seed demo data → Playwright capture →
  optimised assets) so flows can be regenerated when the UI changes — never
  hand-shot, never stale.
- An **initial set of flows** (PROMPT-67); the pattern makes adding the rest a
  content task, not an engineering one.

## Non-goals

- Not replacing prose articles — flows sit beside them.
- No video, no per-locale screenshots yet (English captures; copy is i18n-ready
  but ships `en` only).

## Prompts

- [PROMPT-67 — Visual Flow help pages](prompts/PROMPT-67-visual-flow-help-pages.md)
