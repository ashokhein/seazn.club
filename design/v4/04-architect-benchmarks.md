# 04 — Architect benchmarks: what the defaults are, and why

> **Status (2026-07-20):** first live measurements. `SCHEDULING_AI_EFFORT` default moved
> `high` → `medium`; `ROUND_TIMEOUT_MS` 300s → 600s. Repeats run partially complete —
> **the cost delta is not yet quotable** (see §5). Phase B (officials) unmeasured.

The v4 README says *"Token spend is acceptable: a couple of runs per division, quality over
cost."* That was the right call with no data. This document is the data, and it changes the
picture in one specific way: the spend is **not** where anyone assumed.

---

## 1. How to reproduce

```bash
AI_AB_LIVE=1 AI_AB_REPEATS=3 SCHEDULING_AI_ROUND_TIMEOUT_MS=900000 \
  node --env-file=.env.local ../../node_modules/vitest/vitest.mjs run \
  src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts
```

Harness: `apps/web/src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts`.
Skipped unless `AI_AB_LIVE=1`, so CI never spends. `runAiPlan(pack, movableIds)` is pure
over its pack, so the bench needs no database — packs are built in-file with deterministic
ids, and both arms of a comparison see a byte-identical pack.

Two packs, chosen to differ in **constraint density**, not just size:

| pack | movable | shape | what makes it bite |
|---|---|---|---|
| `teams-15` | 30 | 15 teams, 3 pools × 5, round-robin, 3 courts | 60m rest, no back-to-back, court blackout 12:00–13:30 |
| `individuals-50` | 25 | 50 entrants, R1 knockout, 4 courts | 10 players dual-entered → hard cross-person clash |

---

## 2. The token anatomy — the finding everything else follows from

Measured with `count_tokens` (free) against a realistic 30-fixture plan:

```
structured plan output    2,588 tokens
measured total output    27,349 tokens

plan       2,588  =  9.5%
thinking  24,761  = 90.5%
```

**Roughly 90% of a run's cost is the model thinking, not the plan it emits.** Cost is
~96% output tokens overall (input is <4%), so this is the whole picture.

Consequences, in order of how much they change what we should do:

- **Prompt caching is not the lever.** Input is under 4% of spend. `schedule-ai.ts` already
  sets `cache_control` on the system prompt, and that prompt is ~1,200 tokens — under the
  2,048-token minimum cacheable prefix, so it is likely a silent no-op. Worth fixing only
  for multi-round runs; worth nothing for the common single-round case.
- **Schema changes are capped at 9.5%**, no matter how aggressive:

  | candidate | saving | % of output |
  |---|---|---|
  | Short ordinal ids (`f0`) instead of UUIDs | 570 | 2.1% |
  | Diff-from-draft contract (`{keep_draft, changes[]}`) | 2,052 | 7.5% |

  Dropping effort `high` → `medium` beat both combined. Short ids are still worth doing —
  UUIDs cost ~15 tokens each and appear in `assignments`, `unschedulable`, `explanations`,
  the pack, *and* every repair round — but as housekeeping, not as the cost fix.
- **`thinking_tokens` is directly reportable.** `usage.output_tokens_details.thinking_tokens`
  exists on the non-beta response type. The 90.5% above was derived by subtraction; the
  bench should record the reported figure instead. **Not yet wired up.**

---

## 3. The 2×2 (single sample per cell, 2026-07-20)

Every arm returned an engine-verified CLEAN plan in **one round** — zero blocking, zero
warnings, zero unschedulable, every fixture placed.

| pack | effort | secs | out tokens | $ (intro) |
|---|---|---|---|---|
| teams-15 | high | 1094.9 | 27,349 | $0.2848 |
| teams-15 | medium | 213.2 | 22,463 | $0.2357 |
| individuals-50 | high | 159.4 | 16,923 | $0.1827 |
| individuals-50 | medium | 84.3 | 9,880 | $0.1122 |

**Constraint density drives spend, not fixture count.** `teams-15` has five *more* fixtures
than `individuals-50` but 2.3× the output tokens at medium. Any future adaptive-effort
heuristic should key on density (rest rules, blackouts, cross-person links, round-robin
structure), never on `movableIds.size`.

---

## 4. Repeats — why the single sample was misleading

`AI_AB_REPEATS=3`, partial at time of writing:

| pack / effort | out tokens per run | spread | secs per run |
|---|---|---|---|
| teams-15 @ high | 29,529 / 29,275 / 30,769 | **1.05×** | 268.5 / 279.1 / 282.9 |
| teams-15 @ medium | 14,566 / 23,699 / … | **1.63×** so far | 291.4 / 748.5 / … |

