import "server-only";
// W5 (#400) — the parse-only preview that precedes an AI schedule run.
//
// Until now the organiser typed a sentence and the next thing that happened was
// a credit leaving the wallet. What their words had actually compiled into was
// only visible AFTER the architect had run against it. This endpoint splits
// that in two: it runs stage 1 (the instruction compile, W3/#398) and stops,
// returning the rules, the preferences, the wording nobody could compile and
// the readings the resolver had to pick. The run is a second, deliberate
// request.
//
// Three properties make that split honest, and each is asserted by
// __tests__/schedule-ai-preview.test.ts:
//
//   1. NOTHING IS SPENT. No `spendCredit`, no architect call. Walking away
//      costs the organiser nothing, which is the entire point — a confirm gate
//      that had already charged would be a receipt, not a gate.
//   2. UNPRICED IS NOT FREE. An org that cannot pay for the run this precedes is
//      refused HERE, with the run's own 402, before we spend our tokens
//      compiling for it. The bound is `minimumCredits`, never `balance > 0`: a
//      3-credit wallet and a 4-credit joint run walk straight through the
//      latter.
//   3. THE SPEND IS VISIBLE. The compile costs real output tokens outside any
//      credit budget, so it is stamped on the ledger under the SAME
//      `parse_tokens` / `parse_failed` field names a run stamps
//      (lib/ai-rung.ts RunMeterStamp) — one vocabulary, not two.
//
// The gate ORDER below mirrors `aiPlanForDivision` / `aiPlanForCompetition`
// deliberately: kill switch → paid gate → frozen → rate limit → affordability →
// compile. A preview that refused later than the run does would tell the
// organiser a run is possible and then refuse it at confirm; one that refused
// earlier would hide a run that would in fact have gone through.
//
// The rate-limit bucket is SHARED with the run, unchanged, because the preview
// IS the LLM call the limit exists to bound. A second bucket would double the
// abuse surface it was sized for (#391).
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { dayKeyInTz, HardConstraint, makeClock } from "@seazn/engine/scheduling";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { balance, walletIdFor } from "@/lib/credits";
import { minimumCredits } from "@/lib/ai-rung";
import { rateLimit } from "@/lib/rate-limit";
import { isServerFeatureEnabled } from "@/lib/posthog-server";
import { requireFeature } from "@/lib/entitlements";
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AiParsePreviewRequest, AiParsePreviewResponse } from "@/server/api-v1/schemas";
import {
  parseInstruction,
  RawParsed,
  resolveParsed,
  type ResolvedParse,
} from "@/server/usecases/schedule-ai-parse";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { MOVABLE_STATUS } from "./schedule";
import { resolveVenueTz } from "@/lib/tz";

/** Which endpoint asked. A preview is only ever valid for its own scope: the
 *  joint resolver sees every selected division's fixture count, so the same
 *  sentence can resolve a different window on the two routes. */
export type AiPreviewScope = { kind: "division" | "competition"; id: string };

/** How long a preview stays reusable. Long enough that reading the card and
 *  thinking about it is not a race; short enough that the org clock cannot
 *  cross a day boundary — and "tomorrow" with it — while the preview waits. */
export const PREVIEW_TTL_MS = 30 * 60_000;

/**
 * The instruction, reduced to what it MEANS rather than how it was typed.
 * Leading/trailing space and a double space between two words are not a
 * different instruction; a different word is.
 *
 * Unicode normalisation is part of that, and only NFC. A sentence pasted from
 * elsewhere on macOS can arrive DECOMPOSED (`e` + combining acute) while the
 * same sentence typed into the box arrives composed — byte-different, visually
 * identical, and a needless recompile at the organiser's expense.
 *
 * The chain stops there, on purpose, in both directions:
 *   * CASE STAYS SIGNIFICANT. No normalisation form folds it, and a retyped
 *     sentence that differs in case costs a cheap recompile rather than
 *     silently matching a confirmation it may not describe;
 *   * LOOK-ALIKES ARE NOT FOLDED. No standard form merges a curly apostrophe
 *     with a straight one, or an en dash with a hyphen. Inventing a fold here
 *     would let two visibly different sentences share one confirmation — the
 *     exact failure this hash exists to prevent, arrived at from the other side.
 *
 * Exported because Task 2's run gate compares against it — two normalisers
 * would mean a preview that can never be matched, or worse, one that matches a
 * sentence it did not compile.
 */
