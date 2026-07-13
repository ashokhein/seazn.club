"use client";

// Match rules — curated per-sport fields that build the config override
// object (previously a raw-JSON textarea). Blank = keep the variant default;
// the pinned module's configSchema still validates server-side. Shared by
// the division builder and the division Settings tab (v8) so the two format
// editors can't drift.

export interface RuleField {
  key: string;
  label: string;
  help?: string;
  /** number input, or a Default/On/Off select for booleans, or an option list. */
  kind: "number" | "bool" | "select";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  /** Maps the entered value onto the override object (top-level key). */
  build: (value: string) => Record<string, unknown>;
}

const SETBASED_RULES: RuleField[] = [
  {
    key: "bestOf",
    label: "Best of (sets)",
    kind: "select",
    options: [1, 3, 5, 7].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
  },
  {
    key: "setTo",
    label: "Points to win a set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ setTo: Number(v) }),
  },
  {
    key: "finalSetTo",
    label: "Points in the deciding set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ finalSetTo: Number(v) }),
  },
];

export const SPORT_RULES: Record<string, RuleField[]> = {
  football: [
    {
      key: "halfMinutes",
      label: "Half length (minutes)",
      kind: "number",
      min: 5,
      max: 60,
      build: (v) => ({ halfMinutes: Number(v) }),
    },
    {
      key: "extraTime",
      label: "Extra time",
      help: "Knockout fixtures only.",
      kind: "bool",
      build: (v) => ({ extraTime: { enabled: v === "on", halfMinutes: 15 } }),
    },
    {
      key: "shootout",
      label: "Penalty shootout",
      help: "Knockout fixtures only.",
      kind: "bool",
      build: (v) => ({ shootout: v === "on" }),
    },
  ],
  cricket: [
    {
      key: "overs",
      label: "Overs per innings",
      kind: "number",
      min: 1,
      max: 100,
      build: (v) => ({ ballsPerInnings: Number(v) * 6 }),
    },
    {
      key: "maxOversPerBowler",
      label: "Max overs per bowler",
      kind: "number",
      min: 1,
      max: 50,
      build: (v) => ({ maxOversPerBowler: Number(v) }),
    },
    {
      key: "superOver",
      label: "Super over on a tie",
      help: "Knockout fixtures only.",
      kind: "bool",
      build: (v) => ({ superOver: v === "on" }),
    },
    {
      key: "dls",
      label: "DLS revised targets",
      help: "Pro feature — a manual umpire target works on every plan.",
      kind: "bool",
      build: (v) => ({ dls: { enabled: v === "on", edition: "standard" } }),
    },
  ],
  volleyball: SETBASED_RULES,
  badminton: SETBASED_RULES,
  tabletennis: SETBASED_RULES,
  tennis: [
    {
      key: "bestOf",
      label: "Best of (sets)",
      kind: "select",
      options: [1, 3, 5].map((n) => ({ value: String(n), label: `Best of ${n}` })),
      build: (v) => ({ bestOf: Number(v) }),
    },
    {
      key: "setType",
      label: "Set type",
      kind: "select",
      options: [
        { value: "tb6", label: "Tie-break sets (to 6)" },
        { value: "fast4", label: "Fast4 (to 4, TB at 3–3)" },
        { value: "advantage", label: "Advantage sets" },
      ],
      // Nested config objects must be complete — a partial `set` fails the
      // pinned module schema (v8 gotcha).
      build: (v) => ({
        set:
          v === "fast4"
            ? { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 }
            : v === "advantage"
              ? { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 }
              : { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
      }),
    },
    {
      key: "finalSet",
      label: "Deciding set",
      kind: "select",
      options: [
        { value: "same", label: "Same as other sets" },
        { value: "mtb10", label: "Match tie-break to 10" },
        { value: "mtb7", label: "Match tie-break to 7" },
        { value: "tb10", label: "Set with tie-break to 10" },
      ],
      build: (v) => ({
        finalSet:
          v === "mtb10"
            ? { matchTiebreakTo: 10 }
            : v === "mtb7"
              ? { matchTiebreakTo: 7 }
              : v === "tb10"
                ? { tiebreakTo: 10 }
                : "same",
      }),
    },
    {
      key: "noAd",
      label: "No-ad games",
      help: "A single deciding point at deuce.",
      kind: "bool",
      build: (v) => ({ game: { noAd: v === "on" } }),
    },
  ],
  icehockey: [
    {
      key: "periodMinutes",
      label: "Period length (minutes)",
      kind: "number",
      min: 5,
      max: 30,
      build: (v) => ({ periods: { count: 3, minutes: Number(v) } }),
    },
    {
      key: "overtime",
      label: "Sudden-death overtime",
      help: "IIHF: 5 minutes, 3 skaters.",
      kind: "bool",
      build: (v) => ({
        overtime: v === "on" ? { kind: "sudden_death", minutes: 5, skaters: 3 } : null,
      }),
    },
    {
      key: "shootout",
      label: "Shootout (GWS)",
      kind: "bool",
      build: (v) => ({ shootout: v === "on" ? { attempts: 5, suddenDeath: true } : null }),
    },
  ],
  hockey: [
    {
      key: "quarterMinutes",
      label: "Quarter length (minutes)",
      kind: "number",
      min: 5,
      max: 20,
      build: (v) => ({ periods: { count: 4, minutes: Number(v) } }),
    },
    {
      key: "shootout",
      label: "Shoot-out on a draw",
      help: "FIH: 5 attempts, 8 seconds each.",
      kind: "bool",
      build: (v) => ({
        shootout: v === "on" ? { attempts: 5, suddenDeath: true, clockSeconds: 8 } : null,
      }),
    },
  ],
  boardgame: [
    {
      key: "variant",
      label: "Clock family",
      kind: "select",
      options: [
        { value: "classical", label: "Classical" },
        { value: "rapid", label: "Rapid" },
        { value: "blitz", label: "Blitz" },
      ],
      build: (v) => ({ variant: v }),
    },
  ],
};

/** Merge every non-blank field into one override object. */
export function buildRuleOverride(
  sportKey: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const override: Record<string, unknown> = {};
  for (const field of SPORT_RULES[sportKey] ?? []) {
    const value = values[field.key];
    if (value !== undefined && value !== "") Object.assign(override, field.build(value));
  }
  return override;
}

/** The builder's field grid, extracted verbatim so both editors share it. */
export function MatchRuleFields({
  sportKey,
  values,
  onChange,
  disabled = false,
}: {
  sportKey: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const fields = SPORT_RULES[sportKey] ?? [];
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {fields.map((field) => (
        <label key={field.key} className="block">
          <span className="label">{field.label}</span>
          {field.kind === "number" ? (
            <input
              type="number"
              min={field.min}
              max={field.max}
              disabled={disabled}
              value={values[field.key] ?? ""}
              onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
              placeholder="Default"
              className="input"
            />
          ) : (
            <select
              disabled={disabled}
              value={values[field.key] ?? ""}
              onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
              className="select"
            >
              <option value="">Default</option>
              {field.kind === "bool" ? (
                <>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </>
              ) : (
                (field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))
              )}
            </select>
          )}
          {field.help && (
            <span className="mt-0.5 block text-[11px] text-slate-400">{field.help}</span>
          )}
        </label>
      ))}
    </div>
  );
}
