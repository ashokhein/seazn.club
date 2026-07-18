"use client";

// Division Settings tab (v8 spec §2): General → Format → Sharing & embed →
// Danger zone, tap-per-section. The format section renders read-only once
// fixtures exist; patchDivision enforces the same rule (409 FORMAT_LOCKED),
// so hiding and enforcement can't drift.
import { useState, type ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { divisionAccent, monogram } from "@/lib/division-hue";
import { MatchRuleFields, buildRuleOverride } from "./match-rules";
import { STAGE_TEMPLATES, buildTemplateStages, detectTemplate } from "./format-templates";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

// The three entrant shapes, in a stable display order. The effective model
// (module default ← division override) decides which are ticked.
const ENTRANT_KINDS = ["individual", "pair", "team"] as const;
const KIND_LABEL_KEY: Record<(typeof ENTRANT_KINDS)[number], MessageKey> = {
  individual: "divset.entrants.kind.individual",
  pair: "divset.entrants.kind.pair",
  team: "divset.entrants.kind.team",
};

export interface DivisionSettingsInfo {
  id: string;
  name: string;
  sport_key: string;
  variant_key: string;
  config: unknown;
  logo_url: string | null;
  logo_storage_path: string | null;
}

function Group({
  title,
  summary,
  defaultOpen = false,
  danger = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card p-0 ${danger ? "border-red-200" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
      >
        <span className={`text-sm font-semibold ${danger ? "text-red-700" : "text-slate-700"}`}>
          {title}
        </span>
        <span className="flex items-center gap-2">
          {summary && !open && (
            <span className="max-w-48 truncate text-xs text-slate-400">{summary}</span>
          )}
          <span aria-hidden className="text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && <div className="space-y-3 px-5 pb-5">{children}</div>}
    </section>
  );
}

async function fileToWebp(file: File, max: number): Promise<Blob> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("bad image"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.88),
  );
  if (!blob) throw new Error("image conversion failed");
  return blob;
}

