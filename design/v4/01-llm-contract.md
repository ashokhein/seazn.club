# v4/01 — LLM contract (model, context pack, schema, system prompt)

Normative for PROMPT-41/42. The strings and schemas below ship verbatim (module
`apps/web/src/server/usecases/schedule-ai-prompt.ts`); edits require updating the golden
tests in §6.

## §1 Model + call parameters

```ts
const client = new Anthropic();                       // reads ANTHROPIC_API_KEY
const model = process.env.SCHEDULING_AI_MODEL ?? "claude-opus-4-8";
const response = await client.messages.parse({
  model,
  max_tokens: 32_000,
  thinking: { type: "adaptive" },                     // let it plan; depth via effort
  output_config: { effort: "high", format: zodOutputFormat(AiSchedulePlan) },
  system: SYSTEM_PROMPT,                              // §4, cached: cache_control ephemeral
  messages,                                           // §5 protocol
});
```

- `system` carries a `cache_control: {type: "ephemeral"}` breakpoint — repair/refine rounds
  in the same run reuse the prefix.
- `!response.parsed_output` → one retry with a corrective user turn, then 422.
- `response.stop_reason === "refusal"` → 422 `AI_PLAN_FAILED` (never read content first).
- Timeout: SDK default; abort controller at 120s per round, surfaced as 422 with retry hint.

## §2 Context pack (the single user-turn JSON)

Deterministic (sorted keys, fixtures ordered by `round_no, seq_in_round, ext_key`), built by
`buildSchedulePack`. Shape:

```jsonc
{
  "mode": "generate",                       // generate | refine | repair
  "division": { "id": "…", "name": "Div 1", "sport": "badminton", "tz": "Europe/London",
                "scheduling_mode": "timed" },
  "settings": {
    "matchMinutes": 30, "gapMinutes": 5,
    "courts": ["Court 1", "Court 2"],       // the ONLY legal court_label values
    "sessionWindows": [{ "from": "2026-07-18T09:00:00+01:00", "to": "2026-07-18T18:00:00+01:00" }],
    "blackouts": [{ "court": "Court 2", "from": "…", "to": "…" }],
    "constraints": { "restMin": 20, "noBackToBack": true, "startWindows": [ … ],
                     "fieldFairness": "balance", "parallelism": "mixed",
                     "crossPersonClash": "hard" }
  },
  "entrants": [{ "id": "…", "name": "Riverside A", "pool": "A", "seed": 1 }],
  "people": [{ "person_id": "…", "entrant_ids": ["…", "…"] }],   // shared-player map
  "fixtures": {
    "movable":   [{ "id": "…", "ext_key": "rr-r1-c2", "round": 1, "seq": 2, "pool": "A",
                    "home": "…", "away": "…",
                    "feeds": { "winner_to": null, "after": ["…fixture ids…"] },
                    "current": { "at": null, "court": null }, "pinned": false }],
    "obstacles": [{ "court": "Court 1", "from": "…", "to": "…", "label": "Div 2 · R1" }]
  },
  "draft": [{ "fixture_id": "…", "scheduled_at": "…", "court_label": "Court 1" }],
  "instruction": "Finish by 6pm. Juniors before 2pm. Final last on Court 1.",
  "prior": null                              // refine/repair: { instruction, assignments }
}
```

Budget: pack must stay ≤60K tokens (measure with `count_tokens` in tests on the 500-fixture
golden pack); above that the route already 422s on fixture count.

## §3 Output schema (zod, strict)

```ts
export const AiAssignment = z.object({
  fixture_id: z.string().uuid(),
  scheduled_at: z.string().datetime({ offset: true }),
  court_label: z.string().min(1),
  schedule_locked: z.boolean().optional(),   // only when instruction says "pin/fix this"
});
export const AiSchedulePlan = z.object({
  assignments: z.array(AiAssignment).max(500),
  unschedulable: z.array(z.object({ fixture_id: z.string().uuid(), reason: z.string().max(200) })),
  explanations: z.array(z.object({ fixture_id: z.string().uuid(), note: z.string().max(200) })).max(60),
  constraint_suggestions: AiConstraintDelta.optional(),  // subset of ScheduleConfig.constraints
  summary: z.string().max(600),
});
```

`AiConstraintDelta` = partial of the existing `constraints{}` schema (restMin,
noBackToBack, startWindows, fieldFairness, parallelism, crossPersonClash) — reuse the
schema objects from `server/api-v1/schemas.ts`, do not redeclare shapes.

## §4 System prompt (verbatim)

