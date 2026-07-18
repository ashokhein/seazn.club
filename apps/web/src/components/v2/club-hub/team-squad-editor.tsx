"use client";

// Shared squad editor for the club hub (W1 §5.2). Lifted out of clubs-panel.tsx
// so the hub Teams tab and Task 7's directory team list can both drive it.
// Adds player quick-add — you no longer have to create the person under Players
// first — plus a self-fetching `TeamSquadPanel` wrapper for the thin list.
import { useEffect, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";

interface PersonLite {
  id: string;
  full_name: string;
}
export interface SquadMember {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  roles: string[];
}

/** Case- and diacritic-folded exact-name match — powers the "did you mean?"
 *  dedupe hint on quick-add so an accented duplicate ("José") isn't created
 *  twice. Pure and DOM-free so it stays unit-testable. */
export function foldSuggest(
  name: string,
  persons: { id: string; full_name: string }[],
): { id: string; full_name: string } | null {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const target = fold(name);
  return persons.find((p) => fold(p.full_name) === target) ?? null;
}

// Inline quick-add (W1 §5.2): when a squad search matches no existing person,
// offer to create them on the spot — and, if the folded name already exists,
// surface a "did you mean?" chip so the same player isn't duplicated.
function QuickAdd({
  name,
  persons,
  busy,
  onAdded,
  onError,
}: {
  name: string;
  persons: { id: string; full_name: string }[];
  busy: boolean;
  onAdded: (p: { id: string; full_name: string }) => void;
  onError: (msg: string) => void;
}) {
  const msg = useMsg();
  const [saving, setSaving] = useState(false);
  const dupe = foldSuggest(name, persons);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {dupe && (
        <button
          type="button"
          className="min-h-[44px] rounded-full border border-amber-300 bg-amber-50 px-3 py-2 text-amber-700"
          onClick={() => onAdded(dupe)}
        >
          {msg("clubs.squad.didYouMean", { name: dupe.full_name })}
        </button>
      )}
      <button
        type="button"
        disabled={busy || saving}
        className="min-h-[44px] rounded-full border border-purple-300 px-3 py-2 text-purple-700 hover:bg-purple-50 disabled:opacity-50"
        onClick={() => {
          setSaving(true);
          void apiV1<{ id: string; full_name: string }>("/api/v1/persons", {
            method: "POST",
            json: { full_name: name },
          })
            .then((p) => onAdded({ id: p.id, full_name: p.full_name }))
            .catch((err) => onError(err instanceof Error ? err.message : "Failed"))
            .finally(() => setSaving(false));
        }}
      >
        {saving ? msg("clubs.squad.adding") : msg("clubs.squad.quickAdd", { name })}
      </button>
    </span>
  );
}

// The persistent squad editor: add/remove people, squad number, captain. Saved
// members auto-seed an entrant roster whenever the team is enrolled.
export function TeamSquadEditor({
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
  const msg = useMsg();
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
      {members.length === 0 && <p className="text-slate-400">{msg("clubs.squad.empty")}</p>}
      {members.map((m, i) => (
        <div key={m.person_id} className="flex flex-wrap items-center gap-2">
          <span className="w-40 truncate font-medium text-slate-700">{m.full_name}</span>
          <input
            type="number"
            min={0}
            placeholder={msg("clubs.squad.numberPlaceholder")}
            disabled={!canEdit}
            value={m.squad_number ?? ""}
            onChange={(e) => update(i, { squad_number: e.target.value ? Number(e.target.value) : null })}
            className="input w-16 px-2 py-1"
            aria-label={msg("clubs.squad.noAria", { name: m.full_name })}
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
            {msg("clubs.squad.captain")}
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
              {msg("clubs.squad.remove")}
            </button>
          )}
        </div>
      ))}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={msg("clubs.squad.find")}
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
          {filter.trim() && candidates.length === 0 && (
            <QuickAdd
              name={filter.trim()}
              persons={persons}
              busy={busy}
              onAdded={(p) => {
                setMembers((prev) => [
                  ...prev,
                  { person_id: p.id, full_name: p.full_name, squad_number: null, default_position_key: null, is_captain: false, roles: [] },
                ]);
                setDirty(true);
                setFilter("");
              }}
              onError={onError}
            />
          )}
          {persons.length === 0 && !filter.trim() && (
            <span className="text-slate-400">{msg("clubs.squad.noPlayers")}</span>
          )}
          <div className="flex-1" />
          <button type="button" className="btn btn-primary px-3 py-1" disabled={busy || !dirty} onClick={save}>
            {busy ? msg("clubs.squad.saving") : msg("clubs.squad.save")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Self-fetching squad editor: loads the team's saved squad + the org person
 *  directory, then renders the editor. Used by the hub Teams tab and Task 7's
 *  thin directory list so callers don't have to prime the data. */
export function TeamSquadPanel({ teamId, canEdit }: { teamId: string; canEdit: boolean }) {
  const msg = useMsg();
  const [squad, setSquad] = useState<SquadMember[] | null>(null);
  const [persons, setPersons] = useState<PersonLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiV1<{ members: SquadMember[] }>(`/api/v1/teams/${teamId}/squad`)
      .then((r) => {
        if (!cancelled) setSquad(r.members);
      })
      .catch(() => {
        if (!cancelled) setSquad([]);
      });
    (async () => {
      const all: PersonLite[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const url: string = cursor
          ? `/api/v1/persons?limit=100&cursor=${encodeURIComponent(cursor)}`
          : "/api/v1/persons?limit=100";
        const pageRes: { items: PersonLite[]; nextCursor: string | null } = await apiV1(url);
        all.push(...pageRes.items);
        if (!pageRes.nextCursor) break;
        cursor = pageRes.nextCursor;
      }
      if (!cancelled) setPersons(all);
    })().catch(() => {
      if (!cancelled) setPersons([]);
    });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  if (squad === null) return <p className="text-xs text-slate-400">{msg("clubs.team.loadingSquad")}</p>;
  return (
    <>
      {paywall && <UpgradeGate feature={paywall} />}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <TeamSquadEditor
        teamId={teamId}
        initial={squad}
        persons={persons}
        canEdit={canEdit}
        onSaved={setSquad}
        onError={(m) => setError(m || null)}
        onPaywall={setPaywall}
      />
    </>
  );
}
