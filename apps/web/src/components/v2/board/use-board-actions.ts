"use client";

// Board action layer (v3/04 §2): every schedule write, optimistic overrides,
// debounced re-validation, realtime refresh, and the optimistic-concurrency
// resync (v3/11 gap 10). Views stay dumb — they call these.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { dayKey, PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED } from "@/lib/schedule-board";
import type { FeedLabelPair } from "@/lib/schedule-board";
import type {
  AutoScheduleRequest,
  ScheduleMetrics,
  ScheduleSolverInfo,
} from "@/server/api-v1/schemas";

/** Which solver a run is asking for. Off the request schema rather than
 *  re-declared, so a fourth mode cannot appear on the wire without every caller
 *  here being typechecked against it. */
export type AutoScheduleMode = AutoScheduleRequest["mode"];
import {
  CONFLICT_HELP,
  cardTitle,
  type BoardConflict,
  type BoardDivision,
  type BoardFixture,
} from "./types";

type Override = { scheduled_at: string | null; court_label: string | null; schedule_locked: boolean };

/**
 * A publish/start refusal from the server-side validation gate, carried back to
 * the caller intact.
 *
 * `kind` is derived from the CODE, never from the conflict rows: the two are not
 * interchangeable. `conflict.start_window` is non-blocking and `warn.window` IS
 * blocking, so a client that recomputed "is anything blocking" from the list
 * would disagree with the server that produced it — and would offer a "publish
 * anyway" button that can only ever 422 again.
 */
export interface GateRefusal {
  kind: "blocking" | "warnings";
  conflicts: BoardConflict[];
}

export interface BoardActions {
  board: BoardFixture[];
  conflicts: BoardConflict[];
  conflictsByFixture: Record<string, BoardConflict[]>;
  error: string | null;
  notice: string | null;
  paywall: string | null;
  busy: boolean;
  /** The LAST conflicts check failed (#230 item 5). The conflicts list is then
   *  whatever the last successful check returned — possibly nothing, which is
   *  byte-for-byte what a clean board looks like — so this is the only thing
   *  that distinguishes "no conflicts" from "nobody could ask". */
  checkFailed: boolean;
  /** A conflicts check is in flight; the manual retry is disabled while it is. */
  checking: boolean;
  /**
   * Board quality + solver telemetry from the LAST auto/re-flow run, for the
   * result strip. Null whenever the wire did not carry them — the strip stays
   * away rather than reporting zeros.
   *
   * CLEARED BY EVERY BOARD WRITE, not only by the next run. The strip describes
   * a board; the instant that board is edited, every number on it is about a
   * timetable that no longer exists — drag one card after an auto pass and
   * "Scheduled 6/6 · Total length 1h 30m" is a statement about the board before
   * the drag. It used to be set and cleared inside `autoRun` alone, so it
   * outlived `moveCard`, `togglePin`, `shiftDay`, `swapCourts` and `act`.
   *
   * `togglePin` clears it too, even though a pin moves no card and invalidates
   * no number the strip prints. "Which writes invalidate which cell" is a
   * judgement the next person would have to re-make, correctly, for every cell
   * added later; "every write clears it" cannot rot. Pinned by
   * `__tests__/result-strip-wiring.test.tsx`.
   */
  lastRun: { metrics: ScheduleMetrics; solver: ScheduleSolverInfo } | null;
  /** Re-run the check NOW, not on the 400ms debounce. A button whose effect
   *  starts half a second later is indistinguishable from a dead one. */
  revalidate: () => Promise<void>;
  setError: (e: string | null) => void;
  setNotice: (n: string | null) => void;
  moveCard: (fixtureId: string, atIso: string | null, court: string | null) => Promise<boolean>;
  togglePin: (f: BoardFixture) => Promise<void>;
  /**
   * Propose + apply for one stage.
   *
   * `mode` is OMITTED by the two original callers and that is the contract, not
   * an oversight: `AutoScheduleRequest` derives it from `only_unlocked` server
   * side (absent or true -> reflow, false -> build), and the derivation is pinned
   * there. Sending it from here as well would move the decision to the client
   * with nothing to notice when the two definitions drift.
   *
   * POLISH is the exception, because it is the one mode `only_unlocked` cannot
   * express: it re-flows the unlocked cards exactly as REFLOW does, and asks the
   * tier solver to improve the board rather than the repair solver to make it
   * legal.
   */
  autoRun: (stageId: string, onlyUnlocked: boolean, mode?: AutoScheduleMode) => Promise<void>;
  /**
   * Publish / start. Resolves to `null` when the action landed, and to the
   * gate's refusal when the server would not put this board in front of players
   * (#230 item 2 follow-up) — the caller opens the confirm dialog on that and
   * calls back with `acknowledgeWarnings: true`.
   *
   * A refusal is deliberately a RETURN VALUE rather than a thrown error routed
   * through `fail`: `fail` renders one sentence and discards `extra.conflicts`,
   * and the whole point here is to show the organiser which conflicts and offer
   * the way through.
   */
  act: (path: string, done: string, acknowledgeWarnings?: boolean) => Promise<GateRefusal | null>;
  shiftDay: (day: string, minutes: number) => Promise<void>;
  swapCourts: (day: string, a: string, b: string) => Promise<void>;
  queueValidate: () => void;
}

