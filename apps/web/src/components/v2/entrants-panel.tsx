"use client";

// Entrant & roster management (PROMPT-15 task 1): persons picker, CSV import,
// position/role assignment from the module catalog, withdraw/seed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { entrantKindCap } from "@seazn/engine/sport";
import type { EffectiveEntrantModel, EntrantKind } from "@seazn/engine/sport";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

// Shared entrant-kind labels — reuse the same catalog keys the Settings tab
// uses so "Individual / Pair / Team" read identically across the console.
const ENTRANT_KIND_LABEL: Record<EntrantKind, MessageKey> = {
  individual: "divset.entrants.kind.individual",
  pair: "divset.entrants.kind.pair",
  team: "divset.entrants.kind.team",
};

interface PositionGroup {
  key: string;
  name: string;
}
interface RoleSpec {
  key: string;
  name?: string;
}
interface EntrantRow {
  id: string;
  kind: string;
  team_id: string | null;
  display_name: string;
  seed: number | null;
  status: string;
  badge_url: string | null;
}
interface TeamOption {
  id: string;
  name: string;
  short_name: string | null;
  club_name: string | null;
  club_short_name: string | null;
  logo_path: string | null;
  latest_entrant_id: string | null;
}
interface Member {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  roles: string[];
}
interface Person {
  id: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
}
interface DivisionRosterRow {
  person_id: string;
  entrant_id: string;
  entrant_name: string;
}

interface Props {
  divisionId: string;
  entrants: EntrantRow[];
  /** entrant id → resolved badge URL (own badge → team logo → club crest),
   *  from listEntrantLogoUrls. The rows fall back to this when the entrant
   *  has no badge of its own — without it a squad-seeded team entrant showed
   *  a bare monogram even though its club crest existed. */
  logoUrls?: Record<string, string | null>;
  canEdit: boolean;
  positionGroups: PositionGroup[];
  roles: RoleSpec[];
  eligibility: Record<string, unknown>[];
  /** Effective entrant model (sport default merged with any config.entrants
   *  override) — decides which kinds the add form offers and whether the
   *  roster editor shows squad numbers / captain. */
  entrantModel: EffectiveEntrantModel;
}

