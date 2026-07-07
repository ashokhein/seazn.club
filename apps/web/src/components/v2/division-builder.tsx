"use client";

// Division builder (PROMPT-15 task 1): sport → variant → match rules →
// eligibility template → stage graph. Creates the division, then its stages,
// then lands on the division console. Match-rule fields build the config
// override object, validated server-side by the pinned module's configSchema.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { venueNoun, venueLabel } from "@/lib/venue";

export interface SportOption {
  key: string;
  name: string;
  variants: { key: string; name: string; system: boolean }[];
}

interface StageDraft {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  qualification: Record<string, unknown> | null;
}

// One-click stage graphs. `qualified(n)` = how many advance to stage 2.
const STAGE_TEMPLATES: {
  key: string;
  label: string;
  help: string;
  build: (q: number) => StageDraft[];
}[] = [
  {
    key: "league",
    label: "League",
    help: "Single round robin, table decides.",
    build: () => [{ kind: "league", name: "League", config: { legs: 1 }, qualification: null }],
  },
  {
    key: "league_ko",
    label: "League + Finals",
    help: "Round robin, then top N knockout.",
    build: (q) => [
      { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
      { kind: "knockout", name: "Finals", config: {}, qualification: { topN: q } },
    ],
  },
  {
    key: "groups_ko",
    label: "Groups + Knockout",
    help: "Two pools, top of each cross over.",
    build: (q) => [
      {
        kind: "group",
        name: "Group stage",
        config: { legs: 1, pools: { count: 2 } },
        qualification: null,
      },
      {
        kind: "knockout",
        name: "Knockout",
        config: {},
        qualification: {
          take: Array.from({ length: q }, (_, i) => ({
            pool: i % 2 === 0 ? "A" : "B",
            rank: Math.floor(i / 2) + 1,
          })),
        },
      },
    ],
  },
  {
    key: "group_stepladder",
    label: "Group + Stepladder",
    help: "Round robin, then a stepladder final — lowest seed climbs.",
    build: (q) => [
      { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
      { kind: "stepladder", name: "Stepladder finals", config: {}, qualification: { topN: q } },
    ],
  },
  {
    key: "swiss",
    label: "Swiss",
    help: "Score-group pairings, fixed rounds.",
    build: () => [
      { kind: "swiss", name: "Swiss", config: { rounds: 5 }, qualification: null },
    ],
  },
  {
    key: "knockout",
    label: "Knockout",
    help: "Single elimination bracket.",
    build: () => [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
  },
  {
    key: "double_elim",
    label: "Double elimination",
    help: "Losers bracket + grand final (Pro).",
    build: () => [
      { kind: "double_elim", name: "Double elimination", config: {}, qualification: null },
    ],
  },
  {
    key: "triple_rr",
    label: "Triple round robin",
    help: "Everyone plays everyone three times (Jul3/08).",
    build: () => [{ kind: "league", name: "Triple RR", config: { legs: 3 }, qualification: null }],
  },
  {
    key: "americano",
    label: "Americano (padel)",
    help: "Individuals rotate partners each round; personal points (Pro).",
    build: () => [
      { kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 7 }, qualification: null },
    ],
  },
  {
    key: "mexicano",
    label: "Mexicano (padel)",
    help: "Re-rank each round: 1+4 vs 2+3 from live points (Pro).",
    build: () => [
      { kind: "americano", name: "Mexicano", config: { mode: "mexicano", courtCount: 2, rounds: 7 }, qualification: null },
    ],
  },
  {
    key: "ladder",
    label: "Ladder",
    help: "Open standings; players challenge upward over a long window (Pro).",
    build: () => [
      { kind: "ladder", name: "Ladder", config: { challengeRange: 3 }, qualification: null },
    ],
  },
];

const GENDERS = [
  { key: "m", label: "Male" },
  { key: "f", label: "Female" },
  { key: "x", label: "Mixed / other" },
];

// ---------------------------------------------------------------------------
// Match rules — curated per-sport fields that build the config override
// object (previously a raw-JSON textarea). Blank = keep the variant default;
// the pinned module's configSchema still validates server-side.
// ---------------------------------------------------------------------------

interface RuleField {
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

const SPORT_RULES: Record<string, RuleField[]> = {
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

export function DivisionBuilder({
  competitionId,
  sports,
}: {
  competitionId: string;
  sports: SportOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [sportKey, setSportKey] = useState(sports[0]?.key ?? "");
  const sport = useMemo(() => sports.find((s) => s.key === sportKey), [sports, sportKey]);
  const [variantKey, setVariantKey] = useState(sport?.variants[0]?.key ?? "");
  // Match-rule values keyed by RuleField.key; "" = keep the variant default.
  const [ruleValues, setRuleValues] = useState<Record<string, string>>({});

  // Eligibility template (doc 06 §2): age cutoff + gender + note.
  const [maxAge, setMaxAge] = useState("");
  const [cutoffMonth, setCutoffMonth] = useState("1");
  const [cutoffDay, setCutoffDay] = useState("1");
  const [genders, setGenders] = useState<string[]>([]);
  const [customNote, setCustomNote] = useState("");

  const [template, setTemplate] = useState("league");
  const [qualified, setQualified] = useState(4);
  const [swissRounds, setSwissRounds] = useState(5);
  const [poolCount, setPoolCount] = useState(2);
  const [legs, setLegs] = useState(1);

  // Scheduling (optional — can also be edited later on the schedule board).
  const [courts, setCourts] = useState<string[]>(() => [`${venueLabel(sports[0]?.key)} 1`]);
  const [matchMinutes, setMatchMinutes] = useState(30);
  const [scheduleStart, setScheduleStart] = useState(""); // datetime-local
  const [scheduleEnd, setScheduleEnd] = useState(""); // date

  const [tab, setTab] = useState<"basics" | "eligibility" | "format" | "scheduling">("basics");

  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function selectSport(key: string) {
    setSportKey(key);
    const next = sports.find((s) => s.key === key);
    setVariantKey(next?.variants[0]?.key ?? "");
    setRuleValues({}); // rules are sport-specific
    // Rename the default single venue to match the sport, unless the organiser
    // has already customised the list.
    setCourts((cs) =>
      cs.length === 1 && /^(Court|Pitch|Table|Board) 1$/.test(cs[0]!.trim())
        ? [`${venueLabel(key)} 1`]
        : cs,
    );
  }

  function buildEligibility(): Record<string, unknown>[] {
    const rules: Record<string, unknown>[] = [];
    const age = Number(maxAge);
    if (maxAge && Number.isInteger(age) && age > 0) {
      // "U16" = 15 or younger on the cutoff (doc 06 §2.1) — always explicit.
      rules.push({
        kind: "age",
        maxAgeAt: age - 1,
        cutoff: { month: Number(cutoffMonth), day: Number(cutoffDay), yearOf: "season_start" },
      });
    }
    if (genders.length > 0) rules.push({ kind: "gender", allowed: genders });
    if (customNote.trim()) rules.push({ kind: "custom", note: customNote.trim() });
    return rules;
  }

  function buildStages(): StageDraft[] {
    const t = STAGE_TEMPLATES.find((s) => s.key === template);
    const drafts = (t ?? STAGE_TEMPLATES[0]).build(qualified);
    // Apply the knob values onto the template's first stage.
    return drafts.map((d) => {
      const config = { ...d.config };
      if (d.kind === "swiss") config.rounds = swissRounds;
      if (d.kind === "league" || d.kind === "group") config.legs = legs;
      if (d.kind === "group") config.pools = { count: poolCount };
      return { ...d, config };
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPaywallFeature(null);

    // Only rules the user actually set become overrides; the rest stay on
    // the variant's defaults.
    let overrides: Record<string, unknown> = {};
    for (const field of SPORT_RULES[sportKey] ?? []) {
      const value = ruleValues[field.key];
      if (value) overrides = { ...overrides, ...field.build(value) };
    }

    setBusy(true);
    try {
      const division = await apiV1<{ id: string }>(
        `/api/v1/competitions/${competitionId}/divisions`,
        {
          method: "POST",
          json: {
            name,
            sport_key: sportKey,
            variant_key: variantKey,
            config: overrides,
            eligibility: buildEligibility(),
          },
        },
      );
      const stages = buildStages().map((s, i) => ({ ...s, seq: i + 1 }));
      await apiV1(`/api/v1/divisions/${division.id}/stages`, {
        method: "POST",
        json: stages,
      });

      // Seed scheduling settings (courts / match length / start). Non-fatal:
      // the board can set these later, so a failure here shouldn't block create.
      const cleanCourts = courts.map((c) => c.trim()).filter(Boolean);
      try {
        await apiV1(`/api/v1/divisions/${division.id}/schedule-settings`, {
          method: "PUT",
          json: {
            config: {
              courts: cleanCourts.length ? cleanCourts : ["Court 1"],
              matchMinutes,
              startAt: scheduleStart ? new Date(scheduleStart).toISOString() : null,
              endAt: scheduleEnd ? new Date(`${scheduleEnd}T23:59:00`).toISOString() : null,
            },
          },
        });
      } catch {
        /* board settings are editable later — ignore */
      }

      router.push(`/divisions/${division.id}`);
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
      setBusy(false);
    }
  }

  const templateInfo = STAGE_TEMPLATES.find((t) => t.key === template);
  const venue = venueNoun(sportKey); // "pitch" / "table" / "court" / "board"
  const VenueCap = venueLabel(sportKey);

  // Wizard flow: Next validates the current tab before advancing.
  const TAB_ORDER = ["basics", "eligibility", "format", "scheduling"] as const;
  const tabIndex = TAB_ORDER.indexOf(tab);
  const isLastTab = tabIndex === TAB_ORDER.length - 1;

  function tabError(t: (typeof TAB_ORDER)[number]): string | null {
    if (t === "basics") {
      if (!name.trim()) return "Enter a division name.";
      if (!sportKey) return "Choose a sport.";
      if (!variantKey) return "Choose a variant.";
    }
    if (t === "eligibility" && maxAge) {
      const n = Number(maxAge);
      if (!Number.isInteger(n) || n <= 0) return "Max age must be a whole number above 0.";
    }
    if (t === "scheduling") {
      if (!(matchMinutes >= 1)) return "Match length must be at least 1 minute.";
      if (!courts.some((c) => c.trim())) return `Add at least one ${venue}.`;
    }
    return null;
  }

  function goNext() {
    const err = tabError(tab);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setTab(TAB_ORDER[Math.min(tabIndex + 1, TAB_ORDER.length - 1)]!);
  }

  // Nav jumps: going back is free; going forward must clear the current tab.
  function goToTab(key: (typeof TAB_ORDER)[number]) {
    if (TAB_ORDER.indexOf(key) > tabIndex) {
      const err = tabError(tab);
      if (err) {
        setError(err);
        return;
      }
    }
    setError(null);
    setTab(key);
  }
  const hasSecondStage =
    template === "league_ko" || template === "groups_ko" || template === "group_stepladder";

  return (
    <form onSubmit={submit} className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {(
          [
            ["basics", "Basics"],
            ["eligibility", "Eligibility"],
            ["format", "Format"],
            ["scheduling", "Scheduling"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => goToTab(key)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === key
                ? "border-purple-600 text-purple-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className={`card space-y-4 p-6 ${tab === "basics" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">Sport & variant</h2>
        <label className="block">
          <span className="label">Division name</span>
          <input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="U16 Boys T20"
            className="input"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Sport</span>
            <select value={sportKey} onChange={(e) => selectSport(e.target.value)} className="select">
              {sports.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Variant</span>
            <select
              value={variantKey}
              onChange={(e) => setVariantKey(e.target.value)}
              className="select"
            >
              {(sport?.variants ?? []).map((v) => (
                <option key={v.key} value={v.key}>
                  {v.name}
                  {v.system ? "" : " (org preset)"}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(SPORT_RULES[sportKey] ?? []).length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Match rules
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Leave a field on its default to use the variant&apos;s standard rules.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              {(SPORT_RULES[sportKey] ?? []).map((field) => (
                <label key={field.key} className="block">
                  <span className="label">{field.label}</span>
                  {field.kind === "number" ? (
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      value={ruleValues[field.key] ?? ""}
                      onChange={(e) =>
                        setRuleValues({ ...ruleValues, [field.key]: e.target.value })
                      }
                      placeholder="Default"
                      className="input"
                    />
                  ) : (
                    <select
                      value={ruleValues[field.key] ?? ""}
                      onChange={(e) =>
                        setRuleValues({ ...ruleValues, [field.key]: e.target.value })
                      }
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
          </div>
        )}
      </section>

      <section className={`card space-y-4 p-6 ${tab === "eligibility" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">Eligibility</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="label">Age group (e.g. 16 = U16)</span>
            <input
              type="number"
              min={4}
              max={99}
              value={maxAge}
              onChange={(e) => setMaxAge(e.target.value)}
              placeholder="Open"
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">Cutoff month</span>
            <select
              value={cutoffMonth}
              onChange={(e) => setCutoffMonth(e.target.value)}
              className="select"
              disabled={!maxAge}
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(2000, i, 1).toLocaleString("en", { month: "long" })}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Cutoff day</span>
            <input
              type="number"
              min={1}
              max={31}
              value={cutoffDay}
              onChange={(e) => setCutoffDay(e.target.value)}
              className="input"
              disabled={!maxAge}
            />
          </label>
        </div>
        <fieldset>
          <legend className="label">Gender</legend>
          <div className="flex flex-wrap gap-2">
            {GENDERS.map((g) => (
              <label
                key={g.key}
                className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition ${
                  genders.includes(g.key)
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : "border-slate-200 text-slate-500 hover:border-purple-200"
                }`}
              >
                <input
                  type="checkbox"
                  checked={genders.includes(g.key)}
                  onChange={(e) =>
                    setGenders(
                      e.target.checked
                        ? [...genders, g.key]
                        : genders.filter((k) => k !== g.key),
                    )
                  }
                  className="sr-only"
                />
                {g.label}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">None selected = open to all.</p>
        </fieldset>
        <label className="block">
          <span className="label">Custom rule (manual, shown as a warning)</span>
          <input
            value={customNote}
            onChange={(e) => setCustomNote(e.target.value)}
            placeholder="School-registered students only"
            className="input"
          />
        </label>
      </section>

      <section className={`card space-y-4 p-6 ${tab === "format" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">Format (stage graph)</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {STAGE_TEMPLATES.map((t) => (
            <label
              key={t.key}
              className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                template === t.key
                  ? "border-purple-500 bg-purple-50 text-purple-800"
                  : "border-slate-200 bg-white text-slate-600 hover:border-purple-200"
              }`}
            >
              <input
                type="radio"
                name="template"
                checked={template === t.key}
                onChange={() => {
                  setTemplate(t.key);
                  // Keep the qualifier valid for the template's option list.
                  if (t.key === "group_stepladder" && ![3, 4, 5, 6].includes(qualified)) {
                    setQualified(4);
                  } else if (t.key !== "group_stepladder" && ![2, 4, 8, 16].includes(qualified)) {
                    setQualified(4);
                  }
                }}
                className="sr-only"
              />
              <span className="block font-medium">{t.label}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t.help}</span>
            </label>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {(template === "league" ||
            template === "league_ko" ||
            template === "groups_ko" ||
            template === "group_stepladder") && (
            <label className="block">
              <span className="label">Legs</span>
              <select
                value={legs}
                onChange={(e) => setLegs(Number(e.target.value))}
                className="select"
              >
                <option value={1}>Single round robin</option>
                <option value={2}>Home & away</option>
              </select>
            </label>
          )}
          {template === "groups_ko" && (
            <label className="block">
              <span className="label">Pools</span>
              <input
                type="number"
                min={2}
                max={8}
                value={poolCount}
                onChange={(e) => setPoolCount(Number(e.target.value))}
                className="input"
              />
            </label>
          )}
          {template === "swiss" && (
            <label className="block">
              <span className="label">Rounds</span>
              <input
                type="number"
                min={1}
                max={15}
                value={swissRounds}
                onChange={(e) => setSwissRounds(Number(e.target.value))}
                className="input"
              />
            </label>
          )}
          {hasSecondStage && (
            <label className="block">
              <span className="label">Qualify to finals</span>
              <select
                value={qualified}
                onChange={(e) => setQualified(Number(e.target.value))}
                className="select"
              >
                {(template === "group_stepladder" ? [3, 4, 5, 6] : [2, 4, 8, 16]).map((n) => (
                  <option key={n} value={n}>
                    Top {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {templateInfo && (
          <p className="text-xs text-slate-400">
            Fixtures are generated per stage from the division console — nothing is
            locked in until you generate.
          </p>
        )}
      </section>

      <section className={`card space-y-4 p-6 ${tab === "scheduling" ? "" : "hidden"}`}>
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            Scheduling <span className="ml-1 text-xs font-normal text-slate-400">optional</span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Courts, match length and a start time for the timetable. You can change these later on
            the schedule board.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Match length (minutes)</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={matchMinutes}
              onChange={(e) => setMatchMinutes(Number(e.target.value) || 30)}
              className="input w-full"
            />
          </label>
          <label className="block">
            <span className="label">Start date &amp; time</span>
            <input
              type="datetime-local"
              value={scheduleStart}
              onChange={(e) => setScheduleStart(e.target.value)}
              className="input w-full"
            />
          </label>
          <label className="block">
            <span className="label">End date</span>
            <input
              type="date"
              value={scheduleEnd}
              min={scheduleStart ? scheduleStart.slice(0, 10) : undefined}
              onChange={(e) => setScheduleEnd(e.target.value)}
              className="input w-full"
            />
            <span className="mt-0.5 block text-xs text-slate-400">
              Sets how many days the schedule&apos;s week view spans.
            </span>
          </label>
        </div>

        <div>
          <span className="label">{VenueCap}s</span>
          <p className="mb-2 text-xs text-slate-400">
            Name each {venue} available — matches run in parallel across them.
          </p>
          <ul className="space-y-2">
            {courts.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  value={c}
                  onChange={(e) =>
                    setCourts((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))
                  }
                  placeholder={`${VenueCap} ${i + 1}`}
                  maxLength={100}
                  className="input flex-1"
                />
                {courts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setCourts((cs) => cs.filter((_, j) => j !== i))}
                    aria-label={`Remove ${venue} ${i + 1}`}
                    className="rounded-md px-2 py-1 text-sm text-red-500 hover:bg-red-50"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() =>
              setCourts((cs) => (cs.length < 50 ? [...cs, `${VenueCap} ${cs.length + 1}`] : cs))
            }
            className="btn btn-ghost mt-2 text-sm"
          >
            + Add {venue}
          </button>
          <p className="mt-1 text-xs text-slate-400">
            {courts.filter((c) => c.trim()).length || 1} {venue}
            {(courts.filter((c) => c.trim()).length || 1) === 1 ? "" : "s"}
          </p>
        </div>
      </section>

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => router.push(`/competitions/${competitionId}`)}
          className="btn btn-ghost"
        >
          Cancel
        </button>
        <div className="flex gap-2">
          {tabIndex > 0 && (
            <button
              type="button"
              onClick={() => setTab(TAB_ORDER[tabIndex - 1]!)}
              className="btn btn-ghost"
            >
              Back
            </button>
          )}
          {isLastTab ? (
            <button
              type="submit"
              disabled={busy || !name.trim() || !sportKey || !variantKey}
              className="btn btn-primary"
            >
              {busy ? "Creating…" : "Create division"}
            </button>
          ) : (
            <button type="button" onClick={goNext} className="btn btn-primary">
              Next
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
