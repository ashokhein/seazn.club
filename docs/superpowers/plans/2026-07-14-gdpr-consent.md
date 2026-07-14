# GDPR Consent Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record terms/privacy acceptance in the DB for every account-creating email entry (clickwrap notice) and require an explicit, stored consent checkbox on public registration.

**Architecture:** One new migration (V279) adds consent columns to `users` and `registrations`. A tiny server module `lib/legal.ts` owns the policy version constant and the idempotent stamp function. UI is one shared `<LegalNotice/>` under account-creating forms plus a required checkbox in the register form's existing consent section (now always shown). Spec: `docs/superpowers/specs/2026-07-14-gdpr-consent-design.md`.

**Tech Stack:** Next.js (custom fork — see AGENTS.md), postgres.js tagged templates, zod v4 (`z.email()`, `z.iso.date()`), vitest (DB-backed suites skip without `DATABASE_URL`), Playwright e2e, Flyway migrations.

## Global Constraints

- AGENTS.md: this Next.js has breaking changes — check `node_modules/next/dist/docs/` before using any Next API you're unsure of.
- Worktree only: `git worktree add .claude/worktrees/gdpr-consent -b feat/gdpr-consent` from repo root. NEVER `git checkout`/`switch` in the main repo dir.
- DB-backed tests: ephemeral PG on 127.0.0.1:54329 (fall back 54331 if squatted), `DATABASE_SSL=disable`, run vitest from `apps/web` cwd (repo-root cwd breaks `@/` aliases).
- `LEGAL_VERSION = "2026-07-14"` everywhere (privacy page "Last updated" bumps to 14 July 2026 in Task 7).
- Every code change ships with a test that fails without it (standing feedback).
- Copy style: sentence case, plain verbs; consent label = "I agree that {org} and Seazn Club will store and process the details on this form (name, contact email, date of birth) to run this competition."
- rtk hook swallows `npx next dev` — launch dev servers as `node <root>/node_modules/next/dist/bin/next dev` with `PORT=<n>`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 0: Worktree + test DB

**Files:** none (environment).

- [ ] **Step 1: Create worktree**

```bash
cd /Users/ashokhein/github/seazn.club
git fetch origin && git worktree add .claude/worktrees/gdpr-consent -b feat/gdpr-consent origin/main
cp -cR node_modules .claude/worktrees/gdpr-consent/node_modules
cp -cR apps/web/node_modules .claude/worktrees/gdpr-consent/apps/web/node_modules
```

(APFS clonefile copies — Turbopack refuses symlinks outside project root.)

- [ ] **Step 2: Start ephemeral Postgres (skip if already running from this session)**

```bash
initdb -D /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/85e3447f-cffb-4871-93fa-d5747746da42/scratchpad/pg -U postgres --no-locale -E UTF8
pg_ctl -D <same>/pg -o "-p 54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp/seazn-pg-sock" -l <same>/pg.log start
createdb -h 127.0.0.1 -p 54329 -U postgres seazn_gdpr
cd .claude/worktrees/gdpr-consent
DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_gdpr" DATABASE_SSL=disable npm run db:apply
npm run sync:sports  # with same env, if smoke will be run later
```

Expected: Flyway migrates through V278. If port 54329 is squatted use 54331 + socket dir `/tmp/seazn-pg2`.

### Task 1: Migration V279

**Files:**
- Create: `db/migration/deltas/V279__consent.sql`

**Interfaces:**
- Produces: columns `users.terms_accepted_at timestamptz`, `users.terms_version text`, `registrations.privacy_consent_at timestamptz`, `registrations.privacy_consent_version text`. All later tasks rely on these names.

- [ ] **Step 1: Write the migration**

```sql
-- GDPR consent capture (spec 2026-07-14): clickwrap acceptance on accounts,
-- explicit processing consent on public registrations. Null = pre-policy row.
alter table users
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;

alter table registrations
  add column if not exists privacy_consent_at      timestamptz,
  add column if not exists privacy_consent_version text;
```

- [ ] **Step 2: Apply and verify**

```bash
DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_gdpr" DATABASE_SSL=disable npm run db:apply
psql "postgresql://postgres@127.0.0.1:54329/seazn_gdpr" -c "set search_path=seazn_club; \d users" | grep terms
```

