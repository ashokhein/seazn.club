# Issue #403 — data protection review: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every checkbox on #403 with cited evidence, ship the small copy
changes the audit found owed, close the one real storage-limitation gap the audit
uncovered, and hand #404 a written requirements set it must satisfy.

**Architecture:** This is an audit wave. Most checkboxes are *verification* — the
mitigations already shipped in #396/#400 and the finding is a citation, not code.
Three items need code: a privacy-page section describing the same-name grouping, a
reword of the three free-text instruction hints so the field steers at scheduling
rules rather than at people, and a retention sweep for `ai_parse_previews` (which
stores the organiser's raw instruction — free text that can carry personal data —
with an `expires_at` nothing acts on). Legal pages are hardcoded English JSX and
owe **no** 4-locale work; the three dictionary hints owe all four.

**Tech Stack:** Next.js (app router), Postgres via `sql` tagged template, vitest,
Playwright, flat dotted-key JSON dictionaries, GitHub Actions cron + `x-cron-secret`.

## Global Constraints

- Every change ships a test that fails without it.
- Dictionary strings → all 4 locales: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`.
  Flat dotted keys. `content/help/**` and `apps/web/src/app/legal/**` are ONE English
  tree and owe no i18n work.
- UI/copy verified by screenshot at desktop **and 375px**, no horizontal page scroll.
- No new migration in this wave (greenfield rules still apply, but nothing here needs
  schema).
- Pre-commit: run `openapi:gen` **and** `i18n:gen-keys`, then `git status --porcelain`
  must be empty. Both are CI-only drift gates; a green local test run proves nothing.
- Fresh git worktree; PR (never a local merge + push to `main`) so smoke CI runs.
- Verify with `--reporter=json --outputFile` and read `numPassedTests` /
  `numTotalTests`. `rtk`'s summary prints `PASS(0) FAIL(0)` for a suite that failed
  to collect.
- `grep -a` always — this repo reports source files as "Binary file … matches".

---

## Evidence already established (do not re-derive)

| Claim | Evidence |
|---|---|
| Grouping impl | `personKeyResolver`, `apps/web/src/server/usecases/schedule-ai.ts:173-202`; `normName` at `:152` |
| Non-persisted | Two call sites only (`schedule-ai.ts:623`, `competition-schedule-ai.ts:517`), both build in-memory maps; no write of the synthetic key. Test `schedule-ai-pack.test.ts:710` "…one participant key, persons untouched" |
| Never reaches the model | `toModelPayload` (`schedule-ai.ts:396`) returns `Omit<SchedulePack,"participants"\|"assumptions">` |
| Scheduling-scoped | Both call sites feed `computeParticipants` → rest/overlap only; no stats/discipline/profile/public call site |
| Disclosed | Assumption string built at `schedule-ai.ts:184-199`, merged at `:800` / `competition-schedule-ai.ts:805`, rendered via `ai-review.ts:76` in `ai-review-panel.tsx`; test `ai-console-review.test.tsx:82,98` |
| What actually reaches the sub-processor | `PackEntrant.name`, `PackOfficial.name`, the free-text `instruction`. `PackPerson` is `{person_id, entrant_ids}` — **ids only, no person names**. No `dob`, `photo_path`, `contact_email` |
| z3 is in-process | `z3-solver: 5.0.0` in `packages/engine/package.json:35`; loaded by `packages/engine/src/scheduling/z3-load.ts` |
| Legal pages are English JSX | `apps/web/src/app/legal/{privacy,dpa,sub-processors,terms,cookie-policy}/page.tsx`, no i18n import |
| `LEGAL_VERSION` | `apps/web/src/lib/legal.ts:5` = `"2026-07-14"`; consumed by `stampTermsAcceptance` (`:12-17`) and `registrations.ts:994`. **No read-side consumer** — bumping it does not re-prompt anyone |
| Sub-processors already name all four AI vendors | `sub-processors/page.tsx:41,47,53,59` |
| `ai_parse_previews` stores raw instruction | `db/migration/deltas/V345__ai_parse_previews.sql:37` `instruction text not null`, `expires_at` at `:50`, sweep index at `:63-65` — and **nothing sweeps**: the only call sites are `schedule-ai-preview.ts:185,249,512` |
| Merge collision surfaces (for #404) | composite PKs containing `person_id`: `entrant_members(entrant_id,person_id)`, `player_profiles(person_id,sport_key)`, `fixture_availability(fixture_id,person_id)`, `player_stat_snapshots(division_id,person_id)`, `team_members(team_id,person_id)`, `lineups(fixture_id,entrant_id,person_id)`; plus partial unique `person_claims_open_uq on person_claims(person_id)` |

---

### Task 1: Privacy page — automated same-name grouping section

**Files:**
- Modify: `apps/web/src/app/legal/privacy/page.tsx` (insert a section after §4, renumber §5-§11 → §6-§12, update "Last updated" at `:17`)
- Modify: `apps/web/src/lib/legal.ts:5` (`LEGAL_VERSION` → `"2026-08-04"`, and widen the docstring to "the latest 'Last updated' of /legal/terms + /legal/privacy")
- Create: `apps/web/src/app/legal/__tests__/privacy-scheduling-note.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the exact sentence Task 5's smoke assertion greps for —
  `treated as one player while a timetable is built` — and
  `LEGAL_VERSION = "2026-08-04"`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "../privacy/page";
import { LEGAL_VERSION } from "@/lib/legal";

describe("privacy page — scheduling grouping disclosure (#403 finding 2)", () => {
  const html = renderToStaticMarkup(<PrivacyPage />);

  it("describes automatic same-name grouping for scheduling", () => {
    expect(html).toContain("treated as one player while a timetable is built");
  });

  it("says the grouping is not written to any record", () => {
    expect(html).toContain("No records are merged");
  });

  it("carries the LEGAL_VERSION date as its Last updated line", () => {
    // Guards the drift that makes a consent stamp mean nothing: the page text
    // moved but the version users consented to did not.
    const [y, m, d] = LEGAL_VERSION.split("-").map(Number);
    const shown = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    expect(html).toContain(`Last updated: ${shown}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run apps/web/src/app/legal/__tests__/privacy-scheduling-note.test.tsx --reporter=json --outputFile=/tmp/t1.json; node -e "const r=require('/tmp/t1.json');console.log(r.numPassedTests,'/',r.numTotalTests)"`
Expected: 0 / 3 — all three fail (no such copy, `LEGAL_VERSION` still 2026-07-14).

- [ ] **Step 3: Write the copy**

In `privacy/page.tsx`, change `:17` to `Last updated: 4 August 2026`, then insert
after the §4 section and renumber the rest:

```tsx
<section>
  <h2 className="mb-2 text-lg font-semibold text-slate-800">5. Automated grouping when we build a schedule</h2>
  <p>When we lay out a timetable, player records that carry the same name are <strong>treated as one player while a timetable is built</strong>, so one person is never booked onto two courts at the same time. It is a scheduling safeguard only. <strong>No records are merged</strong>: the records stay separate on rosters, results and reports, nothing is written to them, and the grouping is discarded when the run ends. Every grouping we make is listed back to the organiser before they apply the schedule, so a wrong match can be corrected. This is not automated decision-making under Article 22 — it decides only what time a match is played.</p>
</section>
```

In `lib/legal.ts`:

```ts
/** The latest "Last updated" date across /legal/terms + /legal/privacy — bump
 *  when either text changes. (Cookie-banner consent versioning lives separately
 *  in consent.ts.) */
