# OpenRouter Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an `AiProvider` seam behind both AI runners so the schedule architect can run on any policy-compliant OpenRouter model, then bench candidates against the recorded Claude baseline.

**Architecture:** One interface, two adapters. `AiProvider.chat()` takes a provider-neutral request and returns a parsed plan plus an opaque assistant turn that is replayed verbatim on repair rounds. The Anthropic adapter wraps today's SDK call with zero behavioural change and stays the shipped default; the OpenRouter adapter speaks OpenAI Chat Completions and carries a hardcoded data policy. Call sites resolve a provider once per run and thread it through.

**Tech Stack:** TypeScript, Next.js, Vitest, Zod 4 (`z.toJSONSchema`), `@anthropic-ai/sdk` 0.110, OpenRouter `/api/v1/chat/completions`, Playwright (e2e fixture server).

Design spec: `docs/superpowers/specs/2026-07-21-openrouter-provider-design.md`. Read it before Task 1.

## Global Constraints

- **Anthropic stays the shipped default.** An unset `AI_PROVIDER` must behave exactly as today. Any task that changes default behaviour is wrong.
- **The data policy is hardcoded, never env-configurable.** Every OpenRouter request carries `provider: {data_collection: "deny", only: ALLOWED_PROVIDERS, allow_fallbacks: false}` and `zdr: true`.
- **No OpenRouter presets.** Model always travels in the request `model` field so the ledger and bench keep per-model attribution.
- **No new npm dependencies.** `zod@^4.4.3` is already present; use native `z.toJSONSchema()`.
- **Provider is fixed for the lifetime of a run.** A repair round must use the provider that produced the earlier turns.
- **`AiTurn.content` is opaque.** Only the adapter that produced it may inspect it.
- **The system prompt is a constant across all bench arms.** Task 1 lands before any bench arm runs; no other task edits the prompt.
- **Cost is read, never guessed.** Response `cost` wins; then `aiRunCostUsd`; then `null`.
- **This worktree owns its own database schema** (`DB_SCHEMA=seazn_openrouter`), set in Task 0. Never run `db:apply` against the main checkout's schema or a remote database.
- Run commands from `apps/web/` unless stated. Full gate before push: `npm run typecheck && npm run test` in `apps/web`, plus `npm run test --workspace packages/engine` from the repo root.
- **Never print `.env.local` contents.** Use `grep -c '^KEY='` to assert a variable exists. Secrets echoed into a terminal end up in transcripts and logs.

---

### Task 0: Bring the worktree up

A fresh worktree carries source only. It has **no `node_modules`**, **no `.env.local` at either level**, and its database schema does not exist yet. Tasks 4, 5, 9, 11 and 12 run DB-backed suites, smoke, and live benches — without this task they fail for reasons that have nothing to do with the change.

Isolating the schema matters specifically: `scripts/flyway.sh:55,67,75-76` reads `DB_SCHEMA` (default `seazn_club`) and pins `search_path` to that schema alone, excluding `public`. Two worktrees sharing one schema will fight over migrations, and a half-migrated schema produces false failures across unrelated suites.

**Files:**
- Create (untracked, never committed): `.env.local`, `apps/web/.env.local` in the worktree
- Read: `scripts/flyway.sh`, `apps/web/.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: a worktree where `npm run test`, `npm run test:smoke` and the e2e suites run clean.

- [ ] **Step 1: Install dependencies**

Run from the worktree root: `npm install`
Expected: completes without peer-dependency errors. The worktree needs its own `node_modules`; it does not share the main checkout's.

- [ ] **Step 2: Copy both env files**

There are two, and both are required — the root one and the app one:

```bash
cp ~/github/seazn.club/.env.local .env.local
cp ~/github/seazn.club/apps/web/.env.local apps/web/.env.local
```

Verify both landed without printing their contents: `wc -l .env.local apps/web/.env.local`

- [ ] **Step 3: Give this worktree its own schema**

Append to the worktree's root `.env.local` (do not edit the main checkout's):

```
DB_SCHEMA=seazn_openrouter
```

Set the same value in `apps/web/.env.local`. Nothing else changes — `DATABASE_URL` still points at the local `seazn` database on :5432; only the schema differs, which is what keeps this worktree's migrations off the main checkout's.

- [ ] **Step 4: Confirm no remote database is reachable by accident**

Run: `grep -c '^REMOTE_DATABASE_URL' .env.local || true`
Expected: `0`, or the line is commented out. `REMOTE_DATABASE_URL` must stay explicit-only — a worktree must never migrate a remote database.

- [ ] **Step 5: Migrate the new schema**

`scripts/flyway.sh` reads `DATABASE_URL` and `DB_SCHEMA` from the **environment** — it does not load `.env.local` itself (`scripts/flyway.sh:16`). Export them for the command:

```bash
set -a; . ./.env.local; set +a; npm run db:apply
```

Expected: Flyway creates `seazn_openrouter` and applies every migration in order. Confirm the log names `seazn_openrouter`, not `seazn_club` — if it names the latter, the export did not take and you are about to migrate the main checkout's schema.

If it reports a baseline error, the schema already exists at a version below the migration floor — drop it and re-run rather than baselining, since this schema is disposable.

- [ ] **Step 6: Verify the migration state**

Run: `npm run db:info`
Expected: every migration `Success`, no `Pending`, no `Ignored` below the current version.

- [ ] **Step 7: Sync the sports catalogue**

Run: `npm run sync:sports`
Expected: completes. This is a CI step; without it, sport-dependent suites fail on missing catalogue rows.

- [ ] **Step 8: Seed demo data (optional — not required by the gate)**

```bash
npm run seed:demo:setup
npm run seed:demo
```

These read `apps/web/.env.local` via `--env-file`, so Step 2 must have run first.

**Known failure on a fresh v305 schema, unrelated to this branch:** `seed:demo` aborts with `402 PAYMENT_REQUIRED — divisions.per_competition.max` when adding a third division to a competition, even though `seed:demo:setup` reports the org as `pro/active`. The demo dataset wants more divisions per competition than the pro entitlement allows.

This does **not** block anything here: `scripts/smoke.ts` provisions its own orgs, competitions and divisions (and lifts the divisions quota itself — see its free-org path), so the smoke gate is independent of the demo seed. Proceed without it. Do not "fix" the seed by raising the org's plan — that would mask whatever entitlement expectation actually drifted, which belongs in its own change.

- [ ] **Step 9: Confirm Stripe test-mode wiring**

The payments suites need a non-empty `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Check they are present without printing them:

```bash
grep -c '^STRIPE_SECRET_KEY=' .env.local
grep -c '^STRIPE_WEBHOOK_SECRET=' .env.local
```
Expected: `1` each.

For **e2e payments specs specifically**, the server must boot with `STRIPE_WEBHOOK_SECRET=whsec_e2e_payments`. Set it in the e2e server environment only — not in `.env.local` — or the payments specs fail as a group for no real reason.

- [ ] **Step 10: Confirm the AI key**

Run: `grep -c '^ANTHROPIC_API_KEY=' .env.local`
Expected: `1`. Required by the Task 3 adapter's live path and by every bench arm; unit suites use a dummy key and do not need it.

Task 11 additionally needs `OPENROUTER_API_KEY`, and Task 2 needs it before that. Add it to the worktree's `.env.local` when you reach Task 2.

- [ ] **Step 11: Establish the green baseline**

```bash
cd apps/web && npm run typecheck && npm run test
cd ../.. && npm run test --workspace packages/engine
npm run test:smoke
```
Expected: all PASS **before any code change**. This is the point of the task — a failure here is environmental, and diagnosing it now is far cheaper than mistaking it later for a regression from Task 4.

- [ ] **Step 12: Nothing to commit**

`.env.local` files are untracked and must stay that way. Confirm: `git status --short` shows no env files. If it does, they are not gitignored in this worktree — stop and fix that before continuing.

---

### Task 1: Prompt cherry-pick — rule IDs, rule-citing reasons, assumptions

Lands first and merges before any bench arm runs, so the prompt is constant across the shootout. The golden snapshot test fails by design on any prompt edit; updating it is part of this task.

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai-prompt.ts:13-94`
- Modify: `apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts:14-23`
- Modify: `apps/web/src/server/usecases/__tests__/__snapshots__/schedule-ai-prompt.test.ts.snap`

**Interfaces:**
- Consumes: nothing.
- Produces: `AiSchedulePlan` gains an optional `assumptions: string[]` field. `SYSTEM_PROMPT` hard rules are labelled `H1`–`H7`, soft goals `S1`–`S5`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts`, inside the existing `describe`:

```typescript
  it("labels hard rules H1-H7 and soft goals S1-S5", () => {
    for (const id of ["H1.", "H2.", "H3.", "H4.", "H5.", "H6.", "H7."]) {
      expect(SYSTEM_PROMPT).toContain(id);
    }
    for (const id of ["S1.", "S2.", "S3.", "S4.", "S5."]) {
      expect(SYSTEM_PROMPT).toContain(id);
    }
    // The old bare numbering and lettering must be gone.
    expect(SYSTEM_PROMPT).not.toContain("\n1. court_label must be");
    expect(SYSTEM_PROMPT).not.toContain("\na. The organiser's instruction.");
  });

  it("requires unschedulable reasons to cite the blocking rule id", () => {
    expect(SYSTEM_PROMPT).toContain("citing the hard rule id");
  });

  it("plan schema accepts an assumptions array and rejects a non-string entry", () => {
    const base = {
      assignments: [],
      unschedulable: [],
      explanations: [],
      summary: "x",
    };
    expect(
      AiSchedulePlan.safeParse({ ...base, assumptions: ["read 'evenings' as after 18:00"] })
        .success,
    ).toBe(true);
    // Omitted is still valid — the field is optional.
    expect(AiSchedulePlan.safeParse(base).success).toBe(true);
    expect(AiSchedulePlan.safeParse({ ...base, assumptions: [42] }).success).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-prompt.test.ts -t "labels hard rules"`
