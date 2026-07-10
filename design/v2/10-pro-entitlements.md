# 10 — Entitlements v2: Expanding the Pro Surface

Engine v2 creates genuinely differentiating paid capabilities (v1's matrix was mostly
quotas). Same enforcement machinery: `plan_entitlements` → `org_entitlement_overrides`,
resolved through `entitlements.ts` + Redis cache, `requireFeature`/`withinLimit` at the
service layer (never in UI only).

## 1. Matrix (feature_key → Community / Pro / Business†)

### Structure & scale
| feature_key | Community | Pro | Business |
|---|---|---|---|
| `orgs.max_owned` (per user — see doc 13 §5 billing note) | 1 | 5 | ∞ |
| `members.max` (owner/admin/viewer seats per org) | 3 | 10 | ∞ |
| `scorers.max` (scorer seats per org, separate pool — doc 13) | 1 | 1 | ∞ |
| `competitions.max_active` | 2 | ∞ | ∞ |
| `divisions.per_competition.max` | **1** | 10 | ∞ |
| `entrants.per_division.max` | 16 | 64 | 256 |
| `stages.per_division.max` | 2 (e.g. group+KO) | 4 | ∞ |
| `formats.double_elim` | ✗ | ✓ | ✓ |

### Sport depth (the new differentiators)
| feature_key | Community | Pro |
|---|---|---|
| `scoring.ball_by_ball` (cricket fine events, wagon-wheel-ready data) | ✗ (innings summaries) | ✓ |
| `scoring.rally_by_rally` (volleyball/badminton/TT point log) | ✗ (set summaries) | ✓ |
| `scoring.match_timeline` (football goal/card minutes) | ✗ (final score) | ✓ |
| `cricket.dls` (DLS targets + live par curve) | ✗ (manual revise) | ✓ |
| `stats.player` (batting/bowling averages, top scorers, MVP tables) | ✗ | ✓ |
| `stats.club_championship` (cross-division aggregate, doc 06 §4.4) | ✗ | ✓ |
| `tiebreakers.custom` (reorder cascade beyond sport preset) | ✗ | ✓ |
| `eligibility.enforced` (hard age/gender locks + compliance panel) | soft warnings | ✓ |

### Public & realtime
| feature_key | Community | Pro |
|---|---|---|
| `dashboard.public.max` | 1 at a time | ∞ |
| `dashboard.branding` (theme, banner, sponsors, no platform footer) | ✗ | ✓ |
| `dashboard.player_profiles` (photos, stats on public cards) | ✗ | ✓ |
| `realtime` (push vs 15 s poll) | ✗ | ✓ |

### Platform (Pro→Business ladder)
| feature_key | Community | Pro | Business |
|---|---|---|---|
| `api.access` (API keys, read) | ✗ | ✓ | ✓ |
| `api.write` + `webhooks` | ✗ | ✗ | ✓ |
| `exports` (CSV/PDF results, scorecards) | ✗ | ✓ | ✓ |
| `scheduling.constraints` (courts, rest, blackouts solver pass) | basic | ✓ | ✓ |
| `officials.assignment` | ✗ | ✓ | ✓ |

Seat quotas (`orgs.max_owned`, `members.max`, `scorers.max`) are normative in
[13-roles-and-scorer.md](13-roles-and-scorer.md) §5 — that doc supersedes any older
`seats.*` keys here.

† Business = new third plan seeded in `plans`; ship dark (is_public=false) until pricing decided.

## 2. Enforcement placement (rules)

1. **Quotas** at creation use-cases (`withinLimit` before insert, count query in same tx).
2. **Scoring fidelity** at the events endpoint: fine-grained event types
   (`cricket.ball`, `volleyball.rally`) require the corresponding feature; coarse
   summaries always allowed. Error = 402 with upgrade hint — the UI already handles
   `PaymentRequiredError`.
3. **Public read features** at the read-model/view layer (branding/profiles fields
   nulled out, not hidden client-side).
4. **Downgrade behaviour** (define now, avoid support hell): existing data never deleted;
   over-quota resources become read-only ("frozen" badge); fine-grained history remains
   visible but new fine events rejected. Freeze logic in one module: `entitlement-freeze.ts`.

## 3. Upgrade moments (product notes for the UI prompt)

Surface upgrade prompts exactly where the limit bites: adding a 2nd division, toggling
ball-by-ball scoring, publishing a 2nd dashboard, enabling DLS on a rain delay, creating
an API key. Each 402 carries `feature_key` so the paywall screen is contextual.
