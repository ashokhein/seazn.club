"use client";

// Schedule board v3 (v3/04 §2, PROMPT-33): courts × time grid with day tabs,
// division hue bars + short-code chips, legend-as-filter with URL state,
// Board / Agenda / By-division density modes (per-user persist, Agenda is the
// mobile default), a conflicts side panel, a docked unscheduled tray with one
// pick-then-place mechanism for mouse, touch AND keyboard, and optimistic-
// concurrency on every write (v3/11 gap 10). Week view (cross-day drag) and
// the pin/undo affordances predate v3 and stay.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { UpgradeGate } from "@/components/upgrade-gate";
import { Tip } from "@/components/ui/tip";
import { apiV1 } from "@/lib/client-v1";
import { track, EVENTS } from "@/lib/analytics";
import { useMsg, useLocale } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { dayKey, daySlots, type FeedLabelPair } from "@/lib/schedule-board";
import type { Currency } from "@/lib/currency";
import { dayLabel, dayWeekday, dayDateShort, timeLabel } from "@/lib/day-label";
import { BoardAgenda } from "./board/board-agenda";
import { BoardGrid } from "./board/board-grid";
import { BoardLanes } from "./board/board-lanes";
import { BoardLegend } from "./board/board-legend";
import { BoardTray } from "./board/board-tray";
import { AiConsole, useAiSchedulingEnabled, type AiBriefContext } from "./board/ai-console";
import { AiCompetitionConsole, type JointDivision } from "./board/ai-competition-console";
import { AiRepairBanner } from "./board/ai-repair-banner";
import { useDisruptionSignals } from "./board/use-disruption-signals";
import type { AiScope } from "./board/ai-console-state";
import { computeAiDiff, ghostToneFor, type AiConsoleFixture } from "./board/ai-diff";
import { ConflictsBadge, ConflictsPanel } from "./board/conflicts-panel";
import { MovePanel } from "./board/move-panel";
import { SettingsPanel } from "./board/settings-panel";
import {
  cardTitle,
  DENSITY_STORAGE_KEY,
  type BoardConfig,
  type BoardDivision,
  type BoardFixture,
  type BoardStage,
  type Density,
  type GhostBlock,
} from "./board/types";
import { useBoardActions } from "./board/use-board-actions";

export type { BoardConfig, BoardConflict, BoardDivision, BoardFixture, BoardStage } from "./board/types";

const MIN = 60_000;

/** Localized fixture status; unknown values fall back to the raw token. */
function fstatusLabel(msg: (k: MessageKey) => string, s: string): string {
  const key = `schedule.fstatus.${s}` as MessageKey;
  const label = msg(key);
  return label === key ? s.replace("_", " ") : label;
}

/**
 * The two AI-pricing inputs the board derives, isolated from the component so
 * they can be tested — `tsc` catches a MISSING prop on the console, never a
 * wrong VALUE, and these two numbers are what the confirm card turns into a
 * credit charge.
 *
 * Both must be read from `actions.board`, not from the `fixtures` prop:
 * `actions.board` carries the optimistic overrides a drag applies before the
 * RSC refresh lands, and the repair scope is derived from it too. Reading
 * different sources was harmless when this was a plain count; it stopped being
 * harmless once a scoped repair started narrowing on court and time, because a
 * fixture dragged into the scoped court would be quoted against a stale label —
 * and that under-quotes.
 */
export function aiPricingInputs(
  divisionFixtures: BoardFixture[],
  divisionId: string | null,
  activeEntrantCounts: Record<string, number>,
): Pick<AiBriefContext, "movableFixtures" | "activeEntrants"> {
  return {
    // The fixtures themselves, not a count: a scoped repair is quoted on the
    // fixtures actually in scope (`movableForRun`), and a count cannot be
    // narrowed after the fact.
    movableFixtures: divisionFixtures
      .filter((f) => f.status === "scheduled")
      .map((f) => ({
        id: f.id,
        scheduled_at: f.scheduled_at ? new Date(f.scheduled_at).toISOString() : null,
        court_label: f.court_label,
      })),
    // SELECTS the count as well as returning it — deliberately. An earlier
    // version took the number as a parameter, which put the boundary BELOW the
    // expression that was wrong: restoring the original
    // `Object.keys(entrantNames).length` bug left the test green, because the
    // test was handed the answer. Choosing the count here is what makes it
    // observable. No division (or no entry) prices at 0 rather than guessing.
    activeEntrants: divisionId === null ? 0 : (activeEntrantCounts[divisionId] ?? 0),
  };
}

/**
 * The whole brief the AI console prices a SINGLE-division run from, derived from
 * the board's own props.
 *
 * Split out of the component — and taking `divisions` + the live fixture list
 * rather than a division id + a pre-filtered list — because the id was the part
 * that could be wrong. Every `aiPricingInputs` test hands the function an id, so
 * they prove it reads its argument and nothing about the board CHOOSING one:
 * replacing the call site's `single?.id ?? null` with a bare `null` priced every
 * run at 0 active entrants with the suite fully green. Deriving the division
 * here means the id and the fixtures it filters can no longer describe different
 * divisions, and "no division" is a case the tests assert on its own terms.
 */
export function buildAiBrief(input: {
  cfg: BoardConfig;
  /** The board's divisions. One → that division's brief; anything else has no
   *  single division to price and the joint console prices per division. */
  divisions: BoardDivision[];
  /** The LIVE board (`actions.board`), carrying the optimistic overrides a drag
   *  applies before the RSC refresh lands. Never the server-shaped prop. */
  boardFixtures: BoardFixture[];
  activeEntrantCounts: Record<string, number>;
  entrantNames: Record<string, string>;
  officialsWithBlackout: number;
}): AiBriefContext {
  const { cfg, divisions, boardFixtures, activeEntrantCounts } = input;
  const single = divisions.length === 1 ? (divisions[0] as BoardDivision) : null;
  const divFixtures = single
    ? boardFixtures.filter((f) => f.division_id === single.id)
    : boardFixtures;
  return {
    courts: cfg.courts,
    windows: cfg.sessionWindows.length,
    blackouts: cfg.blackouts.length,
    constraintsSet:
      cfg.perEntrantMinRest > 0 ||
      (cfg.roundMinutes ?? 0) > 0 ||
      Boolean((cfg as { constraints?: unknown }).constraints),
    ...aiPricingInputs(divFixtures, single?.id ?? null, activeEntrantCounts),
    pinned: divFixtures.filter((f) => f.schedule_locked).length,
    entrants: Object.entries(input.entrantNames)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    officialsWithBlackout: input.officialsWithBlackout,
  };
}

