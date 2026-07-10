"use client";

// Clubs directory (Jul3/01 §2, §5, §8): club CRUD, teams-across-divisions
// detail, and the bulk logo grid (drag-drop, per-club re-map, assign-remaining).
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { msg } from "@/lib/messages";

interface PersonLite {
  id: string;
  full_name: string;
}
interface SquadMember {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  roles: string[];
}

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
  const confirmDialog = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [logo, setLogo] = useState<File | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<ClubDetail | null>(null);
  // Persons directory for the squad picker (loaded once; org rosters are small).
  const [persons, setPersons] = useState<PersonLite[]>([]);

  useEffect(() => {
    if (!canEdit) return;
    (async () => {
      const all: PersonLite[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const url: string = cursor
          ? `/api/v1/persons?limit=100&cursor=${encodeURIComponent(cursor)}`
          : "/api/v1/persons?limit=100";
        const page: { items: PersonLite[]; nextCursor: string | null } = await apiV1(url);
        all.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      setPersons(all);
    })().catch(() => setPersons([]));
  }, [canEdit]);

  const reloadDetail = (clubId: string) =>
    apiV1<ClubDetail>(`/api/v1/clubs/${clubId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed"));

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

  // Per-row badge (single file mapped to the club) — same endpoint as the bulk
  // grid, so imported/existing clubs can be re-badged one at a time.
  const uploadBadge = (clubId: string, file: File) =>
    run(async () => {
      const form = new FormData();
      form.append("files", file);
      form.append("mapping", JSON.stringify({ [file.name]: clubId }));
      const res = await fetch("/api/v1/clubs/logos", { method: "POST", body: form });
      if (!res.ok) {
        const p = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; feature_key?: string };
        };
        if (res.status === 402) {
          setPaywallFeature(String(p.error?.feature_key ?? ""));
          return;
        }
        throw new Error(p.error?.message ?? "Badge upload failed");
      }
    });

  return (
    <div className="space-y-5">
      {canEdit && (
        <form
          className="card grid grid-cols-1 gap-3 p-4 sm:flex sm:flex-wrap sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void run(async () => {
              const club = await apiV1<ClubListRow>("/api/v1/clubs", {
                method: "POST",
                json: {
                  name: name.trim(),
                  ...(shortName.trim() ? { short_name: shortName.trim() } : {}),
                },
              });
              if (logo) {
                const form = new FormData();
                form.append("files", logo);
                form.append("mapping", JSON.stringify({ [logo.name]: club.id }));
                const res = await fetch("/api/v1/clubs/logos", { method: "POST", body: form });
                if (!res.ok) {
                  const p = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
                  throw new Error(p.error?.message ?? "Badge upload failed");
                }
              }
              setName("");
              setShortName("");
              setLogo(null);
              if (logoInput.current) logoInput.current.value = "";
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Club name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Short name
            <input className="input w-full sm:w-28" value={shortName} onChange={(e) => setShortName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Badge
            <input
              ref={logoInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              aria-label="Club badge"
              className="w-full text-sm text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
              onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
            />
          </label>
          <button type="submit" className="btn btn-primary w-full sm:w-auto" disabled={busy}>
            Add club
          </button>
        </form>
      )}

      {canEdit && <LogoGrid clubs={clubs} busy={busy} onDone={() => router.refresh()} onError={setError} onPaywall={setPaywallFeature} />}

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <section className="card scroll-x scroll-x-fade">
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
                  <BadgeCell club={c} storageBase={storageBase} canEdit={canEdit} busy={busy} onUpload={uploadBadge} />
                </td>
                {canEdit && (
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="text-sm text-red-600 hover:underline"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: msg("confirm.deleteClub.title"),
                          body: msg("confirm.deleteClub.body", { name: c.name }),
                          confirmLabel: msg("confirm.deleteClub.label"),
                          tone: "danger",
                        });
                        if (!ok) return;
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
            <ul className="space-y-2 text-sm text-slate-700">
              {detail.teams.map((t) => (
                <TeamDetailRow
                  key={t.id}
                  team={t}
                  storageBase={storageBase}
                  persons={persons}
                  canEdit={canEdit}
                  onError={setError}
                  onPaywall={setPaywallFeature}
                  onLogoChanged={() => reloadDetail(detail.id)}
                />
              ))}
            </ul>
          )}

          {canEdit && (
            <AddTeamForm
              clubId={detail.id}
              onError={setError}
              onPaywall={setPaywallFeature}
              onDone={() => reloadDetail(detail.id)}
            />
          )}
        </section>
      )}
    </div>
  );
}

// Badge cell in the clubs table: shows the badge (or a dash) plus, for editors,
// a set/change control that uploads a single file for this club.
function BadgeCell({
  club,
  storageBase,
  canEdit,
  busy,
  onUpload,
}: {
  club: ClubListRow;
  storageBase: string;
  canEdit: boolean;
  busy: boolean;
  onUpload: (clubId: string, file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      {club.logo_path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${storageBase}/${club.logo_path}`}
          alt={`${club.name} badge`}
          className="h-8 w-8 rounded object-contain"
        />
      ) : (
        <span className="text-sm text-slate-400">—</span>
      )}
      {canEdit && (
        <>
          <button
            type="button"
            className="text-xs text-purple-600 hover:underline"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {club.logo_path ? "change" : "set"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            aria-label={`Badge for ${club.name}`}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(club.id, f);
              e.target.value = "";
            }}
          />
        </>
      )}
    </div>
  );
}