export const LEGAL_VERSION = "2026-08-04";
```

- [ ] **Step 4: Run test to verify it passes**

Run: the Step 2 command.
Expected: 3 / 3.

- [ ] **Step 5: Screenshot-verify at desktop and 375px**

Bring the app up per the `seazn-local-env` skill, then Playwright MCP:
`browser_navigate /legal/privacy` → `browser_resize 1440x900` → screenshot →
`browser_resize 375x812` → screenshot. Confirm no horizontal page scroll and the
section numbering reads 1…12 with no repeat.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/legal/privacy/page.tsx apps/web/src/lib/legal.ts apps/web/src/app/legal/__tests__/privacy-scheduling-note.test.tsx
git commit -m "privacy: disclose the scheduling-only same-name grouping (#403)"
```

---

### Task 2: Instruction copy must not invite free-text personal data

**Files:**
- Modify: `apps/web/src/dictionaries/en/ui.json`, `.../es/ui.json`, `.../fr/ui.json`, `.../nl/ui.json` — keys `board.ai.instructionHint`, `board.ai.joint.instructionHint`, `board.ai.officials.instructionHint`
- Modify: `apps/web/content/help/scheduling/ai-scheduling.md:23` (English-only tree)
- Create: `apps/web/src/components/v2/board/__tests__/ai-instruction-privacy-copy.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: no new keys — the three keys already exist in `i18n-keys.ts`
  (`:454`, `:472`, `:516`), so `i18n:gen-keys` output must be unchanged.

**Why the reword:** the placeholder is already rule-shaped ("Finish the top two
seeds before 6pm…"), but the hint — "Plain language works best — the more
specific, the better the plan" — rewards adding detail without saying which kind.
The structured "Keep apart" wish chip already covers the entrant-vs-entrant case
by *picking* entrants, so nothing is lost by steering the free text at rules.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const HINTS = [
  "board.ai.instructionHint",
  "board.ai.joint.instructionHint",
  "board.ai.officials.instructionHint",
] as const;

describe("#403 finding 4 — the instruction field asks for rules, not people", () => {
  it("no locale still rewards unbounded specificity", () => {
    for (const d of [en, es, fr, nl] as Record<string, string>[]) {
      for (const k of HINTS) {
        expect(d[k], k).toBeTruthy();
        expect(d[k].toLowerCase()).not.toContain("the more specific");
      }
    }
  });

  it("every locale points the organiser at times, courts and rest", () => {
    // en is the source of truth for wording; the other three must simply differ
    // from en (i.e. actually be translated) and be non-empty.
    for (const k of HINTS) {
      expect(en[k as string]).toMatch(/times, courts/i);
      for (const d of [es, fr, nl] as Record<string, string>[]) {
        expect(d[k], k).not.toBe(en[k as string]);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run apps/web/src/components/v2/board/__tests__/ai-instruction-privacy-copy.test.tsx --reporter=json --outputFile=/tmp/t2.json; node -e "const r=require('/tmp/t2.json');console.log(r.numPassedTests,'/',r.numTotalTests)"`
