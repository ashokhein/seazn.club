"use client";

// #404 §7 — the duplicate review queue and the merge it puts a human in front of.
//
// Six states live here: an empty queue, the ranked list, the confirmation, the
// post-merge result, the session merge log, and the reversal confirmation. They
// are one file because they share one vocabulary — "keep" and "merge in" mean
// the same thing in all six, and a merge confirmed in one has to appear in the
// next two.
//
// The signature of the confirmation is the consent truth row: `Shown ∧ Hidden =
// Hidden`. A merge may never widen what a person agreed to, so consent resolves
// to the STRICTER of the two (spec §4, #403), and the dialog shows that
// resolution rather than the survivor's own flags — which is the one thing here
// that can be wrong without anybody noticing.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

// ---------------------------------------------------------------------------
// Wire shapes. These mirror `person-duplicates.ts` / `person-merge.ts` rather
// than importing them: both are `server-only`.
// ---------------------------------------------------------------------------

export interface DupPerson {
  id: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
  consent: Record<string, unknown> | null;
  external_ref: string | null;
  photo_path: string | null;
  user_id: string | null;
}

export type DupEvidenceKind = "name" | "dob" | "shared_entrant";
export interface DupEvidence {
  kind: DupEvidenceKind;
  /** Org DATA — a folded name, an ISO date, an entrant name. Never a sentence,
   *  so it is shown verbatim and owes no dictionary key. */
  detail: string;
}

export interface DupCandidate {
  a: DupPerson;
  b: DupPerson;
  score: number;
  evidence: DupEvidence[];
}

/** One published board the merge changed the meaning of. `name`/`status` are
 *  resolved lazily from `GET /divisions/{id}` — the merge response carries the
 *  id alone. Absent metadata never hides the row. */
export interface RevealedBoard {
  division_id: string;
  conflicts: { fixtureId: string; reason: string; detail?: string }[];
  name?: string;
  status?: string;
}

export interface MergeEntry {
  merge_id: string;
  survivor_name: string;
  absorbed_name: string;
  reversed?: boolean;
}

/** One row of `GET /persons/merges` — the DURABLE log. The undo window is
 *  unbounded by decision, so the history cannot live in React state: a refresh
 *  took every Undo control with it, and the decision was hollow. */
interface MergeLogRow {
  merge_id: string;
  survivor_name: string;
  absorbed_name: string;
  reversed_at: string | null;
}

interface MergeApiResult {
  merge_id: string;
  survivor: { id: string };
  revealed: { division_id: string; conflicts: RevealedBoard["conflicts"] }[];
}

// ---------------------------------------------------------------------------
// Copy tables. A dynamic `msg(\`…${kind}\`)` would not be checked against
// MessageKey, so every lookup goes through a literal map.
// ---------------------------------------------------------------------------

const EVIDENCE_KINDS: DupEvidenceKind[] = ["name", "dob", "shared_entrant"];

const EVIDENCE_LABEL: Record<DupEvidenceKind, MessageKey> = {
  name: "persons.dupes.evidence.name",
  dob: "persons.dupes.evidence.dob",
  shared_entrant: "persons.dupes.evidence.shared_entrant",
};

/** The scheduler's own vocabulary, reused rather than restated — an organiser
 *  who has seen "person overlap" on a board should read the same words here.
 *  An unmapped reason falls back to the generic label; it never renders raw. */
const CONFLICT_LABEL: Record<string, MessageKey> = {
  court: "board.conflict.conflict.court",
  rest: "board.conflict.warn.rest",
  person_overlap: "board.conflict.warn.person_overlap",
  order: "board.conflict.warn.order",
  blackout: "board.conflict.warn.blackout",
  window: "board.conflict.warn.window",
  instruction: "board.conflict.warn.instruction",
  no_slot: "board.conflict.warn.no_slot",
};

/** Consent flags this app names. Anything else an import wrote is still
 *  resolved and shown, under its raw key, after these two. */
