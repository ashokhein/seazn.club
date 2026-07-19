// Client-side officials grid model (v4 Task 14, design/v4/03 §3). The engine
// returns a verified officials proposal (assignments + conflicts + diff +
// lazy_unfilled); this buckets it into a fixture × role grid the review panel
// renders, deriving each chip's state-palette tone. Pure and React-free so every
// tone is unit-tested against a constructed plan — the officials sibling of
// ai-diff.ts.
import type { AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import type { MessageKey } from "@/lib/messages";
import type { AiConsoleFixture } from "./ai-diff";

/** A fixture's dry-run placement (from the Phase A proposal) — where a row reads
 *  its time + court from, so the grid always matches the schedule step. */
export interface OfficialsPlacement {
  fixture_id: string;
  scheduled_at: string;
  court_label: string | null;
}

/** A roster member, resolved from the officials list route (id → display name). */
export interface OfficialsRosterEntry {
  id: string;
  name: string;
}

export type OfficialsSlotTone = "clean" | "changed" | "blocking" | "locked" | "unfilled";

/** One required role on one fixture — the chip the grid paints. */
export interface OfficialsSlot {
  role: string;
  tone: OfficialsSlotTone;
  officialId?: string;
  officialName?: string;
  locked: boolean;
  /** Engine/server conflict kind for a red chip — localized, never shown raw. */
  conflictKind?: string;
  /** Raw engine detail — muted tooltip only, never primary text (02 §6). */
  conflictDetail?: string;
  /** Model/solver reason for a hollow chip — muted tooltip only. */
  reason?: string;
  /** The solver's candidate for a `lazy_unfilled` slot (one-tap adopt). */
  lazyCandidateId?: string;
  lazyCandidateName?: string;
}

export interface OfficialsGridRow {
  fixtureId: string;
  code: string;
  matchup: string;
  marker: "FN" | "JR" | null;
  scheduledAt: string;
  courtLabel: string | null;
  slots: OfficialsSlot[];
}

export interface OfficialsGridModel {
  rows: OfficialsGridRow[];
  /** Slots with an assigned official. */
  filled: number;
  /** Total required slots (fixtures × required roles). */
  total: number;
  /** Blocking conflicts across the proposal (accept-gating count). */
  blocking: number;
}

const slotKey = (fixtureId: string, role: string) => `${fixtureId} ${role}`;

/**
 * Bucket a verified officials proposal into a fixture × role grid. Precedence
 * per slot: a filled chip reddens on a blocking conflict, else shows a padlock
 * when locked, else ambers when its fixture changed vs the prior proposal
 * (`hasPrior` — a first draft has no prior so nothing reads as "changed"), else
 * settles teal. A slot with no assignment is a hollow "unfilled" chip carrying
 * the model's reason (and the solver's candidate when the referee flagged it
 * fillable, i.e. lazy_unfilled).
 */
export function buildOfficialsGrid(input: {
  plan: AiOfficialsPlanResponse;
  placements: OfficialsPlacement[];
  fixtures: Pick<AiConsoleFixture, "id" | "code" | "matchup" | "isFinal" | "isJunior">[];
  roster: OfficialsRosterEntry[];
  roles: string[];
  /** A prior proposal was sent, so `diff.changed` means "changed vs prior". */
  hasPrior: boolean;
}): OfficialsGridModel {
  const { plan, placements, fixtures, roster, roles, hasPrior } = input;
  const fxById = new Map(fixtures.map((f) => [f.id, f]));
  const nameById = new Map(roster.map((o) => [o.id, o.name]));
  const nameOf = (id: string) => nameById.get(id) ?? id.slice(0, 8);

  const assignmentAt = new Map(plan.assignments.map((a) => [slotKey(a.fixtureId, a.roleKey), a]));
  const changed = new Set(hasPrior ? plan.diff.changed : []);
  const reasonAt = new Map(plan.diff.unfilled.map((u) => [slotKey(u.fixture_id, u.role_key), u.reason]));
  const lazyAt = new Map(
    plan.lazy_unfilled.map((l) => [slotKey(l.fixture_id, l.role_key), l.candidate_official_id]),
  );
  const blocks = plan.conflicts.filter((c) => c.severity === "block");

  let filled = 0;
  const rows: OfficialsGridRow[] = [...placements]
    .sort((a, b) => {
      const t = new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
      return t !== 0 ? t : a.fixture_id.localeCompare(b.fixture_id);
    })
    .map((p) => {
      const fx = fxById.get(p.fixture_id);
      const slots: OfficialsSlot[] = roles.map((role) => {
        const a = assignmentAt.get(slotKey(p.fixture_id, role));
        if (a) {
          filled += 1;
          // A blocking conflict claims this filled slot when it names the same
          // official, the same role, or is a bare fixture-level flag.
          const block = blocks.find(
            (c) =>
              c.fixtureId === p.fixture_id &&
              (c.officialId === a.officialId ||
                c.roleKey === role ||
                (c.officialId === undefined && c.roleKey === undefined)),
          );
          const tone: OfficialsSlotTone = block
            ? "blocking"
            : a.locked
              ? "locked"
              : changed.has(p.fixture_id)
                ? "changed"
                : "clean";
          return {
            role,
            tone,
            officialId: a.officialId,
            officialName: nameOf(a.officialId),
            locked: Boolean(a.locked),
            conflictKind: block?.kind,
            conflictDetail: block?.detail,
          };
        }
        // Unfilled — a hollow chip. Surface the solver's candidate when the
        // referee marked it fillable (lazy_unfilled).
        const candidateId = lazyAt.get(slotKey(p.fixture_id, role));
        return {
          role,
          tone: "unfilled" as const,
          locked: false,
          reason: reasonAt.get(slotKey(p.fixture_id, role)),
          lazyCandidateId: candidateId,
          lazyCandidateName: candidateId ? nameOf(candidateId) : undefined,
        };
      });
      return {
        fixtureId: p.fixture_id,
        code: fx?.code ?? "—",
        matchup: fx?.matchup ?? p.fixture_id.slice(0, 8),
        marker: fx?.isFinal ? "FN" : fx?.isJunior ? "JR" : null,
        scheduledAt: p.scheduled_at,
        courtLabel: p.court_label,
        slots,
      };
    });

  return { rows, filled, total: placements.length * roles.length, blocking: blocks.length };
}

const KNOWN_OFFICIALS_CONFLICTS = new Set([
  "official_overlap",
  "team_ref_self",
  "role_unfilled",
  "pool_leak",
  "fairness",
  "travel",
  "ineligible",
]);

/** The `board.ai.officials.conflict.*` dict key for an engine conflict kind —
 *  the reason→dict-key helper, mirroring blockingConflictKey in ai-diff.ts. An
 *  unknown kind falls back to the generic `conflict.unknown` label so a raw
 *  engine token never surfaces as primary text (02 §6). */
export function officialsConflictKey(kind: string): MessageKey {
  return `board.ai.officials.conflict.${KNOWN_OFFICIALS_CONFLICTS.has(kind) ? kind : "unknown"}` as MessageKey;
}
