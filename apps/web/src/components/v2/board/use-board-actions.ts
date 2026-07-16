"use client";

// Board action layer (v3/04 §2): every schedule write, optimistic overrides,
// debounced re-validation, realtime refresh, and the optimistic-concurrency
// resync (v3/11 gap 10). Views stay dumb — they call these.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { dayKey } from "@/lib/schedule-board";
import type { FeedLabelPair } from "@/lib/schedule-board";
import {
  CONFLICT_HELP,
  cardTitle,
  type BoardConflict,
  type BoardDivision,
  type BoardFixture,
} from "./types";

type Override = { scheduled_at: string | null; court_label: string | null; schedule_locked: boolean };

export interface BoardActions {
  board: BoardFixture[];
  conflicts: BoardConflict[];
  conflictsByFixture: Record<string, BoardConflict[]>;
  error: string | null;
  notice: string | null;
  paywall: string | null;
  busy: boolean;
  setError: (e: string | null) => void;
  setNotice: (n: string | null) => void;
  moveCard: (fixtureId: string, atIso: string | null, court: string | null) => Promise<boolean>;
  togglePin: (f: BoardFixture) => Promise<void>;
  autoRun: (stageId: string, onlyUnlocked: boolean) => Promise<void>;
  act: (path: string, done: string) => Promise<void>;
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    try {
      const results = await Promise.all(
        divisions.map((d) =>
          apiV1<{ conflicts: BoardConflict[] }>(`/api/v1/divisions/${d.id}/schedule/validate`, {
            method: "POST",
          }),
        ),
      );
      setConflicts(results.flatMap((r) => r.conflicts));
    } catch {
      /* validation is advisory — never break the board */
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
    async (stageId: string, onlyUnlocked: boolean) => {
      setError(null);
      setNotice(null);
      setBusy(true);
      try {
        const out = await apiV1<{
          assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
          conflicts: BoardConflict[];
        }>(`/api/v1/stages/${stageId}/schedule/auto`, {
          method: "POST",
          json: { only_unlocked: onlyUnlocked },
        });
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
    async (path: string, done: string) => {
      setError(null);
      setNotice(null);
      setBusy(true);
      try {
        await apiV1(path, { method: "POST" });
        setNotice(done);
        router.refresh();
      } catch (err) {
        fail(err);
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