/**
 * The joint console's per-division inputs, derived from the board's own props.
 *
 * Two of these fields are money — each division's movable-fixture count and its
 * active-entrant count are what the receipt prices, one line each, summed into
 * one charge — so they go through the SAME `aiPricingInputs` the division
 * console's brief does, filtered per division inside the loop. Reading the whole
 * board for either would multiply the quote by the number of divisions.
 *
 * The other three are things the joint surface cannot infer and the division
 * surface never needs: courts (matched across divisions BY NAME), the division's
 * configured timezone, and `crossPersonClash` — the rule that decides whether
 * the joint apply refuses a person clash the plan only warned about.
 */
export function jointDivisionsFor(
  divisions: BoardDivision[],
  boardFixtures: BoardFixture[],
  activeEntrantCounts: Record<string, number>,
  divisionSettings: Record<
    string,
    { courts: string[]; tz: string; crossPersonClash?: "warn" | "hard" }
  >,
): JointDivision[] {
  return divisions.map((d) => {
    const s = divisionSettings[d.id];
    const priced = aiPricingInputs(
      boardFixtures.filter((f) => f.division_id === d.id),
      d.id,
      activeEntrantCounts,
    );
    return {
      id: d.id,
      name: d.name,
      seq: d.seq,
      // Absent lock state reads as unfrozen — the server is the authority.
      scheduleLocked: d.schedule_locked ?? false,
      // A missing settings row means no courts, NOT another division's: a
      // borrowed list would price capacity this division does not have and make
      // the by-name divergence check agree where it should warn.
      courts: s?.courts ?? [],
      tz: s?.tz ?? "UTC",
      personClashBlocks: s?.crossPersonClash === "hard",
      movableFixtures: priced.movableFixtures.length,
      activeEntrants: priced.activeEntrants,
    };
  });
}

/** Which AI console a board offers, if any. `null` hides the launch button. */
export type AiEntryPoint = "division" | "competition" | null;

/**
 * The gate the launch button reads.
 *
 * It used to be `single !== null`, which is what kept multi-division boards
 * without an AI console at all (#350). A multi-division board now opens the
 * JOINT console — but only when it knows which competition it belongs to, which
 * only the competition schedule page passes, and that page is itself behind
 * `scheduling.multi_division` (it renders an UpgradeGate in place of the board
 * without it). The entitlement gate is therefore structural here and re-checked
 * server-side on all three joint endpoints; this is the second lock, not the
 * only one.
 */
export function aiEntryPoint(input: {
  /** Role + not frozen (`canManage ?? canEdit`), not the paid entitlement — a
   *  free org still reaches the in-dock paywall. */
  canManage: boolean;
  /** The PostHog "ai-scheduling" kill switch, fail-open. */
  aiFlagOn: boolean;
  divisions: BoardDivision[];
  competitionId: string | null;
}): AiEntryPoint {
  if (!input.canManage || !input.aiFlagOn) return null;
  if (input.divisions.length === 1) return "division";
  if (input.divisions.length > 1 && input.competitionId !== null) return "competition";
  return null;
}

/**
 * The board's fixtures in the shape the AI console and the ghost overlay read
 * (short code, matchup line, the JR/Final marker).
 *
 * "Final" is a heuristic — the sole fixture in the last round — and it has to be
 * computed PER DIVISION. Taken across a competition board it marks only the
 * longest division's last round, so every shorter division's final silently
 * loses its marker; and a competition where two divisions happen to share a max
 * round would mark neither, because the round then holds two matches.
 */
export function consoleFixtures(
  boardFixtures: BoardFixture[],
  entrantNames: Record<string, string>,
  feedLabels: Record<string, FeedLabelPair>,
): AiConsoleFixture[] {
  const maxRoundOf = new Map<string, number>();
  for (const f of boardFixtures) {
    maxRoundOf.set(f.division_id, Math.max(maxRoundOf.get(f.division_id) ?? 0, f.round_no));
  }
  const atMaxRound = new Map<string, number>();
  for (const f of boardFixtures) {
    if (f.round_no === maxRoundOf.get(f.division_id)) {
      atMaxRound.set(f.division_id, (atMaxRound.get(f.division_id) ?? 0) + 1);
    }
  }
  return boardFixtures.map((f) => {
    const maxRound = maxRoundOf.get(f.division_id) ?? 0;
    return {
      id: f.id,
      stage_id: f.stage_id,
      // Carried for the JOINT review card, whose chip is the only thing naming
      // a row's division — including for fixtures the plan could not place,
      // which are absent from the proposal it used to be read from.
      division_id: f.division_id,
      scheduled_at: f.scheduled_at ? new Date(f.scheduled_at).toISOString() : null,
      court_label: f.court_label,
      code: `R${f.round_no}·${f.seq_in_round}`,
      matchup: cardTitle(f, entrantNames, feedLabels),
      isFinal: maxRound > 0 && f.round_no === maxRound && atMaxRound.get(f.division_id) === 1,
      isJunior: false,
      // Carried for the PHASE B quote: the officials pack holds the fixtures
      // that have a time and are not decided, priced on their distinct entrant
      // and court counts (officialsQuoteInput mirrors it).
      status: f.status,
      home_entrant_id: f.home_entrant_id,
      away_entrant_id: f.away_entrant_id,
    };
  });
}

/** What the ghost overlay reads out of a proposal — the two fields BOTH the
 *  per-division and the JOINT plan responses carry, so one derivation serves
 *  both. `division_id` is present only on a joint one. */
export interface GhostSource {
  proposal: {
    fixture_id: string;
    scheduled_at: string;
    court_label: string | null;
    division_id?: string;
  }[];
  blocking: { fixtureId: string }[];
}

/**
 * The proposal painted over the grid.
 *
 * Exported and pure because of the one thing it has to get right on a
 * competition board and cannot on a division board: attributing each proposed
 * placement to the division that owns it. The real cards carry that chip; a
 * proposal that dropped it would repaint a multi-division board as a wall of
 * anonymous blocks, and "did one age group get all the good slots?" is the
 * question a joint run exists to answer.
 */