Expected: 0 / 2 — en still contains "the more specific".

- [ ] **Step 3: Write the copy (all four locales)**

English:
```json
"board.ai.instructionHint": "Plain language works best. Describe times, courts and rest gaps — pick entrants with a wish above rather than describing people.",
"board.ai.joint.instructionHint": "Say what matters most about times, courts and rest gaps. Every proposal is checked by the engine before you see it.",
"board.ai.officials.instructionHint": "Plain language works best — describe duties, times and rest gaps, or add a wish below."
```
Spanish:
```json
"board.ai.instructionHint": "El lenguaje sencillo funciona mejor. Describe horarios, pistas y descansos: elige participantes con un deseo arriba en lugar de describir personas.",
"board.ai.joint.instructionHint": "Di qué importa más sobre horarios, pistas y descansos. El motor comprueba cada propuesta antes de que la veas.",
"board.ai.officials.instructionHint": "El lenguaje sencillo funciona mejor: describe funciones, horarios y descansos, o añade un deseo abajo."
```
French:
```json
"board.ai.instructionHint": "Le langage simple fonctionne le mieux. Décrivez horaires, terrains et temps de repos — choisissez les participants avec un souhait ci-dessus plutôt que de décrire des personnes.",
"board.ai.joint.instructionHint": "Dites ce qui compte le plus en matière d'horaires, de terrains et de temps de repos. Chaque proposition est vérifiée par le moteur avant de vous être présentée.",
"board.ai.officials.instructionHint": "Le langage simple fonctionne le mieux — décrivez les fonctions, les horaires et les temps de repos, ou ajoutez un souhait ci-dessous."
```
Dutch:
```json
"board.ai.instructionHint": "Gewone taal werkt het best. Beschrijf tijden, banen en rustpauzes — kies deelnemers met een wens hierboven in plaats van personen te beschrijven.",
"board.ai.joint.instructionHint": "Zeg wat het belangrijkst is aan tijden, banen en rustpauzes. Elk voorstel wordt door de engine gecontroleerd voordat je het ziet.",
"board.ai.officials.instructionHint": "Gewone taal werkt het best — beschrijf taken, tijden en rustpauzes, of voeg hieronder een wens toe."
```