export function hashInstruction(instruction: string): string {
  return createHash("sha256")
    .update(instruction.normalize("NFC").trim().replace(/\s+/g, " "))
    .digest("hex");
}

/**
 * The stored compile, re-validated on its way back OUT of the database.
 *
 * `resolved.hard` goes straight to the engine's verifier and `raw` can be
 * re-resolved by the pack builder, so this is a genuine trust boundary: a
 * preview lives thirty minutes, which is long enough for a deploy to land
 * inside it and change what `HardConstraint` means. Reading the jsonb back
 * through the SAME schemas the engine and the compiler publish is what stops a
 * shape nothing can check from being presented as an enforced rule.
 *
 * `ResolvedParse` is a TS interface, so the column would otherwise be typed by
 * generic parameter alone — a claim about the row, not a check on it.
 *
 * Every field is REQUIRED here. `RawParsed`'s own members carry `.default([])`,
 * which is right for a model answer that may legitimately omit an empty list,
 * and wrong for a row this code wrote: a stored `resolved` missing `soft` is a
 * row we do not recognise, and filling it in would be this schema quietly
 * repairing the thing it exists to detect. Hence `.removeDefault()`.
 */
const StoredResolvedParse = z.object({
  hard: z.array(HardConstraint),
  soft: RawParsed.shape.soft.removeDefault(),
  unparsed: z.array(z.string()),
  assumptions: z.array(z.string()),
  windowMs: z.object({ from: z.number(), to: z.number() }).nullable(),
});

/** The 409 both run orchestrators raise when a `preview_id` cannot be honoured.
 *  Exported so the two call sites and their tests name it once. */
export const PREVIEW_STALE = "preview_stale";

/**
 * Claim a preview for the run that is about to execute, atomically.
 *
 * Returns the compiled parse, or `null` when the preview cannot be honoured —
 * which the callers turn into a 409 {@link PREVIEW_STALE}. All six refusals are
 * deliberately one answer, because they are one fact: *this run may not proceed
 * on this confirmation.*
 *
 *   * no such row — a fabricated or long-swept id;
 *   * another org's row. Honouring it would be a cross-tenant read of somebody
 *     else's compiled instruction, so `org_id` is in the predicate and not a
 *     post-hoc check;
 *   * another scope's row. A preview taken against one division resolved its
 *     window from that division's fixture count; the joint run's is a different
 *     number, so the same sentence is a different compile. Scope is part of a
 *     preview's identity;
 *   * a different DIVISION SET. `scope_id` is the competition on the joint path
 *     and says nothing about which divisions were selected, yet the window is
 *     resolved from their SUMMED movable-fixture count and the compiler is shown
 *     them by name. A run over a set the compile never saw would place the extra
 *     division under a window resolved without it. Compared as a SET — both
 *     sides are sorted — because reordering a multi-select is not a change to
 *     the run;
 *   * a different instruction. This is the one this wave exists for: recompiling
 *     silently would run — and charge — the architect under rules the organiser
 *     never saw. The comparison is on the NORMALISED hash, so retyped
 *     whitespace is still the same sentence;
 *   * already consumed. A preview is single-use, so a double-submitted confirm
 *     buys one run, not two;
 *   * expired. Thirty minutes is short enough that the org clock cannot cross a
 *     day boundary — and "tomorrow" with it — while the card sits open, but a
 *     backgrounded tab can outlive it, and a preview that is stale by wall
 *     clock is as wrong as one that is stale by content.
 *
 * ONE statement, deliberately. A read-then-update would let two concurrent
 * submits both pass the read and both spend a credit; `update … where
 * consumed_at is null returning` cannot. And putting the hash in the predicate
 * rather than comparing after the claim means a mismatched submit refuses
 * WITHOUT consuming the preview the organiser actually confirmed — otherwise a
 * stray stale request would destroy a valid confirmation and force them to pay
 * for another compile.
 */
