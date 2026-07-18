"use client";

// SPEC-1 rules editor (division Settings → Discipline). Two rule families:
// accumulation (repeating card counts → ban) and dismissal (a single card →
// ban). Colours are exactly what the sport module offers. Sport defaults are
// prefilled server-side; when a division has genuinely empty rules we seed the
// same defaults client-side so the editor is never blank. Division-wizard
// .input/.label look, no bespoke controls.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { CardGlyph, toneForColor } from "./card-glyph";

export interface DisciplineRules {
  accumulation: { key: string; color: string; count: number; ban_matches: number }[];
  dismissal: { key: string; color: string; ban_matches: number }[];
}
type Color = { key: string; label: string };
type AccRow = { color: string; count: number; ban_matches: number };
type DisRow = { color: string; ban_matches: number };

/** Sport defaults from the offered colours — football's FA shape when yellow +
 *  red exist, dismissal-only for anything else. Pure; unit-tested. */
export function defaultRulesFor(colors: Color[]): DisciplineRules {
  const has = (k: string) => colors.some((c) => c.key === k);
  const accumulation: DisciplineRules["accumulation"] = has("yellow")
    ? [
        { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
        { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
      ]
    : [];
  const dismissal: DisciplineRules["dismissal"] = [];
  if (has("second_yellow")) dismissal.push({ key: "second_yellow", color: "second_yellow", ban_matches: 1 });
  if (has("red")) dismissal.push({ key: "red", color: "red", ban_matches: 1 });
  if (dismissal.length === 0) {
    for (const c of colors) {
      if (!c.key.includes("yellow")) dismissal.push({ key: c.key, color: c.key, ban_matches: 1 });
    }
  }
  return { accumulation, dismissal };
}

/** State rows → the exact rules doc the PUT posts. Keys are derived from
 *  (colour, count) so re-editing the same rule keeps its idempotency bucket. */
export function serializeRules(acc: AccRow[], dis: DisRow[]): DisciplineRules {
  return {
    accumulation: acc.map((r) => ({
      key: `${r.color}_${r.count}`,
      color: r.color,
      count: r.count,
      ban_matches: r.ban_matches,
    })),
    dismissal: dis.map((r) => ({ key: r.color, color: r.color, ban_matches: r.ban_matches })),
  };
}

function labelFor(colors: Color[], key: string): string {
  return colors.find((c) => c.key === key)?.label ?? key;
}

export function RulesEditor({
  divisionId,
  enabled: initialEnabled,
  rules: initialRules,
  sportColors,
  canEdit,
}: {
  divisionId: string;
  enabled: boolean;
  rules: DisciplineRules;
  sportColors: Color[];
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const seed =
    initialRules.accumulation.length === 0 && initialRules.dismissal.length === 0
      ? defaultRulesFor(sportColors)
      : initialRules;
  const [enabled, setEnabled] = useState(initialEnabled);
  const [acc, setAcc] = useState<AccRow[]>(
    seed.accumulation.map((r) => ({ color: r.color, count: r.count, ban_matches: r.ban_matches })),
  );
  const [dis, setDis] = useState<DisRow[]>(
    seed.dismissal.map((r) => ({ color: r.color, ban_matches: r.ban_matches })),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const defaultColor = sportColors[0]?.key ?? "yellow";
  const dismissalColor =
    sportColors.find((c) => !c.key.includes("yellow"))?.key ?? sportColors[0]?.key ?? "red";

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/discipline-rules`, {
        method: "PUT",
        json: { enabled, rules: serializeRules(acc, dis) },
      });
      setNotice(msg("disc.rules.saved"));
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiV1Error ? err.message : err instanceof Error ? err.message : msg("disc.rules.failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-5 p-5" data-testid="discipline-rules">
      <div>
        <h2 className="app-display text-base font-semibold text-slate-800">{msg("disc.rules.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{msg("disc.rules.desc")}</p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4"
          disabled={!canEdit}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {msg("disc.rules.enable")}
      </label>

      {/* Accumulation */}
      <div className="space-y-2 border-t border-slate-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {msg("disc.rules.accumulation")}
        </p>
        <p className="text-[11px] text-slate-400">{msg("disc.rules.accumulationHint")}</p>
        {acc.length === 0 && <p className="text-xs text-slate-400">{msg("disc.rules.none")}</p>}
        {acc.map((row, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2" data-testid="acc-row">
            <CardGlyph tone={toneForColor(row.color)} className="mb-2" />
            <label className="block text-[11px] text-slate-500">
              {msg("disc.rules.color")}
              <select
                disabled={!canEdit}
                value={row.color}
                onChange={(e) => setAcc(patch(acc, i, { color: e.target.value }))}
                className="input mt-1 w-32"
                aria-label={msg("disc.rules.color")}
              >
                {sportColors.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] text-slate-500">
              {msg("disc.rules.count")}
              <input
                type="number"
                min={1}
                max={99}
                disabled={!canEdit}
                value={row.count}
                onChange={(e) => setAcc(patch(acc, i, { count: Number(e.target.value) }))}
                className="input mt-1 w-20"
                aria-label={msg("disc.rules.count")}
              />
            </label>
            <label className="block text-[11px] text-slate-500">
              {msg("disc.rules.ban")}
              <input
                type="number"
                min={1}
                max={20}
                disabled={!canEdit}
                value={row.ban_matches}
                onChange={(e) => setAcc(patch(acc, i, { ban_matches: Number(e.target.value) }))}
                className="input mt-1 w-20"
                aria-label={msg("disc.rules.ban")}
              />
            </label>
            {canEdit && (
              <button
                type="button"
                onClick={() => setAcc(acc.filter((_, j) => j !== i))}
                className="mb-1 text-xs text-red-500 hover:underline"
              >
                {msg("disc.rules.remove")}
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button
            type="button"
            onClick={() => setAcc([...acc, { color: defaultColor, count: 5, ban_matches: 1 }])}
            className="btn btn-ghost text-xs"
          >
            + {msg("disc.rules.addAccumulation")}
          </button>
        )}
      </div>

      {/* Dismissal */}
      <div className="space-y-2 border-t border-slate-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {msg("disc.rules.dismissal")}
        </p>
        <p className="text-[11px] text-slate-400">{msg("disc.rules.dismissalHint")}</p>
        {dis.length === 0 && <p className="text-xs text-slate-400">{msg("disc.rules.none")}</p>}
        {dis.map((row, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2" data-testid="dis-row">
            <CardGlyph tone={toneForColor(row.color)} className="mb-2" />
            <label className="block text-[11px] text-slate-500">
              {msg("disc.rules.color")}
              <select
                disabled={!canEdit}
                value={row.color}
                onChange={(e) => setDis(patch(dis, i, { color: e.target.value }))}
                className="input mt-1 w-40"
                aria-label={msg("disc.rules.color")}
              >
                {sportColors.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] text-slate-500">
              {msg("disc.rules.ban")}
              <input
                type="number"
                min={1}
                max={20}
                disabled={!canEdit}
                value={row.ban_matches}
                onChange={(e) => setDis(patch(dis, i, { ban_matches: Number(e.target.value) }))}
                className="input mt-1 w-20"
                aria-label={msg("disc.rules.ban")}
              />
            </label>
            {canEdit && (
              <button
                type="button"
                onClick={() => setDis(dis.filter((_, j) => j !== i))}
                className="mb-1 text-xs text-red-500 hover:underline"
              >
                {msg("disc.rules.remove")}
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button
            type="button"
            onClick={() => setDis([...dis, { color: dismissalColor, ban_matches: 1 }])}
            className="btn btn-ghost text-xs"
          >
            + {msg("disc.rules.addDismissal")}
          </button>
        )}
      </div>

      {canEdit && (
        <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
          <button type="button" disabled={busy} onClick={save} className="btn btn-primary text-sm">
            {msg("disc.rules.save")}
          </button>
          {notice && <span className="text-xs text-emerald-600">{notice}</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      )}
      {/* Hidden semantic summary so tests + screen readers can read the doc. */}
      <p className="sr-only" data-testid="rules-summary">
        {acc.map((r) => `${labelFor(sportColors, r.color)} ${r.count}/${r.ban_matches}`).join(", ")}
        {" | "}
        {dis.map((r) => `${labelFor(sportColors, r.color)}/${r.ban_matches}`).join(", ")}
      </p>
    </section>
  );
}

function patch<T>(rows: T[], i: number, next: Partial<T>): T[] {
  return rows.map((r, j) => (j === i ? { ...r, ...next } : r));
}