const CONSENT_LABEL: Record<string, MessageKey> = {
  public_name: "persons.consent.name",
  public_photo: "persons.consent.photo",
};

/**
 * The client-side twin of `resolveConsent` in `person-merge.ts`: every boolean
 * flag resolves to `survivor && absorbed`, and an absent flag is a "no". Kept
 * as its own exported function so the dialog cannot quietly show one rule while
 * the server applies another.
 */
export function resolveConsentFlags(
  survivor: Record<string, unknown> | null,
  absorbed: Record<string, unknown> | null,
): Record<string, boolean> {
  const s = survivor ?? {};
  const a = absorbed ?? {};
  const out: Record<string, boolean> = {};
  for (const key of new Set([...Object.keys(s), ...Object.keys(a)])) {
    if (typeof s[key] === "boolean" || typeof a[key] === "boolean") {
      out[key] = s[key] === true && a[key] === true;
    }
  }
  return out;
}

const consentOrder = (keys: string[]): string[] => [
  ...Object.keys(CONSENT_LABEL).filter((k) => keys.includes(k)),
  ...keys.filter((k) => !(k in CONSENT_LABEL)).sort(),
];

const errorText = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback;

// ---------------------------------------------------------------------------
// State 1 + 2 — the queue itself, and the shell that owns states 3-6.
// ---------------------------------------------------------------------------

