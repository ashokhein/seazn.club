// Entrant shapes (spec 2026-07-18): what an entrant of a sport/kind looks
// like. Module declaration ← division config.entrants override, merged
// field-by-field; structural caps are not configurable.
const ALL_KINDS = ["team", "individual", "pair"] as const;
export type EntrantKind = (typeof ALL_KINDS)[number];

export interface EntrantModel {
  kinds: EntrantKind[];
  defaultKind: EntrantKind;
  team?: { squadNumbers: boolean; captain: boolean; minMembers?: number; maxMembers?: number };
}

export interface EffectiveEntrantModel {
  kinds: EntrantKind[];
  defaultKind: EntrantKind;
  squadNumbers: boolean;
  captain: boolean;
  maxTeamMembers: number | null;
}

const isKind = (v: unknown): v is EntrantKind => ALL_KINDS.includes(v as EntrantKind);

export function effectiveEntrantModel(
  model?: EntrantModel | null,
  divisionConfig?: unknown,
): EffectiveEntrantModel {
  const base: EffectiveEntrantModel = {
    kinds: model?.kinds?.length ? [...model.kinds] : [...ALL_KINDS],
    defaultKind: model?.defaultKind ?? (model?.kinds?.[0] ?? "individual"),
    squadNumbers: model?.team ? model.team.squadNumbers : true,
    captain: model?.team ? model.team.captain : true,
    maxTeamMembers: model?.team?.maxMembers ?? null,
  };
  // Invariant holds for the base too: a module declaring a defaultKind outside
  // its own kinds must be repaired even when there's no division override.
  if (!base.kinds.includes(base.defaultKind)) base.defaultKind = base.kinds[0]!;
  const raw = (divisionConfig as { entrants?: Record<string, unknown> } | null | undefined)?.entrants;
  if (!raw || typeof raw !== "object") return base;
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter(isKind) : [];
  if (kinds.length > 0) base.kinds = kinds;
  if (isKind(raw.defaultKind) && base.kinds.includes(raw.defaultKind)) base.defaultKind = raw.defaultKind;
  if (!base.kinds.includes(base.defaultKind)) base.defaultKind = base.kinds[0]!;
  if (typeof raw.squadNumbers === "boolean") base.squadNumbers = raw.squadNumbers;
  if (typeof raw.captain === "boolean") base.captain = raw.captain;
  return base;
}

/** Structural caps; a team cap comes from the model's maxMembers when set. */
export function entrantKindCap(
  kind: string,
  eff?: Pick<EffectiveEntrantModel, "maxTeamMembers">,
): number {
  if (kind === "individual") return 1;
  if (kind === "pair") return 2;
  return eff?.maxTeamMembers ?? Number.POSITIVE_INFINITY;
}
