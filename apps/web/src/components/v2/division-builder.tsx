"use client";

// Division builder (PROMPT-15 task 1): sport → variant → eligibility template
// → stage graph. Creates the division, then its stages, then lands on the
// division console. Config overrides are validated server-side by the pinned
// module's configSchema — invalid JSON never reaches the DB.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

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
];

const GENDERS = [
  { key: "m", label: "Male" },
  { key: "f", label: "Female" },
  { key: "x", label: "Mixed / other" },
];

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
  const [overridesText, setOverridesText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function selectSport(key: string) {
    setSportKey(key);
    const next = sports.find((s) => s.key === key);
    setVariantKey(next?.variants[0]?.key ?? "");
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

    let overrides: Record<string, unknown> = {};
    if (overridesText.trim()) {
      try {
        overrides = JSON.parse(overridesText) as Record<string, unknown>;
      } catch {
        setError("Config overrides must be valid JSON.");
        return;
      }
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
  const hasSecondStage = template === "league_ko" || template === "groups_ko";

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="card space-y-4 p-6">
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
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs font-medium text-purple-600 hover:underline"
        >
          {showAdvanced ? "Hide" : "Show"} advanced config overrides
        </button>
        {showAdvanced && (
          <label className="block">
            <span className="label">Config overrides (JSON, merged over the variant)</span>
            <textarea
              rows={4}
              value={overridesText}
              onChange={(e) => setOverridesText(e.target.value)}
              placeholder='{"maxOversPerBowler": 4}'
              className="textarea font-mono text-xs"
            />
          </label>
        )}
      </section>

      <section className="card space-y-4 p-6">
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

      <section className="card space-y-4 p-6">
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
                onChange={() => setTemplate(t.key)}
                className="sr-only"
              />
              <span className="block font-medium">{t.label}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{t.help}</span>
            </label>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {(template === "league" || template === "league_ko" || template === "groups_ko") && (
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
                {[2, 4, 8, 16].map((n) => (
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

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push(`/competitions/${competitionId}`)}
          className="btn btn-ghost"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !name.trim() || !sportKey || !variantKey}
          className="btn btn-primary"
        >
          {busy ? "Creating…" : "Create division"}
        </button>
      </div>
    </form>
  );
}