export function ghostBlocks(
  plan: GhostSource,
  fixtures: AiConsoleFixture[],
  divisionNames: Record<string, string>,
  pulseIds: string[],
): GhostBlock[] {
  const meta = new Map(fixtures.map((f) => [f.id, f]));
  const diff = computeAiDiff(plan, fixtures);
  const blocking = new Set(plan.blocking.map((b) => b.fixtureId));
  const pulsing = new Set(pulseIds);
  return plan.proposal.map((p) => {
    const m = meta.get(p.fixture_id);
    return {
      id: p.fixture_id,
      code: m?.code ?? p.fixture_id.slice(0, 6),
      matchup: m?.matchup ?? "—",
      isFinal: m?.isFinal ?? false,
      isJunior: m?.isJunior ?? false,
      at: new Date(p.scheduled_at).getTime(),
      court: p.court_label ?? null,
      tone: ghostToneFor(p.fixture_id, diff, blocking),
      pulse: pulsing.has(p.fixture_id),
      // A single-division proposal sends no division_id, and labelling every
      // block with the one division would be noise rather than information.
      division: p.division_id
        ? { id: p.division_id, name: divisionNames[p.division_id] ?? p.division_id }
        : null,
    };
  });
}

interface Props {
  divisions: BoardDivision[];
  stages: BoardStage[];
  fixtures: BoardFixture[];
  entrantNames: Record<string, string>;
  /** Per division, the entrants an AI run is PRICED on — `status not in
   *  ('withdrawn','disqualified')`, mirroring schedule-ai.ts:505. Distinct from
   *  `entrantNames`, which is a competition-wide id→name map for card titles
   *  and must keep naming withdrawn entrants' existing fixtures. */
  activeEntrantCounts: Record<string, number>;
  feedLabels: Record<string, FeedLabelPair>;
  settings: { division_id: string; config: BoardConfig; tz: string };
  canEdit: boolean;
  constraintsAllowed: boolean;
  /** Organiser can manage this division (role + not frozen), independent of the
   *  paid board-edit entitlement. Drives the AI console entry point so a free
   *  org still reaches the in-dock paywall (canEdit folds in scheduling.board,
   *  which a Community org lacks). Defaults to canEdit. */
  canManage?: boolean;
  /** Client-side entitlement read for the AI console (scheduling.ai). When
   *  false the docked console renders the paywall instead of the wizard. */
  aiAllowed?: boolean;
  /** The org's locked billing currency — prices the AI console's out-of-credits
   *  recovery block (A6) Buy-credits ladder. Defaults to USD for callers that
   *  don't host the AI console. */
  currency?: Currency;
  /** Competition run dates — drive the week view's day span. */
  competitionStart?: string | null;
  competitionEnd?: string | null;
  /** Sport-appropriate playing-area word, capitalised (e.g. "Pitch"). */
  venueCap?: string;
  /** Render the inline settings card. The division schedule page turns this
   *  off and hosts the settings on its constraints tab instead. */
  showSettings?: boolean;
  /** Officials with at least one blackout date (page-loaded official
   *  availability), for the AI console pre-flight's "N officials, M with
   *  blackout dates" row. Optional so non-schedule-page callers can omit it. */
  officialsWithBlackout?: number;
  /**
   * The competition this board belongs to, and every division's own schedule
   * settings — ONE prop, deliberately, because the two are useless apart and
   * dangerous apart.
   *
   * The id is what turns a multi-division board's AI entry point on (#350);
   * only the competition schedule page passes it, and that page is behind
   * `scheduling.multi_division`. The settings are the joint console's quote
   * inputs (each division's OWN courts), the by-name court-divergence check,
   * the timezone spread (ruling R8), and the `crossPersonClash` rule that
   * decides whether the joint apply REFUSES a person clash it only warned
   * about.
   *
   * As two optional props, dropping the settings one typechecked and stayed
   * green while every division silently fell back to `courts: []` (a PRICING
   * input — fewer courts lowers the size score, so it under-quotes), `tz:
   * "UTC"`, and `personClashBlocks: false`, and the court-divergence banner
   * went quiet. Four safety surfaces failing open on one deleted line, the
   * money one toward under-quoting. Bundled, the id cannot arrive without them.
   */
  competition?: {
    id: string;
    divisionSettings: Record<
      string,
      { courts: string[]; tz: string; crossPersonClash?: "warn" | "hard" }
    >;
  };
}