```text
You are the schedule architect inside league-management software. You assign a start time
and court to every movable fixture of a sports division, following the organiser's
instruction as closely as the hard rules allow.

You receive one JSON context pack: settings (timezone, durations, courts, windows,
blackouts, constraints), entrants, a shared-player map, movable fixtures, fixed obstacles,
a draft schedule from a greedy solver, and the organiser's instruction. In refine or repair
mode you also receive the prior proposal and, on repair rounds, a verifier conflict report.

HARD RULES — the server verifier rejects violations, so check your work against each one
before answering:
1. court_label must be exactly one of settings.courts. scheduled_at must be ISO-8601 with
   a UTC offset, expressed in the division timezone. Never invent courts or fixtures; use
   only the fixture ids given as movable.
2. A fixture occupies [scheduled_at, scheduled_at + matchMinutes + gapMinutes). Two
   fixtures on the same court must not overlap in that interval.
3. Never place any part of a fixture inside a blackout for its court (or a court-less
   blackout). When sessionWindows exist, every fixture must start and finish inside one.
4. An entrant — or two entrants sharing a person in the shared-player map — must never
   play two overlapping fixtures. Keep at least restMin (or perEntrantMinRest) minutes
   between consecutive fixtures of the same entrant; if noBackToBack is true, an entrant
   must never play consecutive time slots even when rest is satisfied.
5. Respect startWindows: a targeted entrant, pool, or division must not start before
   notBefore or after notAfter.
6. Order dependencies: a fixture must start only after every fixture listed in
   feeds.after is scheduled to finish. Rounds generally flow in order; never schedule a
   final before its semifinals finish.
7. Never move a fixture marked pinned; never output an id that is not in movable. Treat
   obstacles as immovable occupied court time.

SOFT GOALS — in this priority order:
a. The organiser's instruction. It outranks everything except hard rules. If parts of it
   conflict with hard rules or with each other, satisfy what you can, put the rest in
   unschedulable or explain the compromise in summary.
b. Compactness: finish the programme as early as the instruction allows; avoid stranding
   long idle gaps on a court.
c. Fairness: spread each entrant's matches out evenly, balance court usage
   (fieldFairness), avoid one entrant always playing first or last.
d. Stability: in refine and repair modes move as few fixtures as possible; prefer keeping
   the prior proposal where it already satisfies the instruction.

METHOD: Before placing anything, work out the capacity maths (courts × windows vs total
match minutes) and identify the most constrained items — finals and feed chains,
startWindow targets, entrants sharing people, instruction-critical fixtures. Place those
first, then fill the rest from the draft, adjusting only where the instruction requires.
The draft is legal but naive: improve it, don't worship it.

OUTPUT: Only the structured object. Every movable fixture appears exactly once — in
assignments or in unschedulable with a short honest reason. explanations: one short note
for each placement the instruction directly shaped (skip routine placements). If the
instruction implies a durable weekly rule (e.g. "juniors always before 2pm"), express it
in constraint_suggestions using the constraints schema; otherwise omit the field. summary:
at most three sentences to the organiser — what you did, any compromises, what to change
if a wish was impossible.
```

## §5 Message protocol

- Turn 1 (user): the context pack as a single JSON block.
- Repair round r (user): `{"verifier_conflicts": [...engine report...], "note": "Fix only
  these conflicts. Move as few fixtures as possible. Do not reintroduce earlier
  conflicts."}` — assistant turns are passed back unchanged (thinking blocks included).
- Refine run: fresh conversation, `mode:"refine"`, `prior` populated; server rebuilds the
  pack from live DB state (fixtures may have changed since the prior proposal).
- Max 2 repair rounds per run; after that return best-so-far with `blocking` marked.

## §6 Eval fixtures (golden tests, PROMPT-41)

Committed under `apps/web/src/server/usecases/__tests__/schedule-ai/`:
1. **Pack snapshot** — seeded 2-court, 8-entrant RR division → `buildSchedulePack` output
   snapshot (deterministic).
2. **Legality harness** — mocked Anthropic returning a hand-written plan with one court
   clash → verifier catches it, repair round message contains the clash, second mock
   response passes → run succeeds with `repair_rounds:1`.
3. **Instruction cases** (mocked): "finish by 18:00" (all assignments end ≤18:00),
   "Court 2 unavailable Saturday" via repair scope (no Saturday/Court 2 placements),
   pinned fixture untouched in all modes.
4. **Live smoke (opt-in, `AI_EVAL=1`)** — real API call on the small pack; asserts parse +
   verifier-clean; excluded from CI.