Expected: FAIL — `SYSTEM_PROMPT` does not contain `"H1."`.

- [ ] **Step 3: Relabel the hard rules**

In `apps/web/src/server/usecases/schedule-ai-prompt.ts`, replace the numbers `1.` through `7.` in the HARD RULES block with `H1.` through `H7.`, changing nothing else about the wording. The block runs from line 24 (`1. court_label must be exactly one of…`) to line 41 (`…Treat obstacles as immovable occupied court time.`). Preserve the two-space hanging indent on continuation lines — widen it to three spaces so the text still aligns under the new two-character labels.

For example, the first rule becomes:

```
H1. court_label must be exactly one of settings.courts. scheduled_at must be ISO-8601 with
    a UTC offset, expressed in the division timezone. Never invent courts or fixtures; use
    only the fixture ids given as movable.
```

- [ ] **Step 4: Relabel the soft goals**

Replace `a.` through `e.` in the SOFT GOALS block (lines 44-54) with `S1.` through `S5.`, again changing only the labels and the continuation indent.

- [ ] **Step 5: Require rule-citing reasons and describe assumptions**

Replace the OUTPUT paragraph's first two sentences:

```
OUTPUT: Only the structured object. Every movable fixture appears exactly once — in
assignments or in unschedulable with a short honest reason.
```

with:

```
OUTPUT: Only the structured object. Every movable fixture appears exactly once — in
assignments or in unschedulable with a short honest reason citing the hard rule id
(H1-H7) that blocked it.
```

Then, in the same OUTPUT paragraph, immediately before the sentence beginning `summary:`, insert:

```
assumptions: when the instruction was ambiguous in a way that changed the schedule, record
the reading you chose, one entry each; omit the field when the instruction was unambiguous.
```

- [ ] **Step 6: Add the schema field**

In the `AiSchedulePlan` object (line 83), add after `explanations`:

```typescript
  assumptions: z.array(z.string().max(200)).max(10).optional(),
```

- [ ] **Step 7: Update the lettering assertions**

The existing test at lines 14-23 asserts the old `d.`/`e.` lettering and will now fail. Replace that whole `it` block with:

```typescript
  it("carries the amended Coverage (S4) + Stability (S5) soft goals", () => {
    expect(SYSTEM_PROMPT).toContain(
      "S4. Coverage: prefer slots where each required officiating role has an eligible, free",
    );
    expect(SYSTEM_PROMPT).toContain(
      "S5. Stability: in refine and repair modes move as few fixtures as possible",
    );
    // The pre-relabel lettering must be gone.
    expect(SYSTEM_PROMPT).not.toContain("d. Stability:");
    expect(SYSTEM_PROMPT).not.toContain("d. Coverage:");
  });
```

- [ ] **Step 8: Update the golden snapshot deliberately**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-prompt.test.ts -u`
Then read the snapshot diff with `git diff` and confirm every change is a label change, the OUTPUT sentence, or the assumptions sentence. **If any other wording moved, revert it** — the module header at line 3 states the prompt is verbatim from `design/v4/01-llm-contract.md` §4 and drift must be deliberate.

- [ ] **Step 9: Run the full prompt suite**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-prompt.test.ts`
Expected: PASS, all tests.

- [ ] **Step 10: Run the AI suites that consume the schema**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-run.test.ts src/server/usecases/__tests__/schedule-ai-route.test.ts src/server/usecases/__tests__/schedule-ai-pack.test.ts`
Expected: PASS. `assumptions` is optional, so no existing fixture should break. If one does, the fixture asserted an exact object shape — relax that assertion rather than dropping the field.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/server/usecases/schedule-ai-prompt.ts \
        apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts \
        apps/web/src/server/usecases/__tests__/__snapshots__/schedule-ai-prompt.test.ts.snap
git commit -m "feat(ai): label the schedule rules, and make stranded fixtures cite one

Unschedulable reasons were free text, so a stranded fixture told you it
had no slot without saying which rule closed the door. Label the hard
rules H1-H7 and the soft goals S1-S5, require reasons to cite the rule
that blocked the fixture, and add an assumptions array so an ambiguous
instruction records the reading the model chose.

The labels also let the upcoming model shootout classify failures by
rule instead of counting them.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Candidate filter and live pre-flight probe

Answers the open risk — whether Grok, GLM and Kimi survive `data_collection:"deny"` + `zdr:true` — before any adapter code exists. The filter is pure and unit-tested; the probe is a live script run by hand.

**Files:**
- Create: `apps/web/src/server/ai/candidate-filter.ts`
- Create: `apps/web/src/server/ai/__tests__/candidate-filter.test.ts`
- Create: `scripts/openrouter-preflight.ts`
- Create: `design/v4/05-openrouter-candidates.md` (generated output, committed)

**Interfaces:**
- Consumes: nothing.
- Produces: `type OpenRouterModel`, `type Candidate`, `eligibleCandidates(models: OpenRouterModel[]): Candidate[]`, and `MIN_CONTEXT_TOKENS`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/ai/__tests__/candidate-filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { eligibleCandidates, MIN_CONTEXT_TOKENS } from "../candidate-filter";

const model = (over: Partial<Parameters<typeof eligibleCandidates>[0][number]> = {}) => ({
  id: "vendor/model",
  context_length: 200_000,
  supported_parameters: ["reasoning", "response_format", "structured_outputs"],
  ...over,
});

describe("candidate filter", () => {
  it("keeps a model supporting reasoning + structured outputs with enough context", () => {
    expect(eligibleCandidates([model()]).map((c) => c.id)).toEqual(["vendor/model"]);
  });

  it("drops a model that cannot reason — no-thinking left blocking conflicts in the v4 bench", () => {
    const out = eligibleCandidates([
      model({ id: "vendor/no-reason", supported_parameters: ["structured_outputs"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a model without structured outputs — the runners read a parsed plan", () => {
    const out = eligibleCandidates([
      model({ id: "vendor/no-schema", supported_parameters: ["reasoning"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a model whose context is below the floor", () => {
    const out = eligibleCandidates([
      model({ id: "vendor/small", context_length: MIN_CONTEXT_TOKENS - 1 }),
    ]);
    expect(out).toEqual([]);
  });

  it("is stable and de-duplicated regardless of input order", () => {
    const a = model({ id: "a/one" });
    const b = model({ id: "b/two" });
    expect(eligibleCandidates([b, a, b]).map((c) => c.id)).toEqual(["a/one", "b/two"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/ai/__tests__/candidate-filter.test.ts`
Expected: FAIL — cannot resolve `../candidate-filter`.

- [ ] **Step 3: Write the filter**

Create `apps/web/src/server/ai/candidate-filter.ts`:

```typescript
// Pure eligibility filter for the OpenRouter model shootout. No network: the
// caller fetches /api/v1/models and passes the array in, so the rules stay
// unit-testable and the generated candidate list is reproducible.
//
// The three capability rules come from the 2026-07-20 v4 benchmark
// (design/v4/04-architect-benchmarks.md), not from taste:
//   - reasoning is load-bearing — the no-thinking arm left blocking conflicts
//     on 2/3 dense runs AND cost more, because repairs resend prior output;
//   - structured outputs are required — both runners read a parsed plan;
//   - context must clear the observed output (29,858 tokens mean on the dense
//     pack) plus the context pack and repair-round resends.
//
// Data-policy survival is NOT decided here. It is a live property of the
// endpoints, probed by scripts/openrouter-preflight.ts.

export const MIN_CONTEXT_TOKENS = 128_000;

export type OpenRouterModel = {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
};

export type Candidate = {
  id: string;
  contextLength: number;
};

export function eligibleCandidates(models: OpenRouterModel[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];

  for (const m of models) {
    if (seen.has(m.id)) continue;
    const params = m.supported_parameters ?? [];
    const contextLength = m.context_length ?? 0;

    if (!params.includes("reasoning")) continue;
    if (!params.includes("structured_outputs")) continue;
    if (contextLength < MIN_CONTEXT_TOKENS) continue;

    seen.add(m.id);
    out.push({ id: m.id, contextLength });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/ai/__tests__/candidate-filter.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the live probe script**

Create `scripts/openrouter-preflight.ts`:

```typescript
// Live pre-flight for the OpenRouter shootout. Run by hand, never in CI.
//
//   OPENROUTER_API_KEY=... node --experimental-strip-types scripts/openrouter-preflight.ts
//
// Does two things:
//   1. fetches /api/v1/models and applies the pure capability filter;
//   2. sends one tiny request per named candidate carrying the real data
//      policy, to find out whether it has any route at all under
//      data_collection:"deny" + zdr:true.
//
// Writes design/v4/05-openrouter-candidates.md. A candidate that cannot route
// under the policy is recorded as such — that is a result, not a blocker.
import fs from "node:fs";
import {
  eligibleCandidates,
  MIN_CONTEXT_TOKENS,
  type OpenRouterModel,
} from "../apps/web/src/server/ai/candidate-filter.ts";

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error("OPENROUTER_API_KEY is required");

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

