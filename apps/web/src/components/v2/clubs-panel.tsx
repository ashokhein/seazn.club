"use client";

// Clubs directory (Jul3/01 §2, §5, §8): club CRUD, teams-across-divisions
// detail, and the bulk logo grid (drag-drop, per-club re-map, assign-remaining).
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

export interface ClubListRow {
  id: string;
  name: string;
  short_name: string | null;
  logo_path: string | null;
  external_ref: string | null;
}

interface ClubDetail extends ClubListRow {
  teams: {
    id: string;
    name: string;
    logo_path: string | null;
    entries: { division_id: string; division_name: string }[];
  }[];
}

interface LogoAssignment {
  filename: string;
  clubId: string | null;
  clubName: string | null;
  matchedBy: string | null;
}

export function ClubsPanel({
  clubs,
  storageBase,
  canEdit,
}: {
  clubs: ClubListRow[];
  storageBase: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [detail, setDetail] = useState<ClubDetail | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {canEdit && (
        <form
          className="card flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void run(async () => {
              await apiV1("/api/v1/clubs", {
                method: "POST",
                json: {
                  name: name.trim(),
                  ...(shortName.trim() ? { short_name: shortName.trim() } : {}),
                },
              });
              setName("");
              setShortName("");
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Club name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Short name
            <input className="input w-28" value={shortName} onChange={(e) => setShortName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Add club
          </button>
        </form>
      )}

      {canEdit && <LogoGrid clubs={clubs} busy={busy} onDone={() => router.refresh()} onError={setError} onPaywall={setPaywallFeature} />}

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <section className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">Club</th>
              <th className="px-4 py-2 text-left">Short</th>
              <th className="px-4 py-2 text-left">Badge</th>
              {canEdit && <th className="px-4 py-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {clubs.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 4 : 3} className="px-4 py-6 text-center text-sm text-slate-400">
                  No clubs yet — add one above or bring them in with the spreadsheet import.
                </td>
              </tr>
            )}
            {clubs.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-2">
                  <button
                    type="button"
                    className="text-left font-medium text-slate-900 hover:underline"
                    onClick={() =>
                      void apiV1<ClubDetail>(`/api/v1/clubs/${c.id}`)
                        .then(setDetail)
                        .catch((err) => setError(err instanceof Error ? err.message : "Failed"))
                    }
                  >
                    {c.name}
                  </button>
                </td>
                <td className="px-4 py-2 text-sm text-slate-500">{c.short_name ?? "—"}</td>
                <td className="px-4 py-2">
                  {c.logo_path ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`${storageBase}/${c.logo_path}`}
                      alt={`${c.name} badge`}
                      className="h-8 w-8 rounded object-contain"
                    />
                  ) : (
                    <span className="text-sm text-slate-400">—</span>
                  )}
                </td>
                {canEdit && (
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="text-sm text-red-600 hover:underline"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(`Delete ${c.name}? Its teams stay, badges fall back to none.`)) return;
                        void run(() => apiV1(`/api/v1/clubs/${c.id}`, { method: "DELETE" }));
                      }}
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detail && (
        <section className="card space-y-2 p-4" aria-label={`${detail.name} detail`}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              {detail.name} — teams across divisions
            </h2>
            <button type="button" className="text-sm text-slate-500 hover:underline" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
          {detail.teams.length === 0 ? (
            <p className="text-sm text-slate-500">No teams belong to this club yet.</p>
          ) : (
            <ul className="space-y-1 text-sm text-slate-700">
              {detail.teams.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.entries.map((e) => (
                    <span key={e.division_id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {e.division_name}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// Bulk logo grid (Jul3/01 §5): drop N files, match by filename stem, re-map
// per file, optionally assign the rest to unlogo'd clubs in order.
function LogoGrid({
  clubs,
  busy,
  onDone,
  onError,
  onPaywall,
}: {
  clubs: ClubListRow[];
  busy: boolean;
  onDone: () => void;
  onError: (msg: string) => void;
  onPaywall: (feature: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [assignRemaining, setAssignRemaining] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const stemMatch = useMemo(() => {
    const byFold = new Map<string, ClubListRow>();
    for (const c of clubs) {
      byFold.set(c.name.trim().toLowerCase(), c);
      if (c.short_name) byFold.set(c.short_name.trim().toLowerCase(), c);
    }
    const out: Record<string, ClubListRow | null> = {};
    for (const f of files) {
      const stem = f.name.replace(/\.[^.]+$/, "").trim().toLowerCase();
      out[f.name] = byFold.get(stem) ?? null;
    }
    return out;
  }, [files, clubs]);

  async function assign() {
    setUploading(true);
    onError("");
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      form.append("mapping", JSON.stringify(mapping));
      form.append("assign_remaining", String(assignRemaining));
      const res = await fetch("/api/v1/clubs/logos", { method: "POST", body: form });
      const payload = (await res.json()) as {
        ok?: boolean;
        data?: LogoAssignment[];
        error?: { message?: string; feature_key?: string };
      };
      if (!res.ok || payload.ok === false) {
        if (res.status === 402) {
          onPaywall(String(payload.error?.feature_key ?? ""));
          return;
        }
        throw new Error(payload.error?.message ?? "Upload failed");
      }
      setFiles([]);
      setMapping({});
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section
      className={`card space-y-3 p-4 ${dragOver ? "ring-2 ring-sky-400" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
      }}
    >
      <h2 className="text-sm font-semibold text-slate-900">Bulk logo upload</h2>
      <p className="text-xs text-slate-500">
        Drop image files named after clubs (e.g. <code>acme-sc.png</code>) — every team in a
        club inherits its badge. Unmatched files can be re-mapped below.
      </p>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        multiple
        aria-label="Choose logo files"
        className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
        onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])])}
      />
      {files.length > 0 && (
        <>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {files.map((f) => {
              const matched = mapping[f.name]
                ? clubs.find((c) => c.id === mapping[f.name])
                : stemMatch[f.name];
              return (
                <li key={f.name} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm">
                  <span className="truncate font-mono text-xs text-slate-500">{f.name}</span>
                  <select
                    className="input w-36"
                    aria-label={`Club for ${f.name}`}
                    value={mapping[f.name] ?? matched?.id ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.name]: e.target.value }))}
                  >
                    <option value="">— unmatched —</option>
                    {clubs.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={assignRemaining}
                onChange={(e) => setAssignRemaining(e.target.checked)}
              />
              Assign remaining files to clubs without a badge, in order
            </label>
            <button type="button" className="btn btn-primary" disabled={busy || uploading} onClick={assign}>
              Assign {files.length} logo{files.length > 1 ? "s" : ""}
            </button>
            <button type="button" className="btn" onClick={() => setFiles([])} disabled={uploading}>
              Clear
            </button>
          </div>
        </>
      )}
    </section>
  );
}