// Load the whole org persons directory once (cursor-paged) — org rosters are
// small; the picker filters locally.
async function loadAllPersons(): Promise<Person[]> {
  const all: Person[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const url: string = cursor
      ? `/api/v1/persons?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "/api/v1/persons?limit=100";
    const page: { items: Person[]; nextCursor: string | null } = await apiV1(url);
    all.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

export function EntrantsPanel({
  divisionId,
  entrants,
  logoUrls,
  canEdit,
  positionGroups,
  roles,
  eligibility,
  entrantModel,
}: Props) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [persons, setPersons] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Club facet (Jul3/01 §8): filter entrants by parent club. Hidden when the
  // org has no clubs (or the clubs list is not readable on this plan).
  const [clubs, setClubs] = useState<{ id: string; name: string }[]>([]);
  const [clubFilter, setClubFilter] = useState("");
  const [clubEntrantIds, setClubEntrantIds] = useState<Set<string> | null>(null);
  // Existing-team enrollment (unified Add Entrant): the org's teams, for the
  // picker. Empty for orgs that never imported — the form then shows only the
  // "new entrant" mode, exactly as before.
  const [teams, setTeams] = useState<TeamOption[]>([]);
  // Division-wide (person → team entrant) map, for the same-division
  // double-roster warning (advisory: a person on two teams here is flagged,
  // not blocked).
  const [rosterIndex, setRosterIndex] = useState<DivisionRosterRow[]>([]);
  // Bumped after every mutation to force a roster-map refetch.
  const [rosterBump, setRosterBump] = useState(0);

  useEffect(() => {
    loadAllPersons().then(setPersons).catch(() => setPersons([]));
    apiV1<{ id: string; name: string }[]>("/api/v1/clubs")
      .then(setClubs)
      .catch(() => setClubs([]));
    apiV1<TeamOption[]>("/api/v1/teams")
      .then(setTeams)
      .catch(() => setTeams([]));
  }, []);

  const enteredTeamIds = useMemo(
    () => new Set(entrants.map((e) => e.team_id).filter((id): id is string => id != null)),
    [entrants],
  );

  // Refetch the roster map whenever the entrant set changes OR any mutation
  // runs (rosterBump) — a member added/removed on one team must clear/raise the
  // warning on the others, and entrant ids alone don't capture roster edits.
  const entrantSig = entrants.map((e) => `${e.id}:${e.status}`).join(",");
  useEffect(() => {
    apiV1<DivisionRosterRow[]>(`/api/v1/divisions/${divisionId}/roster`)
      .then(setRosterIndex)
      .catch(() => setRosterIndex([]));
  }, [divisionId, entrantSig, rosterBump]);

  const otherTeamsFor = useCallback(
    (personId: string, exceptEntrantId: string) =>
      rosterIndex.filter((r) => r.person_id === personId && r.entrant_id !== exceptEntrantId),
    [rosterIndex],
  );

  useEffect(() => {
    if (!clubFilter) return; // cleared in the select's onChange
    apiV1<EntrantRow[]>(
      `/api/v1/divisions/${divisionId}/entrants?club_id=${encodeURIComponent(clubFilter)}`,
    )
      .then((rows) => setClubEntrantIds(new Set(rows.map((r) => r.id))))
      .catch(() => setClubEntrantIds(null));
  }, [clubFilter, divisionId]);

  const visibleEntrants = clubEntrantIds
    ? entrants.filter((e) => clubEntrantIds.has(e.id))
    : entrants;

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
      setPaywallFeature(String(err.extra.feature_key ?? ""));
    } else {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }, []);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      const result = await fn();
      router.refresh();
      setRosterBump((n) => n + 1); // re-pull the division roster map
      return result;
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {eligibility.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">Eligibility:</span>
          {eligibility.map((rule, i) => (
            <span key={i} className="rounded-full bg-white/70 px-2 py-0.5">
              {eligibilityLabel(rule)}
            </span>
          ))}
          <span className="text-amber-600">
            Checked at roster add — organisers can override with a reason.
          </span>
        </div>
      )}

      {canEdit && (
        <AddEntrantForm
          persons={persons}
          teams={teams}
          enteredTeamIds={enteredTeamIds}
          entrantModel={entrantModel}
          busy={busy}
          onSubmit={(payload) =>
            run(() =>
              apiV1<{ roster_keys_dropped?: number }>(
                `/api/v1/divisions/${divisionId}/entrants`,
                { method: "POST", json: payload },
              ),
            )
          }
          importControls={
            <CsvImport
              busy={busy}
              onImport={async (rows) =>
              run(async () => {
                // Create missing persons first (matched by exact name against
                // the directory), then register entrants in one bulk call.
                const byName = new Map(persons.map((p) => [p.full_name.toLowerCase(), p]));
                const ensurePerson = async (row: CsvRow): Promise<string> => {
                  const existing = byName.get(row.name.toLowerCase());
                  if (existing) return existing.id;
                  const created = await apiV1<Person>("/api/v1/persons", {
                    method: "POST",
                    json: {
                      full_name: row.name,
                      dob: row.dob || null,
                      gender: row.gender || null,
                    },
                  });
                  byName.set(created.full_name.toLowerCase(), created);
                  setPersons((prev) => [...prev, created]);
                  return created.id;
                };

                const teamMode = rows.some((r) => r.team);
                if (teamMode) {
                  const teams = new Map<string, CsvRow[]>();
                  for (const row of rows) {
                    const key = row.team || row.name;
                    if (!teams.has(key)) teams.set(key, []);
                    teams.get(key)!.push(row);
                  }
                  const entrantsPayload = [];
                  for (const [team, teamRows] of teams) {
                    const members = [];
                    for (const row of teamRows) {
                      members.push({
                        person_id: await ensurePerson(row),
                        squad_number: row.squad_number ?? null,
                        is_captain: false,
                        roles: [],
                      });
                    }
                    entrantsPayload.push({
                      kind: "team",
                      display_name: team,
                      members,
                    });
                  }
                  await apiV1(`/api/v1/divisions/${divisionId}/entrants`, {
                    method: "POST",
                    json: entrantsPayload,
                  });
                } else {
                  const entrantsPayload = [];
                  for (const row of rows) {
                    entrantsPayload.push({
                      kind: "individual",
                      display_name: row.name,
                      seed: row.seed ?? null,
                      members: [
                        { person_id: await ensurePerson(row), is_captain: false, roles: [] },
                      ],
                    });
                  }
                  await apiV1(`/api/v1/divisions/${divisionId}/entrants`, {
                    method: "POST",
                    json: entrantsPayload,
                  });
                }
              })
            }
            />
          }
        />
      )}

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {clubs.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span>Club</span>
          <select
            className="input max-w-xs"
            value={clubFilter}
            onChange={(e) => {
              setClubFilter(e.target.value);
              if (!e.target.value) setClubEntrantIds(null);
            }}
            aria-label="Filter entrants by club"
          >
            <option value="">All clubs</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      )}

      <section className="card scroll-x scroll-x-fade">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">Entrant</th>
              <th className="px-4 py-2 text-left">Kind</th>
              <th className="px-4 py-2 text-left">Seed</th>
              <th className="px-4 py-2 text-left">Status</th>
              {canEdit && <th className="px-4 py-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {visibleEntrants.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 5 : 4} className="px-4 py-6 text-center text-sm text-slate-400">
                  {clubFilter ? "No entrants from this club." : "No entrants registered yet."}
                </td>
              </tr>
            )}
            {visibleEntrants.map((e) => (
              <EntrantTableRow
                key={e.id}
                entrant={e}
                logoUrl={logoUrls?.[e.id] ?? null}
                canEdit={canEdit}
                busy={busy}
                persons={persons}
                positionGroups={positionGroups}
                roles={roles}
                entrantModel={entrantModel}
                otherTeamsFor={otherTeamsFor}
                onPatch={(patch) =>
                  run(() =>
                    apiV1(`/api/v1/entrants/${e.id}`, { method: "PATCH", json: patch }),
                  )
                }
                onWithdraw={async () => {
                  // Withdrawal mid-tournament does fixture surgery (spec 05
                  // §5) — spell out the policy before firing.
                  const ok = await confirmDialog({
                    title: msg("confirm.withdrawEntrant.title", { name: e.display_name }),
                    body: msg("confirm.withdrawEntrant.body"),
                    confirmLabel: msg("confirm.withdrawEntrant.label"),
                    tone: "danger",
                  });
                  if (!ok) return;
                  await run(() =>
                    apiV1(`/api/v1/entrants/${e.id}/withdraw`, { method: "POST", json: {} }),
                  );
                }}
                onBadge={(file) => void run(() => badgeRequest(e.id, file))}
              />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function eligibilityLabel(rule: Record<string, unknown>): string {
  switch (rule.kind) {
    case "age": {
      const max = rule.maxAgeAt;
      const cutoff = rule.cutoff as { month?: number; day?: number } | undefined;
      return `U${Number(max) + 1} (cutoff ${cutoff?.day ?? 1}/${cutoff?.month ?? 1})`;
    }
    case "gender":
      return `Gender: ${(rule.allowed as string[]).join(", ")}`;
    case "custom":
      return String(rule.note ?? "custom rule");
    default:
      return String(rule.kind ?? "rule");
  }
}

// ---------------------------------------------------------------------------
// Add one entrant
// ---------------------------------------------------------------------------

const STORAGE_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;

function AddEntrantForm({
  persons,
  teams,
  enteredTeamIds,
  entrantModel,
  busy,
  onSubmit,
  importControls,
}: {
  persons: Person[];
  teams: TeamOption[];
  enteredTeamIds: Set<string>;
  entrantModel: EffectiveEntrantModel;
  busy: boolean;
  onSubmit: (
    payload: Record<string, unknown>,
  ) => Promise<{ roster_keys_dropped?: number } | undefined>;
  /** Inline CSV-import controls rendered in the footer row. */
  importControls?: React.ReactNode;
}) {
  // "Existing team" mode enrolls a whole team, so it only makes sense when this
  // division actually accepts a team kind AND the org has teams (created by
  // import). Otherwise the form is exactly the old "new entrant" flow.
  const teamKindAllowed = entrantModel.kinds.includes("team");
  const canExisting = teamKindAllowed && teams.length > 0;
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [touched, setTouched] = useState(false);
  // Teams load after first paint; default to "existing" once available, but
  // never override a mode the organiser explicitly picked.
  useEffect(() => {
    if (!touched) setMode(canExisting ? "existing" : "new");
  }, [canExisting, touched]);

  return (
    <form className="card space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-700">Add entrant</h3>
        {canExisting && (
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs">
            {(["existing", "new"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  setTouched(true);
                  setMode(m);
                }}
                className={`rounded-md px-2.5 py-1 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
                  mode === m ? "bg-purple-600 text-white" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {m === "existing" ? "Existing team" : "New entrant"}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "existing" && canExisting ? (
        <ExistingTeamFields
          teams={teams}
          enteredTeamIds={enteredTeamIds}
          busy={busy}
          onSubmit={onSubmit}
        />
      ) : (
        <NewEntrantFields
          persons={persons}
          entrantModel={entrantModel}
          busy={busy}
          onSubmit={onSubmit}
        />
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">{importControls}</div>
    </form>
  );
}

/** Mode A: enroll a team that already exists (season rollover, league + cup). */
function ExistingTeamFields({
  teams,
  enteredTeamIds,
  busy,
  onSubmit,
}: {
  teams: TeamOption[];
  enteredTeamIds: Set<string>;
  busy: boolean;
  onSubmit: (
    payload: Record<string, unknown>,
  ) => Promise<{ roster_keys_dropped?: number } | undefined>;
}) {
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyRoster, setCopyRoster] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = q
      ? teams.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.club_name ?? "").toLowerCase().includes(q),
        )
      : teams;
    return rows.slice(0, 12);
  }, [teams, filter]);

  const selected = teams.find((t) => t.id === selectedId) ?? null;
  const canCopy = Boolean(selected?.latest_entrant_id);

  async function submit() {
    if (!selected) return;
    setNote(null);
    const res = await onSubmit({
      kind: "team",
      team_id: selected.id,
      // display_name is intentionally omitted — the server snapshots it from
      // the team so a later rename never rewrites historical standings.
      ...(copyRoster && selected.latest_entrant_id
        ? { copy_roster_from_entrant_id: selected.latest_entrant_id }
        : {}),
    });
    if (res === undefined) return; // failed — panel shows the error (incl. 409)
    setSelectedId(null);
    setFilter("");
    if (res.roster_keys_dropped)
      setNote(
        `Enrolled. ${res.roster_keys_dropped} position/role setting${
          res.roster_keys_dropped > 1 ? "s" : ""
        } didn't carry over to this sport.`,
      );
  }

  return (
    <div className="space-y-3">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="input"
        placeholder="Search teams…"
        aria-label="Search teams"
      />
      <div className="flex flex-wrap gap-1.5">
        {teams.length === 0 && (
          <span className="text-xs text-slate-400">No teams yet — import some first.</span>
        )}
        {filtered.map((t) => {
          const entered = enteredTeamIds.has(t.id);
          const isSelected = t.id === selectedId;
          return (
            <button
              key={t.id}
              type="button"
              disabled={entered}
              onClick={() => setSelectedId(isSelected ? null : t.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition ${
                entered
                  ? "cursor-not-allowed border-slate-200 text-slate-300"
                  : isSelected
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : "border-slate-200 text-slate-600 hover:border-purple-200"
              }`}
              title={t.club_name ?? undefined}
            >
              {t.logo_path && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${STORAGE_BASE}/${t.logo_path}`}
                  alt=""
                  className="h-4 w-4 rounded object-contain"
                />
              )}
              <span>{t.name}</span>
              {t.club_short_name && (
                <span className="text-[10px] text-slate-400">{t.club_short_name}</span>
              )}
              {entered && <span className="text-[10px] text-slate-400">· Already entered</span>}
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={copyRoster && canCopy}
          disabled={!canCopy}
          onChange={(e) => setCopyRoster(e.target.checked)}
        />
        Copy roster from this team&apos;s most recent entrant
        {!canCopy && selected && <span className="text-slate-400">(no earlier roster)</span>}
      </label>

      {note && <p className="text-xs text-emerald-600">{note}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={busy || !selected}
        className="btn btn-primary"
      >
        {busy ? "Enrolling…" : "Enroll team"}
      </button>
    </div>
  );
}

/** Mode B: the original ad-hoc entrant (scratch pairs, one-offs) — never
 *  creates a team, kept deliberately as an explicit choice. The add form now
 *  follows the division's effective entrant model: it offers only the allowed
 *  kinds, and individual/pair entrants derive their display name from the
 *  picked people instead of a free-text box. Exported for the markup test. */
export function NewEntrantFields({
  persons,
  entrantModel,
  busy,
  onSubmit,
}: {
  persons: Person[];
  entrantModel: EffectiveEntrantModel;
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const msg = useMsg();
  const [kind, setKind] = useState<string>(entrantModel.defaultKind);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [seed, setSeed] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  const isIndividual = kind === "individual";
  const isTeam = kind === "team";
  const cap = entrantKindCap(kind, entrantModel);
  const atCap = memberIds.length >= cap;
  const singleKind = entrantModel.kinds.length === 1;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return persons.slice(0, 8);
    return persons.filter((p) => p.full_name.toLowerCase().includes(q)).slice(0, 8);
  }, [persons, filter]);

  // Derived name from the picked people: individual → that person, pair →
  // "A & B". Teams always name themselves manually.
  const derivedName = useMemo(() => {
    const picked = memberIds
      .map((id) => persons.find((p) => p.id === id)?.full_name)
      .filter((n): n is string => Boolean(n));
    if (isIndividual) return picked[0] ?? "";
    if (kind === "pair") return picked.join(" & ");
    return "";
  }, [isIndividual, kind, memberIds, persons]);

  // The name shown in / submitted from the editable field. Teams and a
  // hand-edited individual/pair keep the typed value; untouched ones
  // auto-fill from the picked people. The field stays for individuals too:
  // organisers legitimately register name-only entrants with no person
  // record (board-game one-nighters) — the person pick is optional sugar.
  const nameValue = isTeam || nameTouched ? name : derivedName;
  const submitName = nameValue;

  function pickKind(next: string) {
    setKind(next);
    // Trim any picks beyond the new kind's cap (team→pair keeps the first two).
    setMemberIds((prev) => prev.slice(0, entrantKindCap(next, entrantModel)));
  }

  function togglePick(id: string) {
    setMemberIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (isIndividual) return [id]; // single seat — a new pick replaces
      if (prev.length >= cap) return prev; // pair/team cap reached — ignore
      return [...prev, id];
    });
  }

  async function submit() {
    await onSubmit({
      kind,
      display_name: submitName,
      seed: seed ? Number(seed) : null,
      members: memberIds.map((id) => ({ person_id: id, is_captain: false, roles: [] })),
    });
    setName("");
    setNameTouched(false);
    setSeed("");
    setMemberIds([]);
  }

  return (
    <div className="space-y-3">
      {/* Kind — chips when the division offers a choice (mirrors the Settings
          tab), a static caption when only one shape is allowed. */}
      {singleKind ? (
        <span className="inline-flex w-fit rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
          {msg(ENTRANT_KIND_LABEL[kind as EntrantKind])}
        </span>
      ) : (
        <fieldset className="min-w-0 space-y-1.5 [min-inline-size:0]">
          <legend className="label">{msg("entrants.add.kind")}</legend>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={msg("entrants.add.kind")}
          >
            {entrantModel.kinds.map((k) => {
              const active = k === kind;
              return (
                <button
                  key={k}
                  type="button"
                  data-kind={k}
                  aria-pressed={active}
                  onClick={() => pickKind(k)}
                  className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
                    active
                      ? "border-purple-600 bg-purple-600 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-purple-300"
                  }`}
                >
                  {msg(ENTRANT_KIND_LABEL[k])}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="label">Name</span>
          <input
            value={nameValue}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            className="input w-full"
            placeholder={isTeam ? "Riverside CC" : isIndividual ? "Alex Doe" : "Alice & Bob"}
          />
        </label>
        <label className="block min-w-0">
          <span className="label">Seed</span>
          <input
            type="number"
            min={1}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="input w-full"
          />
        </label>
      </div>

      <div className="min-w-0">
        <span className="label">
          {kind === "individual"
            ? msg("entrants.add.player")
            : kind === "pair"
              ? msg("entrants.add.pairPlayers")
              : "Members (persons directory)"}
        </span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input w-full"
          placeholder="Search players…"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {filtered.map((p) => {
            const selected = memberIds.includes(p.id);
            // Pair/team seats are finite: once full, unpicked people are
            // disabled. Individual always allows a replacing pick.
            const blocked = !selected && atCap && !isIndividual;
            return (
              <button
                key={p.id}
                type="button"
                disabled={blocked}
                aria-pressed={selected}
                onClick={() => togglePick(p.id)}
                className={`max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
                  selected
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : blocked
                      ? "cursor-not-allowed border-slate-200 text-slate-300"
                      : "border-slate-200 text-slate-500 hover:border-purple-200"
                }`}
              >
                {p.full_name}
              </button>
            );
          })}
          {persons.length === 0 && (
            <span className="text-xs text-slate-400">
              No players yet — add them under Players, or import a CSV.
            </span>
          )}
        </div>
        {memberIds.length > 0 && (
          <p className="mt-1 text-xs text-slate-400">{memberIds.length} selected</p>
        )}
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={busy || !submitName.trim()}
        className="btn btn-primary w-full sm:w-auto"
      >
        {busy ? "Saving…" : "Add entrant"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

interface CsvRow {
  name: string;
  dob?: string;
  gender?: string;
  team?: string;
  seed?: number;
  squad_number?: number;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes("name");
  const headers = hasHeader ? first.split(",").map((h) => h.trim()) : ["name"];
  const rows: CsvRow[] = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cells = line.split(",").map((c) => c.trim());
    const get = (key: string) => {
      const i = headers.indexOf(key);
      return i >= 0 ? cells[i] : undefined;
    };
    const name = hasHeader ? get("name") : cells[0];
    if (!name) continue;
    const row: CsvRow = { name };
    const dob = get("dob");
    if (dob) row.dob = dob;
    const gender = get("gender");
    if (gender && ["m", "f", "x"].includes(gender.toLowerCase())) {
      row.gender = gender.toLowerCase();
    }
    const team = get("team");
    if (team) row.team = team;
    const seed = get("seed");
    if (seed && Number.isInteger(Number(seed))) row.seed = Number(seed);
    const squad = get("squad_number") ?? get("number");
    if (squad && Number.isInteger(Number(squad))) row.squad_number = Number(squad);
    rows.push(row);
  }
  return rows;
}

function CsvImport({
  busy,
  onImport,
}: {
  busy: boolean;
  onImport: (rows: CsvRow[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const rows = parseCsv(await file.text());
    if (rows.length === 0) {
      setError("No entrants found in that file — check it matches the sample format.");
      return;
    }
    setError(null);
    onImport(rows);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        onChange={onFile}
        className="hidden"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="btn btn-ghost"
      >
        {busy ? "Importing…" : "Import CSV"}
      </button>
      <a
        href="/entrants-sample.csv"
        download
        className="text-xs text-purple-600 underline hover:text-purple-800"
      >
        Sample CSV
      </a>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entrant row (+ expandable roster editor)
// ---------------------------------------------------------------------------

/** F4 — the badge route is multipart, so it can't ride apiV1 (which forces a
 *  JSON content-type); same raw-fetch pattern as the /me photo upload. */
async function badgeRequest(entrantId: string, file: File | null): Promise<void> {
  let res: Response;
  if (file) {
    const form = new FormData();
    form.append("file", file);
    res = await fetch(`/api/v1/entrants/${entrantId}/badge`, { method: "POST", body: form });
  } else {
    res = await fetch(`/api/v1/entrants/${entrantId}/badge`, { method: "DELETE" });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `badge update failed (${res.status})`);
  }
}

/** Exported for the markup test. Renders the crest preview plus, when
 *  editable, upload/replace + remove controls. */
export function EntrantBadgeControl({
  entrant,
  logoUrl = null,
  canEdit,
  busy,
  onBadge,
}: {
  entrant: Pick<EntrantRow, "id" | "display_name" | "badge_url">;
  /** Resolved fallback (team logo / club crest) when no own badge is set. */
  logoUrl?: string | null;
  canEdit: boolean;
  busy: boolean;
  onBadge: (file: File | null) => void;
}) {
  const src = entrant.badge_url
    ? resolveEntrantBadge({ badge_url: entrant.badge_url })
    : (logoUrl ?? null);
  return (
    <div className="flex items-center gap-3">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-8 w-8 shrink-0 rounded-md border border-slate-200 object-cover" />
      ) : (
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-500"
        >
          {entrant.display_name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="text-xs text-slate-500">Badge</span>
      {canEdit && (
        <>
          <label className="btn btn-ghost cursor-pointer px-2 py-1 text-xs">
            {entrant.badge_url ? "Replace" : "Upload"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              disabled={busy}
              aria-label={`Badge for ${entrant.display_name}`}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) onBadge(file);
              }}
            />
          </label>
          {entrant.badge_url && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onBadge(null)}
              className="btn btn-ghost px-2 py-1 text-xs text-red-600"
            >
              Remove
            </button>
          )}
        </>
      )}
    </div>
  );
}

function EntrantTableRow({
  entrant,
  logoUrl,
  canEdit,
  busy,
  persons,
  positionGroups,
  roles,
  entrantModel,
  otherTeamsFor,
  onPatch,
  onWithdraw,
  onBadge,
}: {
  entrant: EntrantRow;
  logoUrl: string | null;
  canEdit: boolean;
  busy: boolean;
  persons: Person[];
  positionGroups: PositionGroup[];
  roles: RoleSpec[];
  entrantModel: EffectiveEntrantModel;
  otherTeamsFor: (personId: string, exceptEntrantId: string) => DivisionRosterRow[];
  onPatch: (patch: Record<string, unknown>) => void;
  /** Withdraw with fixture surgery (spec 05 §5) — confirm handled upstream. */
  onWithdraw: () => void;
  onBadge: (file: File | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && members === null) {
      try {
        const full = await apiV1<{ members: Member[] }>(`/api/v1/entrants/${entrant.id}`);
        setMembers(full.members);
      } catch {
        setMembers([]);
      }
    }
  }

  const withdrawn = entrant.status === "withdrawn" || entrant.status === "disqualified";

  return (
    <>
      <tr className={withdrawn ? "opacity-50" : ""}>
        <td className="px-4 py-2">
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-2 text-left text-sm font-medium text-slate-800 hover:text-purple-700"
          >
            {(() => {
              const src = logoUrl ?? resolveEntrantBadge({ badge_url: entrant.badge_url });
              return src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
              ) : null;
            })()}
            {entrant.display_name}
            <span className="ml-1.5 text-xs text-slate-400">{open ? "▾" : "▸"}</span>
          </button>
        </td>
        <td className="px-4 py-2 text-sm text-slate-500">{entrant.kind}</td>
        <td className="px-4 py-2 text-sm text-slate-500">
          {canEdit ? (
            <input
              type="number"
              min={1}
              defaultValue={entrant.seed ?? ""}
              onBlur={(e) => {
                const v = e.target.value ? Number(e.target.value) : null;
                if (v !== entrant.seed) onPatch({ seed: v });
              }}
              className="input w-16 px-2 py-1 text-xs"
              aria-label={`Seed for ${entrant.display_name}`}
            />
          ) : (
            (entrant.seed ?? "—")
          )}
        </td>
        <td className="px-4 py-2">
          <span className={`badge ${entrantStatusStyle(entrant.status)}`}>{entrant.status}</span>
        </td>
        {canEdit && (
          <td className="px-4 py-2 text-right">
            {withdrawn ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onPatch({ status: "registered" })}
                className="btn btn-ghost px-2 py-1 text-xs"
              >
                Reinstate
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={onWithdraw}
                className="btn btn-danger px-2 py-1 text-xs"
              >
                Withdraw
              </button>
            )}
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={canEdit ? 5 : 4} className="bg-slate-50 px-4 py-3">
            <div className="mb-3">
              <EntrantBadgeControl
                entrant={entrant}
                logoUrl={logoUrl}
                canEdit={canEdit}
                busy={busy}
                onBadge={onBadge}
              />
            </div>
            {members === null ? (
              <p className="text-xs text-slate-400">Loading roster…</p>
            ) : (
              <RosterEditor
                kind={entrant.kind}
                members={members}
                persons={persons}
                positionGroups={positionGroups}
                roles={roles}
                canEdit={canEdit}
                busy={busy}
                allowCaptain={entrantModel.captain}
                allowSquadNumbers={entrantModel.squadNumbers}
                entrantModel={entrantModel}
                conflictsFor={(personId) => otherTeamsFor(personId, entrant.id)}
                onSave={(next) =>
                  onPatch({
                    members: next.map((m) => ({
                      person_id: m.person_id,
                      squad_number: m.squad_number,
                      default_position_key: m.default_position_key,
                      is_captain: m.is_captain,
                      roles: m.roles,
                    })),
                  })
                }
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function entrantStatusStyle(status: string): string {
  if (status === "confirmed") return "bg-emerald-100 text-emerald-700";
  if (status === "withdrawn") return "bg-slate-100 text-slate-500";
  if (status === "disqualified") return "bg-red-100 text-red-600";
  return "bg-sky-100 text-sky-700";
}

export function RosterEditor({
  members: initial,
  persons,
  positionGroups,
  roles,
  canEdit,
  busy,
  kind,
  allowCaptain,
  allowSquadNumbers,
  entrantModel,
  conflictsFor,
  onSave,
}: {
  members: Member[];
  persons: Person[];
  positionGroups: PositionGroup[];
  roles: RoleSpec[];
  canEdit: boolean;
  busy: boolean;
  /** Entrant kind — only a team roster shows captain + squad number. */
  kind: string;
  /** Whether the division's effective model allows a captain marker. */
  allowCaptain: boolean;
  /** Whether the division's effective model allows squad numbers. */
  allowSquadNumbers: boolean;
  /** Effective model — supplies the team member cap for the picker gate. */
  entrantModel: EffectiveEntrantModel;
  /** Other team entrants IN THIS DIVISION a person is already on. */
  conflictsFor: (personId: string) => DivisionRosterRow[];
  onSave: (members: Member[]) => void;
}) {
  const [members, setMembers] = useState(initial);
  const [filter, setFilter] = useState("");
  const [dirty, setDirty] = useState(false);
  // Captain + squad numbers are team concepts, and each is independently
  // switchable in the division's entrant settings.
  const teamish = kind === "team";
  const atCap = members.length >= entrantKindCap(kind, entrantModel);

  function update(i: number, patch: Partial<Member>) {
    setMembers((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    setDirty(true);
  }

  const memberIds = new Set(members.map((m) => m.person_id));
  const candidates = persons
    .filter((p) => !memberIds.has(p.id))
    .filter((p) => !filter || p.full_name.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 6);

  // Advisory: people also rostered to another team in this division. Not
  // blocked — the organiser may knowingly double-roster (guest, correction).
  const conflicts = members
    .map((m) => ({ name: m.full_name, on: conflictsFor(m.person_id) }))
    .filter((c) => c.on.length > 0);

  return (
    <div className="space-y-3">
      {conflicts.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">Also on another team in this division:</span>{" "}
          {conflicts
            .map((c) => `${c.name} (${c.on.map((o) => o.entrant_name).join(", ")})`)
            .join("; ")}
          . You can still save.
        </div>
      )}
      {members.length === 0 && (
        <p className="text-xs text-slate-400">No players on this roster.</p>
      )}
      {members.map((m, i) => (
        <div key={m.person_id} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="w-40 truncate font-medium text-slate-700">
            {m.full_name}
            {conflictsFor(m.person_id).length > 0 && (
              <span
                className="ml-1 text-amber-600"
                title={`Also on ${conflictsFor(m.person_id)
                  .map((o) => o.entrant_name)
                  .join(", ")} in this division`}
              >
                ⚠
              </span>
            )}
          </span>
          {teamish && allowSquadNumbers && (
            <input
              type="number"
              min={0}
              placeholder="No."
              disabled={!canEdit}
              value={m.squad_number ?? ""}
              onChange={(e) =>
                update(i, { squad_number: e.target.value ? Number(e.target.value) : null })
              }
              className="input w-16 px-2 py-1 text-xs"
              aria-label={`Squad number for ${m.full_name}`}
            />
          )}
          {positionGroups.length > 0 && (
            <select
              disabled={!canEdit}
              value={m.default_position_key ?? ""}
              onChange={(e) => update(i, { default_position_key: e.target.value || null })}
              className="select w-36 px-2 py-1 text-xs"
              aria-label={`Position for ${m.full_name}`}
            >
              <option value="">position…</option>
              {positionGroups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {teamish && allowCaptain && (
            <label className="flex items-center gap-1 text-slate-500">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={m.is_captain}
                onChange={(e) => {
                  // Captain is unique — setting it clears the others.
                  setMembers((prev) =>
                    prev.map((mm, j) => ({
                      ...mm,
                      is_captain: j === i ? e.target.checked : false,
                    })),
                  );
                  setDirty(true);
                }}
              />
              captain
            </label>
          )}
          {/* `captain` has its own dedicated checkbox above; don't render it
              again as a generic role (some sport specs list it in roles). */}
          {roles.filter((r) => r.key !== "captain").map((r) => (
            <label key={r.key} className="flex items-center gap-1 text-slate-500">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={m.roles.includes(r.key)}
                onChange={(e) =>
                  update(i, {
                    roles: e.target.checked
                      ? [...m.roles, r.key]
                      : m.roles.filter((k) => k !== r.key),
                  })
                }
              />
              {r.name ?? r.key}
            </label>
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setMembers((prev) => prev.filter((_, j) => j !== i));
                setDirty(true);
              }}
              className="text-red-500 hover:underline"
            >
              remove
            </button>
          )}
        </div>
      ))}

      {canEdit && !atCap && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find player…"
            className="input w-44 px-2 py-1 text-xs"
          />
          {candidates.map((p) => {
            const onOther = conflictsFor(p.id);
            return (
              <button
                key={p.id}
                type="button"
                title={
                  onOther.length > 0
                    ? `Already on ${onOther.map((o) => o.entrant_name).join(", ")} in this division`
                    : undefined
                }
                onClick={() => {
                  setMembers((prev) => [
                    ...prev,
                    {
                      person_id: p.id,
                      full_name: p.full_name,
                      squad_number: null,
                      default_position_key: null,
                      is_captain: false,
                      roles: [],
                    },
                  ]);
                  setDirty(true);
                }}
                className={`rounded-full border px-2 py-0.5 text-xs hover:border-purple-300 ${
                  onOther.length > 0
                    ? "border-amber-300 text-amber-700"
                    : "border-slate-200 text-slate-500"
                }`}
              >
                + {p.full_name}
                {onOther.length > 0 && " ⚠"}
              </button>
            );
          })}
          <div className="flex-1" />
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => onSave(members)}
            className="btn btn-primary px-3 py-1 text-xs"
          >
            Save roster
          </button>
        </div>
      )}
    </div>
  );
}