Expected: V279 applied; both `terms_*` columns listed (schema is `seazn_club`, not `public`).

- [ ] **Step 3: Commit** — `git add db/migration/deltas/V279__consent.sql && git commit -m "feat(db): V279 consent columns on users + registrations"`

### Task 2: `lib/legal.ts` — version constant + stamp function (TDD)

**Files:**
- Create: `apps/web/src/lib/legal.ts`
- Test: `apps/web/src/lib/__tests__/legal.test.ts`

**Interfaces:**
- Produces: `LEGAL_VERSION: string` (= `"2026-07-14"`), `stampTermsAcceptance(userId: string): Promise<void>` — idempotent, first acceptance wins.

- [ ] **Step 1: Write the failing test**

```ts
// DB-backed (skipped without DATABASE_URL, like registrations.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { LEGAL_VERSION, stampTermsAcceptance } from "@/lib/legal";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("stampTermsAcceptance", () => {
  afterAll(async () => {
    await sql.end();
  });

  it("stamps first acceptance and never moves it", async () => {
    const email = `legal-${randomUUID()}@example.com`;
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${email}, 'Legal Test') returning id`;

    await stampTermsAcceptance(u.id);
    const [first] = await sql<{ terms_accepted_at: Date; terms_version: string }[]>`
      select terms_accepted_at, terms_version from users where id = ${u.id}`;
    expect(first.terms_accepted_at).toBeInstanceOf(Date);
    expect(first.terms_version).toBe(LEGAL_VERSION);

    await stampTermsAcceptance(u.id);
    const [second] = await sql<{ terms_accepted_at: Date }[]>`
      select terms_accepted_at from users where id = ${u.id}`;
    // Date equality via getTime() — toBe on Dates is a known vitest trap here.
    expect(second.terms_accepted_at.getTime()).toBe(first.terms_accepted_at.getTime());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_gdpr" DATABASE_SSL=disable npx vitest run src/lib/__tests__/legal.test.ts
```

Expected: FAIL — cannot resolve `@/lib/legal`.

- [ ] **Step 3: Implement**

```ts
import { sql } from "@/lib/db";

/** "Last updated" date of /legal/terms + /legal/privacy — bump when the text changes.
 *  (Cookie-banner consent versioning lives separately in lib/consent.ts.) */
export const LEGAL_VERSION = "2026-07-14";

/**
 * Record clickwrap acceptance of Terms + Privacy (GDPR spec 2026-07-14): the
 * user acted under a "By continuing, you agree…" notice. First acceptance
 * wins — later logins must not move the timestamp.
 */
export async function stampTermsAcceptance(userId: string): Promise<void> {
  await sql`
    update users set
      terms_accepted_at = coalesce(terms_accepted_at, now()),
      terms_version     = coalesce(terms_version, ${LEGAL_VERSION})
    where id = ${userId}`;
}
```

- [ ] **Step 4: Run test — PASS.** Same command as Step 2.
- [ ] **Step 5: Commit** — `git add -A apps/web/src/lib && git commit -m "feat: lib/legal — LEGAL_VERSION + idempotent terms-acceptance stamp"`

### Task 3: Registration consent enforcement (TDD)

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (~line 920, `PublicRegisterRequest`)
- Modify: `apps/web/src/server/usecases/registrations.ts` (guardian check ~line 760; insert ~line 807)
- Test: `apps/web/src/server/usecases/__tests__/registrations.test.ts`

**Interfaces:**
- Consumes: `LEGAL_VERSION` from Task 2.
- Produces: `PublicRegisterRequest.privacy_consent: boolean` (default false); `submitRegistration` throws `HttpError(422)` when false; stored rows carry `privacy_consent_at` + `privacy_consent_version`.

- [ ] **Step 1: Write the failing test.** In `registrations.test.ts`, find the guardian-consent 422 test (near line 463, uses a shared `base` payload) and add alongside, matching the file's existing rejection-assertion style:

```ts
it("rejects submissions without privacy consent (GDPR)", async () => {
  await expect(
    submitRegistration(orgSlug, competition.slug, { ...base, privacy_consent: false }, "http://t.local"),
  ).rejects.toMatchObject({ status: 422 });
});
```

(Adapt `orgSlug`/`competition`/`base` names and the exact rejects-matcher to what the surrounding tests actually use — read them first.)

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_gdpr" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/registrations.test.ts -t "privacy consent"
```

