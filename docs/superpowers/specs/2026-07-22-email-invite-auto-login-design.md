# Email-invite auto-login + auto-join — design

**Date:** 2026-07-22
**Branch:** `feat/invite-auto-login`
**Status:** design approved (owner), pre-implementation

## Problem

A person invited to an org **by email** (org admin, player, or official) reaches
`/join/{token}` with no session. The page renders `AuthForm`, so a brand-new
invitee must request a **magic-link** — a *second* email — sign in, come back to
the invite page, then click Accept. Two inboxes, two round-trips, to join one org.

The invite link in the first email is already a magic-link-grade credential; the
second email is redundant.

## Goal

For an invitee whose account is **new or unverified**, the email-invite link both
signs them in and joins the org in **one click**. Invitees whose email already
maps to a **verified** account keep the current sign-in-first flow (no change).

Non-goals: shareable/QR invite links (no bound email), password auth, changing
invite creation, backfill/grandfather (pre-launch, zero customers).

## Trust model

An email invite token (`org_invites`) is equivalent in trust to a magic-link
token (`login_links`):

| | invite token | magic-link token |
|---|---|---|
| bound to | one email (`invite.email`) | one user |
| uses | single (`max_uses=1` for email invites) | single (`used`) |
| entropy | 24 random bytes | 32 random bytes |
| delivery | emailed to the invited address | emailed to the user |

Possession of an email-bound invite token proves control of that inbox — the same
basis `consumeLoginLink` → `createSession` already relies on. So the invite-accept
path may mint a session, exactly as magic-link does.

## The safety gate

Auto-login is allowed **only when the invited email has no protectable account**:

```
account for invite.email:
  none                    -> create + session + join      (auto)
  exists, email_verified=false -> session + join           (auto; inert, nothing to steal)
  exists, email_verified=true  -> NO session; normal sign-in, then accept
```

Rationale: an invite can be forwarded. If the invite minted a session for a
**verified** account, a forwarded copy would be account takeover of that person's
real orgs/billing/data. An unverified/absent account has nothing to steal, so
auto-login there is safe. The gate is one boolean: `users.email_verified`.

This means existing org owners/users (verified) never auto-login from an invite —
they sign in as today (and if already logged in, the existing one-click
`JoinInvite` applies). The zero-friction win targets **never-registered**
players/officials, the common case.

## Architecture

### New route — `POST /api/invites/[token]/claim`  (anonymous-allowed)

Mirrors the magic-link `consume` route (page → POST, route mints the session).

1. IP rate-limit (`AUTH_LIMIT`), same as `magic-link/consume`.
2. `loadInvite(token)`; `inviteProblem` → 4xx (not-found / expired / revoked / used).
3. **Require `invite.email`** — shareable links (email `null`) are not claimable
   this way; return "sign in to accept".
4. Resolve the invited-email account:
   - none → `resolveOrCreateUser(invite.email)`.
   - exists & `email_verified=false` → use it.
   - exists & `email_verified=true` → return `{ needs_signin: true }`, **no
     session, no join** — the client falls back to sign-in.
5. `createSession(userId)`; flip `email_verified=true` (invite proves the inbox,
   same as `consumeLoginLink`); `stampTermsAcceptance(userId)` (button sits under
   the terms notice, GDPR spec 2026-07-14).
6. `acceptInvite(invite, userId)` — email match now trivially holds; join burns
   the single use via `grantInvite`.
7. `setActiveOrgId(invite.org_id)`; return the same `{ org_id, org_name, role,
   outcome, landing }` shape the existing accept route returns.

Steps 5–6 run so the session, verified-flip, and join are coherent. Defense in
depth: once the account is verified, a replayed/forwarded token hits the
`needs_signin` branch even before the use-count check.

### Shared helpers (dedupe)

- Extract `resolveOrCreateUser` (today local to `api/auth/magic-link/route.ts`)
  into `@/lib/users.ts`; magic-link and claim both import it.
- Extract the landing computation (`role === "scorer" || outcome ===
  "scope_added" ? "/my-matches" : "/dashboard"`) into `inviteLanding()` in
  `@/lib/invites.ts`; the accept and claim routes share it.

### Join page — `app/join/[token]/page.tsx`

When there is **no session** and `invite.email` is set and the invite is valid,
render a primary **"Accept invitation"** button (new `ClaimInvite` client
component) that POSTs the claim route. On `{ needs_signin: true }` the component
falls back to the existing `AuthForm` (magic-link to the invited email,
`next=/join/{token}`). Shareable-link (no email) anonymous case is unchanged
(`AuthForm`). Logged-in case is unchanged (`JoinInvite`).

### New client component — `components/claim-invite.tsx`

Button → `POST /api/invites/{token}/claim` → on success `router.push(landing)`;
on `needs_signin` reveal `AuthForm`. Sits under the "By continuing, you agree…"
terms notice.

## Security requirements (must hold)

- Claim is **POST only** and IP rate-limited — never a GET (email scanners /
  link prefetch must not consume it; CSRF).
- A **verified** account is never auto-logged-in — forwarded-invite takeover of a
  real account is impossible.
- Session-mint, verified-flip, and join happen together; the single use is burned.
- No enumeration beyond token possession (a valid invite token is already the
  secret; the page already reveals org + role for it).

## Testing (regression-first)

Unit (`vitest`), each fails without the change:
- new email → account created, session, joined, `email_verified=true`, landing.
- unverified existing → joined, session, `email_verified` flips true.
- **verified existing → `needs_signin`, NO session, NO join** (the takeover guard).
- non-email (shareable) invite → refused, no account created.
- expired / revoked / used invite → problem error, no account created.

E2E (`apps/web/e2e`, prod-build local only — do **not** enable `e2e.yml`):
- email invite → one click → lands logged-in on dashboard/my-matches, no second
  email.

## Files

- NEW `apps/web/src/app/api/invites/[token]/claim/route.ts`
- NEW `apps/web/src/components/claim-invite.tsx`
- NEW `apps/web/src/lib/users.ts` (extracted `resolveOrCreateUser`)
- `apps/web/src/lib/invites.ts` (add `inviteLanding`)
- `apps/web/src/app/api/auth/magic-link/route.ts` (import extracted helper)
- `apps/web/src/app/api/invites/[token]/accept/route.ts` (use `inviteLanding`)
- `apps/web/src/app/join/[token]/page.tsx` (anonymous + email-bound → claim button)
- i18n `ui` dict keys (claim button, terms notice) across the 4 locales
- Help page (invites/onboarding) — mandatory closing pass
- `scripts/smoke.ts` — extend an invite path

## Open items (resolve during planning)

- Confirm whether org-invite creation pre-creates a `users` row for the invited
  email (with `email_verified=false`). Either way the gate covers it, but it
  decides whether "new" and "unverified existing" are one branch or two.
