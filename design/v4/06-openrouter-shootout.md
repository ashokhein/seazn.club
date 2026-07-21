# 06 — OpenRouter shootout: blocked before any candidate ran

> **Status (2026-07-21):** Stage 1 could not complete. The fidelity control arm — the gate
> the brief requires passing before reading any candidate number — failed outright on the
> shipped `effort:high` / adaptive-thinking configuration, for a reason unrelated to model
> quality. Two real adapter bugs were found and fixed along the way (both now shipped, both
> regression-tested); a third, deeper problem was found and is **not** fixed here. No
> candidate (`x-ai/grok-4.5`, `z-ai/glm-5.2`, `moonshotai/kimi-k2.6`) was run. **No candidate
> beats sonnet-5, because no candidate was tested with valid data.**
>
> **Update (2026-07-21, later same day):** §10 below records a single follow-up
> exploratory arm (`x-ai/grok-4.5`, harness key-parser bug fixed, `maxTokens` raised to
> 64,000 for this arm only). It is not a resumption of the blocked stage-1 shootout above —
> the fidelity control arm it depended on was deliberately dropped per a user instruction
> (no `anthropic/claude-sonnet-5` via OpenRouter, at all) rather than fixed. Read §10's
> caveats before treating any number in it as comparable to this document's earlier
> sections.
>
> **Update (2026-07-21/22, Task 12):** `openrouter-policy.ts`'s `ALLOWED_PROVIDERS` is now
> narrowed to exactly `["xai", "google-vertex"]` — only `x-ai/grok-4.5` and
> `google/gemini-3.6-flash` are pursued from here. §12 records a 2×2×3 matrix (2 models × 2
> repeats × 3 packs, including a new `bracket-16` pack built to actually exercise the
> ordering rule H6 and the shared-person rule H4) at the shipped 32,000-token default. §13
> records a follow-up 40k exploratory rerun on the one pack that failed, per a mid-session
> user request — it does **not** change the shipped default and is not part of the delivered
> matrix.

---

## 1. What this document is not

It is not a comparison of grok-4.5, glm-5.2, and kimi-k2.6 against sonnet-5. The brief is
explicit that the fidelity arm gates everything: *"Check the fidelity arm before reading any
candidate number. If it diverges materially… stop: the adapter is wrong and every candidate
result is contaminated."* The fidelity arm did not diverge — it failed to produce a plan at
all, twice, for a diagnosed and confirmed reason. Per that instruction, the shootout stops
here rather than testing three more models under the same broken configuration and reporting
numbers that would look like a real comparison but would not be one.

## 2. Two real adapter bugs found and fixed

Both live in `apps/web/src/server/ai/openrouter-request.ts`, both are now fixed and
regression-tested (`apps/web/src/server/ai/__tests__/openrouter-request.test.ts`), and both
affected **every** OpenRouter call this branch ever made — not just candidates.

### 2a. Strict json_schema rejects numeric/array bound keywords

`buildOpenRouterBody` sent `z.toJSONSchema(req.schema.zod)` verbatim as the strict
`response_format.json_schema.schema`. `AiSchedulePlan` (schedule-ai-prompt.ts) and
`SchedulingConstraints` (packages/engine/src/scheduling/constraints.ts, reached via
`AiConstraintDelta`) both bound arrays and integers with zod's `.max()` / `.nonnegative()`,
which `z.toJSONSchema` turns into `maxItems`, `minItems`, `maximum`, `minimum`, and — for the
`z.record()`-shaped `restByGroup` — `propertyNames`. OpenRouter's strict validator (at least
on the Anthropic-served route) rejects every one of these, one at a time, each its own live
400:

```
For 'array' type, property 'maxItems' is not supported          (request_id req_011CdFj2ythzm8q8drnCah8F)
For 'integer' type, properties maximum, minimum are not supported (request_id req_011CdFjaCFxkqpqrJEH8BysU)
For 'object' type, property 'propertyNames' is not supported      (request_id req_011CdFjiYZKZ5oumqKtT66w6)
```

Fix: strip the whole bound-keyword family recursively from the wire schema before sending.
`AiSchedulePlan.safeParse()` in schedule-ai.ts still enforces every bound on the response, so
this only drops a wire-level hint the vendor can't accept — not the enforcement.

### 2b. Repair-round assistant-turn replay nested the message instead of using it

`openrouter-provider.ts`'s `assistantTurn.content` is deliberately the **whole raw message
object** (`{role, content, reasoning_details, …}`), so a repair round can replay it verbatim —
this is correct and its own unit test ("keeps the assistant message whole") protects it.
`openrouter-request.ts` then spread `req.messages` directly into the wire `messages` array,
which nested that whole object inside *another* message's `content` field:
`{role:"assistant", content:{role,content,reasoning_details}}`. OpenRouter rejects `content`
that isn't a string or content-part array. Verified live: a real repair round, ~340s of
generation on `anthropic/claude-sonnet-5`, then `messages.2.content: Invalid input` (HTTP
400) the moment the corrective retry replayed the prior turn.

Fix: when an assistant turn's content is that raw message shape, use it directly as the wire
message instead of re-wrapping it.

Both fixes are necessary but not sufficient — see §3.

## 3. The blocking finding: a shared 32,000-token ceiling, transport-dependent reasoning accounting

`schedule-ai.ts`'s `callModel()` sends `maxTokens: 32_000` identically to both transports.
The 2026-07-20 Anthropic-direct baseline (04-architect-benchmarks.md §4a) used **29,858**
output tokens on average for teams-15 at `effort:high` — a margin of under 2,150 tokens
against that same ceiling, already tight.

With both bugs in §2 fixed, the fidelity arm (`anthropic/claude-sonnet-5` via OpenRouter,
`effort:high`, adaptive thinking, teams-15) was run clean. It failed on **both** the initial
round and the corrective retry:

```
finish_reason: "length"        native_finish_reason: "max_tokens"
message.content: null          message.reasoning: "I'm working through the scheduling
                                 constraints: with 30 fixtures to place across 3 courts…"
                                 (reasoning text present and coherent, just never reaches
                                 the JSON answer before the token ceiling hits)
```

627.8s wall clock, `in=49,969`, `out=64,000` (exactly 2 × 32,000 — both attempts maxed the
ceiling on reasoning alone), real cost **$0.735518**, 0 usable output. On this transport, for
this model, at this effort level, on this pack, reasoning consumed the entire completion
budget before content generation started — twice in a row.

This is not the same class of bug as §2. It's not that the wire request was malformed; the
request was accepted and the model reasoned productively (the truncated `reasoning` text
reads like a real, on-track scheduling analysis). The problem is that the **same** hardcoded
ceiling that already had a slim margin on the native transport has no margin at all once
routed through OpenRouter, whose reasoning-token accounting for this model/effort/workload
combination evidently runs longer than Anthropic's own native transport did for the recorded
baseline. Whether that's OpenRouter's accounting, sampling variance in adaptive thinking
(04 §4 already documented 1.6–2.6× run-to-run spread), or some interaction between the two,
is not established by one clean data point — and establishing it would require its own
measurement, the same way `SCHEDULING_AI_EFFORT` and `ROUND_TIMEOUT_MS` each got their own
dedicated bench in 04 rather than a judgment call inside an unrelated task.

**This is deliberately not fixed here.** Raising `maxTokens` is a cost/latency policy
decision affecting every production run on both transports, not a wire-correctness fix like
§2 — exactly the kind of change 04's own history warns against making on a single sample
(“medium is 5.1× faster” shipped as a default for a day on an n=1 outlier, reverted at n=3).
It needs its own scoped measurement and its own review, not a fix made mid-shootout to make
the shootout's own gate pass.

## 4. A second, independent blocker: the Anthropic-direct control arm could not run

`ANTHROPIC_API_KEY` in this worktree's `.env.local` (both the root copy and the
`apps/web/` copy — identical corruption, identical byte offset) contains a literal U+2192
("→") character embedded in the key value. Verified two ways without printing the key:

```
python3: non-ascii at index 165, codepoint 8594 ("→"), line length 186
node:    TypeError: Cannot convert argument to a ByteString because the character at
         index 146 has a value of 8594 which is greater than 255
           at webidl.converters.ByteString … at Anthropic.apiKeyAuth
```

The Anthropic SDK throws building the auth header, before any network call — every direct
arm (including the pre-existing, previously-working `low/no-think` and `haiku/budget8k`
cells, untouched by this task) failed instantly with zero tokens the moment `AI_AB_LIVE=1`
was set. No key repair was attempted: guessing at a corrupted secret risks silently using the
wrong credential, and the instructions are explicit that this key is never to be printed —
diagnosing the corruption without ever displaying the value was the limit of what could be
done safely. `OPENROUTER_API_KEY` is a separate, valid key and was unaffected (confirmed via
an independent live probe, $0.000035, before this bug was known).

**Consequence:** the `sonnet-5 direct` control arm — the *first* gate, listed before the
fidelity arm in the brief — could not be freshly run this session at all. The existing
recorded number (04 §4a: 276.8s mean, 29,858 out mean, 0 blocking, 0 warnings, $0.465, n=3,
2026-07-20) is the only reference point, and it predates Task 1's `SYSTEM_PROMPT` edit
(H1–H7 labels, the `assumptions` field) — so it is context, not a live-reproduced baseline.

## 5. Results table

Only three arms produced real data. `sonnet-5 direct` is historical (§4); `grok-4.5`,
`glm-5.2`, `kimi-k2.6` were never run (§0/§3).

| pack | arm | transport | secs | in | out | rounds | blocking | warnings | $ (real, reported) | endpoint / quantisation |
|---|---|---|---|---|---|---|---|---|---|---|
| teams-15 | sonnet-5 direct | anthropic (native) | *(historical, 2026-07-20, pre-Task-1 prompt)* 276.8 mean [268.5–282.9] | — | 29,858 mean | 0 | 0 | 0 | $0.465 | n/a — native Anthropic API |
| teams-15 | sonnet-5 via openrouter, adaptive (**fidelity control**) | openrouter | 627.8 | 49,969 | 64,000 (2×32,000, both rounds truncated) | n/a (never returned a plan) | — | — | $0.735518 | **Anthropic**, native/full precision — confirmed via response `provider` field |
| teams-15 | sonnet-5 via openrouter, no-think (`enabled:false`) | openrouter | 30.6 | 8,934 | 2,473 | 0 | 0 | 56 | $0.044298 | **Anthropic**, native/full precision — confirmed via response `provider` field |
| teams-15 | grok-4.5 | openrouter | — not run — | | | | | | | expected: **xAI** (allowlist forces `xai` slug; single-endpoint status unverified) |
| teams-15 | glm-5.2 | openrouter | — not run — | | | | | | | expected: **z-ai/fp8** (sole first-party endpoint per openrouter-policy.ts) |
| teams-15 | kimi-k2.6 | openrouter | — not run — | | | | | | | expected: **moonshotai/int4** (sole first-party endpoint per openrouter-policy.ts) |

Endpoint/quantisation values for the two arms that did run are taken from the live response's
top-level `provider` field (captured via an isolated, standalone probe call —
`probeServedProvider()` in the harness — never by intercepting the real call's transport, see
§6 gotcha). Anthropic's allowlist entry (`only: ["anthropic", …]`) has exactly one first-party
vendor, so "Anthropic" here means the same native model, not a quantised third-party copy.

## 6. Spend

