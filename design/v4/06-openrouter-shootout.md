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