In `ai-scheduling.md:23`, make the data-minimisation fact explicit (it is currently
true but unstated — the pack sends `{person_id, entrant_ids}`, never a person's name):

```md
- entrants, and players shared across entrants — as links between records, never their names (so it never double-books a person);
```

- [ ] **Step 4: Run test to verify it passes**

Run: the Step 2 command. Expected: 2 / 2.

- [ ] **Step 5: Run the copy-adjacent suites that assert on this surface**

Run: `cd <worktree> && npx vitest run apps/web/src/components/v2/board/__tests__ --reporter=json --outputFile=/tmp/t2b.json; node -e "const r=require('/tmp/t2b.json');console.log(r.numPassedTests,'/',r.numTotalTests,r.numFailedTests)"`
Expected: 0 failed. Then `grep -ra "the more specific" apps/web/e2e` → no hits.

- [ ] **Step 6: Screenshot-verify at desktop and 375px**

Playwright MCP on the AI console: the hint sits under the textarea at
`ai-console.tsx:1200`; confirm it wraps rather than overflows at 375px.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/dictionaries apps/web/content/help/scheduling/ai-scheduling.md apps/web/src/components/v2/board/__tests__/ai-instruction-privacy-copy.test.tsx
git commit -m "ai console: point the instruction field at rules, not people (#403)"
```

---

### Task 3: Retention sweep for `ai_parse_previews`

**Files:**
- Create: `apps/web/src/server/usecases/ai-preview-sweep.ts`
- Create: `apps/web/src/app/api/cron/ai-previews/route.ts`
- Create: `.github/workflows/ai-preview-sweep.yml`
- Create: `apps/web/src/server/usecases/__tests__/ai-preview-sweep.test.ts` (DB-backed)
- Modify: `apps/web/src/app/legal/privacy/page.tsx` — add one line to the retention section (now §7 after Task 1)

**Interfaces:**
- Consumes: Task 1's renumbered privacy sections.
- Produces: `sweepExpiredPreviews(): Promise<{ expired: number; spent: number }>`.

**Why:** `ai_parse_previews.instruction` stores the organiser's raw sentence, which
is exactly the free text Finding 4 says can carry personal data. The table declares a
30-minute life, ships a partial index commented "Sweep support" — and nothing sweeps.
Rows live until the org is deleted. That is a storage-limitation gap (Art. 5(1)(e)),
and it is the only item in this audit that is a defect rather than a citation.

**Policy (state it in the PR):** unconsumed rows go as soon as `expires_at` passes;
consumed rows are kept 30 days, because V345's own comment keeps `raw` beside
`resolved` so a disputed compile can be re-derived — 30 days is enough for a dispute
and short enough to be a retention period rather than "forever".

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { sweepExpiredPreviews } from "../ai-preview-sweep";
import { makeOrg } from "./helpers"; // follow the helper this suite's siblings use

describe("#403 — ai_parse_previews retention sweep", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await makeOrg();
    await sql`delete from ai_parse_previews where org_id = ${orgId}`;
  });

  const insert = (o: { expiresAt: string; consumedAt: string | null; createdAt: string }) => sql`
    insert into ai_parse_previews (org_id, scope, scope_id, instruction_hash, instruction, resolved, expires_at, consumed_at, created_at)
    values (${orgId}, 'division', gen_random_uuid(), 'h', 'keep Alice away from Bob', '{}'::jsonb,
            ${o.expiresAt}::timestamptz, ${o.consumedAt}::timestamptz, ${o.createdAt}::timestamptz)
    returning id`;

  it("deletes an unconsumed preview once it has expired", async () => {
    const [row] = await insert({ expiresAt: "now() - interval '1 minute'", consumedAt: null, createdAt: "now()" });
    const out = await sweepExpiredPreviews();
    expect(out.expired).toBeGreaterThanOrEqual(1);
    const left = await sql`select 1 from ai_parse_previews where id = ${row.id}`;
    expect(left.length).toBe(0);
  });

  it("keeps an unconsumed preview that is still live", async () => {
    const [row] = await insert({ expiresAt: "now() + interval '20 minutes'", consumedAt: null, createdAt: "now()" });
    await sweepExpiredPreviews();
    const left = await sql`select 1 from ai_parse_previews where id = ${row.id}`;
    expect(left.length).toBe(1);
  });

  it("keeps a consumed preview inside the 30-day dispute window and drops it after", async () => {
    const [fresh] = await insert({ expiresAt: "now() - interval '1 hour'", consumedAt: "now() - interval '1 hour'", createdAt: "now() - interval '1 hour'" });
    const [old] = await insert({ expiresAt: "now() - interval '40 days'", consumedAt: "now() - interval '40 days'", createdAt: "now() - interval '40 days'" });
    await sweepExpiredPreviews();
    expect((await sql`select 1 from ai_parse_previews where id = ${fresh.id}`).length).toBe(1);
    expect((await sql`select 1 from ai_parse_previews where id = ${old.id}`).length).toBe(0);
  });

  afterAll(async () => { await sql`delete from ai_parse_previews where org_id = ${orgId}`; });
});
```

Note: the sweep runs as the **service** role, not `app_user` — RLS on this table is
`force`d and tenant-scoped, so a sweep running under `app_user` with no
`current_org_id()` deletes nothing. Follow whatever the billing sweeps use
(`sweepStuckEvents` in `apps/web/src/server/usecases/billing-events.ts`) and mirror it
exactly; if that helper is org-scoped, the test above must set the org context the
same way the billing sweep test does.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run apps/web/src/server/usecases/__tests__/ai-preview-sweep.test.ts --reporter=json --outputFile=/tmp/t3.json; node -e "const r=require('/tmp/t3.json');console.log(r.numPassedTests,'/',r.numTotalTests,'pending',r.numPendingTests)"`
Expected: fails to resolve `../ai-preview-sweep`. If it reports `pending`, the
worktree has no `.env.local` and the DB suite skipped — fix the env before reading
this as a result.

- [ ] **Step 3: Write the sweep**

```ts
import { sql } from "@/lib/db";

/** #403 — storage limitation for the one table that persists an organiser's raw
 *  free-text instruction. V345 gives every preview a 30-minute life and ships a
 *  partial "sweep support" index; this is the sweep. Unconsumed rows go at
 *  expiry. Consumed rows are kept 30 days because V345 keeps `raw` beside
 *  `resolved` so a disputed compile can be re-derived — long enough for a
 *  dispute, short enough to be a retention period. */
export async function sweepExpiredPreviews(): Promise<{ expired: number; spent: number }> {
  const expired = await sql`
    delete from ai_parse_previews
    where consumed_at is null and expires_at < now()
    returning id`;
  const spent = await sql`
    delete from ai_parse_previews
    where consumed_at is not null and consumed_at < now() - interval '30 days'
    returning id`;
  return { expired: expired.length, spent: spent.length };
}
```

Route (mirrors `/api/cron/billing-events` exactly):

```ts
import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepExpiredPreviews } from "@/server/usecases/ai-preview-sweep";

