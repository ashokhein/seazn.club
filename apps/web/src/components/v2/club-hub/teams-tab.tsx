"use client";

// Club hub → Teams tab (W1 §5.2): the club's teams with add-a-team, the crest
// grid, per-team badge + squad, and detach. The squad editor + bulk logo grid
// are lifted out of the legacy clubs-panel.tsx (deleted in Task 11); each
// expanded team row drives the self-fetching squad panel.
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { TeamSquadPanel } from "./team-squad-editor";

interface TeamEntry {
  division_id: string;
  division_name: string;
}
interface HubTeam {
  id: string;
  name: string;
  short_name?: string | null;
  logo_path: string | null;
  entries: TeamEntry[];
}
interface ClubListRow {
  id: string;
  name: string;
  short_name: string | null;
  logo_path: string | null;
  external_ref: string | null;
}
interface LogoAssignment {
  filename: string;
  clubId: string | null;
  clubName: string | null;
  matchedBy: string | null;
}

export function TeamsTab({
  club,
  canEdit,
  storageBase,
}: {
  club: {
    id: string;
    name: string;
    short_name: string | null;
    logo_path: string | null;
    teams: HubTeam[];
  };
  canEdit: boolean;
  storageBase: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);

  // The bulk grid matches files to clubs by name; in the hub that scope is this
  // one club, so the grid becomes "drop a crest for this club".
  const clubRow: ClubListRow = {
    id: club.id,
    name: club.name,
    short_name: club.short_name,
    logo_path: club.logo_path,
    external_ref: null,
  };

  return (
    <div className="space-y-5">
      {paywall && <UpgradeGate feature={paywall} />}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {canEdit && (
        <AddTeamForm
          clubId={club.id}
          onError={setError}
          onPaywall={setPaywall}
          onDone={() => router.refresh()}
        />
      )}

      {canEdit && (
        <LogoGrid
          clubs={[clubRow]}
          pinClubId={club.id}
          onDone={() => router.refresh()}
          onError={setError}
          onPaywall={setPaywall}
        />
      )}

      <section className="card space-y-2 p-4" aria-label={msg("clubs.teams.title")}>
        <h2 className="text-sm font-semibold text-slate-900">{msg("clubs.teams.title")}</h2>
        {club.teams.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
            {msg("clubs.teams.empty")}
          </p>
        ) : (
          <ul className="space-y-2 text-sm text-slate-700">
            {club.teams.map((t) => (
              <TeamDetailRow
                key={t.id}
                team={t}
                storageBase={storageBase}
                canEdit={canEdit}
                onError={setError}
                onPaywall={setPaywall}
                onChanged={() => router.refresh()}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// Add a team directly under this club (Pro clubs.hierarchy).
function AddTeamForm({
  clubId,
  onError,
  onPaywall,
  onDone,
}: {
  clubId: string;
  onError: (msg: string) => void;
  onPaywall: (feature: string) => void;
  onDone: () => void;
}) {
  const msg = useMsg();
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card grid grid-cols-1 gap-2 p-4 sm:flex sm:flex-wrap sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        onError("");
        void apiV1(`/api/v1/clubs/${clubId}/teams`, {
          method: "POST",
          json: { name: name.trim(), ...(shortName.trim() ? { short_name: shortName.trim() } : {}) },
        })
          .then(() => {
            setName("");
            setShortName("");
            onDone();
          })
          .catch((err) => {
            if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED")
              onPaywall(String(err.extra.feature_key ?? ""));
            else onError(err instanceof Error ? err.message : "Failed");
          })
          .finally(() => setBusy(false));
      }}
    >
      <label className="label flex flex-col gap-1 text-xs">
        {msg("clubs.team.name")}
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={msg("clubs.team.namePlaceholder")}
        />
      </label>
      <label className="label flex flex-col gap-1 text-xs">
        {msg("clubs.team.short")}
        <input className="input w-full sm:w-24" value={shortName} onChange={(e) => setShortName(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary w-full text-sm sm:w-auto" disabled={busy || !name.trim()}>
        {msg("clubs.team.add")}
      </button>
    </form>
  );
}

// One team in the club: its division entries, badge upload, expandable squad,
// and a detach action (leave the club, keep its players).
function TeamDetailRow({
  team,
  storageBase,
  canEdit,
  onError,
  onPaywall,
  onChanged,
}: {
  team: HubTeam;
  storageBase: string;
  canEdit: boolean;
  onError: (msg: string) => void;
  onPaywall: (feature: string) => void;
  onChanged: () => void;
}) {
  const msg = useMsg();
  const confirmDialog = useConfirm();
  const [open, setOpen] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  // Team-level badge (v3/03 §5): overrides the club badge for this team only.
  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/v1/teams/${team.id}/logo`, { method: "POST", body: form });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok === false) {
        throw new Error(payload?.error?.message ?? `Upload failed (${res.status})`);
      }
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Logo upload failed");
    } finally {
      setLogoBusy(false);
    }
  }

  async function detach() {
    const ok = await confirmDialog({
      title: msg("clubs.team.detach"),
      body: msg("clubs.team.detachConfirm", { name: team.name }),
      confirmLabel: msg("clubs.team.detach"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    onError("");
    try {
      await apiV1(`/api/v1/teams/${team.id}`, { method: "PATCH", json: { club_id: null } });
      onChanged();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED")
        onPaywall(String(err.extra.feature_key ?? ""));
      else onError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-slate-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full flex-wrap items-center gap-2 p-2 text-left hover:text-purple-700"
      >
        <span
          aria-hidden
          className={`inline-block text-[10px] leading-none text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        {team.logo_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${storageBase}/${team.logo_path}`} alt="" aria-hidden className="h-5 w-5 rounded object-contain" />
        ) : null}
        <span className="font-medium text-slate-800">{team.name}</span>
        {team.entries.map((e) => (
          <span key={e.division_id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {e.division_name}
          </span>
        ))}
      </button>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3 px-2 pb-1 pl-6">
          <button
            type="button"
            disabled={logoBusy}
            onClick={() => logoInputRef.current?.click()}
            className="inline-flex min-h-[44px] items-center text-xs text-purple-600 hover:underline disabled:opacity-50"
          >
            {logoBusy ? msg("clubs.team.uploading") : team.logo_path ? msg("clubs.team.changeBadge") : msg("clubs.team.setBadge")}
          </button>
          <input
            ref={logoInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              void uploadLogo(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void detach()}
            className="inline-flex min-h-[44px] items-center text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            {msg("clubs.team.detach")}
          </button>
        </div>
      )}
      {open && (
        <div className="px-2 pb-2 pl-6">
          <TeamSquadPanel teamId={team.id} canEdit={canEdit} />
        </div>
      )}
    </li>
  );
}

/**
 * Pin every dropped crest file to the hub's own club id.
 *
 * The bulk-logo server usecase (`bulkAssignLogos`) IGNORES the client `clubs[]`
 * prop: it re-derives matches from filename stems across ALL org clubs and, with
 * `assign_remaining`, fills any unlogo'd org club in name order — so in the
 * single-club hub an unmapped drop could silently crest a DIFFERENT club. The
 * `mapping` (filename → clubId) is the one input the server honours over its own
 * stem-matching, so we pre-fill it to the hub club for every file.
 */
export function pinFilesToClub(fileNames: string[], clubId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fileNames) out[name] = clubId;
  return out;
}

/**
 * Coerce a per-file mapping into its final posted form.
 *
 * When `pinClubId` is set the hub has exactly one club, so every file MUST
 * resolve to it. A `""` value (or a missing entry) would be treated as falsy by
 * the server (`const manual = mapping[filename]`) and fall back to stem-matching
 * across ALL org clubs — silently cresting or overwriting a fold-matching
 * sibling. This backstops the UI: no dropped file can post an empty mapping.
 * With no `pinClubId` the org-wide mapping is returned untouched.
 */
export function finalizeMapping(
  mapping: Record<string, string>,
  fileNames: string[],
  pinClubId?: string,
): Record<string, string> {
  if (!pinClubId) return mapping;
  const out: Record<string, string> = { ...mapping };
  for (const name of fileNames) {
    if (!out[name]) out[name] = pinClubId;
  }
  return out;
}

// Bulk logo grid (Jul3/01 §5): drop N files, match by filename stem, re-map
// per file, optionally assign the rest to unlogo'd clubs in order. In the club
// hub (single known club) `pinClubId` pre-maps every file to that club and hides
// the org-wide "assign remaining" mode.
function LogoGrid({
  clubs,
  pinClubId,
  onDone,
  onError,
  onPaywall,
}: {
  clubs: ClubListRow[];
  pinClubId?: string;
  onDone: () => void;
  onError: (msg: string) => void;
  onPaywall: (feature: string) => void;
}) {
  const msg = useMsg();
  const [files, setFiles] = useState<File[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [assignRemaining, setAssignRemaining] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Add files and, in the hub, pin each to the hub club so the server never
  // stem-matches them onto a sibling org club.
  function addFiles(incoming: File[]) {
    setFiles((prev) => [...prev, ...incoming]);
    if (pinClubId) {
      const pins = pinFilesToClub(
        incoming.map((f) => f.name),
        pinClubId,
      );
      setMapping((m) => ({ ...m, ...pins }));
    }
  }

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
      const finalMapping = finalizeMapping(
        mapping,
        files.map((f) => f.name),
        pinClubId,
      );
      form.append("mapping", JSON.stringify(finalMapping));
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
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <h2 className="text-sm font-semibold text-slate-900">{msg("clubs.logo.title")}</h2>
      <p className="text-xs text-slate-500">
        {msg("clubs.logo.descPre")} <code>acme-sc.png</code>
        {msg("clubs.logo.descPost")}
      </p>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        multiple
        aria-label={msg("clubs.logo.chooseAria")}
        className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
        onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
      />
      {files.length > 0 && (
        <>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {files.map((f) => {
              const matched = mapping[f.name] ? clubs.find((c) => c.id === mapping[f.name]) : stemMatch[f.name];
              return (
                <li
                  key={f.name}
                  className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
                >
                  <span className="truncate font-mono text-xs text-slate-500">{f.name}</span>
                  {pinClubId ? (
                    // Single-club hub: nothing to choose — every file pins to the
                    // hub club. Show its name statically so no UI path can select
                    // "Unmatched" and let the server stem-match onto a sibling.
                    <span className="w-36 truncate text-right text-xs font-medium text-slate-700">
                      {clubs.find((c) => c.id === pinClubId)?.name ?? ""}
                    </span>
                  ) : (
                    <select
                      className="input w-36"
                      aria-label={msg("clubs.logo.forAria", { name: f.name })}
                      value={mapping[f.name] ?? matched?.id ?? ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.name]: e.target.value }))}
                    >
                      <option value="">{msg("clubs.logo.unmatched")}</option>
                      {clubs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            {!pinClubId && (
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={assignRemaining} onChange={(e) => setAssignRemaining(e.target.checked)} />
                {msg("clubs.logo.assignRemaining")}
              </label>
            )}
            <button type="button" className="btn btn-primary" disabled={uploading} onClick={assign}>
              {msg(files.length === 1 ? "clubs.logo.assign.one" : "clubs.logo.assign.other", { count: files.length })}
            </button>
            <button type="button" className="btn" onClick={() => setFiles([])} disabled={uploading}>
              {msg("clubs.logo.clear")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
