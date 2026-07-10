# PROMPT-39 — ROI Quick Wins Wave 1: Share Cards, WhatsApp, QR Poster, Embeds, Sponsors

**Read first:** `v3/10-roi-features-and-suggestions.md` Wave 1 (normative);
`v3/11-gaps-and-decisions.md` gaps 7, 8, 15; `v3/03` §5 (logo matrix), `engine/Jul3/06`
(DocModel for the poster), `engine/09` (public dashboard). Preamble: PROMPT-00.
**Depends:** PROMPT-32 (logos, chips), PROMPT-34 for youth flag if it lands first
(else add the flag here).

## Task
1. **OG/share images:** satori+resvg renderer (self-contained, no external fonts at
   runtime) with three templates — division standings, fixture result (team logos + score),
   competition hero; wired as `og:image` on every public `/shared/...` page and the
   registration ticket PNG (v3/05 §3 reuse); brand hue + org logo per logo matrix;
   cached (ISR-aligned revalidation), < 500ms warm render (v3/11 gap 15). **Youth rule
   (v3/11 gap 8): youth-division images render team/division names only — never player
   names.** Org accent contrast-guard with violet fallback (v3/11 gap 7).
2. **WhatsApp share:** one-tap share actions (Web Share API, `wa.me` fallback) with
   pre-written message + link on: fixture decided (console + public), standings, and
   registration ticket.
3. **QR poster:** "Print poster" on competition + division consoles → A4 PDF via Jul3/06
   DocModel: comp name, org logo, dates, big QR → public dashboard, "Follow live" line.
4. **Embeds** (Pro): `/embed/divisions/[id]/{standings|schedule|bracket}` — read-only,
   minimal chrome, `X-Frame-Options` relaxed for these routes only, honours visibility
   (private 404s, link-only allowed), auto-height postMessage; copy-snippet UI in
   division sharing panel behind `<UpgradeGate>`.
5. **Sponsor slots** (Pro / Event Pass): org-level sponsors (name, logo upload, url,
   order); render: public dashboard footer strip, slideshow rotation slide, registration
   masthead line; managed in org settings.

## Acceptance
- Golden: OG renderer snapshot per template (deterministic fonts); QR resolves to the
  public URL; embed 404s a private division and renders a link-only one; youth-division
  OG snapshot contains no player names; failing org accent falls back to violet.
- E2E: decided fixture page exposes correct `og:image` (fetch + pixel-dim assert);
  sponsor upload appears on dashboard + registration; embed snippet gated free → 402,
  works on pro.
- No external hosts referenced by embeds/OG renderer (CSP-clean).
- `npm test` + `tsc` green; smoke.ts: OG fetch on free, embed + sponsors on pro; update
  v3/README status.
