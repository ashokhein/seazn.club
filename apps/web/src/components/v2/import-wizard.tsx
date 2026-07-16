"use client";

// Import wizard (Jul3/01 §8): upload → column mapper (remembered per org) →
// preview grouped by club with per-row op badges + issue list → Commit.
// The preview IS the ImportPlan rendered — no surprise writes.
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

const FIELDS: [string, MessageKey][] = [
  ["", "import.field.ignore"],
  ["clubName", "import.field.club"],
  ["clubShortName", "import.field.clubShort"],
  ["clubExternalRef", "import.field.clubRef"],
  ["teamName", "import.field.team"],
  ["teamShortName", "import.field.teamShort"],
  ["playerFullName", "import.field.player"],
  ["dob", "import.field.dob"],
  ["gender", "import.field.gender"],
  ["squadNumber", "import.field.squad"],
  ["position", "import.field.position"],
  ["isCaptain", "import.field.captain"],
  ["divisionSlug", "import.field.division"],
  ["entrantDisplayName", "import.field.entrant"],
];

interface ImportIssue {
  rowNo: number;
  column?: string;
  severity: "error" | "warn";
  code: string;
  message: string;
}
interface ImportOp {
  kind: string;
  ref?: string;
  sourceRows: number[];
  after?: Record<string, unknown>;
}
interface ImportPlan {
  ops: ImportOp[];
  stats: { clubs: number; teams: number; persons: number; entrants: number; rosters: number };
  issues: ImportIssue[];
}
interface Preview {
  importId: string;
  filename: string;
  rowCount: number;
  mapping?: Record<string, string>;
  plan: ImportPlan;
}
interface CommitResult {
  importId: string;
  stats: ImportPlan["stats"];
  divisionIds: string[];
}

const OP_BADGE: Record<string, { labelKey: MessageKey; cls: string }> = {
  "club.create": { labelKey: "import.op.clubCreate", cls: "bg-emerald-50 text-emerald-700" },
  "club.update": { labelKey: "import.op.clubUpdate", cls: "bg-sky-50 text-sky-700" },
  "team.create": { labelKey: "import.op.teamCreate", cls: "bg-emerald-50 text-emerald-700" },
  "team.link": { labelKey: "import.op.teamLink", cls: "bg-sky-50 text-sky-700" },
  "person.create": { labelKey: "import.op.personCreate", cls: "bg-emerald-50 text-emerald-700" },
  "entrant.create": { labelKey: "import.op.entrantCreate", cls: "bg-violet-50 text-violet-700" },
  "roster.add": { labelKey: "import.op.rosterAdd", cls: "bg-slate-100 text-slate-600" },
};

async function postForm<T>(url: string, form: FormData, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, { method: "POST", body: form, headers });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; [k: string]: unknown };
  };
  if (!res.ok || payload.ok === false) {
    const { code = "UNKNOWN", message, ...extra } = payload.error ?? {};
    throw new ApiV1Error(message ?? `Request failed (${res.status})`, res.status, code, extra);
  }
  return payload.data as T;
}

