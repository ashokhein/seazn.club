# GDPR / EU consent capture — design

Date: 2026-07-14. Status: approved (auto-approve standing preference; forks resolved via Q&A: record in DB, all account-creating surfaces).

## Problem

Emails (and registrant PII) are collected with no terms/privacy acceptance anywhere:

- `/login` (`auth-form.tsx`) — magic link + Google; an unknown email silently creates an account.
- `/start` wizard and `/claim` invite-claim — also create accounts via email entry.
- Public division registration (`public-site/register-form.tsx`) — collects name, email, DOB, gender; only guardian consent exists (youth/minors).

GDPR Art. 7 requires being able to *demonstrate* consent/acceptance, so UI notices alone are not enough.

## Decision

Consent columns on existing tables + one shared notice component. No consent-history table (YAGNI — revisit if policy re-consent flows are ever needed).

### Legal basis

- Registration data processing = contract necessity (Art. 6(1)(b)); the explicit checkbox is transparency + belt-and-braces.
- Account creation = clickwrap acceptance of Terms + Privacy ("By continuing…" under the submit action).

### DB — V279 (`db/migration/deltas/V279__consent.sql`)

- `users.terms_accepted_at timestamptz`, `users.terms_version text`
- `registrations.privacy_consent_at timestamptz`, `registrations.privacy_consent_version text`
- No backfill. Null = pre-policy account; stamped on next login through a form that carries the notice.

### Version constant

`lib/legal.ts` exports `LEGAL_VERSION` — the "Last updated" date of `/legal/privacy`. This change itself amends the policy (consent-record disclosure), so both become `2026-07-14`. Bump manually when the policy text changes. (Distinct from `lib/consent.ts`, which already versions the cookie/analytics banner.)

### Server stamping

- `POST /api/auth/magic-link`: stamp on user create; also update-if-null for existing users (the form submit under the notice is the agree act).
- Google OAuth callback: stamp on insert; update-if-null on returning login.
- `POST /api/auth/signup` and password login route: same pattern.
- Public register endpoint (`server/usecases/registrations.ts` + route schema): `privacy_consent: z.literal(true)` — request without it fails 422 with a clear message; persist `privacy_consent_at = now()` + `privacy_consent_version = LEGAL_VERSION`.

### UI

- `<LegalNotice/>` (in or beside `lib/legal.ts`): "By continuing, you agree to our [Terms of Service](/legal/terms) and [Privacy Policy](/legal/privacy)." Small muted text under the primary action.
- Surfaces: `auth-form.tsx` (covers `/login`, `/claim/[token]`, `/join` — all render `<AuthForm/>`) and `start-wizard.tsx` (email step). `v2/invite-claim.tsx` is excluded: there the organiser types the player's email; the player themself agrees on `/claim` via AuthForm.
- `register-form.tsx`: consent section now shows for ALL registrants (previously only guardian cases). Required checkbox: "I agree that {org} and Seazn Club process the details on this form (name, email, date of birth) to run this competition — see Privacy Policy." i18n keys in `lib/messages.ts` (all locale files). Guardian consent unchanged, stacked in same section for youth.

### Out of scope

- Cookie banner (no third-party marketing cookies today; `/legal/cookie-policy` already exists).
- Marketing-email opt-in (no marketing sends exist).
- Data export / erasure tooling (users table already has `deleted_at`/`purge_after`).
- Re-consent UX on version bump.

## Testing

- Unit: register schema rejects missing/false `privacy_consent` (422); accepts `true` and row carries timestamp + version. Magic-link create stamps `terms_accepted_at`; existing-null user gets stamped on re-request.
- E2E: public registration flow checks the consent checkbox (spec update).
- Smoke: `scripts/smoke.ts` registration paths send `privacy_consent: true`.
- openapi regenerated (drift gate).

## Delivery

Worktree `.claude/worktrees/gdpr-consent`, branch `feat/gdpr-consent`, PR to main. Closing pass: `content/help/*.md` updated (registration help + account/privacy mentions), tsc + unit tests before push.