// Named entrants from the design spec §8. They pass through the same filter
// and the same policy probe as everything the models endpoint returns.
const NAMED = ["x-ai/grok-4.5", "z-ai/glm-5.2", "moonshotai/kimi-k2.6"];

async function probePolicy(model: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      provider: { data_collection: "deny", allow_fallbacks: false },
      zdr: true,
    }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 300)}` };
  return { ok: true, detail: "routed under data_collection=deny + zdr" };
}

const listRes = await fetch(`${BASE}/models`, {
  headers: { authorization: `Bearer ${KEY}` },
});
if (!listRes.ok) throw new Error(`models list failed: HTTP ${listRes.status}`);
const models: OpenRouterModel[] = (await listRes.json()).data;

const derived = eligibleCandidates(models);
const derivedIds = new Set(derived.map((c) => c.id));

const rows: string[] = [];
for (const id of [...NAMED, ...derived.map((c) => c.id)].filter(
  (id, i, all) => all.indexOf(id) === i,
)) {
  const capable = derivedIds.has(id);
  const policy = capable
    ? await probePolicy(id)
    : { ok: false, detail: "failed the capability filter; not probed" };
  rows.push(
    `| \`${id}\` | ${NAMED.includes(id) ? "named" : "derived"} | ${capable ? "yes" : "no"} | ${
      policy.ok ? "yes" : "no"
    } | ${policy.detail.replace(/\|/g, "\\|")} |`,
  );
}

const doc = `# OpenRouter shootout candidates

Generated by \`scripts/openrouter-preflight.ts\` on ${new Date().toISOString().slice(0, 10)}.
Do not hand-edit — re-run the script.

Capability filter: \`reasoning\` + \`structured_outputs\` + context >= ${MIN_CONTEXT_TOKENS.toLocaleString()} tokens.
Policy probe: one live request carrying \`data_collection: "deny"\` and \`zdr: true\`.

| model | source | capable | policy-routable | detail |
|---|---|---|---|---|
${rows.join("\n")}

Stage-1 entrants are the rows where both **capable** and **policy-routable** are yes.
`;

fs.writeFileSync("design/v4/05-openrouter-candidates.md", doc);
console.log(doc);
```

- [ ] **Step 6: Run the probe live**

Run from the repo root: `OPENROUTER_API_KEY=<key> node --experimental-strip-types scripts/openrouter-preflight.ts`
Expected: a markdown table printed and written to `design/v4/05-openrouter-candidates.md`.

**Report the Grok / GLM / Kimi rows to the user before continuing.** If all three are policy-unroutable, stop and raise it — the shootout still runs on the derived set, but the named entrants that motivated this work are out, and the user should decide whether to proceed.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/ai/candidate-filter.ts \
        apps/web/src/server/ai/__tests__/candidate-filter.test.ts \
        scripts/openrouter-preflight.ts \
        design/v4/05-openrouter-candidates.md
git commit -m "feat(ai): work out which models could even be candidates

Picking shootout entrants by hand would smuggle in taste and hide the
question that actually matters: whether a model has any route at all
once we demand data_collection=deny and zero retention.

Filter the model list on the capabilities the v4 bench proved
load-bearing, then probe each named entrant with a live request carrying
the real policy. The generated table is committed so the shortlist is
reproducible rather than remembered.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Provider interface and the Anthropic adapter

Introduces the seam and the adapter that must behave identically to today's inline call.

**Files:**
- Create: `apps/web/src/server/ai/provider.ts`
- Create: `apps/web/src/server/ai/anthropic-provider.ts`
- Create: `apps/web/src/server/ai/__tests__/anthropic-provider.test.ts`
- Read first: `apps/web/src/server/usecases/schedule-ai.ts:700-760` (`aiReasoningParams`, client factory) and `:925-973` (`assistantTurn`, `callModel`)

**Interfaces:**
- Consumes: `Candidate` types from Task 2 (unused here).
- Produces:
  - `class AiProviderError extends Error { constructor(message: string, readonly cause?: unknown) }`
  - `type AiEffort` (re-exported from the existing usecase module)
  - `type AiReasoning = {kind:"effort"; effort: AiEffort} | {kind:"budget"; tokens: number} | {kind:"none"}`
  - `type AiTurn = { role: "user" | "assistant"; content: unknown }`
  - `type AiChatRequest<T>`, `type AiChatResponse<T>`, `interface AiProvider`
  - `function anthropicProvider(): AiProvider`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/ai/__tests__/anthropic-provider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const parse = vi.fn();
const ctorOpts: Record<string, unknown>[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { parse };
    constructor(opts: Record<string, unknown>) {
      ctorOpts.push(opts);
    }
    static APIError = class extends Error {};
  }
  return { default: FakeAnthropic };
});

const Plan = z.object({ ok: z.boolean() });

beforeEach(() => {
  parse.mockReset();
  ctorOpts.length = 0;
  process.env.ANTHROPIC_API_KEY = "test-key";
});

async function callOnce(over: Record<string, unknown> = {}) {
  const { anthropicProvider } = await import("../anthropic-provider");
  return anthropicProvider().chat({
    model: "claude-sonnet-5",
    system: "SYS",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 32_000,
    reasoning: { kind: "effort", effort: "high" },
    schema: { name: "plan", zod: Plan },
    signal: new AbortController().signal,
    timeoutMs: 600_000,
    ...over,
  });
}

describe("anthropic provider", () => {
  it("sends adaptive thinking + effort, and caches the system block", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 10, output_tokens: 20 },
      model: "claude-sonnet-5",
    });

    await callOnce();

    const [body] = parse.mock.calls[0];
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config.effort).toBe("high");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.max_tokens).toBe(32_000);
  });

  it("sends a legacy token budget instead of effort when the model demands it", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-haiku-4-5",
    });

    await callOnce({ reasoning: { kind: "budget", tokens: 8_000 } });

    const [body] = parse.mock.calls[0];
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8_000 });
    expect(body.output_config.effort).toBeUndefined();
  });

  it("carries a client-constructor timeout — a per-request timeout cannot bypass the SDK's non-streaming guard", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet-5",
    });

    await callOnce();

    expect(ctorOpts[0].timeout).toBeGreaterThan(0);
  });

  it("returns the assistant turn verbatim for repair replay", async () => {
    const content = [{ type: "thinking", thinking: "…" }, { type: "text", text: "x" }];
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet-5",
    });

    const res = await callOnce();
    expect(res!.assistantTurn).toEqual({ role: "assistant", content });
  });

  it("maps usage and prices the run from the pricing table", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      model: "claude-sonnet-5",
    });

    const res = await callOnce();
    expect(res!.usage.inputTokens).toBe(1_000_000);
    expect(res!.usage.costUsd).toBe(3); // $3 per 1M input, list
  });

  it("returns parsed:null when the payload does not match the schema", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: "not-a-boolean" },
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet-5",
    });

    const res = await callOnce();
    expect(res!.parsed).toBeNull();
  });

  it("reports whether it is configured, so the runner can refuse before calling", async () => {
    const { anthropicProvider } = await import("../anthropic-provider");
    expect(anthropicProvider().isConfigured()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(anthropicProvider().isConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/ai/__tests__/anthropic-provider.test.ts`
Expected: FAIL — cannot resolve `../anthropic-provider`.

- [ ] **Step 3: Write the interface module**

Create `apps/web/src/server/ai/provider.ts`:

```typescript
// The seam between the AI runners and whichever service actually answers.
//
// Phase A (schedule-ai.ts) and Phase B (officials-ai.ts) both want the same
// thing: send a system prompt plus a conversation, get a schema-valid plan
// back, and be able to replay the model's own turn on a repair round. Only the
// wire format differs, so that is all an adapter owns.
import type { ZodType } from "zod";

/** Effort positions shared with the usecase layer. */
export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** How much the model should think, expressed provider-neutrally.
 *
 *  `thinking` and `effort` are ORTHOGONAL on the code this replaces:
 *  schedule-ai.ts:731-734 sends `effort` unconditionally while flipping
 *  `thinking` between adaptive and disabled off SCHEDULING_AI_THINKING. A
 *  variant that collapsed "disabled" to "no reasoning at all" would silently
 *  drop the effort setting on that path, so the effort variant carries the
 *  thinking mode with it.
 *
 *  `budget` exists for models that predate effort (claude-haiku-4-5 400s on
 *  adaptive thinking and on output_config.effort alike). */
export type AiReasoning =
  | { kind: "effort"; effort: AiEffort; thinking: "adaptive" | "disabled" }
  | { kind: "budget"; tokens: number }
  | { kind: "none" };

/** A conversation turn. `content` is OPAQUE and owned by the adapter that
 *  produced it — Anthropic stores content blocks including thinking, OpenRouter
 *  stores an assistant message including reasoning_details, and both providers
 *  require their own shape back unmodified on a repair round. Callers pass it
 *  around; they never read it. A conversation therefore cannot change provider
 *  mid-flight: resolve one provider per run and thread it through. */
export type AiTurn = { role: "user" | "assistant"; content: unknown };

export type AiChatRequest<T> = {
  model: string;
  system: string;
  messages: AiTurn[];
  maxTokens: number;
  reasoning: AiReasoning;
  schema: { name: string; zod: ZodType<T> };
  signal: AbortSignal;
  timeoutMs: number;
};

export type AiChatResponse<T> = {
  /** null when the model answered but the payload is not schema-valid — the
   *  caller runs its corrective retry rather than surfacing a 500. */
  parsed: T | null;
  /** The model declined outright. MUST stay distinct from `parsed: null`:
   *  schedule-ai.ts:1028 fails a refusal fast with 422 and does NOT spend a
   *  corrective retry on it. Because assistantTurn.content is opaque, the
   *  runner cannot recover this from the payload — the adapter has to say so. */
  refused: boolean;
  assistantTurn: AiTurn;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Billed cost when the provider reports it, else derived, else null.
     *  Never a guess. */
    costUsd: number | null;
    cachedTokens?: number;
    cacheWriteTokens?: number;
  };
  /** The model that actually served the request, which can differ from the one
   *  asked for. Stamped onto the ledger in place of the requested constant. */
  servedModel: string;
};

export interface AiProvider {
  readonly id: "anthropic" | "openrouter";
  /** Whether this provider has the credentials it needs. Separate from chat()
   *  so the runners can refuse with 503 BEFORE any call, which is the contract
   *  schedule-ai-run.test.ts asserts ("503 before any call"). A missing key
   *  discovered inside chat() would surface as a 500 instead. */
  isConfigured(): boolean;
  chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null>;
}

/** A genuine transport or API failure. Adapters throw this; the runners let it
 *  propagate to a 5xx rather than folding it into the corrective path. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}
```

