# 04 — Architect benchmarks: what the defaults are, and why

> **Status (2026-07-20, final):** 28 live runs across 6 arms. `ROUND_TIMEOUT_MS` 300s → 600s
> (kept). `SCHEDULING_AI_EFFORT` briefly moved to `medium` and was **reverted to `high`** —
> the repeats concluded against the change they were run to justify (§4a). Phase B
> (officials) still unmeasured.

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

## 4a. Final aggregates (n=3) — and the reversal

| pack | effort | secs mean [min–max] | out mean | warnings | $ list |
|---|---|---|---|---|---|
| teams-15 | high | 276.8 [268.5–282.9] | 29,858 | 0 | $0.465 |
| teams-15 | medium | 616.1 [291.4–808.3] | 20,411 | 0 | $0.330 |
| individuals-50 | high | 97.6 [73.4–142.7] | 11,510 | 0 | $0.195 |
| individuals-50 | medium | 80.0 [55.8–98.0] | 9,460 | 0 | $0.165 |

**All 12 runs: zero blocking, zero warnings, zero repair rounds.** Quality is not a
variable between effort levels — which removes the argument the change was made on.

With quality equal, only latency and money remain. On the dense pack `medium` is **2.2×
slower to save $0.135**; on the sparse pack the two overlap on both axes. Against a
lifetime quota of 20–50 runs per division, the saving is a few dollars ever, traded for
~5.6 extra minutes of an organiser watching a spinner. **Reverted to `high`.**

The n=1 pass had claimed the opposite — "medium is 5.1× faster" — from a single `high` run
of 1094.9s. With n=3, `high` never exceeded 282.9s on that pack. That outlier drove a
default change that shipped for a day. It is the clearest argument in this document for
n>1 before acting on a measurement.

**Effort escalation is not viable**, for the same reason the revert happened: `medium`
never produced a degraded plan, so the referee has nothing to escalate on. A gate would
never fire, making it equivalent to setting `medium` always. Cheap-*model* escalation is a
different case — §4b.

## 4b. Cheap models (n=3)

| pack | arm | rounds | blocking | warnings | $ list |
|---|---|---|---|---|---|
| teams-15 | haiku-4-5 + budget 8k | 0,0,0 | 0,0,0 | 43,100,20 | $0.050 |
| teams-15 | sonnet no-think | 2,0,2 | 8,0,2 | 56,57,59 | $0.205 |
| individuals-50 | haiku-4-5 + budget 8k | 0,0,0 | 0,0,0 | 0,0,0 | $0.043 |
| individuals-50 | sonnet no-think | 0,0,1 | 0,0,0 | 0,0,0 | $0.071 |

**Haiku matches sonnet exactly on the sparse pack** — 4.5× cheaper, no measurable
difference, no port (same SDK, same `zodOutputFormat`, same `parsed_output`). On the dense
pack it stays *legal* but ignores soft constraints: 20–100 warnings where sonnet scored 0.

**No-thinking sonnet fails on dense packs.** Two of three runs exhausted the repair loop
and still left blocking conflicts. Input ballooned 7–12× as each repair re-sent the prior
round's output, so the failures cost *more* than a clean `high` run.

Note the caveat this creates for §2: "input is <4% of spend" holds **only at `rounds=0`**.
On a repair-spiralling run input became 57% of cost.

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

- **A specific cost percentage — now settled (§4a).** medium is 32% cheaper on the dense
  pack and 18% on the sparse one. Not worth taking: the saving only exists where medium is
  also 2.2x slower.
- **"medium is 5.1x faster" — false.** It compared one outlier `high` run (1094.9s) against
  one fast `medium` run. At n=3 `medium` is the SLOWER arm on the dense pack, 616s vs 277s.
  This shipped as a default for a day before the repeats caught it.
- **Anything at all about Phase B.** `officials-ai.ts` has never been benched.
- **A density metric.** The two packs differ simultaneously in structure, court ratio,
  rest minutes, no-back-to-back, blackouts and cross-person links, so which factor
  degrades a cheap model is unknown. That is why model selection escalates on referee
  output rather than predicting from the pack, and why the escalation threshold is
  uncalibrated. Isolating it needs one-factor-off variants of `teams-15` (~$0.30).

---

## 6. Why each default is what it is

| default | value | basis |
|---|---|---|
| `SCHEDULING_AI_EFFORT` | `high` | Quality identical across all 12 runs, so only latency and money remain — and `medium` is 2.2x slower on dense packs to save $0.135 against a lifetime-capped quota. Briefly set to `medium` on an n=1 outlier; reverted (§4a). |
| `SCHEDULING_AI_ROUND_TIMEOUT_MS` | 600s | A 1095s round exists. Raising it does not increase generation (the abort is client-side; it only decides whether we *receive* the round) but does make repair rounds 2–3 reachable, and each round re-sends the prior output as input. |
| `OFFICIALS_AI_EFFORT` | `high` | Deliberately unchanged. Phase B is a different problem shape (role eligibility, per-day caps, blackouts, cross-org busy windows) and inheriting a schedule-pack conclusion would be unjustified. |
| `SCHEDULING_AI_THINKING` | `adaptive` | Tested and kept. Disabling it left blocking conflicts on 2 of 3 dense runs and cost MORE than a clean run, because repair rounds re-send the prior output as input (§4b). |
| model | `claude-sonnet-5` | Unchanged. `SCHEDULING_AI_CHEAP_MODEL` enables runtime escalation to haiku-4-5 — opt-in and OFF, because its warning-ratio threshold is uncalibrated (§7). |

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