Two results that invert the original read:

1. **The 1094.9s `high` run was an outlier.** Three fresh repeats land at 268–283s. The
   claim "effort:high cannot schedule a 15-team division" was wrong — it usually can,
   comfortably. What is true is that a run *sometimes* takes 1095s, which is what the
   timeout change addresses.
2. **`medium` is the noisy one.** It is cheaper on average but spans 1.63× on tokens and
   2.6× on latency, and one `medium` sample (748.5s) was slower than every `high` sample.
   Latency does not track token count — a run producing half the tokens took twice as long.
   Whatever drives wall-clock here, it is not how much the model thinks.

---

## 5. What the evidence supports, and what it does not

**Supported:**

- *Quality is not the variable.* Every arm, every repeat, produced an engine-clean plan in
  one round. The deterministic referee re-checks each proposal, so a thinner plan surfaces
  as repair rounds, never as a bad schedule shipped to an organiser.
- *300s was too tight.* A 1095s round demonstrably exists. At the old ceiling it 422'd
  having burned a full generation that could be neither billed nor shown.
- *`medium` uses meaningfully fewer output tokens.* Every paired observation points the
  same way.

**Not supported — do not quote these:**

- **A specific cost percentage.** The 17–39% figure from the single-sample 2×2 sits inside
  the within-cell spread now being measured. Sizing it needs the repeats to finish.
- **"`medium` is 5.1× faster."** That compared one outlier `high` run against one fast
  `medium` run. On repeats, `medium` is *not* reliably faster and was sometimes slower.
  This was stated in an earlier commit message and is corrected here.
- **Anything at all about Phase B.** `officials-ai.ts` has never been benched.

---

## 6. Why each default is what it is

| default | value | basis |
|---|---|---|
| `SCHEDULING_AI_EFFORT` | `medium` | Fewer output tokens on every paired observation, with no quality cost across 4 cells. **Weaker than first claimed** — the latency argument did not survive repeats. One env var to revert. |
| `SCHEDULING_AI_ROUND_TIMEOUT_MS` | 600s | A 1095s round exists. Raising it does not increase generation (the abort is client-side; it only decides whether we *receive* the round) but does make repair rounds 2–3 reachable, and each round re-sends the prior output as input. |
| `OFFICIALS_AI_EFFORT` | `high` | Deliberately unchanged. Phase B is a different problem shape (role eligibility, per-day caps, blackouts, cross-org busy windows) and inheriting a schedule-pack conclusion would be unjustified. |
| `SCHEDULING_AI_THINKING` | `adaptive` | The 90.5% lever, untested. Disabling it is only *safe to attempt* because the referee catches thin plans; whether it *wins* is open — fewer thinking tokens per round against possibly more rounds. Bench arms exist at `effort:low` + `thinking:disabled`. |
| model | `claude-sonnet-5` | Unchanged from the 2026-07-19 measurement. |

---

## 7. Open questions

1. **Finish the repeats.** Until then the cost delta is directional only.
2. **Run the no-thinking arms.** Highest-upside untested option by an order of magnitude.
3. **Task budgets.** Verified working on `claude-sonnet-5` **only with**
   `betas: ["task-budgets-2026-03-13"]` — without the header the API rejects it with
   `400 output_config.task_budget: Extra inputs are not permitted`, which reads as "not
   supported". Costs ~23 input tokens (the countdown marker the model reads). A hard token
   ceiling may buy *predictability*, which §4 shows is the real weakness of `medium`.
4. **Record `thinking_tokens`** instead of inferring it.
5. **Bench Phase B.** `runOfficialsAiPlan(pack)` is pure over its pack, and the knob now
   exists — the Phase A harness is the template.
6. **Fix or remove the system-prompt `cache_control`.** Likely a silent no-op today.

---

## 8. Cost accounting note

`ai-pricing.ts` prices sonnet-5 at its **introductory** $2/$10 per MTok through 2026-08-31,
falling back to $3/$15 automatically. Costs stamped before 2026-07-20 used the list rate
and overstate spend by ~33%. Dollar figures in this document are intro-rate.

A timed-out run books **$0.00**: the SDK reports no usage on a client abort, so the tokens
burned before the deadline are unmeasurable. Timeout failures are therefore
systematically undercounted in the ledger — a reason to prefer a generous timeout over a
tight one, independent of UX.