export function ImportWizard() {
  const msg = useMsg();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CommitResult | null>(null);
  const [warnsAcknowledged, setWarnsAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const errors = preview?.plan.issues.filter((i) => i.severity === "error") ?? [];
  const warns = preview?.plan.issues.filter((i) => i.severity === "warn") ?? [];

  function fail(err: unknown) {
    if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
      setPaywallFeature(String(err.extra.feature_key ?? ""));
    } else {
      setError(err instanceof Error ? err.message : msg("import.failed"));
    }
  }

  async function upload(selected: File, withMapping?: Record<string, string>) {
    setError(null);
    setPaywallFeature(null);
    setResult(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", selected);
      const remembered =
        withMapping ??
        (JSON.parse(localStorage.getItem("import-mapping") ?? "null") as Record<string, string> | null) ??
        undefined;
      if (remembered && Object.keys(remembered).length > 0) {
        form.append("mapping", JSON.stringify(remembered));
      }
      const data = await postForm<Preview>("/api/v1/imports", form);
      setPreview(data);
      setMapping(data.mapping ?? {});
      setWarnsAcknowledged(false);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function remap() {
    if (!file) return;
    localStorage.setItem("import-mapping", JSON.stringify(mapping));
    await upload(file, mapping);
  }

  async function commit() {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/imports/${preview.importId}/commit`, {
        method: "POST",
        headers: { "Idempotency-Key": preview.importId },
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        data?: CommitResult;
        error?: { code?: string; message?: string; feature_key?: string };
      };
      if (!res.ok || payload.ok === false) {
        if (res.status === 402) {
          setPaywallFeature(String(payload.error?.feature_key ?? ""));
          return;
        }
        throw new Error(payload.error?.message ?? msg("import.commitFailed"));
      }
      setResult(payload.data!);
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // Preview rows grouped by club ref/name (Jul3/01 §8 "grouped by club").
  const grouped = useMemo(() => {
    if (!preview) return [];
    const groups = new Map<string, ImportOp[]>();
    for (const op of preview.plan.ops) {
      const club =
        op.kind.startsWith("club.")
          ? String(op.after?.name ?? op.ref ?? "")
          : String((op.after?.club as { ref?: string } | undefined)?.ref ?? "").replace(/^club:/, "") ||
            (op.ref?.startsWith("team:club:") ? op.ref.slice("team:club:".length).split("/")[0]! : "");
      const key = club || msg("import.noClub");
      const list = groups.get(key) ?? [];
      list.push(op);
      groups.set(key, list);
    }
    return [...groups.entries()];
  }, [preview]);

  return (
    <div className="space-y-5">
      <section className="card space-y-3 p-4">
        <label className="block text-sm font-medium text-slate-700" htmlFor="import-file">
          {msg("import.file")}
        </label>
        <input
          id="import-file"
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f) void upload(f);
          }}
        />
        <p className="text-xs text-slate-500">{msg("import.fileHint")}</p>
      </section>

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {preview && !result && (
        <>
          <section className="card space-y-3 p-4">
            <h2 className="text-sm font-semibold text-slate-900">{msg("import.mapping")}</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {Object.keys(preview.mapping ?? mapping).length === 0 && (
                <p className="text-sm text-slate-500">{msg("import.noHeaders")}</p>
              )}
              {Object.entries(mapping).map(([header, field]) => (
                <label key={header} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm">
                  <span className="truncate font-mono text-xs text-slate-500">{header}</span>
                  <select
                    className="input w-40"
                    value={field}
                    aria-label={msg("import.mapColumn", { header })}
                    onChange={(e) => setMapping((m) => ({ ...m, [header]: e.target.value }))}
                  >
                    {FIELDS.map(([value, labelKey]) => (
                      <option key={value} value={value}>{msg(labelKey)}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button type="button" className="btn" onClick={remap} disabled={busy || !file}>
              {msg("import.remap")}
            </button>
          </section>

          <section className="card space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                {msg("import.preview", { filename: preview.filename, rows: preview.rowCount })}
              </h2>
              <p className="text-xs text-slate-500">
                {msg("import.stats", {
                  clubs: preview.plan.stats.clubs,
                  teams: preview.plan.stats.teams,
                  persons: preview.plan.stats.persons,
                  entrants: preview.plan.stats.entrants,
                  rosters: preview.plan.stats.rosters,
                })}
              </p>
            </div>

            {preview.plan.issues.length > 0 && (
              <ul className="space-y-1" aria-label={msg("import.issuesAria")}>
                {preview.plan.issues.map((issue, i) => (
                  <li
                    key={i}
                    className={`rounded-md px-3 py-1.5 text-sm ${
                      issue.severity === "error"
                        ? "bg-red-50 text-red-700"
                        : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {msg("import.row", { n: issue.rowNo })}
                    {issue.column ? ` (${issue.column})` : ""}: {issue.message}
                    <span className="ml-2 font-mono text-xs opacity-70">{issue.code}</span>
                  </li>
                ))}
              </ul>
            )}

            {preview.plan.ops.length === 0 ? (
              <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg("import.nothing")}</p>
            ) : (
              <div className="space-y-3">
                {grouped.map(([club, ops]) => (
                  <div key={club}>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {club}
                    </h3>
                    <ul className="flex flex-wrap gap-1.5">
                      {ops.map((op, i) => {
                        const badge = OP_BADGE[op.kind];
                        const badgeLabel = badge ? msg(badge.labelKey) : op.kind;
                        const badgeCls = badge?.cls ?? "bg-slate-100 text-slate-600";
                        const name = String(
                          op.after?.name ?? op.after?.fullName ?? op.after?.displayName ?? op.ref ?? "",
                        );
                        return (
                          <li
                            key={i}
                            className={`rounded-full px-2 py-0.5 text-xs ${badgeCls}`}
                            title={msg("import.rowsTitle", { rows: op.sourceRows.join(", ") })}
                          >
                            <span className="font-medium">{badgeLabel}</span> {name}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
              {warns.length > 0 && (
                <label className="flex items-center gap-2 text-sm text-amber-700">
                  <input
                    type="checkbox"
                    checked={warnsAcknowledged}
                    onChange={(e) => setWarnsAcknowledged(e.target.checked)}
                  />
                  {msg("import.reviewedWarnings", { n: warns.length })}
                </label>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy ||
                  errors.length > 0 ||
                  preview.plan.ops.length === 0 ||
                  (warns.length > 0 && !warnsAcknowledged)
                }
                onClick={commit}
              >
                {errors.length > 0 ? msg("import.fixErrors") : msg("import.commit")}
              </button>
            </div>
          </section>
        </>
      )}

      {result && (
        <section className="card space-y-2 p-4">
          <h2 className="text-sm font-semibold text-emerald-700">{msg("import.committed")}</h2>
          <p className="text-sm text-slate-600">
            {msg("import.stats", {
              clubs: result.stats.clubs,
              teams: result.stats.teams,
              persons: result.stats.persons,
              entrants: result.stats.entrants,
              rosters: result.stats.rosters,
            })}
            {result.divisionIds.length > 0 ? msg("import.acrossDivisions", { n: result.divisionIds.length }) : ""}.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPreview(null);
              setResult(null);
              setFile(null);
              if (fileRef.current) fileRef.current.value = "";
            }}
          >
            {msg("import.another")}
          </button>
        </section>
      )}
    </div>
  );
}