export async function consumePreview(
  previewId: string,
  where: {
    orgId: string;
    scope: AiPreviewScope["kind"];
    scopeId: string;
    /** Every division this run will actually solve. Sorted here so callers do
     *  not have to remember to; see {@link sortedDivisionIds}. */
    divisionIds: readonly string[];
    instruction: string;
  },
): Promise<{ raw: RawParsed; resolved: ResolvedParse } | null> {
  return withTenant(where.orgId, async (tx) => {
    const [row] = await tx<{ raw: unknown; resolved: unknown }[]>`
      update ai_parse_previews
         set consumed_at = now()
       where id = ${previewId}
         and org_id = ${where.orgId}
         and scope = ${where.scope}
         and scope_id = ${where.scopeId}
         and division_ids = ${sortedDivisionIds(where.divisionIds)}::uuid[]
         and instruction_hash = ${hashInstruction(where.instruction)}
         and consumed_at is null
         and expires_at > now()
         and failed = false
      returning raw, resolved`;
    if (!row) return null;
    // Validated AFTER the claim, deliberately: a row whose stored shape the
    // running code can no longer read could never have authorised anything, so
    // spending the claim on it destroys nothing. Refusing the shape, on the
    // other hand, is the whole point — see {@link StoredResolvedParse}. `raw` is
    // nullable on the table (a failed compile persists none) though a failed
    // compile never gets a row at all, so a null here is simply a preview with
    // nothing for the run to reuse.
    const parsed = z
      .object({ raw: RawParsed, resolved: StoredResolvedParse })
      .safeParse({ raw: row.raw, resolved: row.resolved });
    return parsed.success ? parsed.data : null;
  });
}

/**
 * The canonical form the division set is stored and compared in.
 *
 * LOWERCASED BEFORE SORTING, and that order matters. Postgres canonicalises a
 * `uuid` to lowercase on the way in but preserves ARRAY ORDER, so a set sorted
 * in JS from mixed-case input is stored in an order that codepoint-sorting the
 * lower-case spelling would not reproduce ('B…' sorts before 'a…', `b…` does
 * not) — and a legitimate confirmation would 409 purely on how the client
 * happened to spell its uuids.
 */
export function sortedDivisionIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.toLowerCase()).sort();
}

/**
 * Give a confirmation back to the organiser.
 *
 * The claim above is taken before the pack, the quote and the credit reserve,
 * because that is what makes a double-submit buy one run rather than two. The
 * cost of taking it that early is that a run which then falls over — an empty
 * wallet at the reserve, a 422 from the pack builder — would eat a confirmation
 * it never used: the retry 409s and the organiser pays for a second compile of a
 * sentence they did not change.
 *
 * Called only when the run cost the organiser nothing — `spendCredit` reports
 * whether it refunded the hold, so "nothing was bought" is a fact rather than an
 * inference from which error came back. It cannot reopen a race: a competing
 * submit that lost the claim has already been refused, and one that wins the
 * reopened claim is simply the retry.
 *
 * `consumed_at is not null` carries the statement's own precondition, so a
 * double release is a provable no-op rather than one that happens to be
 * harmless.
 */
export async function releasePreview(previewId: string, orgId: string): Promise<void> {
  await withTenant(orgId, async (tx) => {
    await tx`
      update ai_parse_previews set consumed_at = null
       where id = ${previewId} and org_id = ${orgId} and consumed_at is not null`;
  });
}

const SINGLE_DIVISION = "AI_PLAN_SINGLE_DIVISION";

/** Everything the scope resolution had to look up, so the compile and the
 *  ledger stamp below never re-query for it. */
