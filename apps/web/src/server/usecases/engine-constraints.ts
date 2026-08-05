import "server-only";
// ONE builder for the engine's `constraints` block (#458).
//
// Three call sites used to build this object as independent literals over the
// same shape — `toSlotConfig` (schedule.ts, board + apply + solver),
// `verifyConfig` (schedule-ai.ts, single-division AI) and `verifyConfigFor`
// (competition-schedule-ai.ts, joint AI) — and having three producers is the
// bug class, not the symptom. They had already drifted three ways:
//
//   - the board site mapped EVERY start window through;
//   - the joint site DROPPED any window whose `target.kind` fell outside the
//     engine's enum;
//   - the single-division AI site pinned `startWindows: []` outright, so that
//     referee was blind to every start window whatever it targeted, and
//     `repair-domain` clipped the repair domain to the same empty config.
//
// The joint site's filter is canonical and the reason is load-bearing:
// `PackStartWindow.target.kind` is a bare `string` (the pack is a wire shape
// that round-trips through JSON), so casting an unrecognised kind through would
// let the engine silently never match it while hiding that a stored settings
// row has drifted from the enum. Dropping it is the honest answer, and it is
// the only one that cannot be mistaken for a rule that binds.
//
// This module is deliberately the sibling of `toRuleFixture` (schedule-ai.ts):
// one derivation, one place to guard, no fourth copy.
import type { HardConstraint, SchedulingConstraints, StartWindow } from "@seazn/engine/scheduling";

/** The ISO-string form of a start window, as both the stored `ScheduleConfig`
 *  and the wire `SchedulePack` hold it. `target.kind` is typed as widely as the
 *  loosest producer types it — the pack's bare `string` — so this one parameter
 *  accepts every source without a cast at any call site. */
export interface StartWindowSource {
  target: { kind: string; id: string };
  notBefore?: string;
  notAfter?: string;
}

/** Everything the engine's `constraints` block takes FROM the stored config.
 *
 *  Deliberately does NOT include `fieldFairness`/`parallelism`/`crossPersonClash`
 *  — see `EngineConstraintPolicy`. Structural, so a caller passes its existing
 *  `config.constraints` / `pack.settings.constraints` object straight in and the
 *  extra members are simply not read. */
export interface EngineConstraintSource {
  restMin?: number;
  restByGroup?: Record<string, number>;
  noBackToBack: boolean;
  startWindows: readonly StartWindowSource[];
  /** Durable typed rules (#398). Carried onto the output only when the policy
   *  asks — see `EngineConstraintPolicy.hard`. */
  hard?: HardConstraint[];
}

/** The three solver knobs plus the durable-rule routing, supplied by the CALLER
 *  rather than read off the source. Required, never defaulted, and that is the
 *  point: both halves differ between the board path and the AI paths, and both
 *  are the kind of thing a silent default gets wrong in a direction no test
 *  would notice.
 *
 *  - The knobs: the stored config types them as the engine's enums, but
 *    `PackConstraints` types them as bare `string` (wire shape), so the AI paths
 *    cannot narrow them and pin the inert values instead. Reading them off the
 *    source would mean either a cast or a silent coercion.
 *  - `hard`: `effectiveHard` MERGES the top-level `hard` field with
 *    `constraints.hard`. The AI paths already merge the durable rules into the
 *    top-level field (they combine them with the rules compiled from the
 *    instruction), so carrying them here as well would count every durable rule
 *    TWICE. The board path has no top-level field and carries them here. */
export interface EngineConstraintPolicy {
  fieldFairness: SchedulingConstraints["fieldFairness"];
  parallelism: SchedulingConstraints["parallelism"];
  crossPersonClash: SchedulingConstraints["crossPersonClash"];
  hard: boolean;
}

/** What both AI verify seams pass. Named rather than repeated so the two paths
 *  cannot drift apart again, which is exactly how #458 happened. */
export const AI_VERIFY_POLICY: EngineConstraintPolicy = {
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  hard: false,
};

const RECOGNISED_KINDS = new Set(["entrant", "pool", "division"]);
const ms = (iso: string): number => new Date(iso).getTime();

/** ISO → epoch ms, dropping any window the engine's enum does not recognise.
 *
 *  Exported because the joint SOLVER config (`competition-schedule-ai.ts`)
 *  unions several divisions' windows and so has no single `constraints` source
 *  to hand `buildEngineConstraints` — but it needs the identical per-window
 *  transform, and a fourth hand-written copy of the filter is the thing this
 *  module exists to prevent. */
export function toEngineStartWindows(windows: readonly StartWindowSource[]): StartWindow[] {
  return windows.flatMap((w) =>
    RECOGNISED_KINDS.has(w.target.kind)
      ? [
          {
            target: { kind: w.target.kind as StartWindow["target"]["kind"], id: w.target.id },
            ...(w.notBefore !== undefined ? { notBefore: ms(w.notBefore) } : {}),
            ...(w.notAfter !== undefined ? { notAfter: ms(w.notAfter) } : {}),
          },
        ]
      : [],
  );
}

/** The engine's `constraints` block, in the engine's units.
 *
 *  Every absent field is OMITTED rather than set to `undefined`: the engine
 *  reads `restByGroup?.[id]` and `constraints?.hard ?? []`, and a defaulted
 *  `hard: []` on a config that stored nothing is indistinguishable downstream
 *  but differs from every literal the suites compare `toSlotConfig` against. */
export function buildEngineConstraints(
  source: EngineConstraintSource,
  policy: EngineConstraintPolicy,
): SchedulingConstraints {
  return {
    ...(source.restMin !== undefined ? { restMin: source.restMin } : {}),
    ...(source.restByGroup !== undefined ? { restByGroup: source.restByGroup } : {}),
    noBackToBack: source.noBackToBack,
    startWindows: toEngineStartWindows(source.startWindows),
    fieldFairness: policy.fieldFairness,
    parallelism: policy.parallelism,
    crossPersonClash: policy.crossPersonClash,
    ...(policy.hard && source.hard !== undefined ? { hard: source.hard } : {}),
  };
}
