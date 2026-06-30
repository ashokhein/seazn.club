# S.A.F.E Tournaments — reference

## Database tables

| Table | Purpose |
|-------|---------|
| `users` | Accounts: `email` (unique login), `password_hash`, `display_name`, `email_verified`, optional `google_sub` |
| `email_verifications` | One-time tokens for email verify (24h TTL on token row) |
| `organizations` | Tenant board: `name`, `slug` (unique, auto `org-<hex>`) |
| `org_members` | `(org_id, user_id)` + `role` |
| `org_invites` | Shareable links: `token`, `role`, `expires_at`, `max_uses`, `used_count`, `revoked` |
| `org_sport_presets` | Per-org sport defaults (format, scoring, clocks); seeded on org create |
| `seasons` | Optional container per org: `(org_id, slug)` unique |
| `tournaments` | Core config: format, status, scoring, round counts |
| `players` | Per-tournament participants |
| `rounds` | Group/playoff/knockout/final stages |
| `matches` | Pairings with bracket links (`next_match_id`, `next_slot`) |
| `match_events` | Undo snapshots (`before_state` jsonb, `seq`, `undone`) |
| `audit_log` | Persistent action history (`actor`, `action`, `summary`, `detail`) |

## Tournament status machine

```
setup → group → knockout → final → completed
         ↑ round_robin may stay in group until done
```

- **setup:** created, not started; reset returns here.
- **group:** progress/Swiss/RR rounds in play.
- **knockout / final:** bracket stages (stepladder uses `playoff` stage too).
- **completed:** winner decided; undo/reset blocked in UI + API.

## Tournament formats (DB `format` column)

| Value | Description |
|-------|-------------|
| `swiss_knockout` | Swiss pairing for `num_group_rounds`, then knockout top `knockout_size` |
| `knockout` | Bracket only |
| `round_robin` | All vs all |
| `progress_stepladder` | Points table → seeding tie-break rounds → stepladder (Eliminator, Semi-final, Final) |

## API routes

### Auth

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/auth/signup` | `{ email, password, next? }` → `needs_verification`, optional `verify_url` |
| POST | `/api/auth/login` | `{ email, password, next? }` → `redirect` |
| POST | `/api/auth/verify-email` | `{ token, next? }` → session + `redirect` |
| POST | `/api/auth/logout` | Clears cookies |
| GET | `/api/auth/google` | Redirect to Google |
| GET | `/api/auth/google/callback` | OAuth callback |

### Organizations

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/orgs` | user | List memberships |
| POST | `/api/orgs` | user | `{ name }` — slug auto; sets active org |
| PATCH | `/api/orgs/[id]` | editor | Rename `{ name }` |
| POST | `/api/orgs/active` | user | `{ org_id }` — switch active org cookie |
| GET | `/api/orgs/[id]/members` | member | List members |
| POST | `/api/orgs/[id]/members/[userId]/role` | owner | `{ role }` |
| DELETE | `/api/orgs/[id]/members/[userId]` | owner | Remove member |
| GET/POST | `/api/orgs/[id]/invites` | editor | List / create (1h expiry) |
| POST | `/api/orgs/[id]/invites/[token]/revoke` | editor | Revoke link |
| GET/POST | `/api/orgs/[id]/sport-presets` | member / editor | List (lazy seed) / create custom |
| PATCH/DELETE | `/api/orgs/[id]/sport-presets/[presetId]` | editor | Update / delete custom |
| POST | `/api/orgs/[id]/sport-presets/[presetId]/reset` | editor | Reset built-in to factory defaults |

### Invites (public join)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/invites/[token]` | Preview org + role |
| POST | `/api/invites/[token]/accept` | Join org (logged in) |

### Seasons & tournaments

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET/POST | `/api/seasons` | editor | Scoped to active org |
| GET/POST | `/api/tournaments` | editor | Create with players array |
| GET | `/api/tournaments/[id]/state` | public* | Full bundle + standings |
| POST | `/api/tournaments/[id]/start` | editor | |
| POST | `/api/tournaments/[id]/result` | editor | `{ match_id, winner_id?, scores?, is_draw? }` |
| POST | `/api/tournaments/[id]/undo` | editor | |
| POST | `/api/tournaments/[id]/reset` | editor | Blocked if completed |
| DELETE | `/api/tournaments/[id]` | editor | Setup only — permanent delete |
| POST | `/api/tournaments/[id]/checkin` | editor | Toggle player checked_in |
| GET | `/api/tournaments/[id]/audit` | member | Audit log entries |

\*State route may be readable without auth depending on deployment; mutations always require editor.

## Cookies

| Name | Content |
|------|---------|
| `safe_session` | JWT `{ uid }` — 30 days |
| `safe_org` | Active organization UUID |
| `safe_oauth_next` | Temporary redirect after Google OAuth |

## Component map

| Component | Role |
|-----------|------|
| `auth-form.tsx` | Login/signup + dev verify link fallback |
| `verify-email.tsx` | Client verify + redirect |
| `create-org-form.tsx` | Name-only org create |
| `create-season-form.tsx` | Inline popover season form |
| `org-switcher.tsx` | Switch org button + expandable list |
| `org-rename.tsx` | Inline org name edit |
| `org-team.tsx` | Members list, invites, role changes |
| `new-tournament-form.tsx` | Full create wizard |
| `live-tournament.tsx` | Main scoring UI (tap winner, undo, reset) |
| `slideshow-view.tsx` | Display mode |
| `audit-modal.tsx` | Tournament audit trail |
| `client-time.tsx` | Hydration-safe timestamps |
| `modal.tsx` | Reusable dialog shell |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/apply-schema.ts` | Run `supabase/schema.sql` (no seed data) |
| `scripts/smoke.ts` | E2E API test (requires dev server on :3000) |
| `scripts/engine-check.ts` | Unit-style checks for pairing/standings |
