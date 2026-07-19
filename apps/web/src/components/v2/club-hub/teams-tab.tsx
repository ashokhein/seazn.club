"use client";

// Club hub → Teams tab (W1 §5.2): the club's teams with add-a-team, per-team
// badge + squad, and detach. The squad editor is lifted out of the legacy clubs
// directory panel (retired in Task 11); each expanded team row drives the
// self-fetching squad panel. The club crest itself is managed on the Overview
// tab — here every row shows its EFFECTIVE badge (own override, or the club
// crest it inherits) so the two never read as the same control.
import { useRef, useState } from "react";
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

/**
 * Resolve the badge a team actually wears: its own override when set,
 * otherwise the club crest it inherits (team_display_v applies the same
 * fallback on the read side — this mirrors it for the hub UI).
 */
export function effectiveBadge(
  teamLogoPath: string | null,
  clubLogoPath: string | null,
): { path: string | null; inherited: boolean } {
  if (teamLogoPath) return { path: teamLogoPath, inherited: false };
  if (clubLogoPath) return { path: clubLogoPath, inherited: true };
  return { path: null, inherited: false };
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
                clubLogoPath={club.logo_path}
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

// One team in the club: its division entries, effective badge (own override or
// inherited club crest), expandable squad, and a detach action.
function TeamDetailRow({
  team,
  clubLogoPath,
  storageBase,
  canEdit,
  onError,
  onPaywall,
  onChanged,
}: {
  team: HubTeam;
  clubLogoPath: string | null;
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
  const badge = effectiveBadge(team.logo_path, clubLogoPath);

  // Team-level badge (v3/03 §5): overrides the club crest for this team only.
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

  // Drop the override so the team falls back to wearing the club crest.
  async function revertToCrest() {
    setLogoBusy(true);
    onError("");
    try {
      const res = await fetch(`/api/v1/teams/${team.id}/logo`, { method: "DELETE" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok === false) {
        throw new Error(payload?.error?.message ?? `Failed (${res.status})`);
      }
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed");
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
        {badge.path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${storageBase}/${badge.path}`} alt="" aria-hidden className="h-5 w-5 rounded object-contain" />
        ) : null}
        <span className="font-medium text-slate-800">{team.name}</span>
        {badge.inherited && (
          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
            {msg("clubs.team.inheritedChip")}
          </span>
        )}
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
            {logoBusy
              ? msg("clubs.team.uploading")
              : team.logo_path
                ? msg("clubs.team.changeBadge")
                : msg("clubs.team.overrideBadge")}
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
          {team.logo_path && (
            <button
              type="button"
              disabled={logoBusy}
              onClick={() => void revertToCrest()}
              className="inline-flex min-h-[44px] items-center text-xs text-purple-600 hover:underline disabled:opacity-50"
            >
              {msg("clubs.team.useClubCrest")}
            </button>
          )}
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
