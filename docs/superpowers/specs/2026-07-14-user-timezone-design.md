# User timezone preference — design

**Date:** 2026-07-14 · **Branch:** `feat/user-timezone` (off `main`) · **Migration:** V280

## Problem

Times render inconsistently and **without ever naming their zone**:

- Console / admin / billing / audit / `/me` format with `toLocaleString`-family
  calls in the **viewer's browser zone** (client) or **Node's zone** (server, usually
  en-US/UTC on host) — a silent, unstable choice, never labelled.
- Schedule boards / public league pages correctly render in the competition's
  **venue zone** (`schedule_settings.tz`) — but also print no zone label, so `19:00`
  is ambiguous to anyone not standing at the venue.
- There is **no user-level timezone**: a signed-in user cannot say "show my personal
  times in Europe/London", and the server has nothing stable to render with (drives
  hydration mismatches, papered over today by client-only `<ClientTime>` fills).

Goal: a per-user timezone setting in **Account settings**, persisted in the DB, and a
zone label on **every** rendered time so the zone is always explicit.

## Non-goals (binding)

- **Not** converting schedule/venue times to the viewer's zone. A fixture at a venue
  happens at venue wall-clock; the competition `schedule_settings.tz` stays
  authoritative for schedule display (v5/00 §5). We add a *label*, we do not re-anchor.
- **Not** the v5 i18n wave (locale columns, dictionaries, fonts, translation pipeline).
  This builds the shared `lib/format.ts` that v5/00 §5 also calls for, and reuses v5's
  cookie+resolver pattern, so v5 lands on top cleanly — but locale is out of scope here.
- Storage format of timestamps is unchanged: all columns are already `timestamptz`
  (UTC instants). "Timezone in the database" means the new **user preference** column,
  not a change to how instants are stored.

## Decisions (approved 2026-07-14)

1. **Two-lane display, always labelled** — schedules stay in venue tz; account / system /
   personal times render in the user's tz; every time carries a zone label.
2. **Label = short abbrev + IANA on hover** — primary `IST` / `BST` / `EDT`; full
   `Asia/Kolkata` in `title` tooltip and shown verbatim in the picker.
3. **Scope = timezone only** — no locale work this wave.

## The two lanes

| Lane | Zone used | Where | Example |
|------|-----------|-------|---------|
| **Venue** | competition `schedule_settings.tz` | fixture board, division & public schedule, round headers, slideshow/embeds, device-link day windows | `Sat 16 Aug 19:00 IST` |
| **Personal** | resolved **user tz** | `/me` fixtures, Account settings, audit log, admin users/orgs/coupons, billing renewal dates, `created_at`, API-key last-used | `14:30 BST` |

`/me` (player home) is a personal page **about venue events** → show the venue time as
primary with its venue label, plus a secondary "· your time HH:MM ZZZ" **only when the
user tz differs from the venue tz**. Players decide when to show up at the venue; the
secondary line prevents a "why does it say 19:00, I thought 2pm" misread.

## Components

### 1. DB — `V280__users_timezone.sql`

```sql
alter table users add column timezone text;
-- IANA zone name (e.g. 'Europe/London'); null = not set → resolver falls back.
-- Light guard: reject empty / whitespace. Full IANA validity is enforced app-side
-- (Intl.supportedValuesOf) — Postgres has no IANA catalogue without pg_timezone joins,
-- and a CHECK against pg_timezone_names would couple us to the server's tzdata.
alter table users add constraint users_timezone_nonblank
  check (timezone is null or btrim(timezone) <> '');
```

### 2. `lib/format.ts` (new — the v5/00 §5 foundation, tz slice only)

Thin `Intl.*` wrappers. Locale param defaults to `"en-GB"` today (v5 will thread the
resolved locale later); **tz is a required, explicit argument** — no implicit
`resolvedOptions()` zone, ever.

```ts
fmtDate(tz, value, opts?)      // date only
fmtTime(tz, value, opts?)      // time only
fmtDateTime(tz, value, opts?)  // date + time
fmtZoneAbbrev(tz, value)       // 'IST' — via Intl timeZoneName:'short', at that instant (DST-correct)
fmtRange(tz, from, to)         // compact date range (absorbs client-time.tsx ClientDateRange logic)
```

