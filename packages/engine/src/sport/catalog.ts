// PositionCatalog — spec 02 §3. Positions are sport metadata, not free text:
// each SportModule exports its catalog; the engine validates lineups against
// it and the UI renders pickers from it. Positions never affect scoring math
// in v2 — they are lineup/display/stats data.
import { z } from "zod";
import { EngineError } from "../core/errors.ts";
import type { Lineup } from "../core/types.ts";

// spec 02 §3 — 'GK'/'Goalkeeper' with optional starting-lineup bounds
// (football GK: min 1, max 1).
export const PositionGroup = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
});
export type PositionGroup = z.infer<typeof PositionGroup>;

// spec 02 §3 — captain (unique), wicketkeeper (unique, required in the
// starting lineup — spec 04 §2.7).
export const PositionRole = z.object({
  key: z.string().min(1),
  name: z.string().min(1).optional(),
  unique: z.boolean().optional(), // at most one holder across the lineup
  required: z.boolean().optional(), // must appear among starting slots
});
export type PositionRole = z.infer<typeof PositionRole>;

export const PositionCatalog = z.object({
  groups: z.array(PositionGroup),
  roles: z.array(PositionRole).optional(),
  lineup: z.object({
    size: z.number().int().positive(), // exact starting-slot count
    benchMax: z.number().int().nonnegative().optional(),
  }),
});
export type PositionCatalog = z.infer<typeof PositionCatalog>;

// Typed validation errors — PROMPT-03 §1: size, unique roles, group min/max.
export type LineupIssue =
  | { kind: "starting_size"; expected: number; actual: number }
  | { kind: "bench_size"; max: number; actual: number }
  | { kind: "duplicate_person"; personId: string }
  | { kind: "unknown_position"; positionKey: string; personId: string }
  | { kind: "role_unknown"; roleKey: string; personId: string }
  | { kind: "role_duplicate"; roleKey: string; personIds: string[] }
  | { kind: "role_missing"; roleKey: string }
  | { kind: "group_min"; groupKey: string; min: number; actual: number }
  | { kind: "group_max"; groupKey: string; max: number; actual: number };

// spec 02 §3 — the engine validates lineups against the catalog. Returns
// every violation rather than the first so the lineup picker can show them
// all at once; assertLineup wraps this for the append path.
export function validateLineup(catalog: PositionCatalog, lineup: Lineup): LineupIssue[] {
  const issues: LineupIssue[] = [];
  const starting = lineup.slots.filter((slot) => slot.slot === "starting");
  const bench = lineup.slots.filter((slot) => slot.slot === "bench");

  if (starting.length !== catalog.lineup.size) {
    issues.push({ kind: "starting_size", expected: catalog.lineup.size, actual: starting.length });
  }
  if (catalog.lineup.benchMax !== undefined && bench.length > catalog.lineup.benchMax) {
    issues.push({ kind: "bench_size", max: catalog.lineup.benchMax, actual: bench.length });
  }

  const seenPersons = new Set<string>();
  for (const slot of lineup.slots) {
    if (seenPersons.has(slot.personId)) {
      issues.push({ kind: "duplicate_person", personId: slot.personId });
    }
    seenPersons.add(slot.personId);
  }

  // Group min/max apply to the starting lineup (spec 02 §3: football needs
  // exactly one starting GK; the bench is unconstrained by groups).
  const groupByKey = new Map(catalog.groups.map((group) => [group.key, group]));
  const groupCounts = new Map<string, number>();
  for (const slot of starting) {
    if (slot.positionKey === undefined) continue;
    if (!groupByKey.has(slot.positionKey)) {
      issues.push({ kind: "unknown_position", positionKey: slot.positionKey, personId: slot.personId });
      continue;
    }
    groupCounts.set(slot.positionKey, (groupCounts.get(slot.positionKey) ?? 0) + 1);
  }
  for (const group of catalog.groups) {
    const count = groupCounts.get(group.key) ?? 0;
    if (group.min !== undefined && count < group.min) {
      issues.push({ kind: "group_min", groupKey: group.key, min: group.min, actual: count });
    }
    if (group.max !== undefined && count > group.max) {
      issues.push({ kind: "group_max", groupKey: group.key, max: group.max, actual: count });
    }
  }

  // Roles: uniqueness counts across the whole lineup; required roles must be
  // filled by a starting player (a benched wicketkeeper is no wicketkeeper).
  const roleByKey = new Map((catalog.roles ?? []).map((role) => [role.key, role]));
  const holders = new Map<string, string[]>();
  const startingRoles = new Set<string>();
  for (const slot of lineup.slots) {
    for (const roleKey of slot.roles ?? []) {
      if (!roleByKey.has(roleKey)) {
        issues.push({ kind: "role_unknown", roleKey, personId: slot.personId });
        continue;
      }
      holders.set(roleKey, [...(holders.get(roleKey) ?? []), slot.personId]);
      if (slot.slot === "starting") startingRoles.add(roleKey);
    }
  }
  for (const role of catalog.roles ?? []) {
    const personIds = holders.get(role.key) ?? [];
    if (role.unique && personIds.length > 1) {
      issues.push({ kind: "role_duplicate", roleKey: role.key, personIds });
    }
    if (role.required && !startingRoles.has(role.key)) {
      issues.push({ kind: "role_missing", roleKey: role.key });
    }
  }

  return issues;
}

export function assertLineup(catalog: PositionCatalog, lineup: Lineup): void {
  const issues = validateLineup(catalog, lineup);
  if (issues.length > 0) {
    throw new EngineError("LINEUP_INVALID", `lineup for "${lineup.entrantId}" is invalid`, {
      entrantId: lineup.entrantId,
      issues,
    });
  }
}