export function useBoardActions(
  divisions: BoardDivision[],
  fixtures: BoardFixture[],
  entrantNames: Record<string, string>,
  feedLabels: Record<string, FeedLabelPair>,
  canEdit: boolean,
): BoardActions {
  const msg = useMsg();
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [conflicts, setConflicts] = useState<BoardConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastRun, setLastRun] = useState<BoardActions["lastRun"]>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Monotonic ticket per conflicts check — see `runValidate`. */
  const validateSeq = useRef(0);

  // Optimistic-concurrency tokens (v3/11 gap 10): the seq each division was
  // rendered at, bumped locally per landed write (every schedule write appends
  // exactly one division event). A wrong count self-heals: the server 409s,
  // we refetch. Resynced from props after every server refresh.
  const propsSeq = useMemo(
    () => Object.fromEntries(divisions.map((d) => [d.id, d.seq])),
    [divisions],
  );
  const seqRef = useRef<Record<string, number>>({ ...propsSeq });
  useEffect(() => {
    seqRef.current = { ...propsSeq };
  }, [propsSeq]);

  // Server props are the source of truth; optimistic overrides melt away on
  // each refresh (last-write-wins per fixture, doc 12 §6). Render-time state
  // adjustment (the React "derive from props" pattern) — no effect cascade.
  const [seenFixtures, setSeenFixtures] = useState(fixtures);
  if (seenFixtures !== fixtures) {
    setSeenFixtures(fixtures);
    setOverrides({});
  }

  const board: BoardFixture[] = useMemo(
    () =>
      fixtures.map((f) => {
        const o = overrides[f.id];
        return o ? { ...f, ...o } : f;
      }),
    [fixtures, overrides],
  );

  const conflictsByFixture = useMemo(() => {
    const map: Record<string, BoardConflict[]> = {};
    for (const c of conflicts) (map[c.fixture_id] ??= []).push(c);
    return map;
  }, [conflicts]);

  const runValidate = useCallback(async () => {
    // LAST STARTED WINS, not last resolved.
    //
    // Two validates overlap routinely: the 400ms debounce fires while the
    // organiser is pressing "check again", or a refresh queues one on top of a
    // manual retry — and they settle in whatever order the network returns
    // them. Without this counter a FAILING check that started first and
    // answered last flips the notice back on over a SUCCEEDING one, telling an
    // organiser the list is stale when it had just been refreshed. The calls
    // are idempotent, so the only thing that needs ordering is which answer is
    // allowed to land.
    const seq = ++validateSeq.current;
    // Any queued debounce is now redundant — this call supersedes it. (A
    // clearTimeout on the timer that just fired is a no-op, so this is safe on
    // the debounced path too.)
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setChecking(true);
    try {
      const results = await Promise.all(
        divisions.map((d) =>
          apiV1<{ conflicts: BoardConflict[] }>(`/api/v1/divisions/${d.id}/schedule/validate`, {
            method: "POST",
          }),
        ),
      );
      if (seq !== validateSeq.current) return;
      setConflicts(results.flatMap((r) => r.conflicts));
      setCheckFailed(false);
    } catch {
      // Validation stays ADVISORY — the board must never break because the
      // check did. But #230 item 5: swallowing it silently left an organiser
      // reading an empty conflicts list that was not an answer. Keep the last
      // known conflicts (they are still the best information available) and
      // record that they are no longer current, so the toolbar can say so.
      if (seq !== validateSeq.current) return;
      setCheckFailed(true);
    } finally {
      if (seq === validateSeq.current) setChecking(false);
    }
  }, [divisions]);

  const queueValidate = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runValidate(), 400);
  }, [runValidate]);

  // Full report on load and after every server refresh (doc 12 §4).
  useEffect(() => {
    queueValidate();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [queueValidate, fixtures]);

  const fail = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? ""));
      } else if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
        // Another organiser edited the board since this client loaded it
        // (v3/11 gap 10): resync and say so — no scary error styling.
        setNotice(msg("board.stale"));
        router.refresh();
        return true;
      } else if (err instanceof ApiV1Error && err.code === "RATE_LIMITED") {
        // The per-org solver cooldown (AUTO_SCHEDULE_COOLDOWN, usecases/
        // schedule.ts). A NOTICE, not an error, and the register is deliberate:
        // this is the same class of outcome as `solver_busy` — ordinary,
        // transient, entirely outside the organiser's hands, and the same click
        // a few minutes later works. Red styling would suggest their board is
        // wrong, and nothing about it is.
        //
        // Keyed on the CODE, not on the message: /api/v1 maps every 429 to
        // RATE_LIMITED (server/api-v1/http.ts), and the limiter's own message is
        // hardcoded English. The board is the only surface that calls a limited
        // endpoint, so the code is unambiguous here.
        setNotice(msg("board.action.cooldown"));
      } else if (err instanceof ApiV1Error && err.code === "SCHEDULE_CONFLICT") {
        const list = (err.extra.conflicts as BoardConflict[] | undefined) ?? [];
        const titleOf = (id: string) => {
          const f = board.find((x) => x.id === id);
          return f ? cardTitle(f, entrantNames, feedLabels) : msg("board.action.anotherMatch");
        };
        const helpOf = (code: string) => {
          const k = `board.conflictHelp.${code}` as MessageKey;
          const l = msg(k);
          return l === k ? (CONFLICT_HELP[code] ?? msg("board.action.slotFail")) : l;
        };
        const reasons = [
          ...new Set(
            list.map((c) => {
              let m = helpOf(c.code);
              const uuid = c.detail?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
              if (uuid) m += msg("board.action.withMatch", { title: titleOf(uuid) });
              return m;
            }),
          ),
        ];
        setError(
          reasons.length > 0
            ? msg("board.action.cantSchedule", { reasons: reasons.join(" ") })
            : msg("board.action.cantScheduleClash"),
        );
      } else {
        // Never surface raw codes/stack text; fall back to a friendly line.
        const raw = err instanceof Error ? err.message : "";
        const friendly = raw && !/[{}<>]|error:|\bundefined\b|[0-9a-f]{8}-[0-9a-f]{4}/i.test(raw);
        setError(friendly ? raw : msg("boardset.error"));
      }
      return false;
    },
    [board, entrantNames, feedLabels, router],
  );

  const moveCard = useCallback(
    async (fixtureId: string, atIso: string | null, court: string | null): Promise<boolean> => {
      if (!canEdit) return false;
      setError(null);
      const prev = board.find((f) => f.id === fixtureId);
      if (!prev || prev.status !== "scheduled") return false;
      // After the two guards, so a refused drag does not throw the report away.
      setLastRun(null);
      setOverrides((o) => ({
        ...o,
        [fixtureId]: {
          scheduled_at: atIso,
          court_label: court,
          schedule_locked: prev.schedule_locked,
        },
      }));
      try {
        await apiV1(`/api/v1/fixtures/${fixtureId}`, {
          method: "PATCH",
          json: {
            scheduled_at: atIso,
            court_label: court,
            expected_seq: seqRef.current[prev.division_id],
          },
        });
        seqRef.current[prev.division_id] = (seqRef.current[prev.division_id] ?? 0) + 1;
        queueValidate();
        router.refresh();
        return true;
      } catch (err) {
        setOverrides((o) => {
          const rest = { ...o };
          delete rest[fixtureId];
          return rest;
        });
        fail(err);
        return false;
      }
    },
    [board, canEdit, fail, queueValidate, router],
  );

  const togglePin = useCallback(
    async (f: BoardFixture) => {
      if (!canEdit) return;
      setError(null);
      setLastRun(null);
      try {
        await apiV1(`/api/v1/fixtures/${f.id}`, {
          method: "PATCH",
          json: { schedule_locked: !f.schedule_locked, expected_seq: seqRef.current[f.division_id] },
        });
        seqRef.current[f.division_id] = (seqRef.current[f.division_id] ?? 0) + 1;
        router.refresh();
      } catch (err) {
        fail(err);
      }
    },
    [canEdit, fail, router],
  );

  const autoRun = useCallback(
    async (stageId: string, onlyUnlocked: boolean, mode?: AutoScheduleMode) => {
      setError(null);
      setNotice(null);
      setLastRun(null);
      setBusy(true);
      try {
        const out = await apiV1<{
          assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
          conflicts: BoardConflict[];
          // OPTIONAL on purpose, even though Task 9 now populates both: a cached
          // response, or a server one deploy behind, carries neither. Typing
          // them as required here would render a strip full of zeros instead of
          // no strip at all, which is the worse of the two failures.
          metrics?: ScheduleMetrics;
          solver?: ScheduleSolverInfo;
        }>(`/api/v1/stages/${stageId}/schedule/auto`, {
          method: "POST",
          // Spread, not `mode: mode` — an explicit `undefined` serialises as a
          // present key on some paths and the request schema's preprocess keys
          // on `body.mode !== undefined`, so it would defeat the derivation the
          // two original callers depend on.
          json: { only_unlocked: onlyUnlocked, ...(mode !== undefined ? { mode } : {}) },
        });
        // Before the empty-proposal return, not after: an `infeasible` run can
        // place nothing at all, and that is exactly the run whose report the
        // organiser most needs.
        if (out.metrics && out.solver) setLastRun({ metrics: out.metrics, solver: out.solver });
        if (out.assignments.length === 0) {
          setNotice(msg("board.action.nothingStage"));
          return;
        }
        const applied = await apiV1<{ applied: number; conflicts: BoardConflict[] }>(
          `/api/v1/stages/${stageId}/schedule/apply`,
          {
            method: "POST",
            json: {
              assignments: out.assignments.map((a) => ({
                fixture_id: a.fixture_id,
                scheduled_at: a.scheduled_at,
                court_label: a.court_label,
              })),
              source: "auto",
            },
          },
        );
        setConflicts(applied.conflicts);
        setNotice(
          applied.conflicts.length > 0
            ? msg("board.action.placedWarn", { n: applied.applied, w: applied.conflicts.length })
            : msg("board.action.placed", { n: applied.applied }),
        );
        router.refresh();
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [fail, router],
  );

  const act = useCallback(
    async (path: string, done: string, acknowledgeWarnings = false): Promise<GateRefusal | null> => {
      setError(null);
      setNotice(null);
      setLastRun(null);
      setBusy(true);
      try {
        // No body unless the organiser is acknowledging: publish and start both
        // parse an ABSENT body as `{}`, and every existing API-key client POSTs
        // them with none. Sending `{}` unconditionally would work but would make
        // "the console always sends a body" a fact the server then has to keep
        // true; sending nothing keeps the two paths identical to today's.
        await apiV1(path, {
          method: "POST",
          json: acknowledgeWarnings ? { acknowledge_warnings: true } : undefined,
        });
        setNotice(done);
        router.refresh();
        return null;
      } catch (err) {
        // The gate's two refusals are NOT errors to render as a red toast —
        // they are a question with an answer, or a report. `fail` would flatten
        // both into a sentence and throw the conflict list away, which is
        // exactly the dead end this follow-up exists to remove.
        if (
          err instanceof ApiV1Error &&
          (err.code === PUBLISH_BLOCKED || err.code === PUBLISH_UNACKNOWLEDGED)
        ) {
          return {
            kind: err.code === PUBLISH_BLOCKED ? "blocking" : "warnings",
            conflicts: (err.extra.conflicts as BoardConflict[] | undefined) ?? [],
          };
        }
        fail(err);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [fail, router],
  );

  // Bulk tools (doc 12 §2): shift a day ±N minutes / swap two courts. These
  // run as sequential single moves; the seq token rides along and self-heals.
  const shiftDay = useCallback(
    async (day: string, minutes: number) => {
      setBusy(true);
      setError(null);
      setLastRun(null);
      try {
        for (const f of board) {
          if (f.scheduled_at === null || f.status !== "scheduled") continue;
          if (dayKey(f.scheduled_at as string) !== day) continue;
          await apiV1(`/api/v1/fixtures/${f.id}`, {
            method: "PATCH",
            json: {
              scheduled_at: new Date(
                new Date(f.scheduled_at as string).getTime() + minutes * 60_000,
              ).toISOString(),
              expected_seq: seqRef.current[f.division_id],
            },
          });
          seqRef.current[f.division_id] = (seqRef.current[f.division_id] ?? 0) + 1;
        }
        router.refresh();
        queueValidate();
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [board, fail, queueValidate, router],
  );

  const swapCourts = useCallback(
    async (day: string, a: string, b: string) => {
      setBusy(true);
      setError(null);
      setLastRun(null);
      try {
        for (const f of board) {
          if (f.scheduled_at === null || f.status !== "scheduled") continue;
          if (dayKey(f.scheduled_at as string) !== day) continue;
          const target = f.court_label === a ? b : f.court_label === b ? a : null;
          if (!target) continue;
          await apiV1(`/api/v1/fixtures/${f.id}`, {
            method: "PATCH",
            json: { court_label: target, expected_seq: seqRef.current[f.division_id] },
          });
          seqRef.current[f.division_id] = (seqRef.current[f.division_id] ?? 0) + 1;
        }
        router.refresh();
        queueValidate();
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [board, fail, queueValidate, router],
  );

  // Realtime board refresh on division:{id} (doc 12 §6 — two organisers).
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels: any[] = [];
    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        const sb = supabaseBrowser();
        for (const d of divisions) {
          if (cancelled) return;
          channels.push(
            sb
              .channel(`division:${d.id}`)
              .on("broadcast", { event: "schedule_changed" }, () => router.refresh())
              .subscribe(),
          );
        }
      } catch {
        /* realtime is best-effort; the board still works without it */
      }
    })();
    return () => {
      cancelled = true;
      for (const ch of channels) ch?.unsubscribe();
    };
  }, [divisions, router]);

  return {
    board,
    conflicts,
    conflictsByFixture,
    error,
    notice,
    paywall,
    busy,
    checkFailed,
    checking,
    lastRun,
    revalidate: runValidate,
    setError,
    setNotice,
    moveCard,
    togglePin,
    autoRun,
    act,
    shiftDay,
    swapCourts,
    queueValidate,
  };
}