Expected: FAIL — submission succeeds (no check exists yet) or TS error on unknown field.

- [ ] **Step 3: Implement.**

3a. `schemas.ts` — inside `PublicRegisterRequest`, after `guardian_consent`:

```ts
/** GDPR (spec 2026-07-14): explicit agreement to store/process the form's PII. */
privacy_consent: z.boolean().default(false),
```

3b. `registrations.ts` — import `LEGAL_VERSION` from `@/lib/legal`; after the guardian-consent 422 block (~line 764):

```ts
// GDPR consent (spec 2026-07-14): explicit agreement before we store the
// registrant's details; timestamp + policy version make it demonstrable.
if (!input.privacy_consent) {
  throw new HttpError(422, "Please agree to the privacy policy to register");
}
```

3c. Insert statement (~line 807): add `privacy_consent_at, privacy_consent_version` to the column list and `now(), ${LEGAL_VERSION}` to values (keep positions aligned).

- [ ] **Step 4: Extend a happy-path test to pin storage.** In the basic successful-submission test, after the assertion on the result:

```ts
const [stored] = await sql<{ privacy_consent_at: Date | null; privacy_consent_version: string | null }[]>`
  select privacy_consent_at, privacy_consent_version from registrations where id = ${res.registration_id}`;
expect(stored.privacy_consent_at).toBeInstanceOf(Date);
expect(stored.privacy_consent_version).toBe(LEGAL_VERSION);
```

(Import `LEGAL_VERSION`; use whatever the test names its result/`sql` handle.)

- [ ] **Step 5: Fix existing payloads.** Every `submitRegistration(...)` happy-path payload in this test file now needs `privacy_consent: true` (add it to the shared `base` object and any inline payloads). Grep: `grep -n "submitRegistration(" src/server/usecases/__tests__/registrations.test.ts`.

- [ ] **Step 6: Run full registrations suite — PASS**

```bash
cd apps/web && DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_gdpr" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/registrations.test.ts
```

- [ ] **Step 7: Commit** — `git commit -am "feat(registration): require + record explicit privacy consent (422 without)"`

### Task 4: Auth route stamping

**Files:**
- Modify: `apps/web/src/app/api/auth/magic-link/route.ts` (~line 67)
- Modify: `apps/web/src/app/api/auth/google/callback/route.ts` (caller of `resolveUser` — grep `resolveUser(`)
- Modify: `apps/web/src/app/api/auth/signup/route.ts` (~line 39)
- Modify: `apps/web/src/app/api/auth/login/route.ts` (~line 47)

**Interfaces:**
- Consumes: `stampTermsAcceptance(userId)` from Task 2.

The stamp function itself is unit-tested (Task 2); these are one-line wire-ups verified by smoke (Task 6). Rationale per surface: the form/button sits directly above the `<LegalNotice/>` added in Task 5, so the submit is the agree act — for existing users each login re-affirms only if never stamped (coalesce).

- [ ] **Step 1: magic-link** — in `POST`, inside the `if (userId) { … }` block, first line:

```ts
await stampTermsAcceptance(userId);
```

- [ ] **Step 2: google callback** — in the handler, immediately after the user id is resolved (the `resolveUser(p)` call site): `await stampTermsAcceptance(userId);` (match the local variable name).

- [ ] **Step 3: signup** — after the `insert into users … returning id`: `await stampTermsAcceptance(user.id);`

- [ ] **Step 4: password login** — after `await createSession(user.id);`: `await stampTermsAcceptance(user.id);`

- [ ] **Step 5: Typecheck** — `cd apps/web && npx tsc --noEmit` (expected: clean) — then commit: `git commit -am "feat(auth): stamp terms acceptance on signup + logins"`

### Task 5: UI — LegalNotice + register-form checkbox

**Files:**
- Create: `apps/web/src/components/legal-notice.tsx`
- Modify: `apps/web/src/components/auth-form.tsx` (~line 114)
- Modify: `apps/web/src/components/start-wizard.tsx` (~line 232)
- Modify: `apps/web/src/components/public-site/register-form.tsx` (consent section ~line 356; state ~line 130; submit json ~line 172)
- Modify: `apps/web/src/lib/messages.ts` (register.* block)