`fmtZoneAbbrev` takes `value` because the abbrev is DST-dependent (`BST` vs `GMT` at the
same location). Unknown/invalid tz → functions catch and fall back to `UTC` + log in dev
(same defensive posture as today's `client-time.tsx`).

### 3. `resolveTimezone()` — server helper (in `lib/tz.ts`)

Precedence, resolved once per request:

1. `users.timezone` (signed-in, non-null)
2. `seazn_tz` cookie — browser-detected IANA name, written client-side on first load
   (1y, SameSite=Lax), so **anonymous** and not-yet-set users still get their real zone
   server-side (kills the hydration-mismatch dance for personal times)
3. `"UTC"`

Validated against `Intl.supportedValuesOf("timeZone")` before use; invalid → next rung.
`getCurrentUser()` select + its cache payload gain `timezone` so lane-2 server renders
read it without an extra query. `invalidateUser()` already called on profile PATCH.

### 4. `<Zoned>` display component (extends today's `client-time.tsx`)

- Server-first: personal times can now render on the server in the resolved tz (stable),
  with `<Zoned tz={userTz} showZone />`. No more empty-span-until-mount for the common case.
- `showZone` appends the abbrev; `title` carries the full IANA name (decision 2).
- Keeps a client fallback for the anonymous-no-cookie first paint only.
- `ClientDateRange` folds into `fmtRange`; existing call sites keep working via re-export.

### 5. Account UI — `<TimezonePreference>` (new) in Account tab

New **Preferences** section in `/o/[org]/settings?tab=account`, above Change-email:

- `<select>` populated from `Intl.supportedValuesOf("timeZone")`, grouped by continent,
  each option showing `Asia/Kolkata — IST (GMT+5:30)` computed live.
- **Detect** button → `Intl.DateTimeFormat().resolvedOptions().timeZone`, preselects it.
- Live preview: "Current time here: **14:30 BST**", updates on select.
- Save → `PATCH /api/users/me { timezone }`. Empty selection allowed → clears to null
  ("Use my browser's timezone").
- On save also writes the `seazn_tz` cookie so anonymous-lane fallback matches.

### 6. API — extend `PATCH /api/users/me`

`updateProfileSchema` gains optional `timezone: z.string().refine(isValidIana).nullable()`.
Route updates `users.timezone`, keeps `display_name` path intact, calls `invalidateUser`.
`isValidIana` = membership in `Intl.supportedValuesOf("timeZone")` (server-side).

### 7. Zone labels on the venue lane

Schedule surfaces already pass `tz={schedule_settings.tz}` to time components — flip on
`showZone` there so venue times read `19:00 IST`. `day-label.ts`/board keep venue-zone
grouping unchanged; only the label is added. The board settings panel (which *sets* the
venue tz) gains a one-line "all times below shown in <tz>" caption.

## Data flow

```
request ─▶ resolveTimezone() ─┬─ users.timezone (cache) ─┐
                              ├─ seazn_tz cookie ────────┤─▶ userTz
                              └─ 'UTC' ──────────────────┘
personal render ─▶ fmtDateTime(userTz, …) + fmtZoneAbbrev(userTz, …)
venue render    ─▶ fmtDateTime(schedule_settings.tz, …) + abbrev   (unchanged zone)
Account save    ─▶ PATCH /api/users/me ─▶ users.timezone + seazn_tz cookie ─▶ invalidateUser
```

## Error handling

- Invalid/unknown tz anywhere → fall to `UTC`, dev-warn, never throw (matches
  `client-time.tsx` today).
- API rejects a non-IANA `timezone` with 422 (zod) — client select can't produce one, but
  the API is public-ish (own-account) so it validates.
- Missing `Intl.supportedValuesOf` (older runtime): ship a static fallback IANA list
  constant; feature-detect at module load.

## Testing (every change ships a failing-without-it test)

- **Unit** `resolveTimezone` precedence: user col > cookie > UTC; invalid values skipped.
- **Unit** `fmtZoneAbbrev` DST correctness: `Europe/London` → `GMT` in Jan, `BST` in Jul.
- **Unit** `updateProfileSchema` rejects `"Mars/Phobos"`, accepts `"Asia/Kolkata"`, accepts null.
- **e2e** set tz in Account → `/me` personal time shows chosen abbrev; venue time on a
  fixture page still shows venue abbrev (proves two-lane).
- **smoke.ts** extend pro + free: PATCH tz, assert whoami/me reflects it and label present.

## Docs (mandatory closing pass)

- `content/help/*` — new "Set your timezone" entry under account/preferences; note the
  two-lane rule (why a fixture shows venue time, not yours).
- OpenAPI: `PATCH /users/me` request body gains `timezone` (no new route → no ROUTES add).

## Rollout

Additive, nullable column — safe pre-deploy. Migration V280 applies via Flyway
(`db:apply`). No backfill. Existing `<ClientTime tz=…>` call sites keep working during the
incremental `lib/format.ts` migration; the wave doesn't need a big-bang cutover.