// Add a team directly under a club (Pro clubs.hierarchy).
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
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="grid grid-cols-1 gap-2 border-t border-slate-200 pt-3 sm:flex sm:flex-wrap sm:items-end"
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
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Team name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Riverside U12" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Short
        <input className="input w-full sm:w-24" value={shortName} onChange={(e) => setShortName(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary w-full text-sm sm:w-auto" disabled={busy || !name.trim()}>
        Add team
      </button>
    </form>
  );
}

// One team in the club detail: its division entries + an expandable squad editor.
function TeamDetailRow({
  team,
  storageBase,
  persons,
  canEdit,
  onError,
  onPaywall,
  onLogoChanged,
}: {
  team: {
    id: string;
    name: string;
    logo_path: string | null;
    entries: { division_id: string; division_name: string }[];
  };
  storageBase: string;
  persons: PersonLite[];
  canEdit: boolean;
  onError: (msg: string) => void;
  onPaywall: (feature: string) => void;
  onLogoChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [squad, setSquad] = useState<SquadMember[] | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState(false);

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
      onLogoChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Logo upload failed");
    } finally {
      setLogoBusy(false);
    }
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && squad === null) {
      try {
        const res = await apiV1<{ members: SquadMember[] }>(`/api/v1/teams/${team.id}/squad`);
        setSquad(res.members);
      } catch {
        setSquad([]);
      }
    }
  }

  return (
    <li className="rounded-md border border-slate-100">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 p-2 text-left hover:text-purple-700"
      >
        <span
          aria-hidden
          className={`inline-block text-[10px] leading-none text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        {team.logo_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${storageBase}/${team.logo_path}`}
            alt=""
            aria-hidden
            className="h-5 w-5 rounded object-contain"
          />
        ) : null}
        <span className="font-medium text-slate-800">{team.name}</span>
        {team.entries.map((e) => (
          <span key={e.division_id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {e.division_name}
          </span>
        ))}
      </button>
      {canEdit && (
        <div className="flex items-center gap-2 px-2 pb-1 pl-6">
          <button
            type="button"
            disabled={logoBusy}
            onClick={() => logoInputRef.current?.click()}
            className="text-xs text-purple-600 hover:underline disabled:opacity-50"
          >
            {logoBusy ? "Uploading…" : team.logo_path ? "Change badge" : "Set team badge"}
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
        </div>
      )}
      {open && (
        <div className="px-2 pb-2 pl-6">
          {squad === null ? (
            <p className="text-xs text-slate-400">Loading squad…</p>
          ) : (
            <TeamSquadEditor
              teamId={team.id}
              initial={squad}
              persons={persons}
              canEdit={canEdit}
              onSaved={setSquad}
              onError={onError}
              onPaywall={onPaywall}
            />
          )}
        </div>
      )}
    </li>
  );
}

