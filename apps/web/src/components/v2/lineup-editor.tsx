"use client";

// Per-fixture lineup editor: pick starters/bench from the entrant's roster,
// assign positions/order from the module catalog. PUT replaces the lineup
// (doc 08 §3); the engine validates size/roles at the scoring door.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import type {
  SideInfo,
  LineupSlotIn,
  PersonAvailability,
} from "@/components/v2/fixture-console";
import { useMsg } from "@/components/i18n/dict-provider";

interface Props {
  fixtureId: string;
  side: SideInfo;
  positionGroups: { key: string; name: string }[];
  roles: { key: string; name?: string }[];
  lineupSize: number;
  canEdit: boolean;
  onSaved: () => void;
  /** Player RSVP/check-in per person (PROMPT-53). No entry → "—" chip. */
  availability?: Record<string, PersonAvailability>;
}

// RSVP chip vocabulary: ✓ in / ✗ out / ? maybe / — no answer (or unclaimed).
// Marks + colours are structural; the labels come from the `ui` catalog.
const AVAIL_CHIP: Record<PersonAvailability["status"], { mark: string; cls: string }> = {
  in: { mark: "✓", cls: "bg-emerald-100 text-emerald-700" },
  out: { mark: "✗", cls: "bg-red-100 text-red-600" },
  maybe: { mark: "?", cls: "bg-amber-100 text-amber-700" },
};
const AVAIL_LABEL_KEY: Record<PersonAvailability["status"], "lineup.avail.in" | "lineup.avail.out" | "lineup.avail.maybe"> = {
  in: "lineup.avail.in",
  out: "lineup.avail.out",
  maybe: "lineup.avail.maybe",
};

