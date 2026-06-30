# 01 — Product Strategy & Positioning

## 1. Goal

Define who we sell to, how the product is packaged into tiers, how pricing maps to
value, and the go-to-market motion. Every later doc (architecture, billing, security)
inherits constraints from this one — e.g. "Enterprise needs SSO" comes from the segment
definitions here.

## 2. Current state

- Single app, no monetization, no plan concept. Every org has identical capabilities.
- Strong differentiator already built: a **multi-sport, multi-format tournament engine**
  (`swiss_knockout`, `knockout`, `round_robin`, `progress_stepladder`) with standings,
  progress score, Buchholz, undo/reset, audit log.
- Multi-tenant foundations exist (orgs, memberships, RBAC owner/admin/viewer, seasons).

## 3. Positioning

**One-liner:** "Run any tournament, for any sport, in any format — from a 4-player club
night to a multi-season regional league."

**Why we win:** Competitors are typically single-sport (chess-only, padel-only) or
single-format (knockout brackets only). Our engine already spans formats and sports and
has serious scoring logic. That breadth + correctness is the moat.

**Category:** Sports/event tournament management SaaS.

**Primary jobs-to-be-done:**
- "I need to run a tournament this weekend without spreadsheets."
- "I need live standings my participants and spectators can follow."
- "I run many events across a season and need them organized and comparable."
- "Our federation/school district needs governed, auditable, branded events."

## 4. Target segments

| Segment | Buyer persona | Core needs | Willingness to pay |
|---------|---------------|-----------|--------------------|
| **Community** | Club organizer, teacher, hobbyist | Quick setup, a few formats, free | Low (free → ad/upsell) |
| **Pro** | Sports club, academy, coach | Unlimited events, branding, exports, public pages | Monthly subscription |
| **Business** | Multi-venue operator, small league | Seasons/leagues, analytics, API, multiple admins | Higher monthly / annual |
| **Enterprise** | Federation, school district, corporate | SSO/SAML, SCIM, audit export, SLA, residency, support | Annual contract, invoiced |

**Beachhead (locked):** **Pro (clubs/academies)** for self-serve revenue and fast feedback.
**Enterprise is coming soon** — not in Phase 1; SSO/SCIM/SOC 2 land in Phase 3 when we sell
upmarket. Do not block Pro launch on enterprise features.

## 5. Packaging & tier matrix

This matrix is the **source of truth for entitlements** (implemented in doc 05). Keep the
feature keys stable; they become `feature` strings in code.

| Capability (`feature_key`) | Community | Pro | Business | Enterprise |
|----------------------------|:---------:|:---:|:--------:|:----------:|
| Orgs per account (`orgs.max`) | 1 | 1 | 3 | unlimited |
| Active tournaments (`tournaments.active.max`) | 2 | ∞ | ∞ | ∞ |
| Formats: all engine formats (`formats.all`) | ✅ | ✅ | ✅ | ✅ |
| Players per tournament (`players.max`) | 32 | 256 | 1024 | unlimited |
| Custom branding / logo (`branding`) | — | ✅ | ✅ | ✅ |
| Public tournament pages (`public_pages`) | basic + "powered by" | ✅ | ✅ custom domain | ✅ white-label |
| CSV / PDF export (`exports`) | — | ✅ | ✅ | ✅ |
| Live realtime scoreboard (`realtime`) | — | ✅ | ✅ | ✅ |
| Seasons / leagues (`leagues`) | — | — | ✅ | ✅ |
| Analytics & ratings (`analytics`) | — | basic | ✅ | ✅ |
| Public API + webhooks (`api`) | — | — | ✅ | ✅ |
| Custom roles (`rbac.custom`) | — | — | — | ✅ |
| SSO / SAML + SCIM (`sso`) | — | — | — | ✅ |
| Audit export / SIEM (`audit.export`) | — | — | — | ✅ |
| Data residency (`residency`) | — | — | — | ✅ |
| Support SLA (`support.sla`) | community | email | priority | dedicated + SLA |

> Keep the **engine itself ungated** (all formats everywhere). We gate scale, branding,
> collaboration, governance — not core correctness. This protects word-of-mouth growth.

## 6. Pricing model (locked)

**Flat per-org tiers only** — no per-seat or per-participant metering at launch.

- **Community:** $0.
- **Pro:** monthly + annual per org. 14-day trial, no card.
- **Business:** higher monthly per org (annual discount). Still flat per-org — no seat add-ons.
- **Enterprise:** coming soon — custom annual, invoiced; not in Phase 1 scope.

Rejected for v1 (do not build):
- Per-participant metering.
- Per-seat pricing or seat add-ons.

## 7. Go-to-market motion

- **Self-serve (Community → Pro/Business):** product-led. Public tournament pages are the
  acquisition flywheel — every shared event markets the product. Add a tasteful
  "Powered by S.A.F.E" on free public pages (`public_pages` entitlement controls removal).
- **Sales-assisted (Enterprise):** "Book a demo" CTA, outbound to federations / school
  athletic associations / corporate event teams. Lighthouse logos → case studies.
- **Content/SEO:** format explainers ("how Swiss pairing works"), sport-specific guides,
  templates. The marketing site (doc 06) is built for this.

## 8. Success metrics (instrument from day one)

- Activation: % of new orgs that **start** a tournament within 24h.
- Time-to-first-tournament.
- Free→Pro conversion; trial→paid conversion.
- Weekly active organizers; tournaments created/week.
- Net revenue retention; logo churn.
- Public page views → signups (flywheel efficiency).

These map to events the analytics doc (08) must emit.

## 9. Acceptance criteria

- A written, versioned tier matrix with stable `feature_key`s (this doc).
- Pricing decided per tier (numbers can be placeholders until launch).
- Beachhead segment chosen and reflected in phase ordering (doc 09).

## 10. Decisions (locked vs open)

**Locked:**
- Beachhead: **Pro / clubs & academies**; Enterprise **coming soon** (Phase 3).
- Pricing: **flat per-org only** (Community / Pro / Business); no per-seat or usage metering.

**Still open:**
1. Exact price points and annual discount %.
2. Do we allow Free public pages to be fully indexable (SEO upside) vs noindex?