// The persistent squad editor: add/remove people, squad number, captain. Saved
// members auto-seed an entrant roster whenever the team is enrolled.
function TeamSquadEditor({
  teamId,
  initial,
  persons,
  canEdit,
  onSaved,
  onError,
  onPaywall,
}: {
  teamId: string;
  initial: SquadMember[];
  persons: PersonLite[];
  canEdit: boolean;
  onSaved: (members: SquadMember[]) => void;
  onError: (msg: string) => void;
  onPaywall: (feature: string) => void;
}) {
  const [members, setMembers] = useState<SquadMember[]>(initial);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const memberIds = new Set(members.map((m) => m.person_id));
  const candidates = persons
    .filter((p) => !memberIds.has(p.id))
    .filter((p) => !filter || p.full_name.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 6);

  function update(i: number, patch: Partial<SquadMember>) {
    setMembers((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    setDirty(true);
  }

  function save() {
    setBusy(true);
    onError("");
    void apiV1<{ members: SquadMember[] }>(`/api/v1/teams/${teamId}/squad`, {
      method: "PUT",
      json: {
        members: members.map((m) => ({
          person_id: m.person_id,
          squad_number: m.squad_number,
          default_position_key: m.default_position_key,
          is_captain: m.is_captain,
          roles: m.roles,
        })),
      },
    })
      .then((res) => {
        setMembers(res.members);
        onSaved(res.members);
        setDirty(false);
      })
      .catch((err) => {
        if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED")
          onPaywall(String(err.extra.feature_key ?? ""));
        else onError(err instanceof Error ? err.message : "Failed");
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-2 text-xs">
      {members.length === 0 && <p className="text-slate-400">No players in this squad yet.</p>}
      {members.map((m, i) => (
        <div key={m.person_id} className="flex flex-wrap items-center gap-2">
          <span className="w-40 truncate font-medium text-slate-700">{m.full_name}</span>
          <input
            type="number"
            min={0}
            placeholder="No."
            disabled={!canEdit}
            value={m.squad_number ?? ""}
            onChange={(e) => update(i, { squad_number: e.target.value ? Number(e.target.value) : null })}
            className="input w-16 px-2 py-1"
            aria-label={`Squad number for ${m.full_name}`}
          />
          <label className="flex items-center gap-1 text-slate-500">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={m.is_captain}
              onChange={(e) =>
                setMembers((prev) =>
                  prev.map((mm, j) => ({ ...mm, is_captain: j === i ? e.target.checked : false })),
                )
              }
            />
            captain
          </label>
          {canEdit && (
            <button
              type="button"
              className="text-red-600 hover:underline"
              onClick={() => {
                setMembers((prev) => prev.filter((_, j) => j !== i));
                setDirty(true);
              }}
            >
              remove
            </button>
          )}
        </div>
      ))}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find player…"
            className="input w-40 px-2 py-1"
          />
          {candidates.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setMembers((prev) => [
                  ...prev,
                  { person_id: p.id, full_name: p.full_name, squad_number: null, default_position_key: null, is_captain: false, roles: [] },
                ]);
                setDirty(true);
              }}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-500 hover:border-purple-300"
            >
              + {p.full_name}
            </button>
          ))}
          {persons.length === 0 && <span className="text-slate-400">No players yet — add them under Players.</span>}
          <div className="flex-1" />
          <button type="button" className="btn btn-primary px-3 py-1" disabled={busy || !dirty} onClick={save}>
            {busy ? "Saving…" : "Save squad"}
          </button>
        </div>
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
