# PROMPT-35 — Description Editor, `/help` Centre, Fixture-Format Gallery

**Read first:** `v3/06-content-editor-and-help.md` (normative); `engine/05` (format
semantics — diagrams must be correct); `v3/03` §4 (Tips deep-links). Preamble: PROMPT-00.
**Depends:** PROMPT-32 (Tips registry).

## Task
1. **Editor** (v3/06 §2): TipTap, Markdown in/out, restricted block set + sponsor/CTA
   button node; Write/Preview tabs where Preview renders `<CompetitionProse>` (the public
   component); Supabase image upload (club-logo pipeline), 2MB cap; rehype-sanitize
   allowlist server-side; 20k char cap. Wire into competition + division + org-about
   settings.
2. **Help centre** (v3/06 §3): MDX under `apps/web/content/help/**` → `/help/[...slug]`
   (ISR); nav tree per §3 structure; seed the getting-started series + one article per
   live feature area (write for non-technical organisers); FlexSearch build-time index;
   `scripts/help-shots.ts` Playwright screenshot generator against seeded demo data;
   footer + console `?` menu links; Tips `helpSlug` links go live.
3. **Format gallery** (v3/06 §4): explainer page per format family with hand-authored
   SVG flow diagram (mind-map style: pools/stages as nodes, progression arrows) + live
   `format-preview` embed (canned 8-entrant set) rendered with console bracket/round
   components; surfaced at `/help/formats/*`, in the console format picker ("How this
   works →" side panel), and marketing `/formats`; picker recommendation strip (entrant
   count + courts + hours → top 2–3 formats, pure function, one-sentence trade-offs).

## Acceptance
- Golden: Markdown round-trip (save→load AST-identical); preview HTML === public render
  for fixture inputs; XSS corpus neutralised (regression test with script/onerror/iframe
  payloads).
- `/help` static build green; search returns "waitlist" article; every stage kind in the
  engine registry has an explainer (test enumerates registry vs content — new formats
  can't ship undocumented).
- E2E: picker side-panel opens explainer with live preview; recommendation strip ranks
  sensibly for 16 entrants / 2 courts / 4h (golden).
- `npm test` + `tsc` green; smoke.ts: editor save + public render on pro & free; update
  v3/README status.
