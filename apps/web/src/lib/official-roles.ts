// Per-sport officials crews — v6/00 §4 (ITF App VII, IIHF 4-official system,
// FIH tournament crew). The officials panel seeds its add-form role and a
// quick "add crew" hint from these; everything stays free-form strings on
// top of the existing role_keys machinery.

export interface RolePreset {
  /** The role preselected in the add-official form. */
  defaultRole: string;
  /** A full match crew, in add order (duplicates = two of that role). */
  crew: string[];
}

const PRESETS: Record<string, RolePreset> = {
  tennis: {
    defaultRole: "chair_umpire",
    crew: ["referee", "chair_umpire", "line_umpire"],
  },
  icehockey: {
    defaultRole: "referee",
    crew: ["referee", "referee", "linesman", "linesman", "scorekeeper", "timekeeper"],
  },
  hockey: {
    defaultRole: "umpire",
    crew: ["umpire", "umpire", "technical_officer", "reserve_umpire"],
  },
};

const FALLBACK: RolePreset = { defaultRole: "referee", crew: ["referee"] };

export function officialRolePreset(sportKey?: string | null): RolePreset {
  return PRESETS[(sportKey ?? "").toLowerCase()] ?? FALLBACK;
}

/**
 * Role chip suggestions for the org-wide Directory add-form (v11.1): the
 * Directory has no division/sport context to seed a single preset, so this
 * is the union of every sport's crew role keys (deduped, first-seen order),
 * plus "judge" and "scorer" — common generic roles no preset names. A custom
 * role stays free-text via the picker's own "add" input.
 */
export const ALL_OFFICIAL_ROLES: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const preset of Object.values(PRESETS)) {
    for (const role of preset.crew) {
      if (!seen.has(role)) {
        seen.add(role);
        out.push(role);
      }
    }
  }
  for (const role of ["judge", "scorer"]) {
    if (!seen.has(role)) {
      seen.add(role);
      out.push(role);
    }
  }
  return out;
})();