- [ ] **Step 4: Write the Anthropic adapter**

Create `apps/web/src/server/ai/anthropic-provider.ts`:

```typescript
// Anthropic adapter — the shipped default. Behaviour must match the inline call
// this replaced (schedule-ai.ts:929 before the seam landed); the parity tests
// exist to keep it that way.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import {
  AiProviderError,
  type AiChatRequest,
  type AiChatResponse,
  type AiProvider,
} from "./provider";

/** One hour. Load-bearing on the CLIENT CONSTRUCTOR, not per-request: the SDK
 *  computes a non-streaming timeout from max_tokens and throws synchronously
 *  ("Streaming is required…") when it exceeds ten minutes. A per-request
 *  timeout cannot bypass that check. */
const CLIENT_TIMEOUT_MS = 60 * 60 * 1000;

export function anthropicProvider(): AiProvider {
  return {
    id: "anthropic",
    isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
    async chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new AiProviderError("ANTHROPIC_API_KEY is not configured");
      const baseURL = process.env.SCHEDULING_AI_BASE_URL;

      const client = new Anthropic({
        apiKey,
        timeout: CLIENT_TIMEOUT_MS,
        ...(baseURL ? { baseURL } : {}),
      });

      const thinking =
        req.reasoning.kind === "effort"
          ? { type: req.reasoning.thinking } // "adaptive" | "disabled"
          : req.reasoning.kind === "budget"
            ? { type: "enabled" as const, budget_tokens: req.reasoning.tokens }
            : undefined;

      let response;
      try {
        response = await client.messages.parse(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            ...(thinking ? { thinking } : {}),
            output_config: {
              ...(req.reasoning.kind === "effort" ? { effort: req.reasoning.effort } : {}),
              format: zodOutputFormat(req.schema.zod),
            },
            system: [
              { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
            ],
            messages: req.messages as Anthropic.MessageParam[],
          },
          { signal: req.signal, timeout: req.timeoutMs },
        );
      } catch (err) {
        if (Anthropic.APIError && err instanceof Anthropic.APIError) {
          throw new AiProviderError("Anthropic API call failed", err);
        }
        // The SDK throws on schema-invalid structured output rather than
        // returning a null parse; fold that into the corrective path.
        return null;
      }

      const raw = (response as { parsed_output?: unknown }).parsed_output ?? null;
      const check = raw === null ? null : req.schema.zod.safeParse(raw);

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const servedModel = response.model ?? req.model;

      return {
        parsed: check && check.success ? check.data : null,
        refused: response.stop_reason === "refusal",
        assistantTurn: { role: "assistant", content: response.content ?? [] },
        usage: {
          inputTokens,
          outputTokens,
          costUsd: aiRunCostUsd(servedModel, inputTokens, outputTokens),
        },
        servedModel,
      };
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/server/ai/__tests__/anthropic-provider.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/ai/provider.ts \
        apps/web/src/server/ai/anthropic-provider.ts \
        apps/web/src/server/ai/__tests__/anthropic-provider.test.ts
git commit -m "feat(ai): give the runners a provider to talk to instead of an SDK

Both AI runners construct an Anthropic client inline, so the model we can
reach is decided by an import. Add the seam they should have had: a
request shape describing what the caller wants rather than how Anthropic
spells it, and an adapter that keeps today's behaviour exactly, including
the constructor timeout that stops the SDK refusing long non-streaming
requests.

The assistant turn stays opaque on purpose. Each provider requires its
own reasoning blocks back unmodified, so callers carry it without reading
it, and a conversation stays with the provider that started it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Migrate Phase A to the provider

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts:700-760` (reasoning params, client factory), `:925-973` (`assistantTurn`, `callModel`), and every `callModel` call site
- Create: `apps/web/src/server/usecases/__tests__/schedule-ai-provider.test.ts`
- Must keep passing unchanged: `apps/web/src/server/usecases/__tests__/schedule-ai-run.test.ts` (it mocks the SDK, so it now exercises the real adapter through the seam)

**Interfaces:**
- Consumes: `anthropicProvider()`, `AiProvider`, `AiReasoning`, `AiProviderError` from Task 3.
- Produces: `callModel` takes a provider as its first argument and returns `AiChatResponse<AiSchedulePlan> | null`.

- [ ] **Step 1: Read the current call graph**

Run: `grep -n "callModel\|aiReasoningParams\|assistantTurn\|anthropicClient" apps/web/src/server/usecases/schedule-ai.ts`
Note every call site. `callModel` is invoked on the first round and again on each repair round; all of them must receive the same provider instance.

- [ ] **Step 2: Write the failing test**

Create a **new** file `apps/web/src/server/usecases/__tests__/schedule-ai-provider.test.ts`. It must be separate from `schedule-ai-run.test.ts`: that suite mocks `@anthropic-ai/sdk` and so exercises the real adapter end to end, which is coverage worth keeping. This file mocks one level higher, at the provider.

Copy the pack and plan fixtures from `schedule-ai-run.test.ts:25-126` (`F1`–`F4`, `makePack`, `assign`, `plan`, `clashingPlan`, `fixedPlan`) — they are module-level consts in that file, so import them if they are exported, and otherwise duplicate the four lines of `clashingPlan`/`fixedPlan` construction verbatim.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicProvider = vi.fn();
vi.mock("@/server/ai/anthropic-provider", () => ({ anthropicProvider }));

// …pack + movableIds + clashingPlan + fixedPlan fixtures, as above…

const round = (parsed: unknown) => ({
  parsed,
  assistantTurn: { role: "assistant" as const, content: [] },
  usage: { inputTokens: 1000, outputTokens: 500, costUsd: null },
  servedModel: "claude-sonnet-5",
});