| item | $ | how known |
|---|---|---|
| Initial policy/served-provider sanity probe (haiku-4.5, 15 tokens) | $0.000035 | logged, exact |
| Fidelity arm, no-think control (successful) | $0.044298 | logged, exact (provider-reported) |
| Fidelity arm, adaptive, final confirmed run (both bugs fixed) | $0.735518 | logged, exact (provider-reported) |
| Fidelity arm, adaptive, 1st attempt (pre both fixes — instant schema 400s, essentially free) | ~$0.00 | inferred: rejected before generation on both live attempts |
| Fidelity arm, adaptive, 2nd attempt (schema fixed, message-replay bug still live — round 1 completed, round 2 rejected instantly) | **not logged** — estimated $0.30–0.45 | round 1 almost certainly hit the same max_tokens truncation as §3's confirmed run; harness didn't read `HttpError.extra.usage` on this failure path at the time (fixed after, see §7 finding 3) |
| Tiny 2-fixture sanity probe (effort:low, no-think, confirms wire+parse path independent of pack size) | $0.004356 | logged, exact |
| Misc `probeServedProvider()` calls (~8 tokens each, 4 total across reruns) | ~$0.0002 | negligible |
| **Total (confirmed + conservative estimate)** | **≈ $1.10–$1.25** | well under the $15 caution threshold and the $25 cap |

No candidate model was ever called, so none of the $25 cap was spent on grok-4.5, glm-5.2, or
kimi-k2.6.

## 7. The two open questions

**1. Does `{effort, enabled:false}` actually suppress reasoning spend while the effort intent
still travels?**

**Yes — confirmed, cleanly.** The no-think control arm (same model, same pack, same
transport, only `thinking:"disabled"` differs) completed in one round: `out=2,473` tokens,
almost exactly matching 04 §2's independently-measured "structured plan output only" figure
of 2,588 tokens for a comparable pack. `blocking=0`, `placed=30/30` — a complete, engine-clean
plan. Compare against the adaptive arm's `out=64,000`, all of it reasoning, zero plan content.
The wire-valid `{effort, enabled:false}` semantics hold: effort intent is sent (per
openrouter-request.ts's comment, unconditionally alongside `enabled:false`) and reasoning
spend is genuinely suppressed, not just capped. `warnings=56` on the no-think arm — consistent
with 04 §4b's Anthropic-direct no-think arm, which scored 56/57/59 warnings on the same pack.
That similarity is itself a small piece of fidelity evidence: the two transports agree on the
no-think configuration even though they disagree badly on the adaptive one.

**2. Do any of the three non-Claude providers signal a refusal, and if so how?**

**Not answered — blocked, not "no".** No candidate was ever called (§0), so this cannot be
reported as "no refusals observed" — that would imply an attempt was made and none occurred.
It was never attempted. The refusal shape for Anthropic-via-OpenRouter remains as Task 8
verified it (`finish_reason:"content_filter"`, `native_finish_reason:"refusal"`,
`message.refusal` populated, `message.content:null`); xai/z-ai/moonshotai remain unverified.

## 8. Failure classification (H1–H7)

Not applicable to the one plan-shaped failure in this document: the adaptive fidelity arm
never reached the structured-output stage (`message.content: null`, `finish_reason:"length"`),
so there is no `unschedulable` array, no engine-verified conflict, and nothing to classify
against a hard rule. The rule ids exist for content the referee actually inspects; a
truncated, contentless response never reaches the referee.

## 9. How to apply

**The default model should not change.** Not because sonnet-5 was proven better — because no
candidate was tested with valid data, and the control arm needed to validate the test
apparatus itself failed. Concluding anything about grok-4.5, glm-5.2, or kimi-k2.6 from this
session would be exactly the "confident wrong answer" the brief warns is worse than no answer.

Concretely:

- **Ship the two adapter fixes** (§2). They are correct, narrowly scoped, regression-tested,
  and make the OpenRouter transport correct for repair rounds and any bounded schema —
  independent of whether or when a shootout re-runs. Every OpenRouter call this branch has
  ever made was broken on at least one of these paths before today.
- **Do not raise `maxTokens` inside this task.** It's a real candidate fix for §3, but it's a
  cost/latency policy change affecting every production run, and this codebase's own history
  (04 §4, the medium/high reversal) is the direct argument for measuring that change on its
  own before shipping it.
- **Re-run this shootout once §3 has its own fix and measurement**, and once a valid
  `ANTHROPIC_API_KEY` restores the direct control arm (§4). The harness (`schedule-ai-effort-ab.live.test.ts`) is ready: `AI_AB_SHOOTOUT_STAGE1=1` runs the control arms plus all three
  candidates on teams-15 at n=1; `AI_AB_SHOOTOUT_STAGE2` is scaffolded for the n=3, both-pack
  follow-up once stage 1 has survivors.
- **Do not conclude the OpenRouter transport is unusable.** The no-think arm ran cleanly and
  matched the Anthropic-direct no-think arm's warning profile closely. The problem is specific
  to the adaptive-thinking + `effort:high` + dense-pack combination against the current fixed
  token ceiling, not the transport in general.

## 10. Follow-up (2026-07-21): one exploratory grok-4.5 arm — NOT the two-stage shootout

> This section is a single n=1 arm on one pack, run to answer a narrow question left open
> by §3. It is explicitly **not** a resumption of the stage-1 shootout, does not restore the
> fidelity control, and should not be read as validating or ranking `grok-4.5` against
> `sonnet-5` or the other two candidates. Treat every number below as a signal, not a result.

### 10a. Two changes made before this run, both by explicit user instruction

**Harness key-parser bug (unrelated to §4's key-corruption finding — a different bug in a
different place).** `loadEnvKeyIfAbsent()` in
`schedule-ai-effort-ab.live.test.ts` matched `^NAME=(.+)$` and stripped only the outer
quotes, so a quoted key with a trailing inline comment —
`ANTHROPIC_API_KEY="sk-ant-...AA"          # required to use the prose→constraints
endpoint` — parsed to a 167-character value containing the comment text and a literal
U+2192. The SDK rejected that value before any network call. The real key is 108 characters,
pure ASCII. Fixed to take up to the matching closing quote (quoted values) or up to the
first whitespace-then-`#` (unquoted values), discarding any trailing comment either way. A
regression test (`loaded ANTHROPIC_API_KEY has no trailing comment / non-ASCII bleed`)
asserts length 108 and `<= U+007E` on every value the parser loads, without ever printing
it.

**Dropped the sonnet-via-OpenRouter arms entirely.** Per direct user instruction: do not
run `anthropic/claude-sonnet-5` via OpenRouter again, at all, in any configuration. The
`sonnet-5 via openrouter` (fidelity) and `sonnet-5 via openrouter, no-think` arms are
removed from the harness (`schedule-ai-effort-ab.live.test.ts`), not merely skipped —
re-adding them would need new code, not a flag flip. **Consequence, stated plainly:**
without a same-model-both-transports control, a poor (or good) candidate number below
cannot be cleanly attributed between the model itself and this branch's OpenRouter adapter.
The adapter's standing evidence is now: the e2e suite (`ai-architect.spec.ts`, 7/7 passing
on both dialects against the fixture), its unit tests, and the two real wire bugs already
found and fixed against live traffic (§2a, §2b). That is real evidence, but it is weaker
than a live same-model control would have been — it does not rule out a transport-shaped
distortion that happens not to trip the fixture or the two bugs already caught.