interface ResolvedScope {
  competitionId: string;
  /** Shown to the compiler so a scoped instruction ("finals in the Open on
   *  Friday") can resolve to a real division id. Divisions ONLY — the parser's
   *  `Scope` cannot express anything narrower. */
  divisions: { id: string; name: string }[];
  /** The GOVERNING zone: the organisation's, never a division override. Two
   *  divisions of one competition must not disagree about which day it is
   *  (#397). */
  orgTz: string;
  /** Movable fixtures across the scope, feeding the resolver's feasibility
   *  reading of an ambiguous window. Queried rather than defaulted to 0: the
   *  run passes the real count, and a preview that showed a different window
   *  from the run it authorises would be precisely the drift this wave exists
   *  to close. */
  fixtureCount: number;
  /** The per-line rungs this run would be priced at — one entry per priced
   *  line, in the shape `minimumCredits` takes. */
  chosenRungs: (number | undefined)[];
  /** The rate-limit key the RUN uses. Shared on purpose; see the file header. */
  rateLimitKey: string;
  rateLimitMax: number;
}

async function resolveDivisionScope(
  auth: AuthCtx,
  divisionId: string,
  input: AiParsePreviewRequest,
): Promise<ResolvedScope> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<
      { competition_id: string; name: string; schedule_locked: boolean | null; org_tz: string | null }[]
    >`
      select d.competition_id, d.name, d.schedule_locked, o.timezone as org_tz
        from divisions d
        left join organizations o on o.id = d.org_id
       where d.id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // A frozen division rejects every applied plan, so previewing one would
    // invite a confirm that can only end in a refusal. Same 409 the run raises,
    // and for the same reason — except here it costs nothing at all.
    if (division.schedule_locked === true) {
      throw new HttpError(
        409,
        "the division schedule is frozen — unfreeze it to plan with AI",
        "SCHEDULE_LOCKED",
      );
    }
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures
       where division_id = ${divisionId} and status = ${MOVABLE_STATUS}`;
    return {
      competitionId: division.competition_id,
      divisions: [{ id: divisionId, name: division.name }],
      orgTz: resolveVenueTz(null, division.org_tz),
      fixtureCount: n,
      chosenRungs: [input.rung],
      rateLimitKey: `ai-plan:${divisionId}`,
      rateLimitMax: 5,
    };
  });
}

async function resolveCompetitionScope(
  auth: AuthCtx,
  competitionId: string,
  input: AiParsePreviewRequest,
): Promise<ResolvedScope> {
  // The joint run needs to know WHICH divisions are in scope before it can
  // resolve a window, so the preview does too. Without them it would compile
  // against a different set than the run and hand back a window the run never
  // uses.
  const requested = [...new Set(input.division_ids ?? [])];
  if (requested.length < 2) {
    throw new HttpError(400, "use the division schedule page to plan a single division", SINGLE_DIVISION);
  }
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ id: string }[]>`
      select id from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    await assertCompetitionNotFrozen(auth.orgId, competitionId, tx);
    const rows = await tx<
      { id: string; name: string; schedule_locked: boolean | null; movable: number; org_tz: string | null }[]
    >`
      select d.id, d.name, d.schedule_locked,
             (select count(*)::int from fixtures f
               where f.division_id = d.id and f.status = ${MOVABLE_STATUS}) as movable,
             o.timezone as org_tz
        from divisions d
        left join organizations o on o.id = d.org_id
       where d.competition_id = ${competitionId} and d.id in ${tx(requested)}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    // REQUEST order, so the error a caller gets is a function of the request
    // alone and never of row order out of Postgres.
    for (const id of requested) {
      if (!byId.has(id)) throw new HttpError(404, `division not in competition: ${id}`);
    }
    for (const id of requested) {
      const row = byId.get(id)!;
      if (row.schedule_locked === true) {
        throw new HttpError(
          409,
          `the schedule for division "${row.name}" is frozen — unfreeze it to plan with AI`,
          "SCHEDULE_LOCKED",
        );
      }
    }
    // Ruling R6: a division with nothing movable is dropped before the price,
    // so it is dropped before the affordability bound too.
    const kept = requested.filter((id) => byId.get(id)!.movable > 0);
    if (kept.length < 2) {
      throw new HttpError(400, "use the division schedule page to plan a single division", SINGLE_DIVISION);
    }
    return {
      competitionId,
      divisions: kept.map((id) => ({ id, name: byId.get(id)!.name })),
      orgTz: resolveVenueTz(null, rows[0]?.org_tz ?? null),
      fixtureCount: kept.reduce((n, id) => n + byId.get(id)!.movable, 0),
      chosenRungs: kept.map((id) => input.rung_overrides?.[id]),
      rateLimitKey: `ai-plan-competition:${competitionId}`,
      rateLimitMax: 3,
    };
  });
}