/** Advance a YYYY-MM-DD key by n days (noon anchor dodges DST/midnight edges). */
function addDaysKey(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ScheduleBoard({
  divisions,
  stages,
  // `fixtures` is DELIBERATELY NOT DESTRUCTURED — see `props.fixtures` at the
  // `useBoardActions` call, its only use. Everything downstream must read
  // `actions.board`, which layers the optimistic overrides a drag applies
  // before the RSC refresh lands, and that distinction now decides a credit
  // charge (the confirm card prices a scoped repair by narrowing on court and
  // time). Leaving the server-shaped list without a bare name means no
  // consumer can reach for the wrong one by habit.
  entrantNames,
  activeEntrantCounts,
  feedLabels,
  settings,
  canEdit,
  constraintsAllowed,
  canManage,
  aiAllowed = false,
  currency = "usd",
  competitionStart,
  competitionEnd,
  venueCap = "Court",
  showSettings = true,
  officialsWithBlackout = 0,
  competition,
  ...props
}: Props) {
  const msg = useMsg();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const single = divisions.length === 1 ? divisions[0] : null;
  const cfg = settings.config;
  const multi = divisions.length > 1;

  // AI schedule console. A one-division board opens the per-division wizard
  // (v4); a multi-division board on the COMPETITION page opens the joint console
  // (#350), which plans them together. The PostHog "ai-scheduling" kill switch
  // hides both entry points when flipped off; it is fail-open (see the hook).
  const aiFlagOn = useAiSchedulingEnabled();
  const [aiOpen, setAiOpen] = useState(false);
  // Set by the repair nudge (Task 16) just before it opens the console, so the
  // console mounts pre-armed in repair mode + this scope; null on a plain open.
  const [aiRepairScope, setAiRepairScope] = useState<AiScope | null>(null);
  // The verified proposal the console is showing (null = none) — drives the grid
  // ghost overlay. The console notifies us on each RUN_DONE and on close.
  const [aiProposal, setAiProposal] = useState<GhostSource | null>(null);
  // Fixtures the referee just flagged — pulse red on the grid for ~1.5s (§0.3).
  const [pulseIds, setPulseIds] = useState<string[]>([]);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulse = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setPulseIds(ids);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulseIds([]), 1500);
  }, []);
  // Entry point is role-gated (not entitlement-gated) so a free org reaches the
  // in-dock paywall; the plan check happens inside the console via aiAllowed.
  const aiEntry = aiEntryPoint({
    canManage: canManage ?? canEdit,
    aiFlagOn,
    divisions,
    competitionId: competition?.id ?? null,
  });
  const aiAvailable = aiEntry !== null;

  // ------------------------------------------------- division filter (?d=)
  const selectedSlugs = useMemo(() => {
    const raw = searchParams.get("d");
    if (!raw) return new Set<string>();
    const known = new Set(divisions.map((d) => d.slug));
    return new Set(raw.split(",").filter((s) => known.has(s)));
  }, [searchParams, divisions]);

  // The filter's synchronous source of truth. Two quick taps race BOTH the
  // useSearchParams snapshot and window.location (the router commits the URL
  // after its transition), so the second tap would otherwise derive from the
  // pre-first-tap state and drop a selection. The ref mutates immediately;
  // the URL follows. Re-syncing from the URL must ignore stale echoes: a
  // re-render carrying the PRE-tap search params would otherwise wipe the
  // tap that's still in flight — so while a push is pending, only the echo
  // that matches it re-opens URL→ref syncing (for back/forward nav).
  const filterRef = useRef(new Set(selectedSlugs));
  const pendingPush = useRef<string | null>(null);
  useEffect(() => {
    const fromUrl = [...selectedSlugs].sort().join(",");
    if (pendingPush.current !== null) {
      if (fromUrl !== pendingPush.current) return; // stale echo — ignore
      pendingPush.current = null; // our push landed; resume normal syncing
      return;
    }
    filterRef.current = new Set(selectedSlugs);
  }, [selectedSlugs]);

  const toggleFilter = useCallback(
    (slug: string | null) => {
      const cur = filterRef.current;
      if (slug === null) cur.clear();
      else if (cur.has(slug)) cur.delete(slug);
      else cur.add(slug);
      pendingPush.current = [...cur].sort().join(",");
      const qs = new URLSearchParams(window.location.search);
      if (cur.size === 0) qs.delete("d");
      else qs.set("d", pendingPush.current);
      router.replace(`${pathname}${qs.size > 0 ? `?${qs}` : ""}`, { scroll: false });
    },
    [pathname, router],
  );

  const visibleDivisions = useMemo(
    () =>
      selectedSlugs.size === 0
        ? divisions
        : divisions.filter((d) => selectedSlugs.has(d.slug)),
    [divisions, selectedSlugs],
  );
  const visibleIds = useMemo(() => new Set(visibleDivisions.map((d) => d.id)), [visibleDivisions]);
  const divisionNames = useMemo(
    () => Object.fromEntries(divisions.map((d) => [d.id, d.name])),
    [divisions],
  );

  // ------------------------------------------------------------- actions
  // The ONLY read of the raw server list, and it is spelled out in full so it
  // reads as a deliberate act rather than a convenient local.
  const actions = useBoardActions(divisions, props.fixtures, entrantNames, feedLabels, canEdit);

  // Whole-division freeze toggle (Jul3/03 §4) — same endpoint the History
  // panel uses, surfaced where organisers actually are when it matters.
  const toggleFreeze = useCallback(async () => {
    if (!single) return;
    try {
      await apiV1(`/api/v1/divisions/${single.id}/locks`, {
        method: "PATCH",
        json: { schedule_locked: !single.schedule_locked },
      });
      actions.setNotice(
        single.schedule_locked ? msg("board.freeze.unfrozen") : msg("board.freeze.frozen"),
      );
      router.refresh();
    } catch (err) {
      actions.setError(err instanceof Error ? err.message : msg("board.freeze.error"));
    }
  }, [single, actions, router]);
  const board = useMemo(
    () => actions.board.filter((f) => visibleIds.has(f.division_id)),
    [actions.board, visibleIds],
  );

  const scheduled = board.filter((f) => f.scheduled_at !== null);
  const unscheduled = board.filter((f) => f.scheduled_at === null && f.status === "scheduled");

  // ------------------------------------------------------- AI proposal ghosts
  // The single division's current fixtures, enriched with the label bits a ghost
  // block and diff row show (§3). Built from the live board so the diff compares
  // against what is actually on screen. "Final" is a light heuristic (the sole
  // fixture in the last round); there is no junior signal in the board data.
  // THE division's live fixtures — one definition, deliberately.
  //
  // The AI console's brief (which prices the run), the repair scope it is
  // pre-armed with, and the ghost overlay must all describe the same board. They
  // used to be derived separately, and once a scoped repair started narrowing on
  // court and time, that divergence became a money bug: `aiBrief` read the
  // `fixtures` PROP while the repair scope read `actions.board`, which carries
  // the optimistic overrides a drag applies before the RSC refresh lands. A
  // fixture dragged into the scoped court was then quoted against a stale label
  // — and that under-quotes. Two consumers cannot disagree about one constant.
  const divBoardFixtures = useMemo(
    () => (single ? actions.board.filter((f) => f.division_id === single.id) : []),
    [single, actions.board],
  );

  // Live brief inputs for the AI console (pre-flight card + chip pickers +
  // the confirm card's price), derived from data the board already holds.
  // Officials come from a fetch-on-open in the console; only their blackout
  // count is threaded (page-loaded, no client route).
  const aiBrief = useMemo<AiBriefContext>(
    () =>
      buildAiBrief({
        cfg,
        divisions,
        boardFixtures: actions.board,
        activeEntrantCounts,
        entrantNames,
        officialsWithBlackout,
      }),
    [cfg, divisions, actions.board, entrantNames, activeEntrantCounts, officialsWithBlackout],
  );

  // The fixtures a proposal is diffed and ghosted against: THE division's on a
  // division board, and the WHOLE board's on a competition board — a joint
  // proposal spans every selected division, so narrowing to one would leave
  // most of its ghosts without a code or a matchup.
  const aiFixtures = useMemo<AiConsoleFixture[]>(
    () => consoleFixtures(single ? divBoardFixtures : actions.board, entrantNames, feedLabels),
    [single, divBoardFixtures, actions.board, entrantNames, feedLabels],
  );

  // The joint console's per-division inputs. Derived here (not in the console)
  // so the money numbers come from the same live board every other consumer
  // reads, and from the same `aiPricingInputs` the division brief uses.
  const jointDivisions = useMemo<JointDivision[]>(
    () =>
      jointDivisionsFor(
        divisions,
        actions.board,
        activeEntrantCounts,
        competition?.divisionSettings ?? {},
      ),
    [divisions, actions.board, activeEntrantCounts, competition?.divisionSettings],
  );

  // ------------------------------------------------------- repair nudge (T16)
  // Client-derived disruptions over the LIVE board + config — a blackout a slot
  // now sits in, a court removed from settings, a match outside the play windows,
  // a postponed match still holding a slot. Zero server calls; the amber banner
  // and the console's repair scope both read this.
  const disruptions = useDisruptionSignals(divBoardFixtures, cfg);
  // The repair nudge is a PER-DIVISION affordance: it opens the division console
  // pre-armed with a repair scope, and the joint console has no repair mode. It
  // is gated on the launch button's own gates (role + flag, via aiAvailable) and
  // the paid read, so the nudge never opens a console that is not usable — and
  // it stays off on a competition board by construction, because
  // `divBoardFixtures` is empty when there is no single division, so
  // `disruptions.fixtureIds` is too. It also hides while the console is open.
  const showRepairBanner =
    aiAvailable && aiAllowed && !aiOpen && disruptions.fixtureIds.length > 0;
  // "Shown" fires once per board load the first time the banner is visible; the
  // ref lives on the board (which persists across console open/close) so toggling
  // the console never re-fires it.
  const repairShownRef = useRef(false);
  useEffect(() => {
    if (showRepairBanner && !repairShownRef.current) {
      repairShownRef.current = true;
      track(EVENTS.AI_REPAIR_NUDGE_SHOWN, {
        division_id: single?.id,
        count: disruptions.fixtureIds.length,
      });
    }
  }, [showRepairBanner, single, disruptions.fixtureIds.length]);
  // The nudge's CTA: arm the scope, then open the console (batched → it mounts
  // already carrying prefillRepair). The click event fires inside the banner.
  const openRepair = useCallback(() => {
    setAiRepairScope(disruptions.scope);
    setAiOpen(true);
  }, [disruptions.scope]);

  // Ghost blocks for the whole proposal, positioned by the PROPOSED slot and
  // toned by diff bucket (blocking wins). Unscheduled (dropped) fixtures are not
  // in the proposal, so they simply leave the grid — they live in the diff list.
  const ghosts = useMemo<GhostBlock[] | null>(
    () => (aiProposal ? ghostBlocks(aiProposal, aiFixtures, divisionNames, pulseIds) : null),
    [aiProposal, aiFixtures, divisionNames, pulseIds],
  );

  // ------------------------------------------------------- density modes
  const [density, setDensity] = useState<Density>("board");
  const [view, setView] = useState<"day" | "week">("day");
  useEffect(() => {
    const saved = window.localStorage.getItem(DENSITY_STORAGE_KEY) as Density | null;
    if (saved === "board" || saved === "agenda" || saved === "lanes") {
      setDensity(saved);
    } else if (window.matchMedia("(max-width: 640px)").matches || divisions.length >= 8) {
      // Agenda is the mobile default and the ≥8-division fallback (v3/04 §2).
      setDensity("agenda");
    }
  }, [divisions.length]);
  const pickDensity = useCallback((d: Density) => {
    setDensity(d);
    window.localStorage.setItem(DENSITY_STORAGE_KEY, d);
  }, []);

  // ------------------------------------------------------------ day tabs
  const days = useMemo(() => {
    const set = new Set(scheduled.map((f) => dayKey(f.scheduled_at as string)));
    // A proposal may place fixtures on days the board has none yet.
    for (const g of ghosts ?? []) set.add(dayKey(new Date(g.at).toISOString()));
    if (set.size === 0 && cfg.startAt) set.add(dayKey(cfg.startAt));
    if (set.size === 0) set.add(dayKey(new Date()));
    return [...set].sort();
  }, [scheduled, ghosts, cfg.startAt]);
  const [day, setDay] = useState<string>(days[0] as string);
  if (!day) setDay(days[0] as string);

  // Week view spans the division's own schedule dates first, then the
  // competition dates, then the scheduled fixtures' range — min four days.
  const weekDays = useMemo(() => {
    const keys = scheduled.map((f) => dayKey(f.scheduled_at as string)).sort();
    const start =
      (cfg.startAt && dayKey(cfg.startAt)) ||
      (competitionStart && dayKey(competitionStart)) ||
      keys[0] ||
      dayKey(new Date());
    const candidatesEnd = [
      cfg.endAt ? dayKey(cfg.endAt) : null,
      competitionEnd ? dayKey(competitionEnd) : null,
      keys[keys.length - 1] ?? null,
    ].filter((k): k is string => k !== null && k >= start).sort();
    let end = candidatesEnd[candidatesEnd.length - 1] ?? start;
    const minEnd = addDaysKey(start, 3);
    if (end < minEnd) end = minEnd;
    const out: string[] = [];
    for (let d = start; d <= end && out.length < 90; d = addDaysKey(d, 1)) out.push(d);
    return out;
  }, [scheduled, competitionStart, competitionEnd, cfg.startAt, cfg.endAt]);

  // Courts: configured list plus anything already used on the board or proposed
  // by a ghost, so a proposal's court always has a column.
  const courts = useMemo(() => {
    const list = [...cfg.courts];
    for (const f of scheduled) {
      if (f.court_label && !list.includes(f.court_label)) list.push(f.court_label);
    }
    for (const g of ghosts ?? []) {
      if (g.court && !list.includes(g.court)) list.push(g.court);
    }
    return list;
  }, [cfg.courts, scheduled, ghosts]);

  // ------------------------------------------- pick-then-place (gap 11)
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const pickedFixture = pickedId !== null ? (board.find((f) => f.id === pickedId) ?? null) : null;
  useEffect(() => {
    if (pickedId && !pickedFixture) setPickedId(null); // filtered away / refreshed
  }, [pickedId, pickedFixture]);

  const pick = useCallback(
    (fixtureId: string) => {
      setPickedId((cur) => {
        const next = cur === fixtureId ? null : fixtureId;
        const f = actions.board.find((x) => x.id === fixtureId);
        if (next && f) {
          setAnnounce(msg("board.announce.picked", { title: cardTitle(f, entrantNames, feedLabels) }));
        } else {
          setAnnounce(msg("board.announce.cancelled"));
        }
        return next;
      });
    },
    [actions.board, entrantNames, feedLabels],
  );

  const place = useCallback(
    async (atIso: string, court: string | null) => {
      if (!pickedFixture) return;
      const title = cardTitle(pickedFixture, entrantNames, feedLabels);
      const ok = await actions.moveCard(pickedFixture.id, atIso, court);
      if (ok) {
        setPickedId(null);
        setAnnounce(
          court
            ? msg("board.announce.scheduledCourt", { title, time: timeLabel(atIso), court })
            : msg("board.announce.scheduledNoCourt", { title, time: timeLabel(atIso) }),
        );
      }
    },
    [actions, entrantNames, feedLabels, pickedFixture],
  );

  // Esc anywhere cancels the pick.
  useEffect(() => {
    if (!pickedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPickedId(null);
        setAnnounce(msg("board.announce.cancelled"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickedId]);

  // ------------------------------------------------- conflicts panel
  const visibleConflicts = useMemo(
    () => actions.conflicts.filter((c) => board.some((f) => f.id === c.fixture_id)),
    [actions.conflicts, board],
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpTo = useCallback(
    (fixtureId: string) => {
      const f = actions.board.find((x) => x.id === fixtureId);
      if (!f) return;
      if (f.scheduled_at !== null) setDay(dayKey(f.scheduled_at as string));
      setPanelOpen(false);
      setHighlightId(fixtureId);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightId(null), 2500);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-fixture-id="${fixtureId}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },
    [actions.board],
  );

  // ------------------------------------------------------------ grid math
  const slotMinutes = cfg.matchMinutes + cfg.gapMinutes;
  const dayFixtures = scheduled.filter((f) => dayKey(f.scheduled_at as string) === day);
  // Ghosts on this day drive the grid layout while a proposal is on screen.
  const dayGhosts = ghosts ? ghosts.filter((g) => dayKey(new Date(g.at).toISOString()) === day) : null;
  const dayStartDefault = new Date(`${day}T08:00`).getTime();
  const dayEndDefault = new Date(`${day}T22:00`).getTime();
  const times = dayGhosts
    ? dayGhosts.map((g) => g.at)
    : dayFixtures.map((f) => new Date(f.scheduled_at as string).getTime());
  const gridFrom = times.length > 0 ? Math.min(...times, dayStartDefault) : dayStartDefault;
  const gridTo =
    times.length > 0
      ? Math.max(...times.map((t) => t + cfg.matchMinutes * MIN), Math.min(dayEndDefault, gridFrom + 8 * 60 * MIN))
      : dayEndDefault;
  const slots = daySlots(gridFrom, gridTo, slotMinutes);

  // ------------------------------------------------------------- render
  return (
    <div className="space-y-4">
      {/* Live region: pick/place + stale-board announcements (WCAG, gap 11). */}
      <p aria-live="polite" role="status" className="sr-only">
        {announce}
      </p>

      {actions.paywall && <UpgradeGate feature={actions.paywall} />}
      {actions.notice && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{actions.notice}</p>
      )}
      {actions.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{actions.error}</p>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit &&
          stages
            .filter((s) => s.status !== "complete" && visibleIds.has(s.division_id))
            .map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1">
                <button
                  type="button"
                  disabled={actions.busy}
                  onClick={() => void actions.autoRun(s.id, false)}
                  className="btn btn-primary px-3 py-1.5 text-xs"
                >
                  {msg("board.autoSchedule", { name: stages.length > 1 ? s.name : "" })}
                </button>
                <button
                  type="button"
                  disabled={actions.busy}
                  onClick={() => void actions.autoRun(s.id, true)}
                  className="btn btn-ghost px-3 py-1.5 text-xs"
                  title={msg("board.reflowTitle")}
                >
                  {msg("board.reflow")}
                </button>
              </span>
            ))}
        {/* Pin semantics live next to the buttons they modify (v3/03 §4). */}
        {canEdit && <Tip id="schedule.locking" />}
        {/* AI schedule architect (v4) — the console dock's entry point. Free
            orgs still see it; the paywall lives inside the dock. */}
        {aiAvailable && (
          <button
            type="button"
            onClick={() => {
              setAiRepairScope(null);
              setAiOpen(true);
            }}
            title={msg("board.ai.buttonTitle")}
            aria-haspopup="dialog"
            aria-expanded={aiOpen}
            className="btn inline-flex items-center gap-1.5 border border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:from-violet-100 hover:to-indigo-100"
          >
            <span aria-hidden>✦</span>
            {msg("board.ai.button")}
            {!aiAllowed && (
              <svg aria-hidden viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 text-violet-500">
                <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
              </svg>
            )}
          </button>
        )}
        <div className="flex-1" />
        {/* Whole-division freeze (Jul3/03 §4), surfaced on the board itself —
            single-division boards only; the competition board freezes per
            division on each division's own page. */}
        {canEdit && single && (
          <button
            type="button"
            disabled={actions.busy}
            onClick={() => void toggleFreeze()}
            title={single.schedule_locked ? msg("board.freezeTitle.unfreeze") : msg("board.freezeTitle.freeze")}
            className={`btn px-3 py-1.5 text-xs ${
              single.schedule_locked
                ? "border border-amber-300 bg-amber-50 text-amber-800"
                : "btn-ghost"
            }`}
          >
            {single.schedule_locked ? msg("board.frozenBtn") : msg("board.freezeBtn")}
          </button>
        )}
        <ConflictsBadge
          count={visibleConflicts.length}
          open={panelOpen}
          onToggle={() => setPanelOpen((o) => !o)}
          checkFailed={actions.checkFailed}
          checking={actions.checking}
          onRetry={() => void actions.revalidate()}
        />
        {canEdit && single && single.status !== "active" && single.status !== "completed" && (
          <>
            <button
              type="button"
              disabled={actions.busy}
              onClick={() =>
                void actions.act(
                  `/api/v1/divisions/${single.id}/publish-schedule`,
                  msg("board.publishNotice"),
                )
              }
              className="btn btn-ghost px-3 py-1.5 text-xs"
            >
              {msg("board.publish")}
            </button>
            <button
              type="button"
              disabled={actions.busy}
              onClick={() =>
                void actions.act(
                  `/api/v1/divisions/${single.id}/start`,
                  msg("board.startNotice"),
                )
              }
              className="btn btn-primary px-3 py-1.5 text-xs"
            >
              {msg("board.start")}
            </button>
          </>
        )}
      </div>

      {/* Legend doubles as the division filter (v3/04 §2) — URL-backed. */}
      <BoardLegend
        divisions={divisions}
        selected={selectedSlugs}
        onToggle={toggleFilter}
        onClear={() => toggleFilter(null)}
      />

      {/* Density modes + day picker + bulk tools */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={msg("board.densityAria")} className="flex rounded-lg border border-purple-100 bg-white p-0.5">
          {(
            [
              { v: "board" as const, label: msg("board.density.board") },
              { v: "agenda" as const, label: msg("board.density.agenda") },
              { v: "lanes" as const, label: msg("board.density.lanes") },
            ]
          ).map(({ v, label }) => (
            <button
              key={v}
              type="button"
              aria-pressed={density === v}
              onClick={() => pickDensity(v)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                density === v ? "bg-purple-100 text-purple-800" : "text-slate-500 hover:text-purple-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {density === "board" && (
          <button
            type="button"
            onClick={() => setView(view === "day" ? "week" : "day")}
            className="btn btn-ghost px-3 py-1 text-xs"
          >
            {view === "day" ? msg("board.weekView") : msg("board.dayView")}
          </button>
        )}

        {(density !== "board" || view === "day") && (
          <>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDay(addDaysKey(day, -1))}
                aria-label={msg("board.prevDay")}
                className="btn btn-ghost px-2 py-1 text-xs"
              >
                ‹
              </button>
              <span className="min-w-32 text-center text-sm font-semibold text-slate-800">
                {dayLabel(day, locale)}
              </span>
              <button
                type="button"
                onClick={() => setDay(addDaysKey(day, 1))}
                aria-label={msg("board.nextDay")}
                className="btn btn-ghost px-2 py-1 text-xs"
              >
                ›
              </button>
            </div>
            <div className="scroll-x scroll-x-fade flex gap-1 whitespace-nowrap">
              {days.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDay(d)}
                  aria-pressed={d === day}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    d === day ? "bg-purple-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {dayLabel(d, locale)}
                </button>
              ))}
            </div>
          </>
        )}

        {canEdit && density === "board" && view === "day" && (
          <span className="ml-auto flex items-center gap-1 text-xs text-slate-500">
            {msg("board.shiftDay")}
            <button type="button" disabled={actions.busy} onClick={() => void actions.shiftDay(day, -15)} className="btn btn-ghost px-2 py-1 text-xs">−15m</button>
            <button type="button" disabled={actions.busy} onClick={() => void actions.shiftDay(day, 15)} className="btn btn-ghost px-2 py-1 text-xs">+15m</button>
            {courts.length >= 2 && (
              <button
                type="button"
                disabled={actions.busy}
                onClick={() => void actions.swapCourts(day, courts[0] as string, courts[1] as string)}
                className="btn btn-ghost px-2 py-1 text-xs"
                title={msg("board.swapTitle", { a: courts[0] as string, b: courts[1] as string })}
              >
                {msg("board.swap", { a: courts[0] as string, b: courts[1] as string })}
              </button>
            )}
          </span>
        )}
      </div>

      {/* Keyboard/precise move for the picked fixture (predates v3, stays). */}
      {canEdit && pickedFixture && (
        <MovePanel
          fixture={pickedFixture}
          courts={courts}
          venueCap={venueCap}
          entrantNames={entrantNames}
          feedLabels={feedLabels}
          onMove={(atIso, court) => {
            void place(atIso ?? new Date().toISOString(), court);
          }}
          onClose={() => setPickedId(null)}
        />
      )}

      {/* Repair nudge (Task 16) — amber banner above the grid; its CTA opens the
          console in repair mode pre-scoped to the disruptions. */}
      {showRepairBanner && single && (
        <AiRepairBanner
          count={disruptions.fixtureIds.length}
          divisionId={single.id}
          onFix={openRepair}
        />
      )}

      {/* Board + tray share the row on desktop; tray is a sheet on mobile. */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {density === "board" && view === "day" && (
            <BoardGrid
              day={day}
              slots={slots}
              slotMinutes={slotMinutes}
              courts={courts}
              fixtures={dayFixtures}
              divisionNames={divisionNames}
              entrantNames={entrantNames}
              feedLabels={feedLabels}
              conflictsByFixture={actions.conflictsByFixture}
              canEdit={canEdit}
              multi={multi}
              pickedId={pickedId}
              onPick={pick}
              onPlace={(iso, court) => void place(iso, court)}
              onDropCard={(fid, iso, court) => void actions.moveCard(fid, iso, court)}
              onTogglePin={(f) => void actions.togglePin(f)}
              venueCap={venueCap}
              highlightId={highlightId}
              ghosts={dayGhosts}
            />
          )}

          {density === "board" && view === "week" && (
            <WeekView
              weekDays={weekDays}
              scheduled={scheduled}
              cfgStartAt={cfg.startAt ?? null}
              courts={courts}
              divisionNames={divisionNames}
              entrantNames={entrantNames}
              feedLabels={feedLabels}
              canEdit={canEdit}
              multi={multi}
              onMove={(fid, iso, court) => void actions.moveCard(fid, iso, court)}
            />
          )}

          {density === "agenda" && (
            <BoardAgenda
              fixtures={dayFixtures}
              divisionNames={divisionNames}
              entrantNames={entrantNames}
              feedLabels={feedLabels}
              conflictsByFixture={actions.conflictsByFixture}
              canEdit={canEdit}
              multi={multi}
              pickedId={pickedId}
              onPick={pick}
              onPlace={(iso, court) => void place(iso, court)}
              onTogglePin={(f) => void actions.togglePin(f)}
              highlightId={highlightId}
            />
          )}

          {density === "lanes" && (
            <BoardLanes
              day={day}
              divisions={visibleDivisions}
              fixtures={dayFixtures}
              entrantNames={entrantNames}
              feedLabels={feedLabels}
              conflictsByFixture={actions.conflictsByFixture}
              canEdit={canEdit}
              pickedId={pickedId}
              onPick={pick}
              onTogglePin={(f) => void actions.togglePin(f)}
              highlightId={highlightId}
            />
          )}
        </div>

        <BoardTray
          unscheduled={unscheduled}
          divisions={visibleDivisions}
          entrantNames={entrantNames}
          feedLabels={feedLabels}
          conflictsByFixture={actions.conflictsByFixture}
          canEdit={canEdit}
          pickedId={pickedId}
          onPick={pick}
          onTogglePin={(f) => void actions.togglePin(f)}
        />
      </div>

      {panelOpen && (
        <ConflictsPanel
          conflicts={visibleConflicts}
          board={board}
          entrantNames={entrantNames}
          feedLabels={feedLabels}
          divisionNames={divisionNames}
          onJump={jumpTo}
          onClose={() => setPanelOpen(false)}
          checkFailed={actions.checkFailed}
          checking={actions.checking}
          onRetryCheck={() => void actions.revalidate()}
        />
      )}

      {/* The JOINT console (#350): every selected division planned in one run,
          applied in one transaction. Mounted only where `aiEntryPoint` says so,
          which needs the competition id the competition page alone supplies. */}
      {aiOpen && aiEntry === "competition" && competition && (
        <AiCompetitionConsole
          competitionId={competition.id}
          divisions={jointDivisions}
          aiAllowed={aiAllowed}
          currency={currency}
          fixtures={aiFixtures}
          onClose={() => {
            setAiOpen(false);
            setAiProposal(null);
          }}
          onApplied={() => router.refresh()}
          onRefetch={() => router.refresh()}
          onProposalChange={setAiProposal}
        />
      )}

      {aiOpen && single && (
        <AiConsole
          key={single.id}
          divisionId={single.id}
          expectedSeq={single.seq}
          aiAllowed={aiAllowed}
          currency={currency}
          // Absent lock state reads as unfrozen: the server is the authority
          // (409 SCHEDULE_LOCKED), so a missing field must not hide the button.
          scheduleFrozen={single.schedule_locked ?? false}
          brief={aiBrief}
          fixtures={aiFixtures}
          prefillRepair={aiRepairScope}
          onClose={() => {
            setAiOpen(false);
            setAiProposal(null);
            setAiRepairScope(null);
          }}
          onApplied={() => router.refresh()}
          onRefetch={() => router.refresh()}
          onProposalChange={(plan) => {
            setAiProposal(plan);
            // Jump to the earliest day the proposal touches so the ghosts show.
            if (plan && plan.proposal.length > 0) {
              const earliest = Math.min(...plan.proposal.map((p) => new Date(p.scheduled_at).getTime()));
              setDay(dayKey(new Date(earliest).toISOString()));
            }
          }}
          onPulse={pulse}
        />
      )}

      {/* Settings (hosted on the constraints tab when the page says so) */}
      {showSettings && (
        <SettingsPanel
          divisionId={settings.division_id}
          config={cfg}
          canEdit={canEdit}
          constraintsAllowed={constraintsAllowed}
          venueCap={venueCap}
          onSaved={() => {
            actions.setNotice(msg("boardset.saved"));
            router.refresh();
          }}
          onError={(err) => actions.setError(err instanceof Error ? err.message : msg("boardset.error"))}
        />
      )}
    </div>
  );
}