function AvailabilityChip({
  personName,
  info,
}: {
  personName: string;
  info: PersonAvailability | undefined;
}) {
  const msg = useMsg();
  if (!info) {
    return (
      <span
        aria-label={msg("lineup.noAnswer", { name: personName })}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[11px] text-slate-400"
        data-testid="availability-chip"
      >
        —
      </span>
    );
  }
  const chip = AVAIL_CHIP[info.status];
  const label = msg(AVAIL_LABEL_KEY[info.status]);
  return (
    <span className="inline-flex items-center gap-1" data-testid="availability-chip">
      <span
        aria-label={msg("lineup.statusAria", { name: personName, label }) + (info.note ? ` — ${info.note}` : "")}
        title={info.note ?? undefined}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${chip.cls}`}
      >
        {chip.mark}
      </span>
      {info.checked_in_at && (
        <span
          aria-label={msg("lineup.checkedInAria", { name: personName })}
          title={msg("lineup.checkedInTitle")}
          className="inline-block h-2 w-2 rounded-full bg-lime-500"
          data-testid="checkedin-dot"
        />
      )}
    </span>
  );
}

interface SlotDraft {
  person_id: string;
  full_name: string;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number;
  roles: string[];
}

export function LineupEditor({
  fixtureId,
  side,
  positionGroups,
  roles,
  lineupSize,
  canEdit,
  onSaved,
  availability = {},
}: Props) {
  const msg = useMsg();
  const [slots, setSlots] = useState<SlotDraft[]>(() =>
    side.lineup.map((s: LineupSlotIn, i) => ({
      person_id: s.person_id,
      full_name: s.full_name,
      slot: s.slot,
      position_key: s.position_key,
      order_no: s.order_no ?? i + 1,
      roles: s.roles ?? [],
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const inLineup = new Set(slots.map((s) => s.person_id));
  const startingCount = slots.filter((s) => s.slot === "starting").length;

  function add(member: SideInfo["members"][number], slot: "starting" | "bench") {
    setSlots((prev) => [
      ...prev,
      {
        person_id: member.person_id,
        full_name: member.full_name,
        slot,
        position_key: member.default_position_key,
        order_no: prev.length + 1,
        roles: member.roles ?? [],
      },
    ]);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/lineups/${side.id}`, {
        method: "PUT",
        json: {
          slots: slots.map((s, i) => ({
            person_id: s.person_id,
            slot: s.slot,
            position_key: s.position_key,
            order_no: i + 1,
            roles: s.roles,
          })),
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("lineup.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{msg("lineup.title", { name: side.name })}</h3>
        <span
          className={`text-xs ${startingCount === lineupSize ? "text-emerald-600" : "text-slate-400"}`}
        >
          {msg("lineup.starting", { n: startingCount, total: lineupSize })}
        </span>
      </header>

      {slots.length === 0 && (
        <p className="mb-2 text-xs text-slate-400">
          {canEdit ? msg("lineup.emptyEdit") : msg("lineup.empty")}
        </p>
      )}

      <ul className="space-y-1.5">
        {slots.map((s, i) => (
          <li key={s.person_id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-7 font-mono text-slate-400">{i + 1}.</span>
            <span className="w-36 truncate font-medium text-slate-700">{s.full_name}</span>
            <AvailabilityChip personName={s.full_name} info={availability[s.person_id]} />
            <select
              disabled={!canEdit}
              value={s.slot}
              onChange={(e) => {
                const v = e.target.value as "starting" | "bench";
                setSlots((prev) => prev.map((x, j) => (j === i ? { ...x, slot: v } : x)));
                setSaved(false);
              }}
              className="select w-24 px-2 py-1 text-xs"
              aria-label={msg("lineup.slotAria", { name: s.full_name })}
            >
              <option value="starting">{msg("lineup.slotStarting")}</option>
              <option value="bench">{msg("lineup.slotBench")}</option>
            </select>
            {positionGroups.length > 0 && (
              <select
                disabled={!canEdit}
                value={s.position_key ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setSlots((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, position_key: v } : x)),
                  );
                  setSaved(false);
                }}
                className="select w-32 px-2 py-1 text-xs"
                aria-label={msg("lineup.positionAria", { name: s.full_name })}
              >
                <option value="">{msg("lineup.positionPlaceholder")}</option>
                {positionGroups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            {roles.map((r) => (
              <label key={r.key} className="flex items-center gap-1 text-slate-500">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={s.roles.includes(r.key)}
                  onChange={(e) => {
                    setSlots((prev) =>
                      prev.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              roles: e.target.checked
                                ? [...x.roles, r.key]
                                : x.roles.filter((k) => k !== r.key),
                            }
                          : x,
                      ),
                    );
                    setSaved(false);
                  }}
                />
                {r.name ?? r.key}
              </label>
            ))}
            {canEdit && (
              <span className="flex gap-1">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => {
                    setSlots((prev) => {
                      const next = [...prev];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      return next;
                    });
                    setSaved(false);
                  }}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label={msg("lineup.moveUp", { name: s.full_name })}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === slots.length - 1}
                  onClick={() => {
                    setSlots((prev) => {
                      const next = [...prev];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      return next;
                    });
                    setSaved(false);
                  }}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label={msg("lineup.moveDown", { name: s.full_name })}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSlots((prev) => prev.filter((_, j) => j !== i));
                    setSaved(false);
                  }}
                  className="text-red-500 hover:underline"
                >
                  ×
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-2">
          <div className="flex flex-wrap gap-1.5">
            {side.members
              .filter((m) => !inLineup.has(m.person_id))
              .map((m) => (
                <span key={m.person_id} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500">
                  <AvailabilityChip personName={m.full_name} info={availability[m.person_id]} />
                  {m.full_name}
                  <button
                    type="button"
                    onClick={() => add(m, "starting")}
                    className="text-purple-600 hover:underline"
                  >
                    {msg("lineup.addStart")}
                  </button>
                  <button
                    type="button"
                    onClick={() => add(m, "bench")}
                    className="text-slate-400 hover:underline"
                  >
                    {msg("lineup.addBench")}
                  </button>
                </span>
              ))}
            {side.members.length === 0 && (
              <span className="text-xs text-slate-400">{msg("lineup.noRoster")}</span>
            )}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {saved && <p className="text-xs text-emerald-600">{msg("lineup.saved")}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {busy ? msg("lineup.saving") : msg("lineup.save")}
          </button>
        </div>
      )}
    </section>
  );
}
