"use client";

// Division builder (PROMPT-15 task 1): sport → variant → match rules →
// eligibility template → stage graph. Creates the division, then its stages,
// then lands on the division console. Match-rule fields build the config
// override object, validated server-side by the pinned module's configSchema.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MatchRuleFields, SPORT_RULES, buildRuleOverride } from "./match-rules";
import { STAGE_TEMPLATES, buildTemplateStages, type StageDraft } from "./format-templates";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { routes } from "@/lib/routes";
import { UpgradeGate } from "@/components/upgrade-gate";
import { venueNoun, venueLabel } from "@/lib/venue";
import { defaultMatchMinutes } from "@/lib/match-length";
import { FormatExplainerPanel } from "@/components/v2/format-explainer-panel";
import { FormatRecommendStrip } from "@/components/v2/format-recommend-strip";
import { useMsg, useLocale } from "@/components/i18n/dict-provider";
import { sportLabel } from "@/lib/scoring-vocab";

export interface SportOption {
  key: string;
  name: string;
  variants: { key: string; name: string; system: boolean }[];
}

// The most common variant to preselect per sport (else the first listed).
const PREFERRED_VARIANT: Record<string, string> = {
  cricket: "t20",
  tennis: "tour",
  icehockey: "iihf",
  hockey: "fih-outdoor",
};

function pickVariant(sportKey: string, variants: { key: string }[]): string {
  const pref = PREFERRED_VARIANT[sportKey.toLowerCase()];
  if (pref && variants.some((v) => v.key === pref)) return pref;
  return variants[0]?.key ?? "";
}

// Wizard template → format-gallery family (v3/06 §4 "How this works →").
const TEMPLATE_FAMILY: Record<string, string> = {
  league: "league",
  league_ko: "league",
  groups_ko: "groups-knockout",
  group_stepladder: "stepladder",
  swiss: "swiss",
  knockout: "knockout",
  double_elim: "double_elim",
  triple_rr: "league",
  americano: "americano",
  mexicano: "americano",
  ladder: "ladder",
};

// Recommendation slug → wizard template key (strip picks land here).
const FAMILY_TEMPLATE: Record<string, string> = {
  league: "league",
  "groups-knockout": "groups_ko",
  swiss: "swiss",
  knockout: "knockout",
  double_elim: "double_elim",
};

// Mirror of the server preview response (src/server/usecases/stages.ts).
interface PreviewMatch {
  home: string;
  away: string;
}
interface PreviewSection {
  title: string;
  matches: PreviewMatch[];
}
interface PreviewPhase {
  title: string;
  note?: string;
  sections: PreviewSection[];
}

const GENDERS: { key: string; labelKey: "wizard.gender.m" | "wizard.gender.f" | "wizard.gender.x" }[] = [
  { key: "m", labelKey: "wizard.gender.m" },
  { key: "f", labelKey: "wizard.gender.f" },
  { key: "x", labelKey: "wizard.gender.x" },
];