/** POST /api/cron/ai-previews — daily (#403): delete compiled-instruction
 *  previews past their life. The row holds the organiser's raw sentence, which
 *  can carry personal data, so it is retained to a policy rather than forever. */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepExpiredPreviews();
  });
}
```

Workflow: copy `.github/workflows/billing-events.yml` verbatim, change the schedule to
`- cron: "41 3 * * *"` (offset from the other crons), the job name, and the POST target
to `/api/cron/ai-previews`. **Do not touch `.github/workflows/e2e.yml`.**

Privacy retention section (now §7) gains one sentence:

```
Scheduling instructions you preview but do not run are deleted within the hour; a preview you did run is kept for 30 days so a disputed plan can be re-checked.
```

- [ ] **Step 4: Run test to verify it passes**

Run: the Step 2 command. Expected: 3 / 3, `pending 0`.

- [ ] **Step 5: OpenAPI drift**

Run: `npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain`
Expected: either the generated spec now carries the new cron route (commit it) or the
tree is clean. A dirty tree left uncommitted fails CI, not local.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/ai-preview-sweep.ts apps/web/src/app/api/cron/ai-previews/route.ts .github/workflows/ai-preview-sweep.yml apps/web/src/server/usecases/__tests__/ai-preview-sweep.test.ts apps/web/src/app/legal/privacy/page.tsx
git commit -m "retention: sweep compiled-instruction previews instead of keeping them forever (#403)"
```