// Week view (cross-day drag) — behaviour unchanged from the pre-v3 board.
function WeekView({
  weekDays,
  scheduled,
  cfgStartAt,
  courts,
  divisionNames,
  entrantNames,
  feedLabels,
  canEdit,
  multi,
  onMove,
}: {
  weekDays: string[];
  scheduled: BoardFixture[];
  cfgStartAt: string | null;
  courts: string[];
  divisionNames: Record<string, string>;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  canEdit: boolean;
  multi: boolean;
  onMove: (fixtureId: string, atIso: string, court: string | null) => void;
}) {
  const msg = useMsg();
  const locale = useLocale();
  const [dragDay, setDragDay] = useState<string | null>(null);

  function moveToDay(fixtureId: string, targetDay: string) {
    const f = scheduled.find((x) => x.id === fixtureId);
    if (!f || f.status !== "scheduled") return;
    if (f.scheduled_at && dayKey(f.scheduled_at as string) === targetDay) return;
    const src = f.scheduled_at ? new Date(f.scheduled_at) : cfgStartAt ? new Date(cfgStartAt) : null;
    const hh = src ? String(src.getHours()).padStart(2, "0") : "09";
    const mm = src ? String(src.getMinutes()).padStart(2, "0") : "00";
    const iso = new Date(`${targetDay}T${hh}:${mm}:00`).toISOString();
    onMove(fixtureId, iso, f.court_label ?? courts[0] ?? null);
  }

  return (
    <div>
      {canEdit && (
        <p className="mb-2 text-xs text-slate-500">{msg("board.week.hint")}</p>
      )}
      <div className="scroll-x scroll-x-fade flex gap-3 pb-2">
        {weekDays.map((d) => {
          const dayFx = scheduled
            .filter((f) => dayKey(f.scheduled_at as string) === d)
            .sort(
              (a, b) =>
                new Date(a.scheduled_at as string).getTime() -
                new Date(b.scheduled_at as string).getTime(),
            );
          const isToday = d === dayKey(new Date());
          const dropOver = dragDay === d;
          return (
            <div
              key={d}
              onDragOver={canEdit ? (e) => { e.preventDefault(); setDragDay(d); } : undefined}
              onDragLeave={canEdit ? () => setDragDay((cur) => (cur === d ? null : cur)) : undefined}
              onDrop={
                canEdit
                  ? (e) => {
                      e.preventDefault();
                      setDragDay(null);
                      const fid = e.dataTransfer.getData("text/fixture");
                      if (fid) moveToDay(fid, d);
                    }
                  : undefined
              }
              className={`flex w-52 shrink-0 flex-col rounded-xl border ${
                dropOver ? "border-purple-400 bg-purple-50/70" : "border-slate-200 bg-slate-50/60"
              }`}
            >
              <div
                className={`flex items-center justify-between rounded-t-xl border-b px-3 py-2 ${
                  isToday ? "border-purple-200 bg-purple-50" : "border-slate-200"
                }`}
              >
                <div className="leading-tight">
                  <p className="text-xs font-semibold text-slate-700">
                    {dayWeekday(d, locale)}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {dayDateShort(d, locale)}
                  </p>
                </div>
                <span className="rounded-full bg-white px-1.5 text-[11px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
                  {dayFx.length}
                </span>
              </div>
              <ul className="flex min-h-24 flex-1 flex-col gap-1.5 p-2">
                {dayFx.length === 0 && (
                  <li className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-200 px-2 py-4 text-center text-[11px] text-slate-500">
                    {canEdit ? msg("board.week.drop") : msg("board.week.noFixtures")}
                  </li>
                )}
                {dayFx.map((f) => {
                  const movable = canEdit && f.status === "scheduled";
                  return (
                    <li
                      key={f.id}
                      draggable={movable}
                      onDragStart={(e) => e.dataTransfer.setData("text/fixture", f.id)}
                      className={`rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs shadow-sm ${
                        movable ? "cursor-grab hover:border-purple-300" : "opacity-70"
                      }`}
                      style={{
                        borderLeftWidth: 3,
                        borderLeftColor: `hsl(${0} 0% 80%)`,
                      }}
                      data-fixture-id={f.id}
                    >
                      <div className="flex items-center justify-between text-[10px] text-slate-500">
                        <span>{timeLabel(f.scheduled_at as string)}</span>
                        <span>{f.court_label}</span>
                      </div>
                      <p className="truncate font-medium text-slate-700">
                        {cardTitle(f, entrantNames, feedLabels)}
                      </p>
                      {multi && (
                        <p className="truncate text-[10px] text-slate-500">
                          {divisionNames[f.division_id]}
                        </p>
                      )}
                      {f.status !== "scheduled" && (
                        <span className="text-[10px] text-sky-600">{fstatusLabel(msg, f.status)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