// ---------------------------------------------------------------------------
export function DivisionBuilder({
  competitionId,
  orgSlug,
  compSlug,
  sports,
}: {
  competitionId: string;
  orgSlug: string;
  compSlug: string;
  sports: SportOption[];
}) {
  const msg = useMsg();
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState("");
  const [sportKey, setSportKey] = useState(sports[0]?.key ?? "");
  const sport = useMemo(() => sports.find((s) => s.key === sportKey), [sports, sportKey]);
  const [variantKey, setVariantKey] = useState(
    sport ? pickVariant(sport.key, sport.variants) : "",
  );
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
  const [matchMinutes, setMatchMinutes] = useState(() =>
    defaultMatchMinutes(sports[0]?.key, sports[0] ? pickVariant(sports[0].key, sports[0].variants) : ""),
  );
  // Once the organiser edits the length, stop auto-filling it from the sport.
  const [matchMinutesTouched, setMatchMinutesTouched] = useState(false);
  const [scheduleStart, setScheduleStart] = useState(""); // datetime-local
  const [scheduleEnd, setScheduleEnd] = useState(""); // date

  const [tab, setTab] = useState<"basics" | "eligibility" | "format" | "scheduling">("basics");

  // "Show example" fixture preview (runs the real engine draw server-side).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [previewCount, setPreviewCount] = useState(8);
  const [preview, setPreview] = useState<PreviewPhase[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function selectSport(key: string) {
    setSportKey(key);
    const next = sports.find((s) => s.key === key);
    const firstVariant = next ? pickVariant(next.key, next.variants) : "";
    setVariantKey(firstVariant);
    setRuleValues({}); // rules are sport-specific
    if (!matchMinutesTouched) setMatchMinutes(defaultMatchMinutes(key, firstVariant));
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
    return buildTemplateStages(template, { qualified, swissRounds, poolCount, legs });
  }

  async function submit() {
    // Guard: only the explicit Create button (on the last tab) may create.
    if (tab !== "scheduling") return;
    setError(null);
    setPaywallFeature(null);

    // Only rules the user actually set become overrides; the rest stay on
    // the variant's defaults.
    const overrides = buildRuleOverride(sportKey, ruleValues);

    setBusy(true);
    try {
      const division = await apiV1<{ id: string; slug: string }>(
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

      router.push(routes.division(orgSlug, compSlug, division.slug));
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : msg("wizard.failed"));
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
      if (!name.trim()) return msg("wizard.err.name");
      if (!sportKey) return msg("wizard.err.sport");
      if (!variantKey) return msg("wizard.err.variant");
    }
    if (t === "eligibility" && maxAge) {
      const n = Number(maxAge);
      if (!Number.isInteger(n) || n <= 0) return msg("wizard.err.maxAge");
    }
    if (t === "scheduling") {
      if (!(matchMinutes >= 1)) return msg("wizard.err.matchLength");
      if (!courts.some((c) => c.trim())) return msg("wizard.err.addVenue", { venue });
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

  // Any change to the format or its knobs invalidates a shown example.
  useEffect(() => {
    setPreview(null);
  }, [template, qualified, swissRounds, poolCount, legs]);

  async function runPreview() {
    setPreviewError(null);
    setPreviewBusy(true);
    try {
      const { phases } = await apiV1<{ phases: PreviewPhase[] }>("/api/v1/format-preview", {
        method: "POST",
        json: { count: previewCount, stages: buildStages() },
      });
      setPreview(phases);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : msg("wizard.previewError"));
    } finally {
      setPreviewBusy(false);
    }
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
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {(
          [
            ["basics", msg("wizard.tab.basics")],
            ["eligibility", msg("wizard.tab.eligibility")],
            ["format", msg("wizard.tab.format")],
            ["scheduling", msg("wizard.tab.scheduling")],
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
        <h2 className="text-sm font-semibold text-slate-700">{msg("wizard.sportVariant")}</h2>
        <label className="block">
          <span className="label">{msg("wizard.divisionName")}</span>
          <input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={msg("wizard.divisionNamePlaceholder")}
            className="input"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">{msg("wizard.sport")}</span>
            <select value={sportKey} onChange={(e) => selectSport(e.target.value)} className="select">
              {sports.map((s) => (
                <option key={s.key} value={s.key}>
                  {sportLabel(s.key, msg)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{msg("wizard.variant")}</span>
            <select
              value={variantKey}
              onChange={(e) => {
                setVariantKey(e.target.value);
                if (!matchMinutesTouched) setMatchMinutes(defaultMatchMinutes(sportKey, e.target.value));
              }}
              className="select"
            >
              {(sport?.variants ?? []).map((v) => (
                <option key={v.key} value={v.key}>
                  {v.name}
                  {v.system ? "" : msg("wizard.orgPreset")}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(SPORT_RULES[sportKey] ?? []).length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {msg("wizard.matchRules")}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">{msg("wizard.matchRulesHint")}</p>
            <div className="mt-3">
              <MatchRuleFields sportKey={sportKey} values={ruleValues} onChange={setRuleValues} />
            </div>
          </div>
        )}
      </section>

      <section className={`card space-y-4 p-6 ${tab === "eligibility" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">{msg("wizard.tab.eligibility")}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="label">{msg("wizard.ageGroup")}</span>
            <input
              type="number"
              min={4}
              max={99}
              value={maxAge}
              onChange={(e) => setMaxAge(e.target.value)}
              placeholder={msg("wizard.ageOpen")}
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">{msg("wizard.cutoffMonth")}</span>
            <select
              value={cutoffMonth}
              onChange={(e) => setCutoffMonth(e.target.value)}
              className="select"
              disabled={!maxAge}
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(2000, i, 1).toLocaleString(locale, { month: "long" })}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{msg("wizard.cutoffDay")}</span>
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
          <legend className="label">{msg("wizard.gender")}</legend>
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
                {msg(g.labelKey)}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">{msg("wizard.genderNone")}</p>
        </fieldset>
        <label className="block">
          <span className="label">{msg("wizard.customRule")}</span>
          <input
            value={customNote}
            onChange={(e) => setCustomNote(e.target.value)}
            placeholder={msg("wizard.customRulePlaceholder")}
            className="input"
          />
        </label>
      </section>

      <section className={`card space-y-4 p-6 ${tab === "format" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">{msg("wizard.formatTitle")}</h2>

        {/* v3/06 §4: entrants + courts + hours → the formats that fit. */}
        <FormatRecommendStrip
          onPick={(slug) => {
            const key = FAMILY_TEMPLATE[slug];
            if (key) setTemplate(key);
          }}
        />

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
              <span className="label">{msg("wizard.legs")}</span>
              <select
                value={legs}
                onChange={(e) => setLegs(Number(e.target.value))}
                className="select"
              >
                <option value={1}>{msg("wizard.legsSingle")}</option>
                <option value={2}>{msg("wizard.legsHomeAway")}</option>
              </select>
            </label>
          )}
          {template === "groups_ko" && (
            <label className="block">
              <span className="label">{msg("wizard.pools")}</span>
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
              <span className="label">{msg("wizard.rounds")}</span>
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
              <span className="label">{msg("wizard.qualify")}</span>
              <select
                value={qualified}
                onChange={(e) => setQualified(Number(e.target.value))}
                className="select"
              >
                {(template === "group_stepladder" ? [3, 4, 5, 6] : [2, 4, 8, 16]).map((n) => (
                  <option key={n} value={n}>
                    {msg("schedule.topN", { n })}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {TEMPLATE_FAMILY[template] && (
            <button
              type="button"
              onClick={() => setExplainOpen(true)}
              className="text-sm font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900"
            >
              {msg("wizard.howWorks")}
            </button>
          )}
          {templateInfo && (
            <p className="text-xs text-slate-400">{msg("wizard.generatedHint")}</p>
          )}
        </div>
        {explainOpen && TEMPLATE_FAMILY[template] && (
          <FormatExplainerPanel
            familySlug={TEMPLATE_FAMILY[template]}
            onClose={() => setExplainOpen(false)}
          />
        )}

        {/* Show example — runs the real engine draw over placeholder entrants. */}
        <div className="border-t border-slate-100 pt-4">
          {!previewOpen ? (
            <button
              type="button"
              onClick={() => {
                setPreviewOpen(true);
                void runPreview(); // always reflect the current format
              }}
              className="btn btn-ghost text-sm"
            >
              {msg("wizard.showExample")}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-700">{msg("wizard.exampleFixtures")}</span>
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  {msg("recommend.entrants")}
                  <input
                    type="number"
                    min={2}
                    max={64}
                    value={previewCount}
                    onChange={(e) => setPreviewCount(Math.min(64, Math.max(2, Number(e.target.value) || 2)))}
                    className="input w-16 px-2 py-1 text-sm"
                  />
                </label>
                <button type="button" onClick={() => void runPreview()} disabled={previewBusy} className="btn btn-primary px-3 py-1 text-xs">
                  {previewBusy ? "…" : msg("wizard.generate")}
                </button>
                <button type="button" onClick={() => setPreviewOpen(false)} className="btn btn-ghost px-3 py-1 text-xs">
                  {msg("wizard.hide")}
                </button>
                <span className="text-[11px] text-slate-400">{msg("wizard.placeholderNote")}</span>
              </div>

              {previewError && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{previewError}</p>
              )}

              {preview?.map((phase, pi) => (
                <div key={pi} className="rounded-lg border border-slate-200 p-3">
                  <p className="text-sm font-semibold text-slate-800">{phase.title}</p>
                  {phase.note && <p className="mt-0.5 text-xs text-slate-500">{phase.note}</p>}
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {phase.sections.map((sec, si) => (
                      <div key={si}>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                          {sec.title}
                        </p>
                        <ul className="space-y-0.5">
                          {sec.matches.map((m, mi) => (
                            <li key={mi} className="flex items-center gap-1.5 text-xs text-slate-600">
                              <span className="truncate font-medium text-slate-700">{m.home}</span>
                              <span className="text-slate-400">v</span>
                              <span className="truncate font-medium text-slate-700">{m.away}</span>
                            </li>
                          ))}
                          {sec.matches.length === 0 && (
                            <li className="text-xs text-slate-400">—</li>
                          )}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className={`card space-y-4 p-6 ${tab === "scheduling" ? "" : "hidden"}`}>
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            {msg("wizard.tab.scheduling")} <span className="ml-1 text-xs font-normal text-slate-400">{msg("wizard.optional")}</span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">{msg("wizard.schedulingHint")}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">{msg("boardset.matchLength")}</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={matchMinutes}
              onChange={(e) => {
                setMatchMinutesTouched(true);
                setMatchMinutes(Number(e.target.value) || 30);
              }}
              className="input w-full"
            />
            <span className="mt-0.5 block text-xs text-slate-400">{msg("wizard.matchLengthHint")}</span>
          </label>
          <label className="block">
            <span className="label">{msg("boardset.startAt")}</span>
            <input
              type="datetime-local"
              value={scheduleStart}
              onChange={(e) => setScheduleStart(e.target.value)}
              className="input w-full"
            />
          </label>
          <label className="block">
            <span className="label">{msg("boardset.endAt")}</span>
            <input
              type="date"
              value={scheduleEnd}
              min={scheduleStart ? scheduleStart.slice(0, 10) : undefined}
              onChange={(e) => setScheduleEnd(e.target.value)}
              className="input w-full"
            />
            <span className="mt-0.5 block text-xs text-slate-400">{msg("wizard.endDateHint")}</span>
          </label>
        </div>

        <div>
          <span className="label">{msg("boardset.venuesLabel", { venue: VenueCap })}</span>
          <p className="mb-2 text-xs text-slate-400">{msg("boardset.venuesDesc", { venue })}</p>
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
                    aria-label={msg("boardset.removeVenue", { venue, n: i + 1 })}
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
            {msg("boardset.addVenue", { venue })}
          </button>
          <p className="mt-1 text-xs text-slate-400">
            {msg("wizard.venueCount", { n: courts.filter((c) => c.trim()).length || 1, venue })}
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
          onClick={() => router.push(routes.competition(orgSlug, compSlug))}
          className="btn btn-ghost"
        >
          {msg("wizard.cancel")}
        </button>
        <div className="flex gap-2">
          {tabIndex > 0 && (
            <button
              type="button"
              onClick={() => setTab(TAB_ORDER[tabIndex - 1]!)}
              className="btn btn-ghost"
            >
              {msg("wizard.back")}
            </button>
          )}
          {isLastTab ? (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !name.trim() || !sportKey || !variantKey}
              className="btn btn-primary"
            >
              {busy ? msg("wizard.creating") : msg("wizard.create")}
            </button>
          ) : (
            <button type="button" onClick={goNext} className="btn btn-primary">
              {msg("wizard.next")}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