---

### Task 4: Smoke assertion for the new privacy copy

**Files:**
- Modify: `scripts/smoke.ts` — extend the suite that already fetches `/legal/terms` (`:849`), or add a sibling suite beside it

**Interfaces:**
- Consumes: Task 1's sentence `treated as one player while a timetable is built`.
- Produces: nothing.

- [ ] **Step 1: Add the check**

```ts
const privacy = await html(newSession(), "/legal/privacy");
check(
  "#403: privacy page discloses the scheduling-only same-name grouping",
  privacy.status === 200 &&
    privacy.body.includes("treated as one player while a timetable is built") &&
    privacy.body.includes("No records are merged"),
);
```

- [ ] **Step 2: Run the smoke suite it lives in**

Per the `seazn-local-env` skill (fresh DB needs `db:apply` **and** `sync:sports`).
Expected: the new check passes, nothing else regresses.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.ts
git commit -m "smoke: pin the privacy page's scheduling-grouping disclosure (#403)"
```

---

### Task 5: Post the findings and the #404 requirements

**Files:** none — GitHub only.

- [ ] **Step 1:** Post the audit findings as a comment on #403, one section per
  finding, every claim carrying a `file:line`. Include the two items the issue did
  not list: (a) exactly what personal data reaches the AI sub-processor
  (`PackEntrant.name`, `PackOfficial.name`, the instruction — and **not** person
  names, dob, photos or emails, because `PackPerson` is ids only); (b) the
  `ai_parse_previews` retention gap and its fix.
- [ ] **Step 2:** Post the merge-tool requirements as a comment on **#404**, so the
  next session's gate ("stop if its merge-tool requirements are not posted") resolves
  against a real artefact. Requirements must name the six composite PKs and the
  partial unique index listed in the evidence table above — the issue text mentions
  only `entrant_members`.
- [ ] **Step 3:** Tick the checkboxes on #403 that this session actually closed, and
  leave Finding 5's sign-off box **unticked** with a comment saying why (below).
- [ ] **Step 4:** Open the PR with `Closes #403` in the **body** — a bare `(#403)` in
  the subject does not close it.

---

## Out of scope / owner-only

**Finding 5 (OpenRouter / Vertex / xAI sub-processor sign-off) cannot be closed by
this session.** The disclosure side is verifiably complete (`sub-processors/page.tsx:41,47,53,59`
name all four with AI-scheduling purposes). What remains is not code:

1. A human legal approval of the sub-processor copy before the production flip.
2. Confirming whether `OPENROUTER_API_KEY` is set on the production app — until it
   is, the ladder resolves to Anthropic-direct and OpenRouter/Vertex/xAI are
   disclosed-but-unused. Owner runs `fly secrets list -a <app> | grep OPENROUTER`.
3. The outstanding key rotation (`ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, both
   OpenRouter keys) carried on the ladder work.

## Self-review

- Spec coverage: Finding 1 → evidence table (no code owed). Finding 2 boxes 1-3 →
  evidence table; box 4 → Task 1. Finding 3 → Task 5 step 2. Finding 4 → Task 2.
  Finding 5 → "Out of scope / owner-only", explicitly left open.
- Placeholders: none — every copy string, test and SQL statement is written out.
- Type consistency: `sweepExpiredPreviews` returns `{expired, spent}` in the
  implementation, the test and the route.
