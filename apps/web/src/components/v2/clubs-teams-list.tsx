"use client";
// Thin Clubs & Teams register (W1 §5.1). Heavy editing lives on /clubs/[id];
// this list only searches, creates, and links. Standalone teams (ladder
// step 2) expand their squad inline — they have no hub page. Create runs
// through an in-app inline form (never window.prompt): a native dialog is
// unstylable, unlocalisable and inconsistent with the rest of the console.
import { useMemo, useState, type FormEvent } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import { TeamSquadPanel } from "@/components/v2/club-hub/team-squad-editor";

export interface ClubListItem {
  id: string;
  name: string;
  short_name: string | null;
  logo_path: string | null;
  slug: string | null;
  team_count: number;
  primary_contact: string | null;
}
export interface TeamListItem {
  id: string;
  name: string;
  club_id: string | null;
  logo_path: string | null;
}

/** Split the org register for the thin directory list: clubs matched by name or
 *  short name, plus the *standalone* teams (club_id === null) that have no hub
 *  page and so surface here. Club-attached teams are intentionally hidden — they
 *  live on their club's /clubs/[id] hub. Pure + DOM-free so it stays testable. */
export function partitionDirectory(
  clubs: ClubListItem[],
  teams: TeamListItem[],
  query: string,
): { clubs: ClubListItem[]; standalone: TeamListItem[] } {
  const fold = (s: string) => s.toLowerCase();
  const q = fold(query.trim());
  const matchedClubs = clubs.filter(
    (c) => !q || fold(c.name).includes(q) || fold(c.short_name ?? "").includes(q),
  );
  const standalone = teams
    .filter((t) => t.club_id === null)
    .filter((t) => !q || fold(t.name).includes(q));
  return { clubs: matchedClubs, standalone };
}

// Monogram fallback when a club/team has no badge — a small kit-coloured chip
// keeps the list scannable instead of a blank square.
function Crest({ src, alt, name }: { src: string | null; alt: string; name: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} aria-hidden className="h-6 w-6 shrink-0 rounded object-contain" />;
  }
  return (
    <span
      aria-hidden
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-slate-100 text-[10px] font-semibold text-slate-500"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ClubsTeamsList({
  clubs,
  teams,
  storageBase,
  canEdit,
}: {
  clubs: ClubListItem[];
  teams: TeamListItem[];
  storageBase: string;
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openTeam, setOpenTeam] = useState<string | null>(null);
  const [creating, setCreating] = useState<"club" | "team" | null>(null);
  const [draft, setDraft] = useState("");

  const { clubs: visClubs, standalone } = useMemo(
    () => partitionDirectory(clubs, teams, q),
    [clubs, teams, q],
  );

  function startCreate(kind: "club" | "team") {
    setCreating((prev) => (prev === kind ? null : kind));
    setDraft("");
    setError(null);
    setPaywall(null);
  }

  async function submitCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = draft.trim();
    if (!name || !creating) return;
    setBusy(true);
    setError(null);
    setPaywall(null);
    try {
      if (creating === "club") {
        // A new club goes straight to its hub, where badges/contacts/teams live.
        const club = await apiV1<{ id: string }>("/api/v1/clubs", { method: "POST", json: { name } });
        router.push(`/clubs/${club.id}`);
      } else {
        // club_id omitted = standalone team (ladder step 2); it stays in this list.
        await apiV1("/api/v1/teams", { method: "POST", json: { name } });
        setCreating(null);
        setDraft("");
        router.refresh();
      }
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED")
        setPaywall(String(err.extra.feature_key ?? ""));
      else setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-h-[44px] w-full sm:w-64"
          placeholder={msg("clubs.list.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={msg("clubs.list.search")}
        />
        <div className="flex-1" />
        {canEdit && (
          <>
            <button
              type="button"
              className="btn btn-primary min-h-[44px]"
              disabled={busy}
              aria-expanded={creating === "club"}
              onClick={() => startCreate("club")}
            >
              {msg("clubs.list.newClub")}
            </button>
            <button
              type="button"
              className="btn min-h-[44px]"
              disabled={busy}
              aria-expanded={creating === "team"}
              onClick={() => startCreate("team")}
            >
              {msg("clubs.list.newTeam")}
            </button>
            <Link href="/import" className="btn btn-ghost text-sm">
              {msg("directory.clubs.import")}
            </Link>
          </>
        )}
      </div>

      {canEdit && creating && (
        <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={submitCreate}>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-slate-600">
            {msg(creating === "club" ? "clubs.list.newClubPrompt" : "clubs.list.newTeamPrompt")}
            <input
              className="input min-h-[44px] w-full"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              required
              aria-label={msg(creating === "club" ? "clubs.list.newClubPrompt" : "clubs.list.newTeamPrompt")}
            />
          </label>
          <button type="submit" className="btn btn-primary min-h-[44px]" disabled={busy || !draft.trim()}>
            {msg("clubs.list.create")}
          </button>
          <button type="button" className="btn min-h-[44px]" disabled={busy} onClick={() => setCreating(null)}>
            {msg("clubs.list.cancel")}
          </button>
        </form>
      )}

      {paywall && <UpgradeGate feature={paywall} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <section className="card scroll-x scroll-x-fade">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">{msg("clubs.col.club")}</th>
              <th className="px-4 py-2 text-left">{msg("clubs.list.col.teams")}</th>
              <th className="px-4 py-2 text-left">{msg("clubs.list.col.contact")}</th>
            </tr>
          </thead>
          <tbody>
            {visClubs.length === 0 && standalone.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-sm text-slate-400">
                  {q ? msg("clubs.list.noMatch") : msg("clubs.list.invite")}
                </td>
              </tr>
            )}
            {visClubs.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-2">
                  <Link
                    href={`/clubs/${c.id}`}
                    className="flex items-center gap-2 font-medium text-slate-900 hover:underline"
                  >
                    <Crest src={c.logo_path ? `${storageBase}/${c.logo_path}` : null} alt="" name={c.name} />
                    {c.name}
                    {c.short_name && <span className="text-xs text-slate-400">({c.short_name})</span>}
                  </Link>
                </td>
                <td className="px-4 py-2 text-sm text-slate-500">{c.team_count}</td>
                <td className="px-4 py-2 text-sm text-slate-500">{c.primary_contact ?? "—"}</td>
              </tr>
            ))}
            {standalone.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="px-4 py-2" colSpan={3}>
                  <button
                    type="button"
                    className="flex min-h-[44px] items-center gap-2 text-left font-medium text-slate-800 hover:underline"
                    onClick={() => setOpenTeam(openTeam === t.id ? null : t.id)}
                    aria-expanded={openTeam === t.id}
                  >
                    <Crest src={t.logo_path ? `${storageBase}/${t.logo_path}` : null} alt="" name={t.name} />
                    {t.name}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {msg("clubs.list.standalone")}
                    </span>
                  </button>
                  {openTeam === t.id && (
                    <div className="mt-2">
                      <TeamSquadPanel teamId={t.id} canEdit={canEdit} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