**Output ceiling made configurable.** `schedule-ai.ts`'s `callModel()` hardcoded
`maxTokens: 32_000` identically for every model/transport. Per user instruction, this is
now `SCHEDULING_AI_MAX_TOKENS` (default `32_000` — the shipped Anthropic-direct path is
byte-for-byte unchanged unless the env var is set). The harness's `Arm` type gained a
matching `maxTokens` field, wired into `process.env.SCHEDULING_AI_MAX_TOKENS` per-arm. Only
`grok-4.5`'s stage-1 entry sets it, to `64_000`, specifically to give reasoning the room
sonnet-5 via OpenRouter didn't have in §3 — this is a one-arm exception, not a new default.

### 10b. The run

`x-ai/grok-4.5`, OpenRouter, `effort:high`, adaptive thinking, `maxTokens:64_000`, n=1,
`teams-15` (dense pack, 30 fixtures). `provider.only` was left untouched — the allowlist
already pins `grok-4.5` to the `xai` vendor slug.

| field | value |
|---|---|
| wall clock | 272.7s |
| repair rounds | 0 (round 1 succeeded outright) |
| input tokens | 6,868 |
| output tokens | 19,670 (of the 64,000 ceiling — **not** exhausted, unlike sonnet's 64,000/64,000) |
| real cost (provider-reported) | $0.1315384 |
| schema-valid plan returned | **yes** — parsed and validated on round 1 |
| blocking conflicts | 0 |
| warnings | 0 |
| unschedulable | 0 |
| fixtures placed | 30 / 30 |
| served by (response `provider` field) | **xAI** |

`finish_reason` / `native_finish_reason` for the real bench round are not directly
observable — `AiChatResponse` (the shared provider seam) exposes neither field (§0's own
design note explains why: exposing them would require changing a type shared by every
production call, not a bench-only concern). The isolated post-run probe
(`probeServedProvider()`, a separate ~8-token call, same model/policy) reported
`finish_reason:"stop"`, `native_finish_reason:"completed"`, `refusal:null`, `provider:"xAI"`
— consistent with, but not proof of, the real round's own finish reason. The strongest
evidence for the real round specifically: it returned a schema-valid, fully-parsed plan at
19,670 of a 64,000-token budget with zero repair rounds, which a length-truncated response
could not do (a truncated response fails `AiSchedulePlan.safeParse()` and either triggers a
repair round or throws — this run had `rounds:0` and no error).

### 10c. Reading it against the sonnet-5-direct baseline (04 §4a, teams-15, n=3, 2026-07-20)

| | sonnet-5 direct (baseline) | grok-4.5 via OpenRouter (this run, n=1) |
|---|---|---|
| secs | 276.8 mean [268.5–282.9] | 272.7 |
| output tokens | 29,858 mean | 19,670 |
| blocking / warnings | 0 / 0 | 0 / 0 |
| cost | ~$0.465 | $0.1315384 |

On this single sample, Grok returned a clean plan in comparable wall-clock time, using
~34% fewer output tokens and at roughly a third of the cost. **This is not a verdict.** It
is one run on one pack with no repeat and no fidelity control (§10a). The two things it does
answer directly, within its own scope:

- **The 32,000-token reasoning ceiling in §3 is not universal across every model on the
  OpenRouter transport.** Sonnet-5 exhausted 64,000 tokens (2×32,000) on reasoning alone and
  returned no content; Grok, given the same doubled ceiling, used less than a third of it and
  returned a complete, engine-clean plan. Whether that's a genuine model-level difference in
  reasoning-token efficiency, an artifact of OpenRouter's per-model accounting, or something
  about `effort:high` mapping differently across vendors, is not established by n=1 — it
  would need its own repeat-and-compare measurement (04's own house rule: n=1 orders, n=3
  sizes the gap).
- It does **not** answer whether Grok would also have completed inside the *original*
  32,000-token ceiling sonnet failed under — this run deliberately used 64,000, per
  instruction, to isolate "can Grok produce a plan at all here" from "does Grok fit the
  shipped default." That's a distinct, still-open question.

### 10d. Spend, this follow-up only

| item | $ |
|---|---|
| grok-4.5 stage-1 arm (teams-15, n=1, maxTokens=64,000) | $0.1315384 |
| **Total, this follow-up** | **$0.1315384** — well under the $3 stop-and-report threshold |

Combined with §6's earlier ≈$1.10–$1.25, total spend against the $25 cap across both
sessions is ≈$1.24–$1.38, leaving well over $20 of headroom.

## 11. Consolidated seven-arm table (2026-07-21, fourth update) — full Gemini Flash added

> This section is the first point in the document where seven candidates have a result, all
> under the **same** stated conditions (`teams-15` only, n=1, `effort:high`,
> `SCHEDULING_AI_MAX_TOKENS` left at the shipped 32,000 default, `provider.only` left at the
> allowlist — never narrowed per-arm). It is still **not** a resumption of the blocked
> stage-1 shootout (§1–§9): there is still no same-model-both-transports fidelity control
> (§10a — dropped by explicit user instruction, not restored here), every arm is n=1 on a
> single pack, Anthropic's `$` is list pricing while every OpenRouter `$` is provider-reported
> (§6/§10d note the same asymmetry), and `openrouter-policy.ts`'s `ALLOWED_PROVIDERS` spans six
> vendors (`google-vertex`, `openai` added earlier this session) — a customer-disclosure change
> (help pages must name all six) still pending at Task 12. No policy edit was needed for the
> new row below: `google-vertex` was already in the allowlist from the prior update.

Five rows are prior results, reproduced here verbatim from the run that produced them (not
re-run this session, per instruction); the `gemini-3.6-flash` row is new this session, run
under the same six-vendor allowlist with no policy edit needed.

| pack | arm | secs | out (tokens) | blocking | warnings | cost (real/reported) | serving provider | pass/fail |
|---|---|---|---|---|---|---|---|---|
| teams-15 | sonnet-5 direct | 684.6 | 15,346 | 0 | 0 | $0.2471 (list) | anthropic (direct) | **PASS** — 30/30 placed |
| teams-15 | grok-4.5 | 339.6 | 20,233 | 0 | 0 | $0.1319 (reported) | xAI | **PASS** — 30/30 placed |
| teams-15 | glm-5.2 | 505 | 47,761 | — | — | $0.2189 (reported) | z-ai | **FAIL** — `finish_reason:"length"`, no usable plan |
| teams-15 | kimi-k2.6 | 2,335 | 0 | — | — | $0 (in=0/out=0) | moonshotai | **FAIL (inconclusive)** — transport error, body read failed, not a model verdict |
| teams-15 | gemini-3.5-flash-lite | 72 | 29,815 (in=8,648) | 0 | 18 | $0.0771319 (reported) | Google | **PASS** — 30/30 placed, `finish_reason:"stop"`, `native_finish_reason:"STOP"`, `refusal:null` |
| teams-15 | gpt-5.6-luna-pro | 0.6 | 0 (in=0) | — | — | $0 (rejected pre-generation) | OpenAI *(from isolated probe only — the real call never reached a model)* | **FAIL** — HTTP 400 before generation: `"Invalid schema for response_format 'schedule_plan': ... 'required' is required to be supplied and to be an array including every key in properties"` |
| teams-15 | gemini-3.6-flash | 103.8 | 29,627 (in=8,648) | 0 | 0 | $0.2351745 (reported) | Google | **PASS** — 30/30 placed, blocking 0, warnings 0. Probe `finish_reason:"length"`/`native_finish_reason:"MAX_TOKENS"` — see note below, this is a probe artifact, not the real round's outcome |

Notes on the three widened-allowlist rows (`gemini-3.5-flash-lite`, `gpt-5.6-luna-pro` from
the prior update; `gemini-3.6-flash` new this session):

- **`gemini-3.5-flash-lite`** completed cleanly on round 1 (`rounds:0`), well inside the
  32,000-token ceiling (29,815 of 32,000 — a margin closer to sonnet-5-direct's than to
  grok-4.5's). 18 warnings is non-zero but `blocking:0`/`unscheduled:0`/`placed:30/30` — an
  engine-clean, deployable plan, just not a *quiet* one. Served by Google (response `provider`
  field), consistent with the `google-vertex` allowlist entry.
- **`gpt-5.6-luna-pro`** never reached the model. OpenRouter's strict `response_format`
  validator, fronting an OpenAI-served endpoint, rejected the wire schema with HTTP 400
  *before* generation: `'required' is required to be supplied and to be an array including
  every key in properties`. This is OpenAI's own strict-mode requirement that **every**
  property in a JSON-schema object be listed in `required` (nullable is how you express
  "optional" under that mode) — a schema-shape incompatibility, structurally the same kind of
  finding as §2's two wire bugs, not a token-budget or reasoning-depth result like glm-5.2's
  `finish_reason:"length"`. It was **not fixed** in this task (out of scope: JOB 2 was to run
  two arms under existing conditions, not extend the schema adapter for a newly-added vendor)
  — recorded as the arm's genuine result, the same way kimi-k2.6's transport failure was
  recorded rather than silently retried. `served=OpenAI` above is only known from the isolated
  `probeServedProvider()` sanity call (tiny separate request, same model/policy), since the
  real bench call itself never got a response body worth reading.
- **`gemini-3.6-flash`** (the full Flash model, not `gemini-3.5-flash-lite` above) completed
  cleanly on round 1 (`rounds:0`), 29,627 of the 32,000-token ceiling — a margin (373 tokens)
  tighter than sonnet-5-direct's and tighter than flash-lite's, the narrowest headroom of any
  passing arm so far. `blocking:0`, `warnings:0`, `unscheduled:0`, `placed:30/30` — engine-clean
  **and** quiet, unlike flash-lite's 18 warnings. Real cost $0.2351745, roughly 3× flash-lite's
  and close to sonnet-5-direct's. Served by Google (response `provider` field), consistent with
  `google-vertex`. The probe's `finish_reason:"length"` / `native_finish_reason:"MAX_TOKENS"` is
  a **probe artifact, not a result for the real round**: `probeServedProvider()` caps that
  isolated sanity call at `max_tokens:8`, and this model apparently spends part of even an
  8-token budget on reasoning before content — unlike every other arm's probe under the same
  8-token cap, which returned `finish_reason:"stop"`. The real bench round's own finish reason
  is not directly observable (§10b's design-note caveat still applies) — the strongest evidence
  it finished cleanly rather than truncated is the same inference used for grok-4.5: `rounds:0`
  plus a successfully parsed, schema-valid plan, which a length-truncated response cannot
  produce.

### How to apply

**The default model should not change**, and the widened allowlist should not be read as
"these vendors are now validated production candidates":

- Of seven arms, four are clean passes with a schema-valid, engine-clean plan
  (`sonnet-5 direct`, `grok-4.5`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`), one is
  inconclusive (`kimi-k2.6`, transport failure, not a quality signal), and two are genuine
  failures under the shipped 32,000-token default (`glm-5.2` exhausted the ceiling on
  reasoning; `gpt-5.6-luna-pro` never got past OpenRouter's schema validator for OpenAI's
  strict mode).
- **Both Gemini arms passed, but they trade off differently.** `gemini-3.5-flash-lite` is
  cheapest and fastest ($0.077, 72s) but leaves 18 warnings — the cheap-tier soft-constraint
  drift pattern this codebase already documented (04-architect-benchmarks.md §4: cheap tiers
  "stay legal but ignore soft constraints"). `gemini-3.6-flash` is the first arm in this table
  that is both **cheap-tier priced** ($0.235, ~well under sonnet-5-direct's $0.247 list) **and
  quiet** (0 warnings, matching sonnet-5-direct's and grok-4.5's clean profile) — but it also
  ran the tightest token margin of any passing arm (373 tokens of headroom on the 32,000
  ceiling), tighter than sonnet-5-direct's. A tighter margin on n=1 is not evidence of fragility
  by itself, but it is the one number in this row that would need repeat-and-compare (n=3)
  scrutiny before treating 0-warnings-at-373-tokens-headroom as a stable result rather than a
  lucky sample.
- **`gpt-5.6-luna-pro`'s failure is an adapter/schema gap, not evidence against the model.**
  Before drawing any conclusion about GPT-family quality through this allowlist, the strict
  `response_format` builder needs the same kind of `required`-completeness pass §2a already
  did for the numeric/array bound keywords — that is new adapter work, out of scope here.
- Every number in this table carries the same standing caveats as the rest of this document:
  n=1 on a single pack (`teams-15` only — no `individuals-50` data for any of the seven arms);
  no same-model-both-transports fidelity control, dropped by explicit user instruction (§10a);
  Anthropic's cost is list pricing while every OpenRouter cost is provider-reported, so the two
  `$` figures are not on the same rate basis; `kimi-k2.6`'s failure is transport (body read
  failed), not a quality verdict, and should never be quoted as "kimi failed the benchmark"
  without that qualifier; and the allowlist spans six vendors
  (`anthropic`, `xai`, `z-ai`, `moonshotai`, `google-vertex`, `openai`), which
  is a customer-facing promise change (help/scheduling/ai-scheduling.md,
  help/scheduling/ai-officials.md) still pending at Task 12 — do not treat the allowlist widen
  as complete until those pages are updated.

### Spend, this update only (gemini-3.6-flash arm)

| item | $ |
|---|---|
| `gemini-3.6-flash` (teams-15, n=1, 32k default) | $0.2351745 |
| **Total, this update** | **$0.2351745** — logged, exact (provider-reported), well under the $3 stop-and-report threshold |

Combined with §6's, §10d's, and the prior update's spend, total spend against the $25 cap
across all four sessions is ≈$1.56–$1.70, leaving over $23 of headroom against the original
cap (account balance was ≈$21.42 before this arm, per the prior update's confirmed delta).

Combined with §6's and §10d's earlier spend, total spend against the $25 cap across all three
sessions is ≈$1.32–$1.46, leaving over $20 of headroom.

## 12. Task 12 — narrowed allowlist, 2×2×3 matrix (2026-07-21/22)

> This is the first section in this document built from a real, controlled matrix rather
> than n=1 screening arms. Conditions: `x-ai/grok-4.5` and `google/gemini-3.6-flash`
> (`openrouter-policy.ts`'s `ALLOWED_PROVIDERS` narrowed to exactly these two vendor slugs —
> `anthropic`, `z-ai`, `moonshotai`, `openai` removed), `effort:high`, adaptive thinking,
> `SCHEDULING_AI_MAX_TOKENS` left at the shipped 32,000 default (not overridden), `n=2`
> repeats, three packs: the pre-existing `teams-15` (30 fixtures, round robin, no ordering
> rules) and `individuals-50` (25 fixtures, flat R1, person-overlap only), plus a new
> `bracket-16` pack (14 fixtures: 8 quarter-finals → 4 semi-finals → 2 finals, real
> `feeds.winner_to`/`feeds.after` chains so H6 — a fixture must not start before every
> fixture it depends on has finished — is actually under test; 4 shared people spanning
> both halves of the bracket so H4 bites; 2 courts and a 5.5h window with one blackout,
> tighter than `teams-15`'s 3 courts/12h; one pinned fixture). Built in
> `apps/web/src/server/usecases/__tests__/schedule-ai-effort-ab.live.test.ts`'s
> `bracketPack()`, run via `AI_AB_SHOOTOUT_STAGE3=1`.
>
> Standing caveats, restated because they still apply: n=2 is enough to see a spread but not
> to call a result stable (04's own house rule is n=3 for that); there is still no
> same-model-both-transports fidelity control (§10a — dropped by user instruction, not
> restored); Anthropic's `$` figures elsewhere in this document are list pricing while every
> row below is OpenRouter provider-reported cost, so they are not on the same rate basis;
> `bracket-16` is new this session and has no historical baseline, so its numbers compare
> `grok-4.5` against `gemini-3.6-flash` on this pack, not against any prior recorded run.

### 12a. Per-cell results

WARNINGS ARE REPORTED AT THE SAME PROMINENCE AS BLOCKING, per this document's own prior
finding (04-architect-benchmarks.md §4: cheap tiers "stay legal but ignore soft constraints
— 20-100 warnings where sonnet scored 0"; `gemini-3.5-flash-lite` reproduced that pattern
with 18 warnings at 0 blocking, §11). **0 blocking alone is never called a clean pass below**
— "clean" means 0 blocking **and** 0 warnings.

| pack | model | rep | secs | in | out | out % of 32k ceiling | blocking | warnings | unsched | placed | $ (reported) | served | clean? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| teams-15 | grok-4.5 | 1 | 371.0 | 6,868 | 21,255 | 66.4% | 0 | 0 | 0 | 30/30 | $0.1410484 | xAI | yes |
| teams-15 | grok-4.5 | 2 | 242.4 | 6,868 | 15,302 | 47.8% | 0 | 0 | 0 | 30/30 | $0.0940152 | xAI | yes |
| individuals-50 | grok-4.5 | 1 | 76.4 | 8,026 | 6,414 | 20.0% | 0 | 0 | 0 | 25/25 | $0.0543184 | xAI | yes |
| individuals-50 | grok-4.5 | 2 | 77.8 | 8,026 | 6,105 | 19.1% | 0 | 0 | 0 | 25/25 | $0.0391908 | xAI | yes |
| bracket-16 | grok-4.5 | 1 | 422.3 | 10,902 | 23,797 | 74.4% | — | — | — | — | $0.1606692 | xAI | **FAIL — `AI_PLAN_FAILED`** |
| bracket-16 | grok-4.5 | 2 | — | — | — | — | — | — | — | — | — | — | **not run** (see note) |
| teams-15 | gemini-3.6-flash | 1 | 125.9 | 8,648 | 31,555 | 98.6% | 0 | 0 | 0 | 30/30 | $0.2496345 | Google | yes |
| teams-15 | gemini-3.6-flash | 2 | 65.1 | 8,648 | 18,321 | 57.3% | 0 | 0 | 0 | 30/30 | $0.1422201 | Google | yes |
| individuals-50 | gemini-3.6-flash | 1 | 42.1 | 10,733 | 12,795 | 40.0% | 0 | 0 | 0 | 25/25 | $0.1120620 | Google | yes |
| individuals-50 | gemini-3.6-flash | 2 | 54.3 | 10,733 | 14,559 | 45.5% | 0 | 0 | 0 | 25/25 | $0.1252920 | Google | yes |
| bracket-16 | gemini-3.6-flash | 1 | 94.6 | 6,882 | 25,579 | 79.9% | 0 | 0 | 0 | 14/14 | $0.2021655 | Google | yes |
| bracket-16 | gemini-3.6-flash | 2 | 168.5 | 15,092 | 46,680 | 145.9% (see note) | 0 | 0 | 0 | 14/14 | $0.3727380 | Google | yes |

**`bracket-16 / grok-4.5` note:** the `it()` block loops `REPEATS` times and asserts each
result's error is empty before continuing; rep 1's `AI_PLAN_FAILED` threw inside that loop,
so rep 2 never ran — this cell is genuinely n=1, not n=2. Per the task brief ("if either
model hits a first-class failure on the harder bracket pack, report it, do not raise the
ceiling to rescue it"), this is reported as-is rather than silently retried at n=2. See §13
for the separate, explicitly-labeled 40k rescue attempt.

**`bracket-16 / gemini-3.6-flash` rep 2 note (145.9% of ceiling):** `usage.output_tokens` is
cumulative across every LLM call inside one `runAiPlan()`, not capped at a single call's
32,000-token ceiling. `rounds:0` on this row means zero *repair* rounds, but the harness
cannot distinguish that from an internal corrective retry after a truncated first attempt —
both are invisible to the `Row` type (§10b's design-note caveat: `AiChatResponse` exposes
neither `finish_reason` nor a per-call token breakdown). §13's 40k rerun is informative here:
at a 40,000-token ceiling, the same pack completed in ~23,000–24,000 tokens total — below
even this row's *single-call* cap — which is consistent with the 32k run's rep 2 having
needed two capped calls (one truncated, one corrective) rather than one call legitimately
exceeding 32,000.

**Probe `finish_reason` caveat, restated (§11):** every `gemini-3.6-flash` row's
`finishReason:"length"` comes from `probeServedProvider()`'s own isolated 8-token sanity
call, not the real bench round — this model spends part of even an 8-token budget on
reasoning before content, unlike every other model's probe under the same cap, which returns
`finish_reason:"stop"`. It is not evidence about the real round's finish reason one way or
the other. No row's *real* generation round is directly observable for `finish_reason` (same
structural limitation as §10b/§11); the strongest available evidence a round finished
cleanly rather than truncated is `rounds:0` plus a schema-valid, fully-parsed, engine-clean
plan — which every row above except the failed `bracket-16/grok-4.5` row produced.

### 12b. Mean per (model, pack)

| pack | model | secs mean | out mean | out % of 32k (mean) | $ mean | clean / n |
|---|---|---|---|---|---|---|
| teams-15 | grok-4.5 | 306.7 [242.4–371.0] | 18,278.5 [15,302–21,255] | 57.1% | $0.1175318 | 2/2 |
| individuals-50 | grok-4.5 | 77.1 [76.4–77.8] | 6,259.5 [6,105–6,414] | 19.6% | $0.0467546 | 2/2 |
| bracket-16 | grok-4.5 | 422.3 (n=1) | 23,797 (n=1) | 74.4% | $0.1606692 (n=1) | 0/1 |
| teams-15 | gemini-3.6-flash | 95.5 [65.1–125.9] | 24,938 [18,321–31,555] | 77.9% | $0.1959273 | 2/2 |
| individuals-50 | gemini-3.6-flash | 48.2 [42.1–54.3] | 13,677 [12,795–14,559] | 42.7% | $0.1186770 | 2/2 |
| bracket-16 | gemini-3.6-flash | 131.6 [94.6–168.5] | 36,129.5 [25,579–46,680] | 112.9% (inflated by rep 2's likely retry — see note) | $0.2874518 | 2/2 |

### 12c. Total spend, this matrix

| item | $ |
|---|---|
| 11 completed cells (grok-4.5 × 5, gemini-3.6-flash × 6) | $1.6933541 |
| Unconditional pre-existing baseline arms (`low/no-think`, `haiku/budget8k`, both packs, n=2 — always run when `AI_AB_LIVE=1`, not part of Task 12's scope) | $0.4449000 |
| **Total, this run** | **$2.1383** — logged, exact (matches the harness's own printed total) |

Well under the $6 stop-and-report threshold set for this task.

### 12d. How to apply

- **`gemini-3.6-flash` is not a clean win on this reading.** It is clean on
  blocking/warnings (0/0 every cell) but runs the tightest token margins of any arm in this
  document: `teams-15` rep 1 used 98.6% of the 32k ceiling, and `bracket-16` needed what
  looks like two capped calls in one repeat (145.9% cumulative). This is the "fragile near
  the ceiling" pattern the task brief called out in advance — `glm-5.2` (§11) failed outright
  by crossing an equivalent ceiling; this model didn't fail, but the margin is thin enough
  that the failure mode is visibly adjacent.
- **`grok-4.5` has more headroom but a real, unrescued failure on the hard pack.**
  `teams-15`/`individuals-50` both ran clean at 47.8–66.4% and 19.1–20.0% of ceiling
  respectively — comfortable margins. `bracket-16` — the pack built specifically to stress
  H6 ordering and H4 shared-person overlap under tight capacity — failed with
  `AI_PLAN_FAILED` at 74.4% of ceiling (not a length exhaustion). §13 shows raising the
  ceiling to 40k did not rescue this cell either; it changed the failure mode to a round
  timeout instead.
- **Neither model has a clean pass on `bracket-16` at n≥2.** `grok-4.5` failed its only
  attempt; `gemini-3.6-flash`'s two attempts both nominally "passed" (0 blocking, 0
  warnings, 14/14 placed) but rep 2's token usage is the least trustworthy number in this
  table (§12a's cumulative-usage note) — it is not established that this was a clean single
  call rather than a truncate-then-retry that happened to still produce a valid plan.
- **The default model should not change on this evidence.** Both candidates are cheaper than
  `sonnet-5 direct` (§11: $0.2471–$0.465 list) on the two easier packs, but the one pack
  designed to be genuinely hard broke one candidate outright and left the other's margin
  unverified. n=2 on two clean packs is not sufficient grounds to replace the shipped
  default; it is grounds to keep watching `bracket-16`-shaped workloads specifically before
  concluding either candidate is production-ready for hard, dependency-chained schedules.

## 13. Bonus: 40k rescue-test on `bracket-16` (2026-07-22, mid-session user request)

> Requested live, mid-run, after §12's `bracket-16/grok-4.5` failure and `bracket-16/gemini`'s
> tight/over-cap numbers were reported: "can you raise the token limit to 40k?" This section
> is a **separate, explicitly-scoped exploratory rerun**, not a change to §12's delivered
> matrix and not a change to `schedule-ai.ts`'s shipped `SCHEDULING_AI_MAX_TOKENS` default
> (still 32,000 in production). Scope: `bracket-16` only, both models, `maxTokens:40_000` set
> per-arm via the harness's existing `Arm.maxTokens` field, n=2, run via
> `AI_AB_SHOOTOUT_STAGE4=1`.

| pack | model | rep | secs | in | out | out % of 40k ceiling | blocking | warnings | placed | $ | served | result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bracket-16 | grok-4.5/40k | 1 | 600.0 | 0 | 0 | — | — | — | — | $0 | xAI | **FAIL — `AI_PLAN_TIMEOUT`** (600s round timeout, not a token-ceiling failure) |
| bracket-16 | grok-4.5/40k | 2 | — | — | — | — | — | — | — | — | — | **not run** (loop aborted after rep 1) |
| bracket-16 | gemini-3.6-flash/40k | 1 | 84.9 | 6,882 | 23,892 | 59.7% | 0 | 0 | 14/14 | $0.189513 | Google | yes |
| bracket-16 | gemini-3.6-flash/40k | 2 | 81.5 | 6,882 | 22,485 | 56.2% | 0 | 0 | 14/14 | $0.1789605 | Google | yes |

**Reading it:** raising the ceiling did not rescue `grok-4.5` — it changed the failure mode
from `AI_PLAN_FAILED` (§12, 74.4% of a 32k ceiling) to `AI_PLAN_TIMEOUT` (600s wall clock),
a different problem the extra token budget didn't fix. `gemini-3.6-flash` did benefit: both
40k reps completed in 22,485–23,892 tokens total — *below* the 32k run's single-call cap,
and well below its own rep 2's 46,680-token cumulative total at 32k (§12a's note) — consistent
with the 32k run having forced a truncate-then-retry that the 40k run didn't need. This is a
narrow, single-pack, n≤2 signal; it does not establish that 40k should become the shipped
default, and per the task brief's original instruction, no such change was made here.

Spend, this rescue test: $0 (timeout) + $0.189513 + $0.1789605 = **$0.3684735**.

Combined total spend across §12 and §13: $2.1383 + $0.3684735 ≈ **$2.5068**, still well under
the $6 stop-and-report threshold and a small fraction of the ≈$21.19 remaining against the
$25 cap noted at the start of this task.