**Interfaces:**
- Consumes: `privacy_consent` request field from Task 3.
- Produces: `<LegalNotice className?: string>`; register form sends `privacy_consent: privacyConsent`.

- [ ] **Step 1: LegalNotice component**

```tsx
import Link from "next/link";

/** Clickwrap notice under any action that signs in / creates an account
 *  (GDPR spec 2026-07-14). Server stamping: lib/legal.ts. */
export function LegalNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`text-center text-xs text-slate-400 ${className}`}>
      By continuing, you agree to our{" "}
      <Link href="/legal/terms" className="underline hover:text-slate-600">
        Terms of Service
      </Link>{" "}
      and{" "}
      <Link href="/legal/privacy" className="underline hover:text-slate-600">
        Privacy Policy
      </Link>
      .
    </p>
  );
}
```

- [ ] **Step 2: auth-form.tsx** — import it; directly under the existing `<p className="mt-4 …">No password needed…</p>` add `<LegalNotice className="mt-2" />`. (Covers /login, /claim/[token], /join — they all render `<AuthForm/>`.)

- [ ] **Step 3: start-wizard.tsx** — after the "We'll email you one link…" paragraph (~line 235) add `<LegalNotice className="text-left" />` (form is left-aligned; keep the notice consistent with the paragraph above it — drop `text-center` via className).

Note: `text-center` + `text-left` conflict — give LegalNotice `text-center` only as default and let className win by ordering: `className={`text-xs text-slate-400 ${className || "text-center"}`}` — adjust Step 1 accordingly if needed.

- [ ] **Step 4: messages.ts** — in the register.* block add:

```ts
"register.consent.data":
  "I agree that {org} and Seazn Club will store and process the details on this form (name, contact email, date of birth) to run this competition.",
"register.consent.privacy": "Privacy Policy",
```

- [ ] **Step 5: register-form.tsx** —

5a. State (near `guardianConsent`, ~line 130): `const [privacyConsent, setPrivacyConsent] = useState(false);`

5b. Submit json (~line 179, after `guardian_consent`): `privacy_consent: privacyConsent,`

5c. Consent section: change `show: needsGuardian` → `show: true` and make the body render the new checkbox always + the existing amber guardian block only when `needsGuardian`:

```tsx
{
  key: "consent",
  title: msg("register.section.consent"),
  show: true,
  body: (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          required
          checked={privacyConsent}
          onChange={(e) => setPrivacyConsent(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          {msg("register.consent.data", { org: org.name })}{" "}
          <a href="/legal/privacy" target="_blank" rel="noreferrer" className="underline">
            {msg("register.consent.privacy")}
          </a>{" "}
          *
        </span>
      </label>
      {needsGuardian && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          {/* existing guardian title/name/checkbox content moves here unchanged */}
        </div>
      )}
    </div>
  ),
},
```

(Keep the existing guardian JSX verbatim inside the conditional. Verify `org.name` exists on the `org` prop — logo/name already used in the masthead.)

- [ ] **Step 6: Visual verify (frontend-design mirror rule).** Start dev server in the worktree (`PORT=3014`, `node <root>/node_modules/next/dist/bin/next dev`, env from Task 0 DB). Playwright-MCP screenshot `/login` and a seeded register page at desktop 1280px and mobile 390px. Notice must read as quiet caption text, not compete with the primary action; checkbox row must not wrap awkwardly at 390px. Screenshots land in the MCP server cwd (main repo root), not session cwd.

- [ ] **Step 7: Commit** — `git commit -am "feat(ui): clickwrap LegalNotice + explicit registration consent checkbox"`

### Task 6: E2E + smoke updates

**Files:**
- Modify: `apps/web/e2e/registration.spec.ts`, `apps/web/e2e/registration-v2.spec.ts`, `apps/web/e2e/registration-payments.spec.ts`
- Modify: `scripts/smoke.ts`

**Interfaces:**
- Consumes: checkbox labelled via `register.consent.data` ("I agree that …"); 422 behaviour from Task 3; stamp behaviour from Task 4.

- [ ] **Step 1: e2e form flows.** In every UI flow that fills `Contact email` and submits, add before the submit click:

```ts
await page.getByRole("checkbox", { name: /I agree that/ }).check();
```