export function DuplicatesPanel({
  candidates,
  canEdit,
}: {
  candidates: DupCandidate[];
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [review, setReview] = useState<DupCandidate | null>(null);
  const [outcome, setOutcome] = useState<{
    entry: MergeEntry;
    boards: RevealedBoard[];
  } | null>(null);
  const [history, setHistory] = useState<MergeEntry[]>([]);
  const [reversing, setReversing] = useState<MergeEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The log is loaded on mount rather than passed down from the page: it is a
  // record of writes THIS panel makes, so it has to stay current after a merge
  // and after an undo without a server round-trip of the whole page.
  //
  // Merged by id rather than replacing state — a merge confirmed while the load
  // is still in flight is already in `history`, and the log would otherwise
  // either duplicate it or drop it depending on which landed first. Failure is
  // silent on purpose: an unreachable log must not take the review queue, which
  // is server-rendered and already on screen, down with it.
  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    void apiV1<{ items: MergeLogRow[] }>("/api/v1/persons/merges")
      .then((res) => {
        if (!live) return;
        const loaded: MergeEntry[] = (res.items ?? []).map((row) => ({
          merge_id: row.merge_id,
          survivor_name: row.survivor_name,
          absorbed_name: row.absorbed_name,
          reversed: row.reversed_at !== null,
        }));
        setHistory((prev) => [
          ...prev,
          ...loaded.filter((row) => !prev.some((e) => e.merge_id === row.merge_id)),
        ]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [canEdit]);

  function onMerged(result: MergeApiResult, survivor: DupPerson, absorbed: DupPerson) {
    const entry: MergeEntry = {
      merge_id: result.merge_id,
      survivor_name: survivor.full_name,
      absorbed_name: absorbed.full_name,
    };
    setReview(null);
    setHistory((prev) => [entry, ...prev]);
    setOutcome({ entry, boards: result.revealed ?? [] });
    router.refresh();
    // A revealed board arrives as a bare id. Name and status are fetched after
    // the fact so a slow or failed lookup can never delay — or suppress — the
    // report itself.
    void Promise.all(
      (result.revealed ?? []).map(async (board) => {
        try {
          const division = await apiV1<{ name: string; status: string }>(
            `/api/v1/divisions/${board.division_id}`,
          );
          return { ...board, name: division.name, status: division.status };
        } catch {
          return { ...board } as RevealedBoard;
        }
      }),
    ).then((boards) => setOutcome((prev) => (prev ? { ...prev, boards } : prev)));
  }

  function onReversed(mergeId: string) {
    setHistory((prev) =>
      prev.map((e) => (e.merge_id === mergeId ? { ...e, reversed: true } : e)),
    );
    setReversing(null);
    setOutcome(null);
    router.refresh();
  }

  return (
    <section aria-labelledby="dupes-title" className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="app-eyebrow mb-1">{msg("persons.dupes.eyebrow")}</p>
          <h2 id="dupes-title" className="app-display text-lg font-semibold text-slate-800">
            {msg("persons.dupes.title")}
          </h2>
        </div>
        {candidates.length > 0 && (
          <p
            data-dupes-count={String(candidates.length)}
            className="inline-flex items-baseline gap-1.5 rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 ring-1 ring-inset ring-purple-100"
          >
            <span className="text-sm tabular-nums font-semibold">{candidates.length}</span>
            {msg("persons.dupes.count")}
          </p>
        )}
      </header>
      <p className="max-w-2xl text-sm text-slate-500">{msg("persons.dupes.desc")}</p>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600" role="status">
          {error}
        </p>
      )}

      {candidates.length === 0 ? (
        <div
          data-dupes-empty="true"
          className="card relative overflow-hidden px-5 py-6 sm:px-6 sm:py-7"
        >
          {/* The one flourish on the good state: the console's lime floodlight
              hairline, so "nothing to do" reads as a finished check. */}
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-1"
            style={{ background: "linear-gradient(90deg, var(--mk-lime), transparent 80%)" }}
          />
          <div className="flex items-start gap-4">
            <span
              aria-hidden
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-base text-emerald-600 ring-1 ring-inset ring-emerald-100"
            >
              ✓
            </span>
            <div className="min-w-0">
              <p className="app-display text-sm font-semibold text-slate-800">
                {msg("persons.dupes.empty.title")}
              </p>
              <p className="mt-1 max-w-md text-sm text-slate-500">
                {msg("persons.dupes.empty.body")}
              </p>
              <p className="mt-2 text-xs text-slate-400">{msg("persons.dupes.empty.live")}</p>
            </div>
          </div>
        </div>
      ) : (
        <ol className="space-y-3">
          {candidates.map((candidate) => (
            <li
              key={`${candidate.a.id}:${candidate.b.id}`}
              data-candidate={`${candidate.a.id}:${candidate.b.id}`}
              className="card p-4 sm:p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                {/* The pair, bracketed: two records reading as one proposal. */}
                <ul className="min-w-0 flex-1 space-y-1 border-l-2 border-purple-100 pl-3">
                  {[candidate.a, candidate.b].map((person) => (
                    <li key={person.id} className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-800">
                        {person.full_name}
                      </span>
                      <span className="block truncate text-xs tabular-nums text-slate-400">
                        {[person.dob, person.gender, person.external_ref]
                          .filter(Boolean)
                          .join(" · ") || msg("persons.dupes.value.none")}
                      </span>
                    </li>
                  ))}
                </ul>
                {canEdit && (
                  <button
                    type="button"
                    data-review={`${candidate.a.id}:${candidate.b.id}`}
                    onClick={() => setReview(candidate)}
                    className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
                  >
                    {msg("persons.dupes.review")}
                  </button>
                )}
              </div>

              <div className="mt-3 border-t border-purple-50 pt-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-purple-700">
                  {msg("persons.dupes.strength")}
                </p>
                {/* Three signals, always all three: which ones did NOT fire is
                    as much of the answer as which ones did. */}
                <ul className="flex flex-wrap gap-1.5">
                  {EVIDENCE_KINDS.map((kind) => {
                    const hit = candidate.evidence.find((e) => e.kind === kind);
                    return (
                      <li
                        key={kind}
                        data-evidence-kind={kind}
                        data-evidence-on={hit ? "true" : "false"}
                        className={`inline-flex max-w-full items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                          hit
                            ? "border-purple-200 bg-purple-50 text-purple-800"
                            : "border-dashed border-slate-200 bg-white text-slate-300"
                        }`}
                      >
                        <span className="font-medium">{msg(EVIDENCE_LABEL[kind])}</span>
                        {hit && (
                          <span className="truncate tabular-nums text-purple-500">
                            {hit.detail}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      )}

      {history.length > 0 && (
        <MergeHistoryList entries={history} onUndo={(entry) => setReversing(entry)} />
      )}

      {review && (
        <MergeConfirmDialog
          a={review.a}
          b={review.b}
          onCancel={() => setReview(null)}
          onMerged={onMerged}
        />
      )}

      {outcome && (
        <div className="modal-overlay">
          <div className="modal max-h-[90vh] overflow-y-auto sm:max-w-xl">
            <span aria-hidden className="sheet-handle" />
            <MergeOutcomeCard
              survivorName={outcome.entry.survivor_name}
              boards={outcome.boards}
              onUndo={() => setReversing(outcome.entry)}
              onClose={() => setOutcome(null)}
            />
          </div>
        </div>
      )}

      {reversing && (
        <ReverseConfirmDialog
          entry={reversing}
          onCancel={() => setReversing(null)}
          onReversed={onReversed}
          onError={(message) => {
            setReversing(null);
            setError(message);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// State 3 — the confirmation. Also the hand-pick path: `persons-panel.tsx`
// opens this same dialog, so a merge started from the roster gets the same
// record diff, the same consent resolution and the same affirmation.
// ---------------------------------------------------------------------------

export function MergeConfirmDialog({
  a,
  b,
  onCancel,
  onMerged,
}: {
  a: DupPerson;
  b: DupPerson;
  onCancel: () => void;
  onMerged: (result: MergeApiResult, survivor: DupPerson, absorbed: DupPerson) => void;
}) {
  const msg = useMsg();
  const [keepFirst, setKeepFirst] = useState(true);
  const [affirmed, setAffirmed] = useState(false);
  const [affirmedDob, setAffirmedDob] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const survivor = keepFirst ? a : b;
  const absorbed = keepFirst ? b : a;
  // The queue never suggests this pair (§6). A hand-picked one is allowed, and
  // it buys its own affirmation with both dates on screen.
  const dobDiffer = !!a.dob && !!b.dob && a.dob !== b.dob;
  const resolved = useMemo(
    () => resolveConsentFlags(survivor.consent, absorbed.consent),
    [survivor.consent, absorbed.consent],
  );
  const ready = affirmed && (!dobDiffer || affirmedDob) && !busy;
  // The account link belongs to the human, not to whichever row the organiser
  // kept: `mergePersons` carries `user_id` onto an unlinked survivor and
  // releases it from the tombstone in the same statement. Nothing is stranded —
  // but the organiser is about to fold away the record their player signs in
  // to, and the surviving record's own name and details are what that player
  // will see afterwards, so the dialog says which record holds the link and
  // offers the swap rather than staying silent about it.
  const carriesAccount = !survivor.user_id && !!absorbed.user_id;

  const fields: { label: MessageKey; of: (p: DupPerson) => string }[] = [
    { label: "persons.dupes.field.name", of: (p) => p.full_name },
    { label: "persons.dupes.field.dob", of: (p) => p.dob ?? "" },
    { label: "persons.dupes.field.gender", of: (p) => p.gender ?? "" },
    { label: "persons.dupes.field.ref", of: (p) => p.external_ref ?? "" },
    {
      label: "persons.dupes.field.account",
      of: (p) => (p.user_id ? msg("persons.dupes.value.linked") : ""),
    },
  ];

  const pill = (on: boolean, strong = false) => (
    <span
      title={strong ? msg("persons.dupes.consent.after") : undefined}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        on
          ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-100"
          : "bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200"
      } ${strong ? "ring-2 ring-purple-300" : ""}`}
    >
      <span aria-hidden>{on ? "✓" : "–"}</span>
      {on ? msg("persons.dupes.consent.on") : msg("persons.dupes.consent.off")}
    </span>
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiV1<MergeApiResult>(`/api/v1/persons/${survivor.id}/merge`, {
        method: "POST",
        json: {
          duplicate_id: absorbed.id,
          // The organiser's yes is a wire field: the usecase cannot tell a
          // confirmed merge from an unconfirmed one, and the route 422s
          // MERGE_NOT_CONFIRMED without it.
          confirmed: true,
          ...(dobDiffer ? { allow_dob_mismatch: true } : {}),
        },
      });
      onMerged(result, survivor, absorbed);
    } catch (err) {
      setError(errorText(err, msg("persons.dupes.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={msg("persons.dupes.dialog.title")}
        className="modal max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <span aria-hidden className="sheet-handle" />
        <h2 className="app-display text-lg font-semibold text-slate-800">
          {msg("persons.dupes.dialog.title")}
        </h2>

        {dobDiffer && (
          <p
            data-dob-differ="true"
            className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800"
          >
            {msg("persons.dupes.dob.differ")}{" "}
            <span className="font-semibold tabular-nums">
              {a.dob} · {b.dob}
            </span>
          </p>
        )}

        {carriesAccount && (
          <p
            data-account-note="1"
            className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700"
          >
            {msg("persons.dupes.account.note")}
            <button
              type="button"
              data-swap-account="1"
              onClick={() => setKeepFirst((v) => !v)}
              className="font-semibold underline underline-offset-2 hover:text-slate-900"
            >
              {msg("persons.dupes.dialog.swap")}
            </button>
          </p>
        )}

        {/* The record diff. Genuinely wide, so it opts into its own scroll
            container above `sm`; below `sm` each field stacks instead. */}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-swap="1"
            onClick={() => setKeepFirst((v) => !v)}
            className="rounded px-1 text-xs font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900"
          >
            {msg("persons.dupes.dialog.swap")}
          </button>
        </div>
        <div className="scroll-x mt-1">
          <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-[6.5rem_minmax(0,1fr)_1.75rem_minmax(0,1fr)]">
            <p className="hidden sm:block" />
            <p className="hidden text-[11px] font-semibold uppercase tracking-[0.16em] text-purple-700 sm:block">
              {msg("persons.dupes.dialog.keepCol")}
            </p>
            <p className="hidden sm:block" />
            <p className="hidden text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 sm:block">
              {msg("persons.dupes.dialog.absorbCol")}
            </p>

            {fields.map(({ label, of }) => {
              const kept = of(survivor);
              const gone = of(absorbed);
              const differs = kept !== gone;
              const shown = (value: string) =>
                value || <span className="text-slate-300">{msg("persons.dupes.value.none")}</span>;
              return (
                <div key={label} className="contents">
                  <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-purple-700 sm:mt-3 sm:self-center">
                    {msg(label)}
                  </p>
                  {/* The column headers are the only thing naming the two
                      sides, and they are off screen once the grid stacks — so
                      below `sm` every value carries its own side. */}
                  <p className="flex items-baseline gap-2 text-sm tabular-nums text-slate-800 sm:mt-3 sm:self-center">
                    <span
                      data-role="keep"
                      className="w-16 shrink-0 text-[10px] uppercase tracking-[0.12em] text-purple-400 sm:hidden"
                    >
                      {msg("persons.dupes.dialog.keepShort")}
                    </span>
                    {shown(kept)}
                  </p>
                  <p
                    aria-hidden
                    className={`hidden text-center text-xs sm:mt-3 sm:block sm:self-center ${
                      differs ? "text-amber-500" : "text-slate-300"
                    }`}
                  >
                    {differs ? "≠" : "·"}
                  </p>
                  <p
                    className={`flex items-baseline gap-2 text-sm tabular-nums text-slate-400 sm:mt-3 sm:self-center ${
                      differs ? "sm:line-through" : ""
                    }`}
                  >
                    <span
                      data-role="absorb"
                      className="w-16 shrink-0 text-[10px] uppercase tracking-[0.12em] text-slate-300 sm:hidden"
                    >
                      {msg("persons.dupes.dialog.absorbShort")}
                    </span>
                    <span className={differs ? "line-through sm:no-underline" : ""}>
                      {shown(gone)}
                    </span>
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* The signature: consent as a truth row. Not the survivor's flags —
            the resolution, spelled out, one row per flag. */}
        <section className="mt-5 rounded-xl border border-purple-100 bg-purple-50/40 px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-purple-700">
              {msg("persons.dupes.consent.title")}
            </h3>
            <p className="text-xs text-purple-500">{msg("persons.dupes.consent.rule")}</p>
          </div>
          <ul className="mt-2 space-y-2">
            {consentOrder(Object.keys(resolved)).map((key) => (
              <li
                key={key}
                data-consent-key={key}
                data-resolved={resolved[key] ? "on" : "off"}
                className="flex flex-wrap items-center gap-x-2 gap-y-1"
              >
                {/* Full width below `sm` so the equation below it never wraps
                    mid-way and strands the resolved pill on its own line. */}
                <span className="w-full text-[11px] uppercase tracking-[0.14em] text-slate-500 sm:w-16 sm:shrink-0">
                  {key in CONSENT_LABEL ? msg(CONSENT_LABEL[key]!) : key}
                </span>
                {pill((survivor.consent ?? {})[key] === true)}
                <span aria-hidden className="text-sm text-purple-300">
                  ∧
                </span>
                {pill((absorbed.consent ?? {})[key] === true)}
                <span aria-hidden className="text-sm text-purple-300">
                  =
                </span>
                {pill(resolved[key] === true, true)}
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-4 text-xs text-slate-500">{msg("persons.dupes.undoable")}</p>

        <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            data-affirm="1"
            checked={affirmed}
            onChange={(e) => setAffirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-purple-200 accent-purple-600"
          />
          {msg("persons.dupes.affirm")}
        </label>
        {dobDiffer && (
          <label className="mt-2 flex items-start gap-2 text-sm text-amber-800">
            <input
              type="checkbox"
              data-affirm-dob="1"
              checked={affirmedDob}
              onChange={(e) => setAffirmedDob(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-300 accent-amber-600"
            />
            {msg("persons.dupes.affirmDob")}
          </label>
        )}

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600" role="status">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            {msg("persons.dupes.cancel")}
          </button>
          <button
            type="button"
            data-merge-confirm="1"
            disabled={!ready}
            onClick={submit}
            className="btn btn-primary"
          >
            {busy ? msg("persons.dupes.merging") : msg("persons.dupes.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State 4 — what the merge revealed.
// ---------------------------------------------------------------------------

export function MergeOutcomeCard({
  survivorName,
  boards,
  onUndo,
  onClose,
}: {
  survivorName: string;
  boards: RevealedBoard[];
  onUndo: () => void;
  onClose: () => void;
}) {
  const msg = useMsg();
  return (
    <div>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-sm text-emerald-600 ring-1 ring-inset ring-emerald-100"
        >
          ✓
        </span>
        <div className="min-w-0">
          <h2 className="app-display text-lg font-semibold text-slate-800">
            {msg("persons.dupes.result.title", { name: survivorName })}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {msg("persons.dupes.result.body", { name: survivorName })}
          </p>
        </div>
      </div>

      {boards.length > 0 && (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-3 sm:px-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-800">
            {msg("persons.dupes.revealed.title")}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-amber-800/80">
            {msg("persons.dupes.revealed.body")}
          </p>
          <ul className="mt-2.5 space-y-2">
            {boards.map((board) => {
              // A finished competition is shown quietly, never hidden: an
              // overlap on a completed board is a data-quality signal, not a
              // scheduling job.
              const completed = board.status === "completed";
              const reasons = [...new Set(board.conflicts.map((c) => c.reason))];
              return (
                <li
                  key={board.division_id}
                  data-board={board.division_id}
                  data-board-completed={completed ? "true" : "false"}
                  className={`rounded-lg border bg-white px-3 py-2 ${
                    completed ? "border-slate-200 opacity-70" : "border-amber-200"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-sm font-medium text-slate-800">
                      {board.name ?? `${msg("persons.dupes.revealed.board")} ${board.division_id}`}
                    </span>
                    {completed && (
                      <span className="badge bg-slate-100 normal-case text-slate-500">
                        {msg("persons.dupes.revealed.completed")}
                      </span>
                    )}
                    <span className="ml-auto text-xs tabular-nums text-slate-400">
                      {board.conflicts.length}
                    </span>
                  </div>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {reasons.map((reason) => (
                      <li
                        key={reason}
                        data-conflict-reason={reason}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
                      >
                        {CONFLICT_LABEL[reason]
                          ? msg(CONFLICT_LABEL[reason]!)
                          : msg("persons.dupes.conflict.other")}
                      </li>
                    ))}
                  </ul>
                  {completed && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                      {msg("persons.dupes.revealed.completedNote")}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" data-outcome-undo="1" onClick={onUndo} className="btn btn-danger">
          {msg("persons.dupes.undo")}
        </button>
        <button type="button" onClick={onClose} className="btn btn-primary">
          {msg("persons.dupes.result.done")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State 5 — the session merge log. A reversed merge stays in it: the log is
// the audit trail, and an entry that vanished on undo would read as "that
// never happened".
// ---------------------------------------------------------------------------

export function MergeHistoryList({
  entries,
  onUndo,
}: {
  entries: MergeEntry[];
  onUndo: (entry: MergeEntry) => void;
}) {
  const msg = useMsg();
  return (
    <section className="card px-4 py-3 sm:px-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-purple-700">
        {msg("persons.dupes.history.title")}
      </h3>
      <p className="mt-1 text-xs text-slate-400">{msg("persons.dupes.history.body")}</p>
      <ul className="mt-2 divide-y divide-purple-50">
        {entries.map((entry) => (
          <li
            key={entry.merge_id}
            data-merge-entry={entry.merge_id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2"
          >
            <span className="min-w-0 text-sm text-slate-700">
              <span className="font-medium text-slate-800">{entry.survivor_name}</span>{" "}
              <span className="text-xs text-slate-400">{msg("persons.dupes.history.pair")}</span>{" "}
              <span className="text-slate-500">{entry.absorbed_name}</span>
            </span>
            {entry.reversed ? (
              <span className="badge bg-slate-100 normal-case text-slate-500">
                {msg("persons.dupes.history.reversed")}
              </span>
            ) : (
              <button
                type="button"
                data-undo={entry.merge_id}
                onClick={() => onUndo(entry)}
                className="btn btn-ghost px-2.5 py-1 text-xs"
              >
                {msg("persons.dupes.undo")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// State 6 — the reversal confirmation.
// ---------------------------------------------------------------------------

export function ReverseConfirmDialog({
  entry,
  onCancel,
  onReversed,
  onError,
}: {
  entry: MergeEntry;
  onCancel: () => void;
  onReversed: (mergeId: string) => void;
  onError: (message: string) => void;
}) {
  const msg = useMsg();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await apiV1(`/api/v1/persons/merges/${entry.merge_id}/reverse`, {
        method: "POST",
        json: { confirmed: true },
      });
      onReversed(entry.merge_id);
    } catch (err) {
      onError(errorText(err, msg("persons.dupes.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={msg("persons.dupes.reverse.title")}
        className="modal"
      >
        <span aria-hidden className="sheet-handle" />
        <h2 className="app-display text-lg font-semibold text-slate-800">
          {msg("persons.dupes.reverse.title")}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          {msg("persons.dupes.reverse.body", {
            absorbed: entry.absorbed_name,
            survivor: entry.survivor_name,
          })}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            {msg("persons.dupes.cancel")}
          </button>
          <button
            type="button"
            data-reverse-confirm="1"
            disabled={busy}
            onClick={submit}
            className="btn btn-danger"
          >
            {busy ? msg("persons.dupes.reverse.working") : msg("persons.dupes.reverse.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
