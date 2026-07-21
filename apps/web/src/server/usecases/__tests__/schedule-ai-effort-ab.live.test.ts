// LIVE cost/quality bench for the architect's `effort` setting — NOT a unit test.
//
// Output tokens are ~96% of a run's cost (5,212 in / 26,917 out on the
// 2026-07-19 measurement), and `effort` is the direct knob on thinking depth.
// This file measures what dropping high → medium actually costs in plan
// quality, on packs materially larger than that 17-fixture baseline.
//
// Skipped unless AI_AB_LIVE=1 — it makes real, billed Anthropic calls. Run:
//   AI_AB_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts
//
// Both arms see a byte-identical pack (ids are deterministic), so the only
// variable is `effort`. The deterministic referee verifies every proposal, so
// a thinner plan shows up as repair rounds / residual conflicts — never as a
// silently bad schedule.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runAiPlan, schedulingAiModel } from "../schedule-ai";
import type { PackFixture, PackPerson, SchedulePack } from "../schedule-ai";
import { applyPolicy } from "../../ai/openrouter-policy";

// vitest does not read .env.local; load just the keys we need if absent.
// OPENROUTER_API_KEY only lives in the worktree ROOT .env.local (not
// apps/web/.env.local), unlike ANTHROPIC_API_KEY which is in both — so each
// key independently tries both paths rather than assuming one holds both.
function loadEnvKeyIfAbsent(name: string) {
  if (process.env[name]) return;
  for (const rel of ["../../../../.env.local", "../../../../../../.env.local"]) {
    const p = path.resolve(__dirname, rel);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) {
      const raw = m[1].trim();
      let value: string;
      if (raw[0] === '"' || raw[0] === "'") {
        // Quoted: take up to the matching closing quote, discarding any
        // trailing inline comment (e.g. `"sk-..."   # required for X`).
        const quote = raw[0];
        const end = raw.indexOf(quote, 1);
        value = end === -1 ? raw.slice(1) : raw.slice(1, end);
      } else {
        // Unquoted: take up to the first whitespace-then-`#`.
        const hashIdx = raw.search(/\s#/);
        value = (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
      }
      process.env[name] = value;
      break;
    }
  }
}
loadEnvKeyIfAbsent("ANTHROPIC_API_KEY");
loadEnvKeyIfAbsent("OPENROUTER_API_KEY");

const LIVE = process.env.AI_AB_LIVE === "1";

// --- OpenRouter served-provider probe ---------------------------------------
// `AiChatResponse` (server/ai/provider.ts) deliberately exposes only
// `servedModel` and a boolean `refused` — neither says which VENDOR actually
// served a candidate call (task-11-brief's endpoint/quantisation column) nor
// preserves the raw finish_reason/native_finish_reason/message.refusal shape
// (open question 2). A first attempt at this wrapped `globalThis.fetch` to
// peek at the real bench call's response via a clone; that MISS-FIRED badly —
// every Anthropic-direct arm (including the pre-existing, previously-working
// low/no-think and haiku cells, untouched by this task) started failing
// instantly with zero tokens the moment the wrap was installed, for reasons
// not worth chasing down against a $25 cap. This does a SEPARATE, minimal,
// cheap request instead (a few tokens, ~$0.00005 observed 2026-07-21) —
// same model, same policy, own isolated fetch call — right after the real
// bench call. It cannot regress runAiPlan's own transport because it never
// touches global fetch, and it answers the same question (which vendor and,
// where knowable, which quantisation serves this model under the allowlist)
// without staking the whole bench on an interception trick.
type ServedProviderProbe = {
  provider?: string;
  finishReason?: string;
  nativeFinishReason?: string;
  refusal?: string | null;
  error?: string;
};

async function probeServedProvider(model: string): Promise<ServedProviderProbe> {
  const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        applyPolicy({
          model,
          max_tokens: 8,
          messages: [{ role: "user", content: "Say OK." }],
        }),
      ),
    });
    const body = await res.json();
    if (!res.ok) return { error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}` };
    const choice = body?.choices?.[0];
    return {
      provider: typeof body?.provider === "string" ? body.provider : undefined,
      finishReason: choice?.finish_reason,
      nativeFinishReason: choice?.native_finish_reason,
      refusal: choice?.message?.refusal ?? null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// --- deterministic ids -----------------------------------------------------
const uuid = (tag: string, n: number) =>
  `00000000-0000-4000-8000-${`${tag}${n}`.padStart(12, "0").slice(-12)}`;

// --- Pack A: 15 teams, 3 pools of 5, round robin within pool = 30 fixtures --
function teamsPack(): { pack: SchedulePack; movable: Set<string> } {
  const pools = ["Pool A", "Pool B", "Pool C"];
  const entrants = pools.flatMap((pool, p) =>
    Array.from({ length: 5 }, (_, t) => ({
      id: uuid("e", p * 5 + t),
      name: `${pool} Team ${t + 1}`,
      pool,
      seed: t + 1,
    })),
  );

  const movable: PackFixture[] = [];
  let n = 0;
  pools.forEach((pool, p) => {
    const ids = Array.from({ length: 5 }, (_, t) => uuid("e", p * 5 + t));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        movable.push({
          id: uuid("f", n),
          ext_key: `rr-${p}-${i}-${j}`,
          round: 1,
          seq: n,
          pool,
          home: ids[i],
          away: ids[j],
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        });
        n++;
      }
    }
  });

  const pack: SchedulePack = {
    mode: "generate",
    division: {
      id: "ab-teams",
      name: "Saturday League",
      sport: "generic",
      tz: "Europe/London",
    },
    settings: {
      matchMinutes: 30,
      gapMinutes: 10,
      perEntrantMinRest: 0,
      courts: ["Court 1", "Court 2", "Court 3"],
      sessionWindows: [{ from: "2026-08-01T09:00:00+01:00", to: "2026-08-01T21:00:00+01:00" }],
      blackouts: [{ court: "Court 3", from: "2026-08-01T12:00:00+01:00", to: "2026-08-01T13:30:00+01:00" }],
      constraints: {
        restMin: 60,
        noBackToBack: true,
        startWindows: [],
        fieldFairness: "balance",
        parallelism: "mixed",
        crossPersonClash: "hard",
      },
    },
    entrants,
    people: [],
    fixtures: { movable, obstacles: [] },
    draft: [],
    instruction:
      "Schedule all pool matches on Saturday. Every team needs at least 60 minutes between its matches, no team plays back-to-back, and Court 3 is unavailable 12:00-13:30 for maintenance. Spread each team's matches across courts where you can.",
    prior: null,
    officials: [],
  };
  return { pack, movable: new Set(movable.map((f) => f.id)) };
}

// --- Pack B: 50 individual entrants, R1 knockout = 25 fixtures -------------
//     10 people are entered twice (multi-event), so crossPersonClash bites.
function individualsPack(): { pack: SchedulePack; movable: Set<string> } {
  const entrants = Array.from({ length: 50 }, (_, i) => ({
    id: uuid("e", i),
    name: `Player ${i + 1}`,
    pool: null,
    seed: i + 1,
  }));

  const movable: PackFixture[] = Array.from({ length: 25 }, (_, i) => ({
    id: uuid("f", i),
    ext_key: `r1-${i + 1}`,
    round: 1,
    seq: i,
    pool: null,
    home: uuid("e", 2 * i),
    away: uuid("e", 2 * i + 1),
    feeds: { winner_to: null, after: [] },
    current: { at: null, court: null },
    pinned: false,
  }));

  // Ten dual-entered people: entrant k and entrant k+25 are the same human, so
  // fixture floor(k/2) and fixture floor((k+25)/2) must not overlap.
  const people: PackPerson[] = Array.from({ length: 10 }, (_, k) => ({
    person_id: uuid("p", k),
    entrant_ids: [uuid("e", k), uuid("e", k + 25)],
  }));

  const pack: SchedulePack = {
    mode: "generate",
    division: {
      id: "ab-individuals",
      name: "Club Championship",
      sport: "generic",
      tz: "Europe/London",
    },
    settings: {
      matchMinutes: 45,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["Court 1", "Court 2", "Court 3", "Court 4"],
      sessionWindows: [{ from: "2026-08-01T09:00:00+01:00", to: "2026-08-01T18:00:00+01:00" }],
      blackouts: [],
      constraints: {
        restMin: 30,
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "balance",
        parallelism: "mixed",
        crossPersonClash: "hard",
      },
    },
    entrants,
    people,
    fixtures: { movable, obstacles: [] },
    draft: [],
    instruction:
      "Schedule all 25 first-round matches in one day across four courts. Ten players are entered in two events each and must never be double-booked; give every player at least 30 minutes between matches. Finish as early in the day as possible.",
    prior: null,
    officials: [],
  };
  return { pack, movable: new Set(movable.map((f) => f.id)) };
}

// --- cost -------------------------------------------------------------------
// Sonnet 5 list is $3/$15 per MTok; introductory $2/$10 runs through
// 2026-08-31, so today's real spend is the `intro` column.
const usd = (i: number, o: number, inRate: number, outRate: number) =>
  Math.round(((i * inRate + o * outRate) / 1_000_000) * 10_000) / 10_000;

type Row = {
  pack: string;
  effort: string;
  secs: number;
  rounds: number;
  in: number;
  out: number;
  listUsd: number;
  introUsd: number;
  blocking: number;
  warnings: number;
  unschedulable: number;
  placed: number;
  error: string;
  /** Transport this arm ran on. */
  provider: string;
  /** Vendor name from the raw OpenRouter response body's `provider` field
   *  (task-11-brief: "capture the serving provider ... record it, with the
   *  known quantisation"). "anthropic (direct)" for the Anthropic transport,
   *  where there is no OpenRouter routing to report. */
  servedProvider: string;
  /** Real provider-reported cost (AiPlanResult.usage.cost_usd) — OpenRouter's
   *  `usage.cost` is the actual billed dollar figure per request, not a
   *  flat-rate estimate, which matters because listUsd/introUsd below assume
   *  Anthropic's own $3/$15 rate and are WRONG for non-Anthropic candidates.
   *  Prefer this field for every arm; listUsd/introUsd are kept only for the
   *  pre-existing Anthropic-only arms' historical comparison. */
  realUsd: number | null;
  /** Raw refusal diagnostics (open question 2), JSON-stringified, only when
   *  the arm ran on OpenRouter and a peek was captured. */
  rawPeek: string;
};

const rows: Row[] = [];

type Arm = {
  effort: string;
  thinking?: "adaptive" | "disabled";
  /** Overrides SCHEDULING_AI_MODEL for this arm. */
  model?: string;
  /** Legacy-reasoning models only (haiku): token-precise thinking ceiling. */
  budget?: number;
  /** Cell label — arms must not aggregate together just because they share an
   *  effort value. */
  label: string;
  /** Transport for this arm. Defaults to "anthropic" — an unset arm behaves
   *  exactly as before this field existed. Sets AI_PROVIDER, which
   *  selectProvider() reads once per run. */
  provider?: "anthropic" | "openrouter";
  /** Overrides SCHEDULING_AI_MAX_TOKENS for this arm. Unset arms fall back to
   *  schedule-ai.ts's own default (32_000) — nothing about the shipped path
   *  changes unless an arm sets this explicitly. */
  maxTokens?: number;
};

async function bench(
  name: string,
  build: () => { pack: SchedulePack; movable: Set<string> },
  arm: Arm,
) {
  const { effort, thinking = "adaptive", model, budget, label: cellEffort, provider = "anthropic", maxTokens } = arm;
  process.env.SCHEDULING_AI_EFFORT = effort;
  process.env.SCHEDULING_AI_THINKING = thinking;
  process.env.AI_PROVIDER = provider;
  if (model) process.env.SCHEDULING_AI_MODEL = model;
  else delete process.env.SCHEDULING_AI_MODEL;
  if (budget) process.env.SCHEDULING_AI_THINKING_BUDGET = String(budget);
  else delete process.env.SCHEDULING_AI_THINKING_BUDGET;
  if (maxTokens) process.env.SCHEDULING_AI_MAX_TOKENS = String(maxTokens);
  else delete process.env.SCHEDULING_AI_MAX_TOKENS;
  const { pack, movable } = build();
  const t0 = Date.now();
  const row: Row = {
    pack: name,
    effort: cellEffort,
    secs: 0,
    rounds: 0,
    in: 0,
    out: 0,
    listUsd: 0,
    introUsd: 0,
    blocking: -1,
    warnings: -1,
    unschedulable: -1,
    placed: -1,
    error: "",
    provider,
    servedProvider: provider === "anthropic" ? "anthropic (direct)" : "",
    realUsd: null,
    rawPeek: "",
  };
  try {
    const res = await runAiPlan(pack, movable);
    row.rounds = res.usage.repair_rounds;
    row.in = res.usage.input_tokens;
    row.out = res.usage.output_tokens;
    row.blocking = res.blocking.length;
    row.warnings = res.warnings.length;
    row.unschedulable = res.unschedulable.length;
    row.placed = res.proposal.length;
    row.realUsd = res.usage.cost_usd;
  } catch (err) {
    row.error = err instanceof Error ? `${(err as { code?: string }).code ?? ""} ${err.message}`.trim() : String(err);
    // runAiPlan rides accumulated usage on AI_PLAN_FAILED/AI_PLAN_TIMEOUT
    // (HttpError.extra.usage — schedule-ai.ts's usageNow()) specifically so a
    // failed-but-expensive run can still be metered. The pre-existing catch
    // above never read it, so a real-money round that failed after
    // generating (e.g. a corrective retry that still didn't parse) silently
    // reported in=0/out=0/real=$null — looked free, wasn't.
    const usage = (err as { extra?: { usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number | null } } })
      ?.extra?.usage;
    if (usage) {
      row.in = usage.input_tokens ?? 0;
      row.out = usage.output_tokens ?? 0;
      row.realUsd = usage.cost_usd ?? null;
    }
  }
  row.secs = Math.round((Date.now() - t0) / 100) / 10;
  if (provider === "openrouter" && model) {
    const probe = await probeServedProvider(model);
    row.servedProvider = probe.provider ?? probe.error ?? "(unknown)";
    row.rawPeek = JSON.stringify(probe);
  }
  // Rates per the arm's model. Reconciliation against the real account balance
  // on 2026-07-20 ($15 -> $9 over ~$5.6 of list-rate runs) says this account is
  // billed at LIST, not the introductory sonnet rate — so `listUsd` is the
  // column to trust and `introUsd` is kept only for comparison. Both assume
  // Anthropic's own rate table, so they are WRONG for non-Anthropic
  // candidates — `row.realUsd` (provider-reported) is the authoritative
  // figure for every arm; these two are kept only for the pre-existing
  // Anthropic-only cells' historical comparison.
  const [inRate, outRate] = model === "claude-haiku-4-5" ? [1, 5] : [3, 15];
  row.listUsd = usd(row.in, row.out, inRate, outRate);
  row.introUsd = usd(row.in, row.out, model === "claude-haiku-4-5" ? 1 : 2, model === "claude-haiku-4-5" ? 5 : 10);
  rows.push(row);
  process.stdout.write(
    `\n[${name} / effort=${cellEffort}] ${row.secs}s  rounds=${row.rounds}  in=${row.in} out=${row.out}  ` +
      `real=$${row.realUsd ?? "null"} list=$${row.listUsd} intro=$${row.introUsd}  blocking=${row.blocking} ` +
      `warnings=${row.warnings} unsched=${row.unschedulable} placed=${row.placed} ` +
      `served=${row.servedProvider}${row.rawPeek ? ` peek=${row.rawPeek}` : ""}` +
      `${row.error ? `  ERROR: ${row.error}` : ""}\n`,
  );
  // A swallowed error is worse than a red test: it looks like a cheap run.
  expect(row.error, `${name}/${cellEffort} failed`).toBe("");
  return row;
}

// Adaptive thinking is noisy: a repeated cell varied 2.1x run-to-run on
// 2026-07-20 (individuals-50 @ high, 7,911 vs 16,923 output tokens for a
// byte-identical pack). One sample per cell can order the arms but cannot size
// the gap between them, so REPEATS>1 is what turns the cost delta from
// directional into quotable.
const REPEATS = Math.max(1, Number(process.env.AI_AB_REPEATS) || 1);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** mean / min / max of one field across a cell's repeats. */
function agg(cell: Row[], pick: (r: Row) => number) {
  const xs = cell.map(pick);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { mean: round2(mean), min: round2(Math.min(...xs)), max: round2(Math.max(...xs)) };
}

describe.skipIf(!LIVE)("effort A/B (live, billed)", () => {
  // Worst observed cell is ~1095s; leave room for REPEATS of it plus repairs.
  const T = Math.max(3_300_000, REPEATS * 1_400_000);

  // Sanity-check the env parser above rather than the key's contents — never
  // print the key itself. A prior bug here let a trailing inline `# comment`
  // on a quoted .env.local line leak into the parsed value (167 chars,
  // containing a U+2192), which the SDK silently rejected before any network
  // call. The real key is 108 chars, pure ASCII (<= U+007E).
  it("loaded ANTHROPIC_API_KEY has no trailing comment / non-ASCII bleed", () => {
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    expect(key.length).toBe(108);
    expect(/^[\x00-\x7E]*$/.test(key)).toBe(true);
  });

  const cell = (name: string, build: () => { pack: SchedulePack; movable: Set<string> }, arm: Arm) =>
    it(`${name} @ ${arm.label} x${REPEATS}`, async () => {
      for (let i = 0; i < REPEATS; i++) await bench(name, build, arm);
    }, T);

  // Baseline arms are settled (2026-07-20, n=3): kept here only so a re-run
  // reproduces the full comparison. Enable with AI_AB_BASELINE=1.
  if (process.env.AI_AB_BASELINE === "1") {
    cell("teams-15", teamsPack, { effort: "high", label: "high" });
    cell("teams-15", teamsPack, { effort: "medium", label: "medium" });
    cell("individuals-50", individualsPack, { effort: "high", label: "high" });
    cell("individuals-50", individualsPack, { effort: "medium", label: "medium" });
  }

  // --- The two open questions -------------------------------------------
  //
  // Both test the same hypothesis: does producing a legal schedule from a
  // solver draft actually require a reasoning model? Thinking is ~90% of a
  // run's output tokens, and the engine referee re-checks every proposal, so a
  // thin plan is caught rather than shipped. Watch `rounds` — the trade is
  // fewer thinking tokens per round against possibly MORE rounds, and each
  // repair re-sends the prior round's output as input.

  // 1. Same model, no reasoning. The control: isolates thinking from model.
  cell("teams-15", teamsPack, { effort: "low", thinking: "disabled", label: "low/no-think" });
  cell("individuals-50", individualsPack, { effort: "low", thinking: "disabled", label: "low/no-think" });

  // 2. Cheaper model, token-capped reasoning. haiku-4-5 is $1/$5 against
  //    sonnet-5's $3/$15 and needs no port — same SDK, same zodOutputFormat,
  //    same parsed_output (verified live 2026-07-20). It rejects adaptive and
  //    effort, so it runs on a legacy budget_tokens ceiling instead, which is
  //    the token-precise knob effort never gave us.
  const HAIKU = { model: "claude-haiku-4-5", budget: 8_000, effort: "low" as const };
  cell("teams-15", teamsPack, { ...HAIKU, label: "haiku/budget8k" });
  cell("individuals-50", individualsPack, { ...HAIKU, label: "haiku/budget8k" });

  // --- Task 11: the OpenRouter shootout -----------------------------------
  // design/v4/06-openrouter-shootout.md is written from this section's
  // output.
  //
  // 2026-07-21 user decision: do NOT run `anthropic/claude-sonnet-5` via
  // OpenRouter, at all — the fidelity and no-think control arms that used to
  // live here (same model, different transport) are removed and must not be
  // re-run. Consequence, recorded here so it isn't silently lost: without a
  // same-model-both-transports control, a poor candidate number cannot be
  // cleanly attributed between the model and our OpenRouter adapter. The
  // adapter's standing evidence is instead the e2e suite (ai-architect.spec.ts,
  // 7/7 on both dialects against the fixture) and its unit tests, plus the two
  // real wire bugs already found and fixed against them — weaker than a live
  // same-model control. Every candidate number below should be read with that
  // caveat, not as a clean apples-to-apples result.
  const CONTROL_DIRECT: Arm = {
    model: "claude-sonnet-5",
    effort: "high",
    provider: "anthropic",
    label: "sonnet-5 direct",
  };
  // Candidates from design/v4/05-openrouter-candidates.md's policy-routable
  // named entrants. Quantisation per openrouter-policy.ts: z-ai/glm-5.2 and
  // moonshotai/kimi-k2.6 each have exactly one first-party endpoint
  // (z-ai/fp8, moonshotai/int4); x-ai/grok-4.5's is not independently pinned
  // to a single endpoint, only to the xai vendor slug — recorded per-row from
  // the live response's `provider` field either way (see `servedProvider`).
  //
  // task-11b brief (2026-07-21): run everything at the shipped 32,000-token
  // default — do NOT raise SCHEDULING_AI_MAX_TOKENS for any arm here. The
  // earlier exploratory grok-4.5 run (§10) doubled the ceiling to 64,000 to
  // isolate "can Grok produce a plan at all"; this run instead tests the
  // production contract as shipped. If a candidate exhausts 32k on reasoning
  // and returns no content, that IS the recorded result for that arm.
  const CANDIDATES: Arm[] = [
    { model: "x-ai/grok-4.5", effort: "high", provider: "openrouter", label: "grok-4.5" },
    { model: "z-ai/glm-5.2", effort: "high", provider: "openrouter", label: "glm-5.2" },
    { model: "moonshotai/kimi-k2.6", effort: "high", provider: "openrouter", label: "kimi-k2.6" },
  ];
  const stage1Arms: Arm[] = [CONTROL_DIRECT, ...CANDIDATES];

  // Stage 1 — screen. n=1 (set AI_AB_REPEATS=1), teams-15 (dense pack) only.
  // Enable with AI_AB_SHOOTOUT_STAGE1=1.
  if (process.env.AI_AB_SHOOTOUT_STAGE1 === "1") {
    for (const arm of stage1Arms) cell("teams-15", teamsPack, arm);
  }

  // Stage 2 — full. n=3 (set AI_AB_REPEATS=3), both packs, all four arms
  // (task-11b brief: control + 3 candidates, n=3, both packs, effort high,
  // 32k default). Enable with AI_AB_SHOOTOUT_STAGE2=1.
  const stage2Arms: Arm[] = [CONTROL_DIRECT, ...CANDIDATES];
  if (process.env.AI_AB_SHOOTOUT_STAGE2 === "1") {
    for (const arm of stage2Arms) {
      cell("teams-15", teamsPack, arm);
      cell("individuals-50", individualsPack, arm);
    }
  }

  // --- Task 12 prep: widened-allowlist candidates (2026-07-21) -----------
  // openrouter-policy.ts's ALLOWED_PROVIDERS widened to six vendors this
  // session (added google-vertex, openai). These two arms run under
  // IDENTICAL conditions to the stage1 screen above (teams-15 only, n=1,
  // effort high, 32k default, provider.only left at the widened allowlist —
  // not overridden per-arm) so the numbers are directly comparable to
  // CONTROL_DIRECT/CANDIDATES without re-running those already-recorded arms.
  const WIDENED_CANDIDATES: Arm[] = [
    { model: "google/gemini-3.5-flash-lite", effort: "high", provider: "openrouter", label: "gemini-3.5-flash-lite" },
    { model: "openai/gpt-5.6-luna-pro", effort: "high", provider: "openrouter", label: "gpt-5.6-luna-pro" },
  ];
  // Enable with AI_AB_SHOOTOUT_STAGE1B=1.
  if (process.env.AI_AB_SHOOTOUT_STAGE1B === "1") {
    for (const arm of WIDENED_CANDIDATES) cell("teams-15", teamsPack, arm);
  }

  // --- Seventh arm (2026-07-21): google/gemini-3.6-flash, full Flash (not
  // flash-lite, already run above) -----------------------------------------
  // Same conditions as WIDENED_CANDIDATES: teams-15 only, n=1, effort high,
  // 32k default, provider.only left at the six-vendor allowlist (google-vertex
  // already present, no policy change needed). Own flag so re-running this
  // file doesn't re-bill the two arms above. Enable with AI_AB_SHOOTOUT_STAGE1C=1.
  const FLASH_CANDIDATE: Arm = {
    model: "google/gemini-3.6-flash",
    effort: "high",
    provider: "openrouter",
    label: "gemini-3.6-flash",
  };
  if (process.env.AI_AB_SHOOTOUT_STAGE1C === "1") {
    cell("teams-15", teamsPack, FLASH_CANDIDATE);
  }

  it("summary", () => {
    const roundMs = Number(process.env.SCHEDULING_AI_ROUND_TIMEOUT_MS) || 300_000;
    process.stdout.write(
      `\n===== effort A/B — model=${schedulingAiModel()} roundTimeout=${roundMs / 1000}s repeats=${REPEATS} =====\n`,
    );
    for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);

    // Per-cell aggregates. Spread (max/min) is the number that says whether the
    // between-effort gap is bigger than the within-effort noise.
    const keys = [...new Set(rows.map((r) => `${r.pack}|${r.effort}`))];
    process.stdout.write(`\n--- per cell (n=${REPEATS}) ---\n`);
    for (const k of keys) {
      const [pack, effort] = k.split("|");
      const c = rows.filter((r) => `${r.pack}|${r.effort}` === k);
      const secs = agg(c, (r) => r.secs);
      const out = agg(c, (r) => r.out);
      // realUsd (provider-reported) is authoritative for every arm — see the
      // Row type comment. introUsd assumes an Anthropic rate table and is
      // wrong for non-Anthropic candidates, so it's only a fallback here for
      // the rare case a round produced no reported cost at all.
      const cost = agg(c, (r) => r.realUsd ?? r.introUsd);
      const spread = out.min > 0 ? round2(out.max / out.min) : 0;
      const clean = c.filter((r) => r.blocking === 0 && r.warnings === 0 && r.unschedulable === 0).length;
      const served = [...new Set(c.map((r) => r.servedProvider))].join(", ");
      process.stdout.write(
        `${pack} @ ${effort}: secs mean=${secs.mean} [${secs.min}-${secs.max}] | ` +
          `out mean=${out.mean} [${out.min}-${out.max}] spread=${spread}x | ` +
          `$ mean=${cost.mean} [${cost.min}-${cost.max}] | clean ${clean}/${c.length} | served=${served}\n`,
      );
    }

    const total = rows.reduce((s, r) => s + (r.realUsd ?? r.introUsd), 0);
    process.stdout.write(`\ntotal spend this bench (real, provider-reported): $${Math.round(total * 10000) / 10000}\n`);
    let expectedCells = process.env.AI_AB_BASELINE === "1" ? 8 : 4;
    if (process.env.AI_AB_SHOOTOUT_STAGE1 === "1") expectedCells += stage1Arms.length;
    if (process.env.AI_AB_SHOOTOUT_STAGE2 === "1") expectedCells += stage2Arms.length * 2;
    if (process.env.AI_AB_SHOOTOUT_STAGE1B === "1") expectedCells += WIDENED_CANDIDATES.length;
    if (process.env.AI_AB_SHOOTOUT_STAGE1C === "1") expectedCells += 1;
    const expected = expectedCells * REPEATS;
    expect(rows.length).toBe(expected);
    expect(rows.every((r) => r.error === "")).toBe(true);
  });
});