export function DivisionSettings({
  division,
  variants,
  locked,
  stages,
  canEdit,
  divisionPathPrefix,
  fixturesHref,
  embed,
  danger,
  entrantModel,
  entrantModelSource,
}: {
  division: DivisionSettingsInfo;
  variants: { key: string; name: string }[];
  /** formatLocked() from the page — fixtures exist. */
  locked: boolean;
  /** Stage structure (kind + name) — shown so group/top sections are visible
   *  here; structure itself is edited on the Fixtures tab. */
  stages: { name: string; kind: string; config: Record<string, unknown> | null; qualification: Record<string, unknown> | null }[];
  canEdit: boolean;
  /** "/o/{org}/c/{comp}/d/" — renames regenerate the slug, and the client
   *  must follow it without losing the settings tab. */
  divisionPathPrefix: string;
  fixturesHref: string;
  /** Server-rendered EmbedSnippet (or the private-comp note). */
  embed: ReactNode;
  /** DivisionDangerZone, unchanged. */
  danger: ReactNode;
  /** Resolved effective entrant model (module default merged with any
   *  `config.entrants` override) — seeds the Entrants block's controls. */
  entrantModel: EffectiveEntrantModel;
  /** Whether the effective model comes from the sport default or a saved
   *  `config.entrants` override — drives the caption + Reset affordance. */
  entrantModelSource: "sport" | "override";
}) {
  const msg = useMsg();
  const router = useRouter();
  const [name, setName] = useState(division.name);
  const [logoUrl, setLogoUrl] = useState(division.logo_url);
  const [variantKey, setVariantKey] = useState(division.variant_key);
  // Competition format = the stage structure (League / Groups + Knockout…).
  const detected = detectTemplate(stages);
  const [template, setTemplate] = useState(detected ?? "league");
  const currentQualified = (() => {
    const q = stages.find((st) => st.qualification)?.qualification as
      | { topN?: number; take?: unknown[] }
      | undefined;
    return q?.topN ?? (Array.isArray(q?.take) ? q.take.length : 4);
  })();
  const [qualified, setQualified] = useState(currentQualified);
  const [poolCount, setPoolCount] = useState(
    ((stages.find((st) => st.kind === "group")?.config as { pools?: { count?: number } } | null)?.pools?.count) ?? 2,
  );
  const [swissRounds, setSwissRounds] = useState(
    ((stages.find((st) => st.kind === "swiss")?.config as { rounds?: number } | null)?.rounds) ?? 5,
  );
  const [legs, setLegs] = useState(
    ((stages.find((st) => st.kind === "league" || st.kind === "group")?.config as { legs?: number } | null)?.legs) ?? 1,
  );
  const cfg = (division.config ?? {}) as { points?: { w?: number; d?: number; l?: number }; progressScore?: boolean };
  const [pointsW, setPointsW] = useState(cfg.points ? String(cfg.points.w ?? "") : "");
  const [pointsD, setPointsD] = useState(cfg.points ? String(cfg.points.d ?? "") : "");
  const [pointsL, setPointsL] = useState(cfg.points ? String(cfg.points.l ?? "") : "");
  const [ruleValues, setRuleValues] = useState<Record<string, string>>({});
  const [advancedText, setAdvancedText] = useState("");
  // Entrants block (spec 2026-07-18): the ticked kinds, the default, and the
  // team extras seed from the resolved effective model.
  const [entrantKinds, setEntrantKinds] = useState<string[]>(entrantModel.kinds);
  const [entrantDefault, setEntrantDefault] = useState<string>(entrantModel.defaultKind);
  const [squadNumbers, setSquadNumbers] = useState<boolean>(entrantModel.squadNumbers);
  const [captain, setCaptain] = useState<boolean>(entrantModel.captain);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputId = `division-logo-${division.id}`;
  const hue = divisionAccent(division.id);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("divset.failed"));
    } finally {
      setBusy(false);
    }
  }

  const saveName = () =>
    run(async () => {
      const row = await apiV1<{ slug: string }>(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { name: name.trim() },
      });
      // Renames regenerate the slug — follow it and stay on this tab.
      router.replace(`${divisionPathPrefix}${row.slug}?tab=settings`);
    }, msg("divset.notice.nameSaved"));

  const uploadLogo = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const webp = await fileToWebp(file, 512);
      const { upload_url, storage_path } = await apiV1<{
        upload_url: string;
        storage_path: string;
      }>(`/api/v1/divisions/${division.id}/logo-upload-url`, { method: "POST", json: {} });
      const put = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp" },
        body: webp,
      });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { logo_storage_path: storage_path },
      });
      const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      setLogoUrl(base ? `${base}/storage/v1/object/public/assets/${storage_path}` : null);
    }, msg("divset.notice.logoUploaded"));
  };

  const removeLogo = () =>
    run(async () => {
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { logo_storage_path: null },
      });
      setLogoUrl(null);
    }, msg("divset.notice.logoRemoved"));

  const applyStructure = () =>
    run(async () => {
      const drafts = buildTemplateStages(template, { qualified, swissRounds, poolCount, legs });
      await apiV1(`/api/v1/divisions/${division.id}/stages`, {
        method: "PUT",
        json: drafts.map((d, i) => ({ ...d, seq: i + 1 })),
      });
    }, msg("divset.notice.formatChanged"));

  const applyFormat = () =>
    run(async () => {
      // The server merges preset + override, but presets only carry the
      // variant-identity keys (resultMode/allowDraws) — schema-required keys
      // like progressScore live in the division's current config. Base the
      // override on that valid snapshot; on a variant change, drop the
      // identity keys so the new preset wins them.
      const override: Record<string, unknown> = {
        ...((division.config as Record<string, unknown>) ?? {}),
      };
      if (variantKey !== division.variant_key) {
        delete override.resultMode;
        delete override.allowDraws;
      }
      Object.assign(override, buildRuleOverride(division.sport_key, ruleValues));
      if (pointsW !== "" || pointsD !== "" || pointsL !== "") {
        override.points = {
          w: pointsW === "" ? (cfg.points?.w ?? 0) : Number(pointsW),
          d: pointsD === "" ? (cfg.points?.d ?? 0) : Number(pointsD),
          l: pointsL === "" ? (cfg.points?.l ?? 0) : Number(pointsL),
        };
      }
      if (advancedText.trim() !== "") {
        try {
          Object.assign(override, JSON.parse(advancedText));
        } catch {
          throw new Error(msg("divset.invalidJson"));
        }
      }
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { variant_key: variantKey, config: override },
      });
    }, msg("divset.notice.rulesSaved"));

  // Tick/untick a kind, keeping canonical order and never emptying the list;
  // if the current default falls out, re-point it at the first remaining kind.
  const toggleKind = (kind: string) => {
    const next: string[] = ENTRANT_KINDS.filter((k) =>
      k === kind ? !entrantKinds.includes(k) : entrantKinds.includes(k),
    );
    if (next.length === 0) return;
    setEntrantKinds(next);
    if (!next.includes(entrantDefault)) setEntrantDefault(next[0]!);
  };

  const saveEntrants = () =>
    run(async () => {
      // Same wholesale-config contract as applyFormat: the server merges the
      // variant preset with the sent config and re-validates, so base the
      // override on the current snapshot and set `entrants` on it.
      const entrants: Record<string, unknown> = { kinds: entrantKinds, defaultKind: entrantDefault };
      if (entrantKinds.includes("team")) {
        entrants.squadNumbers = squadNumbers;
        entrants.captain = captain;
      }
      const override = { ...((division.config as Record<string, unknown>) ?? {}), entrants };
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { config: override },
      });
    }, msg("divset.entrants.saved"));

  const resetEntrants = () =>
    run(async () => {
      // Drop the override key → the server re-derives from the module default.
      const override = { ...((division.config as Record<string, unknown>) ?? {}) };
      delete override.entrants;
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { config: override },
      });
    }, msg("divset.entrants.resetDone"));

  return (
    <div className="max-w-2xl space-y-3" data-testid="division-settings">
      <Group title={msg("divset.general")} defaultOpen summary={division.name}>
        <label className="block text-xs text-slate-500">
          {msg("divset.name")}
          <input
            disabled={!canEdit}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input mt-1 w-full"
          />
        </label>
        {canEdit && (
          <button
            type="button"
            disabled={busy || name.trim() === "" || name.trim() === division.name}
            onClick={saveName}
            className="btn btn-primary text-xs"
          >
            {msg("divset.saveName")}
          </button>
        )}

        <div className="flex items-center gap-4 border-t border-slate-100 pt-3">
          {/* Live card-tile preview: logo, else monogram in the accent hue. */}
          <label
            htmlFor={canEdit ? fileInputId : undefined}
            aria-hidden
            data-testid="settings-tile-preview"
            className={`flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg ${canEdit ? "cursor-pointer" : ""}`}
            style={
              logoUrl
                ? undefined
                : { backgroundColor: `color-mix(in srgb, ${hue} 15%, white)`, color: hue }
            }
          >
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- tenant upload
              <img src={logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xl font-bold">{monogram(name || division.name)}</span>
            )}
          </label>
          <div className="min-w-0 flex-1 text-xs text-slate-500">
            <p className="font-medium text-slate-700">{msg("divset.cardLogo")}</p>
            <p className="mt-0.5">{msg("divset.cardLogoDesc")}</p>
            {canEdit && (
              <span className="mt-1 flex gap-3">
                <label htmlFor={fileInputId} className="cursor-pointer text-purple-700 underline">
                  {msg("divset.uploadImage")}
                </label>
                {logoUrl && (
                  <button type="button" disabled={busy} onClick={removeLogo} className="text-red-500 underline">
                    {msg("divset.remove")}
                  </button>
                )}
              </span>
            )}
          </div>
          <input
            id={fileInputId}
            type="file"
            accept="image/*"
            disabled={!canEdit || busy}
            className="sr-only"
            onChange={(e) => uploadLogo(e.target.files?.[0])}
          />
        </div>
      </Group>

      <Group
        title={msg("divset.format")}
        summary={`${division.sport_key} · ${locked ? msg("divset.variantLocked", { variant: division.variant_key }) : division.variant_key}`}
      >
        {locked ? (
          <div data-testid="format-locked" className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">
              {division.sport_key} · {division.variant_key}
            </p>
            <p className="mt-1">
              {msg("divset.lockedNotePre")}
              <Link href={fixturesHref} className="text-purple-700 underline">{msg("divset.fixtures")}</Link>
              {msg("divset.lockedNotePost")}
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {msg("divset.competitionFormat")}
              </p>
              <label className="block text-xs text-slate-500">
                {msg("divset.structure")}
                <select
                  disabled={!canEdit}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  className="input mt-1 w-full"
                  data-testid="format-template"
                >
                  {STAGE_TEMPLATES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span className="mt-0.5 block text-[11px] text-slate-400">
                  {STAGE_TEMPLATES.find((t) => t.key === template)?.help}
                </span>
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {["league_ko", "groups_ko", "group_stepladder"].includes(template) && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.topN")}
                    <input type="number" min={2} max={32} disabled={!canEdit} value={qualified}
                      onChange={(e) => setQualified(Number(e.target.value))} className="input mt-1 w-full" />
                  </label>
                )}
                {template === "groups_ko" && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.groups")}
                    <input type="number" min={2} max={8} disabled={!canEdit} value={poolCount}
                      onChange={(e) => setPoolCount(Number(e.target.value))} className="input mt-1 w-full" />
                  </label>
                )}
                {template === "swiss" && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.rounds")}
                    <input type="number" min={3} max={15} disabled={!canEdit} value={swissRounds}
                      onChange={(e) => setSwissRounds(Number(e.target.value))} className="input mt-1 w-full" />
                  </label>
                )}
                {["league", "league_ko", "groups_ko"].includes(template) && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.legs")}
                    <input type="number" min={1} max={4} disabled={!canEdit} value={legs}
                      onChange={(e) => setLegs(Number(e.target.value))} className="input mt-1 w-full" />
                  </label>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={applyStructure}
                  className="btn btn-primary text-xs"
                  data-testid="apply-structure"
                >
                  {stages.length > 0 ? msg("divset.changeFormat") : msg("divset.setFormat")}
                </button>
              )}
              {detected === null && stages.length > 0 && (
                <p className="text-[11px] text-amber-600">{msg("divset.customStructure")}</p>
              )}
            </div>

            <p className="border-t border-slate-100 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {msg("divset.matchRules")}
            </p>
            <label className="block text-xs text-slate-500">
              {msg("divset.variant")}
              <select
                disabled={!canEdit}
                value={variantKey}
                onChange={(e) => setVariantKey(e.target.value)}
                className="input mt-1 w-full"
              >
                {variants.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>

            {cfg.points && (
              <div>
                <p className="text-xs text-slate-500">{msg("divset.standingsPoints")}</p>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  <label className="block text-xs text-slate-500">
                    {msg("divset.win")}
                    <input type="number" min={0} max={99} disabled={!canEdit} value={pointsW}
                      onChange={(e) => setPointsW(e.target.value)} className="input mt-1 w-full" />
                  </label>
                  <label className="block text-xs text-slate-500">
                    {msg("divset.draw")}
                    <input type="number" min={0} max={99} disabled={!canEdit} value={pointsD}
                      onChange={(e) => setPointsD(e.target.value)} className="input mt-1 w-full" />
                  </label>
                  <label className="block text-xs text-slate-500">
                    {msg("divset.loss")}
                    <input type="number" min={0} max={99} disabled={!canEdit} value={pointsL}
                      onChange={(e) => setPointsL(e.target.value)} className="input mt-1 w-full" />
                  </label>
                </div>
              </div>
            )}

            <MatchRuleFields
              sportKey={division.sport_key}
              values={ruleValues}
              onChange={setRuleValues}
              disabled={!canEdit}
            />

            {stages.length > 0 && (
              <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-500" data-testid="stage-structure">
                {msg("divset.structureLabel")}{" "}
                {stages.map((st, i) => (
                  <span key={i}>
                    {i > 0 && " → "}
                    <span className="font-medium text-slate-700">{st.name}</span> ({st.kind})
                  </span>
                ))}
                {" · "}
                <Link href={fixturesHref} className="text-purple-700 underline">
                  {msg("divset.editStages")}
                </Link>
              </p>
            )}

            <details>
              <summary className="cursor-pointer text-[11px] text-slate-400">
                {msg("divset.advanced")}
              </summary>
              <textarea
                disabled={!canEdit}
                value={advancedText}
                onChange={(e) => setAdvancedText(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder='e.g. { "progressScore": true }'
                className="input mt-1 w-full font-mono text-xs"
              />
            </details>

            {canEdit && (
              <button type="button" disabled={busy} onClick={applyFormat} className="btn btn-primary text-xs">
                {msg("divset.saveRules")}
              </button>
            )}
            <p className="text-[11px] text-slate-400">{msg("divset.rulesNote")}</p>
          </>
        )}
      </Group>

      <Group
        title={msg("divset.entrants.title")}
        summary={entrantKinds.map((k) => msg(KIND_LABEL_KEY[k as (typeof ENTRANT_KINDS)[number]])).join(", ")}
        defaultOpen
      >
        <p className="text-xs text-slate-500">{msg("divset.entrants.desc")}</p>

        {/* Source line: a muted "Sport default" note, or, once overridden, the
            same note swapped for a quiet Reset affordance beside it. */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {entrantModelSource === "sport" ? (
            <span className="text-slate-400" data-testid="entrants-sport-default">
              {msg("divset.entrants.sportDefault")}
            </span>
          ) : (
            <>
              <span className="text-slate-400">{msg("divset.entrants.overridden")}</span>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={resetEntrants}
                  className="rounded text-slate-500 underline transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300"
                >
                  {msg("divset.entrants.reset")}
                </button>
              )}
            </>
          )}
        </div>

        {/* Kinds — multi-select chips, mirroring RoleChipPicker's toggle style.
            min-inline-size:0 keeps the fieldset from bursting narrow cards. */}
        <fieldset className="min-w-0 space-y-1.5 [min-inline-size:0]" disabled={!canEdit}>
          <legend className="label">{msg("divset.entrants.kinds")}</legend>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={msg("divset.entrants.kinds")}>
            {ENTRANT_KINDS.map((kind) => {
              const active = entrantKinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  data-kind={kind}
                  aria-pressed={active}
                  onClick={() => toggleKind(kind)}
                  disabled={!canEdit}
                  className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 disabled:cursor-not-allowed disabled:opacity-60 ${
                    active
                      ? "border-purple-600 bg-purple-600 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-purple-300"
                  }`}
                >
                  {msg(KIND_LABEL_KEY[kind])}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="block text-xs text-slate-500">
          {msg("divset.entrants.defaultKind")}
          <select
            disabled={!canEdit}
            value={entrantDefault}
            onChange={(e) => setEntrantDefault(e.target.value)}
            className="input mt-1 block w-full sm:w-auto"
          >
            {entrantKinds.map((kind) => (
              <option key={kind} value={kind}>
                {msg(KIND_LABEL_KEY[kind as (typeof ENTRANT_KINDS)[number]])}
              </option>
            ))}
          </select>
        </label>

        {/* Team affordances — indented + grouped, shown only while a team kind
            is ticked (there is nothing to number or captain otherwise). */}
        {entrantKinds.includes("team") && (
          <div className="space-y-2 rounded-lg bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {msg("divset.entrants.teamOptions")}
            </p>
            <label className="flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={squadNumbers}
                onChange={(e) => setSquadNumbers(e.target.checked)}
                disabled={!canEdit}
                className="mt-0.5"
              />
              {msg("divset.entrants.squadNumbers")}
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={captain}
                onChange={(e) => setCaptain(e.target.checked)}
                disabled={!canEdit}
                className="mt-0.5"
              />
              {msg("divset.entrants.captain")}
            </label>
          </div>
        )}

        {canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={saveEntrants}
            className="btn btn-primary w-full text-xs sm:w-auto"
          >
            {msg("divset.entrants.save")}
          </button>
        )}
        <p className="text-[11px] text-slate-400">{msg("divset.entrants.note")}</p>
      </Group>

      <Group title={msg("divset.sharing")} summary={msg("divset.sharingSummary")}>
        {embed}
      </Group>

      <Group title={msg("divset.danger")} summary={msg("divset.dangerSummary")} danger>
        {danger}
      </Group>

      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