beforeEach(() => {
  anthropicProvider.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("schedule runner ↔ provider seam", () => {
  it("resolves the provider once per run and reuses it across repair rounds", async () => {
    // Reasoning blocks are provider-specific and replayed verbatim on repair.
    // A run that resolved a provider per round could send one service's
    // reasoning to another, so the factory must run once and chat twice.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(round(clashingPlan))
      .mockResolvedValueOnce(round(fixedPlan));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runAiPlan } = await import("../schedule-ai");
    const out = await runAiPlan(pack, movableIds);

    expect(anthropicProvider).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.usage.repair_rounds).toBe(1);
    expect(out.blocking).toHaveLength(0);
  });

  it("asks for effort reasoning and the 32k output budget", async () => {
    const chat = vi.fn().mockResolvedValue(round(fixedPlan));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runAiPlan } = await import("../schedule-ai");
    await runAiPlan(pack, movableIds);

    const req = chat.mock.calls[0]![0];
    expect(req.reasoning).toEqual({ kind: "effort", effort: "high" });
    expect(req.maxTokens).toBe(32_000);
    expect(req.schema.name).toBe("schedule_plan");
  });

  it("refuses with 503 before calling when the provider is unconfigured", async () => {
    const chat = vi.fn();
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => false, chat });

    const { runAiPlan } = await import("../schedule-ai");
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 503 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("accumulates usage across rounds and prefers the cost the provider reports", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ ...round(clashingPlan), usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.2 } })
      .mockResolvedValueOnce({ ...round(fixedPlan), usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.3 } });
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runAiPlan } = await import("../schedule-ai");
    const out = await runAiPlan(pack, movableIds);

    expect(out.usage.input_tokens).toBe(2000);
    expect(out.usage.output_tokens).toBe(1000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-provider.test.ts`
Expected: FAIL — `schedule-ai.ts` does not import `anthropicProvider`, so the mock is never used and `chat` is never called.

- [ ] **Step 4: Change the signature**

Replace `callModel` (`:929-973`) with a thin call through the provider:

```typescript
async function callModel(
  provider: AiProvider,
  model: string,
  messages: AiTurn[],
): Promise<AiChatResponse<AiSchedulePlan> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
  try {
    return await provider.chat({
      model,
      system: SYSTEM_PROMPT,
      messages,
      maxTokens: 32_000,
      reasoning: aiReasoning(model),
      schema: { name: "schedule_plan", zod: AiSchedulePlan },
      signal: controller.signal,
      timeoutMs: 600_000,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpError(422, "AI scheduling timed out; please retry", "AI_PLAN_TIMEOUT");
    }
    if (err instanceof HttpError || err instanceof AiProviderError) throw err;
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Convert `aiReasoningParams` to `aiReasoning`**

Replace the Anthropic-shaped helper (`:722-734`) with one returning `AiReasoning`, preserving the legacy-model list and budget exactly:

```typescript
/** Models predating adaptive thinking and the effort parameter. Verified live:
 *  thinking:{type:"adaptive"} → 400, output_config.effort → 400. They do accept
 *  a legacy token budget. */
function aiReasoning(model: string): AiReasoning {
  if (LEGACY_REASONING_MODELS.has(model)) {
    const budget = schedulingAiThinkingBudget();
    return budget > 0 ? { kind: "budget", tokens: budget } : { kind: "none" };
  }
  // `effort` rides along even when thinking is disabled — the code this
  // replaces (:731-734) sends it unconditionally. Mapping "disabled" to
  // `kind: "none"` would silently drop SCHEDULING_AI_EFFORT on that path.
  return {
    kind: "effort",
    effort: schedulingAiEffort(),
    thinking: schedulingAiThinking() === "disabled" ? "disabled" : "adaptive",
  };
}
```

Read `:722-734` for the exact helper names before writing this — use whatever the file actually calls the budget and thinking getters, not the names above.

- [ ] **Step 6: Thread one provider through the run**

In the run entry point (`runScheduleAi`, around `:977-1000`), resolve the provider once and keep the 503-before-any-call contract that `schedule-ai.ts:738` provides today:

```typescript
  const provider = anthropicProvider();
  if (!provider.isConfigured()) {
    throw new HttpError(503, "AI scheduling is not configured", "AI_NOT_CONFIGURED");
  }
```

Use the exact status, message and code the current guard at `:738` throws — read it and copy them; `schedule-ai-run.test.ts:371` asserts the 503 and that no call was made. Pass `provider` to every `callModel` call. Delete the old inline client factory (`:738-750`) and `assistantTurn` (`:925-927`) — the adapter now owns both. Replace `assistantTurn(response)` uses with `response.assistantTurn`.

- [ ] **Step 7a: Preserve the refusal fast-path**

`schedule-ai.ts:1028` currently branches on `response?.stop_reason === "refusal"` and fails immediately with 422 `AI_PLAN_FAILED`, deliberately NOT spending a corrective retry. After migration `stop_reason` is no longer visible — `assistantTurn.content` is opaque — so read `response.refused` instead and keep the branch behaving identically.

`schedule-ai-run.test.ts:361` asserts this ("refusal → 422 AI_PLAN_FAILED"). If that test passes but you routed a refusal into the corrective-retry path, the assertion will still fail on the round count — do not "fix" it by relaxing the assertion.

- [ ] **Step 7: Update usage reads**

`response.usage.input_tokens` becomes `response.usage.inputTokens`; same for output. Cost at `:1379` and `:1430` uses `response.usage.costUsd` when non-null, falling back to `aiRunCostUsd` only if it is null.

- [ ] **Step 8: Run the Phase A suites**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-run.test.ts src/server/usecases/__tests__/schedule-ai-route.test.ts src/server/usecases/__tests__/schedule-ai-ledger.test.ts`
Expected: PASS. The constructor-timeout regression test must still pass — it now asserts through the adapter.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add apps/web/src/server/usecases/schedule-ai.ts \
        apps/web/src/server/usecases/__tests__/schedule-ai-run.test.ts
git commit -m "refactor(ai): let the schedule runner ask a provider, not Anthropic

Phase A built its own SDK client and spelled its request in Anthropic's
vocabulary, so the runner and the vendor were the same decision. Route it
through the provider seam instead, resolving one provider per run so a
repair round replays reasoning blocks to the service that produced them.

No behaviour change: same prompt, same budget, same legacy-model handling
for the models that reject adaptive thinking.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Migrate Phase B to the provider

**Files:**
- Modify: `apps/web/src/server/usecases/officials-ai.ts:589-800` (`officialsAssistantTurn` at `:757`, `callOfficialsModel` at `:762`)
- Create: `apps/web/src/server/usecases/__tests__/officials-ai-provider.test.ts`
- Must keep passing unchanged: `apps/web/src/server/usecases/__tests__/officials-ai-route.test.ts` (`:187-188` asserts `output_config.effort` through the real adapter)

**Interfaces:**
- Consumes: everything Task 3 produces, plus the `callModel` pattern from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create a **new** file `apps/web/src/server/usecases/__tests__/officials-ai-provider.test.ts`, for the same reason as Task 4: `officials-ai-route.test.ts` mocks `@anthropic-ai/sdk` (line 28) and its assertion at `:187-188` that `body.output_config.effort === "high"` must keep passing through the real adapter.

Reuse that suite's pack/fixture helpers (`resp`, `assignAll`, `fixtureIds`, `refA`) by importing them if exported, otherwise duplicating the minimum needed.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicProvider = vi.fn();
vi.mock("@/server/ai/anthropic-provider", () => ({ anthropicProvider }));

// …officials pack fixtures, as above…

const round = (parsed: unknown) => ({
  parsed,
  assistantTurn: { role: "assistant" as const, content: [] },
  usage: { inputTokens: 900, outputTokens: 220, costUsd: null },
  servedModel: "claude-sonnet-5",
});

beforeEach(() => {
  anthropicProvider.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OFFICIALS_AI_EFFORT;
});

describe("officials runner ↔ provider seam", () => {
  it("asks for effort reasoning at the officials effort, with the 32k budget", async () => {
    const chat = vi.fn().mockResolvedValue(round(assignAll(fixtureIds, refA)));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runOfficialsAiPlan } = await import("../officials-ai");
    await runOfficialsAiPlan(/* …same args the route test passes… */);

    const req = chat.mock.calls[0]![0];
    // Phase B has no legacy-model branch and must not grow one: it always
    // asks for effort, never a token budget.
    expect(req.reasoning).toEqual({ kind: "effort", effort: "high" });
    expect(req.maxTokens).toBe(32_000);
    expect(req.schema.name).toBe("officials_plan");
  });

  it("resolves the provider once per run", async () => {
    const chat = vi.fn().mockResolvedValue(round(assignAll(fixtureIds, refA)));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runOfficialsAiPlan } = await import("../officials-ai");
    await runOfficialsAiPlan(/* …same args… */);

    expect(anthropicProvider).toHaveBeenCalledTimes(1);
  });
});
```

Read `officials-ai-route.test.ts:173-190` for the exact call signature `runOfficialsAiPlan` takes and substitute it for the `/* … */` comments — do not leave them in the committed test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/officials-ai-provider.test.ts`
Expected: FAIL — `officials-ai.ts` does not import `anthropicProvider`.

- [ ] **Step 3: Apply the same conversion**

Mirror Task 4 exactly: `callOfficialsModel` takes a provider first, builds an `AiChatRequest` with `schema: {name: "officials_plan", zod: AiOfficialsPlan}`, and `reasoning: {kind: "effort", effort: officialsAiEffort()}` — Phase B has no legacy-model branch and does not gain one. Delete `officialsAssistantTurn` (`:757`) and read `response.assistantTurn`. Replace the `Anthropic.APIError` check at `:791` with `AiProviderError`.

Resolve the provider once in the officials run entry point and apply the same `isConfigured()` guard Task 4 added, using whatever status/message/code this file's existing unconfigured path throws — grep for `503` in `officials-ai.ts` and match it. If there is no such guard today, add one throwing the same shape Phase A throws.

- [ ] **Step 4: Run the Phase B suites**

Run: `npx vitest run src/server/usecases/__tests__/officials-ai-route.test.ts src/server/usecases/__tests__/officials-ai-referee.test.ts src/server/usecases/__tests__/officials-ai-pack.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the Anthropic import is gone from both runners**

Run: `grep -n "@anthropic-ai/sdk" apps/web/src/server/usecases/*.ts`
Expected: no matches. The only importers should now be under `apps/web/src/server/ai/`.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add apps/web/src/server/usecases/officials-ai.ts \
        apps/web/src/server/usecases/__tests__/officials-ai-route.test.ts
git commit -m "refactor(ai): move the officials runner onto the provider seam

Phase B carried its own copy of the same Anthropic call, so a provider
change would have had to be made twice and could drift between the two.
Route it through the same seam as Phase A.

Phase B keeps fixed adaptive reasoning and no cheap-model branch, as
before; only the vocabulary changes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: The OpenRouter data policy

The regression guard for a published customer promise. Written before the adapter so the adapter cannot be built without it.

**Files:**
- Create: `apps/web/src/server/ai/openrouter-policy.ts`
- Create: `apps/web/src/server/ai/__tests__/openrouter-policy.test.ts`

**Interfaces:**
- Produces: `ALLOWED_PROVIDERS: readonly string[]`, `POLICY: {provider: {...}, zdr: true}`, `applyPolicy<T extends object>(body: T): T & typeof POLICY`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/ai/__tests__/openrouter-policy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { applyPolicy, ALLOWED_PROVIDERS } from "../openrouter-policy";

describe("openrouter data policy", () => {
  it("denies data collection and pins zero retention", () => {
    const body = applyPolicy({ model: "vendor/model" });
    expect(body.provider.data_collection).toBe("deny");
    expect(body.zdr).toBe(true);
  });

  it("restricts routing to the allowlist and forbids fallbacks", () => {
    // allow_fallbacks defaults true upstream; without this, routing can leave
    // the allowlist and the customer promise silently stops holding.
    const body = applyPolicy({ model: "vendor/model" });
    expect(body.provider.only).toEqual(ALLOWED_PROVIDERS);
    expect(body.provider.allow_fallbacks).toBe(false);
  });

  it("cannot be overridden by the caller", () => {
    const body = applyPolicy({
      model: "vendor/model",
      provider: { data_collection: "allow", allow_fallbacks: true },
      zdr: false,
    } as never);
    expect(body.provider.data_collection).toBe("deny");
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.zdr).toBe(true);
  });

  it("keeps a non-empty allowlist", () => {
    expect(ALLOWED_PROVIDERS.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/ai/__tests__/openrouter-policy.test.ts`
Expected: FAIL — cannot resolve `../openrouter-policy`.

- [ ] **Step 3: Write the policy module**

Create `apps/web/src/server/ai/openrouter-policy.ts`. Populate `ALLOWED_PROVIDERS` from the policy-routable rows of `design/v4/05-openrouter-candidates.md` produced in Task 2.

```typescript
// The data policy attached to every OpenRouter request.
//
// help/scheduling/ai-scheduling.md tells organisers their brief "is not used to
// train AI models", and ai-officials.md repeats the guarantee. Routing through
// third parties only keeps that true if the policy travels with the request, so
// it lives here as a constant rather than an env var: there is no deployment in
// which loosening it is correct.
//
// Reviewed: 2026-07-21. Re-review whenever a provider is added.

/** Upstream providers permitted to serve our traffic — FIRST-PARTY VENDORS ONLY.
 *
 *  A model id says who BUILT the model, never who SERVES it. Verified
 *  2026-07-21 against /api/v1/models/{id}/endpoints: `anthropic/claude-sonnet-5`
 *  has 7 endpoints across Azure, Anthropic, Amazon Bedrock and Google Vertex;
 *  `z-ai/glm-5.2` has 31 across ~30 companies; `moonshotai/kimi-k2.6` has 20.
 *  `data_collection: "deny"` filters on training policy — it does NOT pin who
 *  processes the data. Without this list a single request could be served by
 *  any of them, which is not what the help pages promise organisers.
 *
 *  These are provider ROUTING SLUGS, not model-id prefixes — they differ
 *  (`x-ai/grok-4.5` is served by slug `xai`, display name "xAI"). Take slugs
 *  from the `tag` field, up to the first `/`.
 *
 *  Each slug below was verified with a live request carrying the full policy;
 *  all four returned 200 and were served by the named vendor. */
export const ALLOWED_PROVIDERS = ["anthropic", "xai", "z-ai", "moonshotai"] as const;

const POLICY = {
  provider: {
    data_collection: "deny",
    only: ALLOWED_PROVIDERS,
    // Upstream default is true. Left on, routing can fall through to a
    // provider outside `only` and the promise quietly stops holding.
    allow_fallbacks: false,
  },
  zdr: true,
} as const;

/** Stamp the policy onto a request body, last, so nothing can override it. */
export function applyPolicy<T extends object>(body: T): T & typeof POLICY {
  return { ...body, ...POLICY };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/ai/__tests__/openrouter-policy.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/ai/openrouter-policy.ts \
        apps/web/src/server/ai/__tests__/openrouter-policy.test.ts
git commit -m "feat(ai): make the no-training promise something code enforces

Two help pages tell organisers their brief is never used to train AI
models. Routing through a broker puts that promise in the hands of
whichever provider happens to serve the request, so state it as a
constant that travels with every call: deny data collection, demand zero
retention, and pin routing to an allowlist.

allow_fallbacks is off deliberately. Upstream defaults it on, and left
on, routing can leave the allowlist without anyone noticing.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: OpenRouter request builder

Pure mapping, split from transport so the wire shape is testable without a network.

**Files:**
- Create: `apps/web/src/server/ai/openrouter-request.ts`
- Create: `apps/web/src/server/ai/__tests__/openrouter-request.test.ts`

**Interfaces:**
- Consumes: `AiChatRequest`, `AiReasoning` (Task 3); `applyPolicy` (Task 6).
- Produces: `buildOpenRouterBody<T>(req: AiChatRequest<T>): Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/ai/__tests__/openrouter-request.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildOpenRouterBody } from "../openrouter-request";

const Plan = z.object({ ok: z.boolean() });

const req = (over: Record<string, unknown> = {}) => ({
  model: "anthropic/claude-sonnet-5",
  system: "SYS",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 32_000,
  reasoning: { kind: "effort" as const, effort: "high" as const },
  schema: { name: "schedule_plan", zod: Plan },
  signal: new AbortController().signal,
  timeoutMs: 600_000,
  ...over,
});

describe("openrouter request body", () => {
  it("puts the system prompt first and marks it cacheable", () => {
    const body = buildOpenRouterBody(req()) as never;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("maps effort reasoning to the unified reasoning parameter", () => {
    const body = buildOpenRouterBody(req()) as never;
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("maps a legacy budget to reasoning.max_tokens", () => {
    const body = buildOpenRouterBody(
      req({ reasoning: { kind: "budget", tokens: 8_000 } }),
    ) as never;
    expect(body.reasoning).toEqual({ max_tokens: 8_000 });
  });

  it("omits reasoning entirely when none is asked for", () => {
    const body = buildOpenRouterBody(req({ reasoning: { kind: "none" } })) as never;
    expect(body.reasoning).toBeUndefined();
  });

  it("requests a strict json schema built from the zod schema", () => {
    const body = buildOpenRouterBody(req()) as never;
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("schedule_plan");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.type).toBe("object");
  });

  it("always carries the data policy", () => {
    const body = buildOpenRouterBody(req()) as never;
    expect(body.provider.data_collection).toBe("deny");
    expect(body.zdr).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/ai/__tests__/openrouter-request.test.ts`
Expected: FAIL — cannot resolve `../openrouter-request`.

- [ ] **Step 3: Write the builder**

Create `apps/web/src/server/ai/openrouter-request.ts`:

```typescript
// Translates a provider-neutral request into OpenRouter's OpenAI-shaped body.
// Pure and synchronous so the wire shape can be asserted without a network.
import { z } from "zod";
import { applyPolicy } from "./openrouter-policy";
import type { AiChatRequest } from "./provider";

export function buildOpenRouterBody<T>(req: AiChatRequest<T>): Record<string, unknown> {
  // The system block carries the cache breakpoint. Anthropic models routed
  // through OpenRouter need it explicitly; models that cache automatically
  // ignore it. Keeping it first also keeps the stable prefix stable — anything
  // volatile ahead of it would invalidate the cache on every request.
  const messages = [
    {
      role: "system",
      content: [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
      ],
    },
    ...req.messages,
  ];

  // Three-way, and the thinking mode is NOT decorative. The code being
  // replaced sends effort unconditionally while toggling thinking, so the
  // disabled case must keep the effort intent rather than collapsing to
  // "no reasoning" — that collapse has been a real bug on this branch twice.
  // `{effort, enabled:false}` is accepted by the API (verified live: HTTP 200).
  const reasoning =
    req.reasoning.kind === "effort"
      ? req.reasoning.thinking === "disabled"
        ? { effort: req.reasoning.effort, enabled: false }
        : { effort: req.reasoning.effort }
      : req.reasoning.kind === "budget"
        ? { max_tokens: req.reasoning.tokens }
        : undefined;

  return applyPolicy({
    model: req.model,
    max_tokens: req.maxTokens,
    messages,
    ...(reasoning ? { reasoning } : {}),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: req.schema.name,
        strict: true,
        schema: z.toJSONSchema(req.schema.zod),
      },
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/ai/__tests__/openrouter-request.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/ai/openrouter-request.ts \
        apps/web/src/server/ai/__tests__/openrouter-request.test.ts
git commit -m "feat(ai): translate a plan request into OpenRouter's dialect

OpenRouter speaks OpenAI's chat format, so nothing about our Anthropic
request carries over unchanged: thinking becomes reasoning, structured
output becomes a strict json schema, and the cached system block becomes
the first message.

Kept pure and separate from transport so the wire shape is asserted in
unit tests rather than discovered against a live endpoint.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: OpenRouter adapter

**Files:**
- Create: `apps/web/src/server/ai/openrouter-provider.ts`
- Create: `apps/web/src/server/ai/__tests__/openrouter-provider.test.ts`

**Interfaces:**
- Consumes: `buildOpenRouterBody` (Task 7), `provider.ts` types (Task 3).
- Produces: `function openRouterProvider(): AiProvider`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/ai/__tests__/openrouter-provider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { openRouterProvider } from "../openrouter-provider";
import { AiProviderError } from "../provider";

const Plan = z.object({ ok: z.boolean() });

const reply = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    model: "anthropic/claude-sonnet-5",
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({ ok: true }),
          reasoning_details: [{ type: "reasoning.text", text: "…" }],
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      cost: 0.1234,
      cached_tokens: 5,
      cache_write_tokens: 0,
    },
    ...over,
  }),
});

async function callOnce() {
  return openRouterProvider().chat({
    model: "anthropic/claude-sonnet-5",
    system: "SYS",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 32_000,
    reasoning: { kind: "effort", effort: "high" },
    schema: { name: "schedule_plan", zod: Plan },
    signal: new AbortController().signal,
    timeoutMs: 600_000,
  });
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  vi.restoreAllMocks();
});

describe("openrouter provider", () => {
  it("parses the plan out of the message content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const res = await callOnce();
    expect(res!.parsed).toEqual({ ok: true });
  });

  it("keeps the assistant message whole, reasoning_details included", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const res = await callOnce();
    const content = res!.assistantTurn.content as { reasoning_details?: unknown[] };
    expect(content.reasoning_details).toHaveLength(1);
  });

  it("prefers the billed cost the response reports", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const res = await callOnce();
    expect(res!.usage.costUsd).toBe(0.1234);
    expect(res!.usage.inputTokens).toBe(10);
    expect(res!.usage.outputTokens).toBe(20);
    expect(res!.usage.cachedTokens).toBe(5);
  });

  it("stamps the model that actually served the request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ model: "xai/other" })));
    const res = await callOnce();
    expect(res!.servedModel).toBe("xai/other");
  });

  it("returns parsed:null when the content is not valid JSON", async () => {
    const bad = reply();
    bad.json = async () => ({
      model: "m",
      choices: [{ message: { role: "assistant", content: "not json" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad));
    const res = await callOnce();
    expect(res!.parsed).toBeNull();
  });

  it("returns parsed:null when the JSON does not match the schema", async () => {
    const bad = reply();
    bad.json = async () => ({
      model: "m",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ ok: "no" }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad));
    const res = await callOnce();
    expect(res!.parsed).toBeNull();
  });

  it("throws AiProviderError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" }),
    );
    await expect(callOnce()).rejects.toBeInstanceOf(AiProviderError);
  });

  it("throws AiProviderError when the key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(callOnce()).rejects.toBeInstanceOf(AiProviderError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/ai/__tests__/openrouter-provider.test.ts`
Expected: FAIL — cannot resolve `../openrouter-provider`.

- [ ] **Step 3: Write the adapter**

Create `apps/web/src/server/ai/openrouter-provider.ts`:

```typescript
// OpenRouter adapter. Opt-in via AI_PROVIDER=openrouter; Anthropic remains the
// shipped default.
import { buildOpenRouterBody } from "./openrouter-request";
import {
  AiProviderError,
  type AiChatRequest,
  type AiChatResponse,
  type AiProvider,
} from "./provider";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export function openRouterProvider(): AiProvider {
  return {
    id: "openrouter",
    isConfigured: () => Boolean(process.env.OPENROUTER_API_KEY),
    async chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null> {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new AiProviderError("OPENROUTER_API_KEY is not configured");
      const base = process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE;

      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(buildOpenRouterBody(req)),
          signal: req.signal,
        });
      } catch (err) {
        // An abort is the caller's round deadline, not a provider failure —
        // let it surface so the caller maps it to AI_PLAN_TIMEOUT.
        if (req.signal.aborted) throw err;
        throw new AiProviderError("OpenRouter request failed", err);
      }

      if (!res.ok) {
        throw new AiProviderError(
          `OpenRouter returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      }

      const body = await res.json();
      const message = body?.choices?.[0]?.message;
      const usage = body?.usage ?? {};

      // The whole message goes back on repair rounds: OpenRouter requires the
      // reasoning block sequence to match what the model produced, unmodified.
      const assistantTurn = { role: "assistant" as const, content: message ?? {} };

      let parsed: T | null = null;
      if (typeof message?.content === "string") {
        try {
          const check = req.schema.zod.safeParse(JSON.parse(message.content));
          if (check.success) parsed = check.data;
        } catch {
          // Malformed JSON is the corrective path's problem, not an exception.
          parsed = null;
        }
      }

      return {
        parsed,
        // Required by AiChatResponse. A refusal must fail fast and spend no
        // corrective retry, so it cannot be inferred from `parsed: null`.
        // OpenRouter is OpenAI-shaped: determine the actual signal from its
        // docs and the live API (candidates include choices[0].finish_reason,
        // native_finish_reason, and an OpenAI-style message.refusal), then
        // document the choice and pin it with a test. Do not guess — getting
        // this wrong routes a refusal into the retry path, which is the exact
        // bug already fixed for the Anthropic adapter.
        refused: /* determined signal */ false,
        assistantTurn,
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          costUsd: typeof usage.cost === "number" ? usage.cost : null,
          cachedTokens: usage.cached_tokens,
          cacheWriteTokens: usage.cache_write_tokens,
        },
        servedModel: body?.model ?? req.model,
      };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/ai/__tests__/openrouter-provider.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add apps/web/src/server/ai/openrouter-provider.ts \
        apps/web/src/server/ai/__tests__/openrouter-provider.test.ts
git commit -m "feat(ai): add an OpenRouter adapter behind the provider seam

Gives the architect a second way to reach a model, and with it any
policy-compliant model rather than the one our SDK import chose.

Billed cost comes from the response instead of a hardcoded rate table,
which is how ai-pricing.ts understated by a third once already. The
assistant message is returned whole because repair rounds must replay the
reasoning sequence unmodified.

Still opt-in: nothing selects this yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Provider selection and the 503 guard

Wires `AI_PROVIDER` and generalises the unconfigured-provider guard.

**Files:**
- Create: `apps/web/src/server/ai/select-provider.ts`
- Create: `apps/web/src/server/ai/__tests__/select-provider.test.ts`
- Modify: `apps/web/src/server/usecases/schedule-ai.ts` (use `selectProvider()` in place of `anthropicProvider()`)
- Modify: `apps/web/src/server/usecases/officials-ai.ts` (same)
- Modify: `apps/web/src/server/usecases/__tests__/schedule-ai-run.test.ts:371`

**Interfaces:**
- Consumes: `anthropicProvider()` (Task 3), `openRouterProvider()` (Task 8).
- Produces: `function selectProvider(): AiProvider`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/ai/__tests__/select-provider.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { selectProvider } from "../select-provider";

beforeEach(() => {
  delete process.env.AI_PROVIDER;
});

describe("provider selection", () => {
  it("defaults to anthropic when AI_PROVIDER is unset", () => {
    expect(selectProvider().id).toBe("anthropic");
  });

  it("selects openrouter when asked", () => {
    process.env.AI_PROVIDER = "openrouter";
    expect(selectProvider().id).toBe("openrouter");
  });

  it("falls back to anthropic on an unrecognised value rather than failing a run", () => {
    process.env.AI_PROVIDER = "tuesday";
    expect(selectProvider().id).toBe("anthropic");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/ai/__tests__/select-provider.test.ts`
Expected: FAIL — cannot resolve `../select-provider`.

- [ ] **Step 3: Write the selector**

Create `apps/web/src/server/ai/select-provider.ts`:

```typescript
// Resolves the provider for a run. Anthropic is the shipped default, so an
// unset or unrecognised AI_PROVIDER behaves exactly as before this seam existed.
import { anthropicProvider } from "./anthropic-provider";
import { openRouterProvider } from "./openrouter-provider";
import type { AiProvider } from "./provider";

export function selectProvider(): AiProvider {
  return process.env.AI_PROVIDER === "openrouter"
    ? openRouterProvider()
    : anthropicProvider();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/ai/__tests__/select-provider.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Use it in both runners**

Replace `anthropicProvider()` with `selectProvider()` in `schedule-ai.ts` (Task 4, Step 6) and in `officials-ai.ts` (Task 5). Still one call per run.

- [ ] **Step 6: Generalise the 503 test**

`schedule-ai-run.test.ts:371` currently reads:

```typescript
  it("missing ANTHROPIC_API_KEY → 503 before any call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 503 });
    expect(parse).not.toHaveBeenCalled();
  });
```

Keep it and add its sibling immediately after:

```typescript
  it("missing OPENROUTER_API_KEY → 503 before any call when that provider is selected", async () => {
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.OPENROUTER_API_KEY;
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 503 });
    // The Anthropic path must be untouched — a misconfigured OpenRouter run
    // must not silently fall back to the other provider's credentials.
    expect(parse).not.toHaveBeenCalled();
  });
```

`AI_PROVIDER` leaks into every later test in the file if left set. Add to the suite's `beforeEach` (alongside the existing `process.env.ANTHROPIC_API_KEY = "test-key"` at line 133):

```typescript
  delete process.env.AI_PROVIDER;
```

- [ ] **Step 7: Run the affected suites**

Run: `npx vitest run src/server/ai src/server/usecases/__tests__/schedule-ai-run.test.ts src/server/usecases/__tests__/officials-ai-route.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add apps/web/src/server/ai/select-provider.ts \
        apps/web/src/server/ai/__tests__/select-provider.test.ts \
        apps/web/src/server/usecases/schedule-ai.ts \
        apps/web/src/server/usecases/officials-ai.ts \
        apps/web/src/server/usecases/__tests__/schedule-ai-run.test.ts
git commit -m "feat(ai): choose the AI provider with an environment variable

Makes the second path reachable: AI_PROVIDER=openrouter switches an
environment over without a code change, so staging can try a model while
production stays where it is.

Unset or unrecognised still means Anthropic. An environment with a typo
in the variable name should behave like today, not fail every run.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Fixture server OpenRouter mode

**Files:**
- Modify: `apps/web/e2e/ai-fixture-server.ts`
- Modify: `.github/workflows/ci.yml` and `.github/workflows/e2e.yml` only if they set `SCHEDULING_AI_BASE_URL` (grep first; **do not enable `e2e.yml` itself** — it is disabled deliberately)

**Interfaces:**
- Consumes: the OpenRouter response shape asserted in Task 8's tests.
- Produces: no application code.

- [ ] **Step 1: Read the current fixture server**

Run: `cat apps/web/e2e/ai-fixture-server.ts`
Note how it echoes the pack draft back as an engine-legal plan, and how `FIXTURE_REFUSE` drives the refusal path.

- [ ] **Step 2: Add a route for the OpenRouter shape**

Keep the existing Anthropic `/v1/messages` handler untouched. Add `POST /api/v1/chat/completions` returning the OpenAI shape around the same generated plan:

```typescript
// OpenRouter mode: same fixture plan, different envelope. Selected by pointing
// OPENROUTER_BASE_URL at this server instead of SCHEDULING_AI_BASE_URL.
{
  model: body.model,
  choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
}
```

Mirror `FIXTURE_REFUSE` in this branch too, so both paths exercise the refusal case.

- [ ] **Step 3: Run the AI e2e specs against the Anthropic path**

Run: `npx playwright test e2e/ai-schedule.spec.ts` (adjust to the actual spec filename found by `ls apps/web/e2e | grep ai`)
Expected: PASS — unchanged behaviour, since `AI_PROVIDER` is unset.

- [ ] **Step 4: Run them again against the OpenRouter path**

Run with `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY=test`, and `OPENROUTER_BASE_URL` pointing at the fixture server.
Expected: PASS, same assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/ai-fixture-server.ts
git commit -m "test(e2e): let the AI fixture answer in either dialect

The fixture server only spoke Anthropic's Messages API, so the OpenRouter
path had no end-to-end coverage at all and would have been exercised for
the first time against a live endpoint.

Same fixture plan, second envelope, chosen by base URL. Refusals are
mirrored so both paths cover that branch.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Two-stage shootout harness

**Files:**
- Modify: `apps/web/src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts`
- Create: `design/v4/06-openrouter-shootout.md` (results, written after the runs)

**Interfaces:**
- Consumes: `selectProvider()` (Task 9), the candidate table from Task 2.
- Produces: results documentation only.

- [ ] **Step 1: Read the existing harness**

Run: `sed -n '190,240p' apps/web/src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts`
Note how an arm sets `SCHEDULING_AI_EFFORT` and `SCHEDULING_AI_MODEL`, and how `AI_AB_LIVE`, `AI_AB_REPEATS` and `AI_AB_BASELINE` gate the run.

- [ ] **Step 2: Add a provider field to the arm type**

Extend the arm definition with `provider?: "anthropic" | "openrouter"`, defaulting to `anthropic`, and set `process.env.AI_PROVIDER` alongside the existing env assignments. Restore it in the same teardown that restores `SCHEDULING_AI_MODEL`.

- [ ] **Step 3: Define the control arms**

```typescript
// Baseline: must reproduce the 2026-07-20 recorded run on teams-15 —
// 276.8s, 29,858 output tokens, 0 blocking, 0 warnings, $0.465.
{ label: "sonnet-5 direct", model: "claude-sonnet-5", effort: "high", provider: "anthropic" },
// Fidelity: same model, different transport. Divergence here is our adapter's
// bug, not the model's — which is the whole reason this arm exists.
{ label: "sonnet-5 via openrouter", model: "anthropic/claude-sonnet-5", effort: "high", provider: "openrouter" },
```

- [ ] **Step 4: Run stage 1 — screen**

For each policy-routable candidate in `design/v4/05-openrouter-candidates.md`, run `AI_AB_LIVE=1 AI_AB_REPEATS=1` against the `teams-15` pack only, plus both control arms.

Run: `AI_AB_LIVE=1 AI_AB_REPEATS=1 npx vitest run src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts`

Eliminate a candidate if any of: blocking conflicts > 0 after the repair loop, output that never parses, no policy-surviving route, or a round exceeding `ROUND_TIMEOUT_MS`. Warnings do **not** eliminate at this stage.

**Check the fidelity arm before reading any candidate result.** If "sonnet-5 via openrouter" diverges materially from "sonnet-5 direct", stop: the adapter is wrong and every candidate number is contaminated.

- [ ] **Step 5: Run stage 2 — full**

Survivors plus both control arms, `AI_AB_REPEATS=3`, both packs.

Run: `AI_AB_LIVE=1 AI_AB_REPEATS=3 npx vitest run src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts`

**Every arm pins its endpoint.** OpenRouter serves many models in quantised variants — endpoint tags carry `fp8`, `fp4`, `int4` suffixes (`z-ai/glm-5.2` alone has 31 endpoints across ~30 companies). Left to routing, this shootout would compare full-precision Claude against a 4-bit GLM and attribute the difference to the model. Each arm therefore sends `provider.only` with its exact endpoint slug, and the results table records the quantisation beside cost and quality, so a row reads "GLM at fp8" rather than "GLM". An arm whose endpoint cannot be pinned is not run.

- [ ] **Step 6: Write up the results**

Create `design/v4/06-openrouter-shootout.md` in the same table shape as `design/v4/04-architect-benchmarks.md` (pack, arm, secs mean, out mean, blocking, warnings, $), plus a column naming the endpoint and quantisation each arm ran on. Include a short "How to apply" section stating explicitly whether the default model should change and why. Classify failures by the rule IDs Task 1 introduced.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts \
        design/v4/06-openrouter-shootout.md
git commit -m "test(ai): bench candidate models against the Claude baseline

Adds a provider axis to the A/B harness and records the shootout: a cheap
single-run screen on the dense pack, which is the one that separates
models, then the full repeat count on whatever survives.

Both control arms run the same model on both transports, so a bad
candidate number can be told apart from a bad adapter.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Help pages, smoke, and the sub-processor flag

**Files:**
- Modify: `apps/web/content/help/scheduling/ai-scheduling.md:30`
- Modify: `apps/web/content/help/scheduling/ai-officials.md:26`
- Modify: `scripts/smoke.ts`

**Interfaces:**
- Consumes: `ALLOWED_PROVIDERS` (Task 6) — the copy must name what the constant permits.
- Produces: nothing code-facing.

- [ ] **Step 1: Rewrite the schedule help sentence**

`ai-scheduling.md:30` currently reads:

> Your data stays yours: the brief is sent to our AI provider (Anthropic) only to produce the proposal, and it is **not used to train AI models**.

Replace the parenthetical with the routing reality, keeping the guarantee and the rest of the paragraph intact. Name the providers in `ALLOWED_PROVIDERS`, and state that requests are sent with data collection denied and zero retention required.

- [ ] **Step 2: Rewrite the officials help sentence**

`ai-officials.md:26` carries the same guarantee by reference. Update it to match, keeping the cross-link to the schedule page.

- [ ] **Step 3: Check for other Anthropic mentions**

Run: `grep -rn "Anthropic" apps/web/content/`
Expected: no stale mentions left. Fix any found.

- [ ] **Step 4: Extend the smoke script**

In `scripts/smoke.ts`, add a check on both the pro and free paths asserting the AI run records a provider and a served model. Follow the file's existing assertion style.

- [ ] **Step 5: Run smoke against a fresh database**

Run from the repo root, against a freshly migrated test database: `npm run test:smoke`
Expected: PASS. A stale database produces false failures unrelated to this change — migrate first.

- [ ] **Step 6: Full gate**

```bash
cd apps/web && npm run typecheck && npm run test
cd ../.. && npm run test --workspace packages/engine
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/content/help/scheduling/ai-scheduling.md \
        apps/web/content/help/scheduling/ai-officials.md \
        scripts/smoke.ts
git commit -m "docs(help): say who actually sees a scheduling brief now

Both AI help pages named Anthropic as the only recipient, which stops
being true the moment a brief can be routed elsewhere. Name the providers
that can serve it and say what we demand of them: no data collection,
zero retention.

The guarantee itself is unchanged, and is now enforced by
openrouter-policy.ts rather than only promised here.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 8: Raise the sub-processor decision with the user**

**Do not edit privacy-policy or consent copy.** Report to the user: adding OpenRouter and its upstream providers is a sub-processor change; `lib/legal.ts` carries a consent stamp that may need bumping; the privacy policy may list sub-processors. Ask whether they want that handled here, in a follow-up branch, or by someone else. Wait for an answer before opening a PR.

---

## Self-Review

**Spec coverage.** Environment bring-up → Task 0 (not a spec section; the spec assumes a working checkout, and a fresh worktree is not one). §0 → Task 1. §1 → Task 3. §2 → Tasks 3, 7, 8. §3 → Task 9. §4 → Task 6. §5 → Tasks 3, 8. §6 → Tasks 7, 8 (cache breakpoint sent, cache tokens captured). §7 → Task 10. §8 → Task 2. §9 → Task 11. §10 → Tasks 4, 5. §11 → Task 12. Risks: Grok routability → Task 2 Step 6; replay fidelity → Task 11 Step 4; provider-fixed-per-run → Task 4 Step 6 and its test.

**Placeholders.** Tasks 4, 5 and 9 point the implementer at existing tests to mirror rather than restating fixtures that run to hundreds of lines; each names the exact file, the exact test to copy, and the exact assertion to change. Task 6's `ALLOWED_PROVIDERS` value is populated from Task 2's generated artifact, which is why Task 2 runs first.

**Type consistency.** `AiReasoning` discriminates on `kind` in Tasks 3, 4, 7. `AiChatResponse.usage` uses `inputTokens`/`outputTokens`/`costUsd` in Tasks 3, 8 and is read under those names in Task 4 Step 7. `selectProvider()` is defined in Task 9 and used in Tasks 4, 5 via the Step 5 replacement. `buildOpenRouterBody` is produced in Task 7 and consumed in Task 8. `eligibleCandidates` is produced in Task 2 and consumed only by the script in the same task.