(`name: /I agree that/` disambiguates from the guardian checkbox "I am the parent/guardian…". Grep: `grep -n "Contact email" e2e/registration*.spec.ts`.)

- [ ] **Step 2: rewrite the inverted assertion.** `registration-v2.spec.ts` ~line 256 asserts the consent section does NOT render without a minor — now it always renders. Change the assertion to: consent section visible, guardian block absent, e.g.

```ts
await expect(page.locator("[data-section='consent']")).toBeVisible();
await expect(page.getByText(/parent\/guardian/i)).toBeHidden();
```

(Read the actual test first; keep its structure, flip only what the feature changed. The `#20` DOM-order test at line 91 should still pass untouched.)

- [ ] **Step 3: smoke payloads.** Add `privacy_consent: true` to every public register POST body in `scripts/smoke.ts` (grep `` /register` `` — 7 sites incl. lines ~621, 1153, 1176, 1200, 1231, 1266, 2030).

- [ ] **Step 4: smoke negative + stamp checks.** Near the honeypot check (~line 1176) add, following the file's `check()` idiom:

```ts
const noConsent = await v1(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${comp.slug}/register`, "POST", {
  division_id: div.id, display_name: `No Consent ${tag}`,
  contact_email: `noconsent_${tag}@example.com`,
});
check("registration without privacy consent is 422", noConsent.status === 422);
```

And after any magic-link request smoke already performs (or add one fresh email via `/api/auth/magic-link`), assert the stamp with the file's SQL helper:

```ts
check("magic-link signup stamps terms acceptance", !!(await sqlRow(`select terms_accepted_at from users where email = '...'`))?.terms_accepted_at);
```

(Adapt to smoke.ts's actual SQL/HTTP helper names — read the top of the file.)

- [ ] **Step 5: Run targeted e2e + full smoke locally.** E2e per repo conventions (dev server from Task 5 Step 6): `npx playwright test e2e/registration.spec.ts e2e/registration-v2.spec.ts e2e/registration-payments.spec.ts` from `apps/web`. Then full smoke: `SMOKE_BASE=http://localhost:3014 DATABASE_URL=… node --experimental-strip-types scripts/smoke.ts` from repo root (worktree). Expected: all green (memory: don't pipe smoke through `tail` — it eats failures).

- [ ] **Step 6: Commit** — `git commit -am "test: consent coverage in e2e + smoke (422 path, stamp check)"`

### Task 7: Docs, openapi, final verify

**Files:**
- Modify: `apps/web/src/app/legal/privacy/page.tsx`
- Modify: `apps/web/content/help/registration/open-registration.md`, `apps/web/content/help/registration/youth.md`, `apps/web/content/help/players/claim-your-profile.md`
- Modify: `openapi/v1.json` (generated)

- [ ] **Step 1: Privacy page.** Bump `Last updated: 14 July 2026`. Add one sentence under the data-collection section: acceptance of these terms is recorded (timestamp + policy version) when an account is created or a registration is submitted.

- [ ] **Step 2: Help pages (MANDATORY closing pass).** `open-registration.md`: registrants must tick a consent checkbox; what is stored and why. `youth.md`: guardian consent now sits alongside the standard privacy consent. `claim-your-profile.md`: signing in accepts Terms/Privacy (one line). Match each file's existing tone/frontmatter.

- [ ] **Step 3: Regenerate openapi** — from worktree root: `npm run openapi:gen`, commit the diff (drift gate is CI-enforced).

- [ ] **Step 4: Full verify before push** (standing feedback: tsc + units):

```bash
cd apps/web && npx tsc --noEmit && DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_gdpr" DATABASE_SSL=disable npx vitest run
```

Expected: tsc clean; suites green (known env flake: full-suite parallel runs against one local DB — re-run failing files individually before blaming the change).

- [ ] **Step 5: Commit + push + PR**

```bash
git add -A && git commit -m "docs: privacy update + help pages + openapi for consent capture"
git push -u origin feat/gdpr-consent
gh pr create --title "feat: GDPR consent capture — clickwrap on auth, explicit consent on registration (V279)" --body "…spec + summary…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

PR body: link spec file, list V279 columns, note deploy step (Flyway V279 on stg/prod alongside pending V278).