/**
 * Compile `input.instruction` and return what it compiled to, spending no
 * credit and making no architect call.
 *
 * @throws HttpError 403 FEATURE_DISABLED (kill switch), 402 (the paid gate, or
 *   a wallet that cannot afford the run this precedes), 404, 409
 *   SCHEDULE_LOCKED, 400 AI_PLAN_SINGLE_DIVISION (joint scope with fewer than
 *   two solvable divisions), 429 (the run's own rate limit).
 *
 * A failed compile is NOT among them. It comes back as `failed: true` with the
 * organiser's own words in `compiled.unparsed` and no `preview_id`, because it
 * is a state the card renders — an explicit "run it as a preference instead?" —
 * and not an error. Throwing here would leave the client with a dead brief and
 * nothing to choose.
 */
export async function previewScheduleAi(
  auth: AuthCtx,
  scope: AiPreviewScope,
  input: AiParsePreviewRequest,
): Promise<AiParsePreviewResponse> {
  const distinctId = auth.userId ?? `org:${auth.orgId}`;
  // Fail-open, exactly as the run does: an unconfigured or unreachable PostHog
  // must never block a paying customer.
  if (!(await isServerFeatureEnabled("ai-scheduling", distinctId, { orgId: auth.orgId, fallback: true }))) {
    throw new HttpError(403, "AI scheduling is currently turned off", "FEATURE_DISABLED");
  }
  await requireFeature(auth.orgId, "scheduling.ai");
  if (scope.kind === "competition") await requireFeature(auth.orgId, "scheduling.multi_division");

  const resolved =
    scope.kind === "division"
      ? await resolveDivisionScope(auth, scope.id, input)
      : await resolveCompetitionScope(auth, scope.id, input);

  const walletId = await walletIdFor(auth.orgId);
  // FAIL-CLOSED, and deliberately unlike the run. The bucket IDENTITY is the
  // run's — same key, same max, so looking before you leap cannot buy extra
  // quota — but the POLICY diverges, because what the two paths fall back on
  // when Redis stops answering is not the same thing. A run that slips past an
  // unreachable limiter is still bounded by the credit wallet: it cannot proceed
  // without spending. A preview spends nothing, so the limiter is the ONLY
  // control on it, and fail-open would turn an Upstash blip into unmetered model
  // access for the length of the outage. The trade is cheap in the other
  // direction: a preview that 429s during a Redis outage costs the organiser a
  // retry, not money.
  await rateLimit(resolved.rateLimitKey, {
    max: resolved.rateLimitMax,
    windowSeconds: 3600,
    failClosed: true,
  });

  // THE MONEY GATE. `minimumCredits` is a lower bound on what the confirmed run
  // would cost — it can only ever decline to compile a run that would have been
  // refused anyway, never refuse one that would have gone through. The run's own
  // 402 comes from `spendCredit` and is unchanged; this one exists so an org
  // that provably cannot pay does not get our tokens spent compiling for it.
  // Same PaymentRequiredError("ai.credits") the reserve raises, so the client's
  // existing paywall handling covers it without a second code to learn.
  if ((await balance(walletId)) < minimumCredits(resolved.chosenRungs)) {
    throw new PaymentRequiredError("ai.credits");
  }

  // Stage 1. Its own meter, its own ~1K ceiling, no provider argument: the
  // compiler resolves its provider from the MODEL SLUG (`schedule-ai-parse.ts`),
  // never from a global AI_PROVIDER, because its default is a bare Anthropic id
  // and a bare id sent to OpenRouter is a 404 that path silently swallows.
  const parse = await parseInstruction(input.instruction, { divisions: resolved.divisions });

  // The unpriced spend, on the ledger under the run's own field names. Written
  // BEFORE the response is built and on the failed path too: an un-stamped
  // compile is exactly the invisible spend #387 complains about, and a failure
  // is the case that spends the MOST (two attempts, no usable result).
  await withTenant(auth.orgId, async (tx) => {
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${resolved.competitionId}, ${auth.orgId}, 'schedule.ai_previewed',
              ${tx.json({
                scope: scope.kind,
                ...(scope.kind === "division"
                  ? { division_id: scope.id }
                  : { division_ids: resolved.divisions.map((d) => d.id) }),
                model: parse.servedModel,
                parse_tokens: parse.tokens,
                parse_failed: parse.failed,
              } as never)}, ${auth.userId})`;
  });

  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();

  // NOTE ON WHAT A FAILED COMPILE COSTS. No row is persisted here, so there is
  // nothing for a run to reuse and the confirm path has no choice but to compile
  // again. An organiser who takes the preference fallback therefore pays for the
  // compile TWICE — 2 preview attempts here plus the run's own 2 inline
  // attempts — and burns 2 of the division's 5 hourly slots, because the preview
  // consumed one and the fallback run (no `preview_id` to claim) consumes
  // another. That is correct, not a leak: persisting a failed compile would
  // hand the run a parse that failed schema, and skipping the limiter for a
  // preview that did reach the model would make failure the cheap path. It is
  // recorded here because undocumented it reads as double-charging.
  //
  // Failed twice against the schema. Not an error — a state. No `preview_id`,
  // because there is nothing to confirm; the organiser's own sentence comes back
  // in `unparsed` so the card can show what we could not read, and the client
  // offers the preference fallback as an EXPLICIT choice. Silent fallback is
  // refused: it would present a rule as enforced while nothing enforces it.
  if (parse.failed || parse.raw === null) {
    return {
      failed: true,
      compiled: { hard: [], soft: [], unparsed: [input.instruction], assumptions: [] },
      window: null,
      expires_at: expiresAt,
    };
  }

  // Deterministic resolution: symbolic date refs become real days against the
  // ORG clock, and every interpretive choice lands in `assumptions`.
  const clock = makeClock(Date.now(), resolved.orgTz);
  const compiled = resolveParsed(parse.raw, clock, resolved.orgTz, {
    fixtureCount: resolved.fixtureCount,
  });

  const previewId = randomUUID();
  // The divisions this compile actually saw (V346). On the joint path `scope_id`
  // is the competition and cannot carry them, yet the window below was resolved
  // from their summed movable-fixture count and the compiler was shown them by
  // name — so the run gate has to be able to check the SET, not just the scope.
  const divisionIds = sortedDivisionIds(resolved.divisions.map((d) => d.id));
  await withTenant(auth.orgId, async (tx) => {
    await tx`
      insert into ai_parse_previews
        (id, org_id, scope, scope_id, division_ids, instruction_hash, instruction,
         resolved, raw, failed, output_tokens, served_model, expires_at)
      values (${previewId}, ${auth.orgId}, ${scope.kind}, ${scope.id},
              ${divisionIds}::uuid[],
              ${hashInstruction(input.instruction)}, ${input.instruction},
              ${tx.json(compiled as never)}, ${tx.json(parse.raw as never)},
              false, ${parse.tokens}, ${parse.servedModel}, ${expiresAt})`;
  });

  return {
    preview_id: previewId,
    failed: false,
    compiled: {
      // Already resolved against the clock — these are the rules the referee
      // will check, not the model's symbolic answer.
      hard: compiled.hard as HardConstraint[],
      soft: compiled.soft,
      unparsed: compiled.unparsed,
      // The RESOLVER's assumptions. The architect's own are stage 2 and ride on
      // the plan response; the two arrays must never be merged.
      assumptions: compiled.assumptions,
    },
    window:
      compiled.windowMs !== null
        ? {
            start: dayKeyInTz(compiled.windowMs.from, resolved.orgTz),
            end: dayKeyInTz(compiled.windowMs.to, resolved.orgTz),
            tz: resolved.orgTz,
          }
        : null,
    expires_at: expiresAt,
  };
}
