// #230 item 2 follow-up — the organiser's way through the publish gate, and the
// honest dead end where there isn't one.
//
// The gate commit shipped without a console step, so a board carrying a single
// rest warning turned Publish into a red toast with no path forward: the button
// POSTs, the server 422s, `fail` flattens the refusal into one sentence and
// throws `extra.conflicts` away. Two things have to be true for that to be
// fixed, and either one alone still leaves the organiser stuck:
//
//   1. the hook has to hand the refusal BACK rather than render it as an error,
//      and re-send with `acknowledge_warnings: true` when asked;
//   2. the dialog has to distinguish the two refusals STRUCTURALLY. Blocking
//      conflicts are physically impossible and the flag is checked strictly
//      after them, so a greyed-out "Publish anyway" would be a promise the
//      server can never keep — it says "not yet" where the truth is "not on this
//      board". `ConfirmDialog` renders no confirm button at all.
//
// There is no jsdom in this workspace (vitest `environment: "node"`), so the
// board is driven through the shared hook harness — production's own `onClick`,
// not a re-implementation — and the dialog is rendered with
// `renderToStaticMarkup` under a real DictProvider, so the sentences asserted
// are the shipped ones.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict, Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { BoardConflict, BoardDivision, BoardFixture, BoardStage } from "../types";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/c/cup/d/open/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `useLocale` THROWS outside a DictProvider and the harness has no provider
// tree; `useMsg` falls back to the real English catalog, which is the production
// path.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useLocale: () => "en" as const };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

/** Every POST the board made, and the answer the next one gets. */
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  /** Queued refusals, consumed in order by the publish/start endpoints. */
  refusals: [] as { code: string; conflicts: unknown[] }[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      const gated = url.endsWith("/publish-schedule") || url.endsWith("/start");
      if (gated && net.refusals.length > 0) {
        const next = net.refusals.shift()!;
        return Promise.reject(
          new actual.ApiV1Error("refused", 422, next.code, { conflicts: next.conflicts }),
        );
      }
      return Promise.resolve({ conflicts: [] });
    },
  };
});

import { ScheduleBoard } from "../../schedule-board";
import { ScheduleGateDialog } from "../schedule-gate-dialog";

const enDict = en as unknown as Dict;

const REST_WARNING: BoardConflict = {
  fixture_id: "f1",
  code: "warn.rest",
  blocking: false,
  detail: "entrant e1 below rest",
} as unknown as BoardConflict;

const COURT_CLASH: BoardConflict = {
  fixture_id: "f1",
  code: "conflict.court",
  blocking: true,
  detail: "court Court 1 double-booked with f2",
} as unknown as BoardConflict;

// ---------------------------------------------------------------------------
// The dialog itself. Rendered under a real provider; assertions read shipped
// English, and every attribute probe is anchored on `="` — React serialises an
// omitted prop as the string "$undefined", so a bare `data-x` probe would pass
// in both states.
// ---------------------------------------------------------------------------

const BOARD: BoardFixture[] = [
  {
    id: "f1",
    division_id: "d1",
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    court_label: "Court 1",
    status: "scheduled",
    schedule_locked: false,
  } as unknown as BoardFixture,
];

function dialogMarkup(gate: Parameters<typeof ScheduleGateDialog>[0]["gate"]): string {
  return renderToStaticMarkup(
    <DictProvider locale={"en" as Locale} dict={enDict}>
      <ScheduleGateDialog
        gate={gate}
        board={BOARD}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        feedLabels={{}}
        onConfirm={() => undefined}
        onDismiss={() => undefined}
      />
    </DictProvider>,
  );
}

/** React escapes `'`, `&`, `<` and `>` in text nodes, so a raw dictionary
 *  sentence containing an apostrophe is never a substring of the markup. */
const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;");

const CONFIRM = 'data-testid="board-gate-confirm"';
const CANCEL = 'data-testid="board-gate-cancel"';

describe("the gate dialog offers a way through for warnings", () => {
  it("renders the confirm affordance and names the warning", () => {
    const html = dialogMarkup({ kind: "warnings", action: "publish", conflicts: [REST_WARNING] });

    expect(html).toContain(CONFIRM);
    expect(html).toContain(enDict["board.gate.publishAnyway"] as string);
    expect(html).toContain(enDict["board.gate.warnTitlePublish"] as string);
    // The conflict itself, not merely "a dialog": the whole point is that the
    // organiser is told what they are acknowledging.
    expect(html).toContain('data-testid="board-gate-conflict"');
    expect(html).toContain('data-code="warn.rest"');
    expect(html).toContain('data-blocking="no"');
    expect(html).toContain(esc(enDict["board.conflictHelp.warn.rest"] as string));
    // Cancel is localized rather than the primitive's hardcoded English.
    expect(html).toContain(CANCEL);
    expect(html).toContain(enDict["board.cancel"] as string);
  });

  it("says out loud that starting publishes, and offers Start anyway", () => {
    // Two actions reach one gate. If the dialog only ever said "publish", the
    // organiser pressing Start would be asked to confirm something they did not
    // press — and would not be told that starting puts the timetable in front of
    // players and opens scoring.
    const html = dialogMarkup({ kind: "warnings", action: "start", conflicts: [REST_WARNING] });

    expect(html).toContain(enDict["board.gate.startAnyway"] as string);
    expect(html).toContain(enDict["board.gate.warnTitleStart"] as string);
    expect(html).toContain(enDict["board.gate.warnBodyStart"] as string);
    expect(html).not.toContain(enDict["board.gate.publishAnyway"] as string);
  });
});

describe("the gate dialog offers NO way through for blocking conflicts", () => {
  it("renders no confirm control at all — structurally, not disabled", () => {
    const html = dialogMarkup({ kind: "blocking", action: "publish", conflicts: [COURT_CLASH] });

    // The assertion this file exists for. `acknowledge_warnings` is checked
    // strictly AFTER the blocking test on the server and can never reach it, so
    // a control that offers to send it would be a promise nothing can keep.
    expect(html).not.toContain(CONFIRM);
    expect(html).not.toContain(enDict["board.gate.publishAnyway"] as string);
    expect(html).not.toContain(enDict["board.gate.startAnyway"] as string);
    // …and it is a dead end that SAYS so, with one dismiss.
    expect(html).toContain(CANCEL);
    expect(html).toContain(enDict["board.gate.dismiss"] as string);
    expect(html).toContain(enDict["board.gate.blockTitle"] as string);
    expect(html).toContain(enDict["board.gate.blockBody"] as string);
    expect(html).toContain('data-code="conflict.court"');
    expect(html).toContain('data-blocking="yes"');
  });

  it("holds for a blocking START too", () => {
    const html = dialogMarkup({ kind: "blocking", action: "start", conflicts: [COURT_CLASH] });
    expect(html).not.toContain(CONFIRM);
  });

  /**
   * The code, never the rows, decides which dialog appears.
   *
   * `conflict.start_window` is NOT blocking and `warn.window` IS
   * (`isBlockingConflict`), so a client that recomputed the kind from the list
   * would disagree with the server that produced it. Here the server said
   * "warnings" while a row happens to carry `blocking: true` — the confirm
   * affordance follows the SERVER.
   */
  it("follows the server's code even when a row's own flag disagrees", () => {
    const html = dialogMarkup({ kind: "warnings", action: "publish", conflicts: [COURT_CLASH] });
    expect(html).toContain(CONFIRM);
  });

  it("renders nothing at all when there is no refusal", () => {
    expect(dialogMarkup(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The board's half of the join: the refusal reaches the dialog, and confirming
// re-sends the SAME action with the flag.
// ---------------------------------------------------------------------------

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Open", slug: "open", status: "setup", seq: 4, schedule_locked: false },
];
const STAGES: BoardStage[] = [
  { id: "s1", division_id: "d1", name: "Round robin", kind: "round_robin", ordinal: 1 },
] as unknown as BoardStage[];

const SETTINGS = {
  tz: "Europe/London",
  config: {
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T18:00:00.000Z",
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
  },
} as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];

type BoardProps = Parameters<typeof ScheduleBoard>[0];

const baseProps = (): BoardProps =>
  ({
    divisions: DIVISIONS,
    stages: STAGES,
    fixtures: BOARD,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 2 },
    feedLabels: {},
    settings: SETTINGS,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: true,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-08-02",
    officialsWithBlackout: 0,
    competition: { id: "c1", divisionSettings: { d1: SETTINGS } },
  }) as unknown as BoardProps;

const localStore = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => void localStore.set(k, v),
  },
  matchMedia: () => ({ matches: false }),
  get location() {
    return { search: nav.search };
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const withTestId = (tree: ReactElement[], id: string): ReactElement => {
  const el = tree.find((node) => propsOf(node)["data-testid"] === id);
  if (!el) throw new Error(`nothing rendered with data-testid="${id}"`);
  return el;
};

/** The mounted dialog's props — the board's output, one level deep. */
const gateProps = (tree: ReactElement[]) => {
  const el = tree.find((node) => node.type === ScheduleGateDialog);
  if (!el) throw new Error("the gate dialog is not mounted on the board");
  return propsOf(el) as {
    gate: { kind: string; action: string; conflicts: BoardConflict[] } | null;
    onConfirm: () => void;
  };
};

const gatedCalls = () =>
  net.calls.filter((c) => c.url.endsWith("/publish-schedule") || c.url.endsWith("/start"));

beforeEach(() => {
  net.calls.length = 0;
  net.refusals.length = 0;
  nav.refresh.mockClear();
});

describe("the board turns a gate refusal into the dialog, and confirming re-sends it", () => {
  it("publish → warnings → Publish anyway re-POSTs with acknowledge_warnings", async () => {
    net.refusals.push({ code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS", conflicts: [REST_WARNING] });
    const island = renderIsland(ScheduleBoard, baseProps());

    await (propsOf(withTestId(island.tree(), "board-publish-schedule")).onClick as () => void)();
    await flush();

    // The first POST carries NO body: publish and start parse an absent body as
    // `{}` and every existing key client sends none, so the console must not
    // start requiring one.
    expect(gatedCalls()).toHaveLength(1);
    expect(gatedCalls()[0]!.json).toBeUndefined();
    expect(gatedCalls()[0]!.url).toContain("/publish-schedule");

    const opened = gateProps(island.tree());
    expect(opened.gate).toMatchObject({ kind: "warnings", action: "publish" });
    expect(opened.gate!.conflicts).toEqual([REST_WARNING]);

    opened.onConfirm();
    await flush();

    expect(gatedCalls()).toHaveLength(2);
    expect(gatedCalls()[1]!.url).toContain("/publish-schedule");
    expect(gatedCalls()[1]!.json).toStrictEqual({ acknowledge_warnings: true });
    // Accepted this time, so the dialog closes.
    expect(gateProps(island.tree()).gate).toBeNull();
  });

  it("start → warnings → Start anyway re-POSTs to /start, not to publish", async () => {
    // The action has to ride with the refusal. A dialog that assumed "publish"
    // would acknowledge the warnings against the wrong endpoint and leave the
    // division in setup with the organiser told it started.
    net.refusals.push({ code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS", conflicts: [REST_WARNING] });
    const island = renderIsland(ScheduleBoard, baseProps());

    await (propsOf(withTestId(island.tree(), "board-start-division")).onClick as () => void)();
    await flush();
    expect(gateProps(island.tree()).gate).toMatchObject({ kind: "warnings", action: "start" });

    gateProps(island.tree()).onConfirm();
    await flush();

    expect(gatedCalls()).toHaveLength(2);
    expect(gatedCalls()[1]!.url).toMatch(/\/divisions\/d1\/start$/);
    expect(gatedCalls()[1]!.json).toStrictEqual({ acknowledge_warnings: true });
  });

  it("a blocking refusal opens the dialog with kind=blocking and posts nothing more", async () => {
    net.refusals.push({ code: "SCHEDULE_BLOCKING_CONFLICTS", conflicts: [COURT_CLASH] });
    const island = renderIsland(ScheduleBoard, baseProps());

    await (propsOf(withTestId(island.tree(), "board-publish-schedule")).onClick as () => void)();
    await flush();

    expect(gateProps(island.tree()).gate).toMatchObject({ kind: "blocking", action: "publish" });
    expect(gatedCalls()).toHaveLength(1);
  });

  /**
   * The race the gate exists for, seen from the console.
   *
   * Another organiser drags a card into a court clash while this one is reading
   * the warnings. Acknowledging must not close the dialog on a refusal — it must
   * re-open on the NEW one, blocking this time, or the organiser is dropped back
   * onto the board believing they published.
   */
  it("a second refusal re-opens the dialog rather than dismissing it", async () => {
    net.refusals.push(
      { code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS", conflicts: [REST_WARNING] },
      { code: "SCHEDULE_BLOCKING_CONFLICTS", conflicts: [COURT_CLASH] },
    );
    const island = renderIsland(ScheduleBoard, baseProps());

    await (propsOf(withTestId(island.tree(), "board-publish-schedule")).onClick as () => void)();
    await flush();
    gateProps(island.tree()).onConfirm();
    await flush();

    expect(gateProps(island.tree()).gate).toMatchObject({ kind: "blocking" });
    expect(gateProps(island.tree()).gate!.conflicts).toEqual([COURT_CLASH]);
  });

  it("a clean publish opens no dialog at all", async () => {
    const island = renderIsland(ScheduleBoard, baseProps());

    await (propsOf(withTestId(island.tree(), "board-publish-schedule")).onClick as () => void)();
    await flush();

    expect(gateProps(island.tree()).gate).toBeNull();
    expect(gatedCalls()).toHaveLength(1);
    expect(nav.refresh).toHaveBeenCalled();
  });
});

describe("the gate copy exists in every locale", () => {
  const KEYS = [
    "board.gate.warnTitlePublish",
    "board.gate.warnTitleStart",
    "board.gate.warnBodyPublish",
    "board.gate.warnBodyStart",
    "board.gate.blockTitle",
    "board.gate.blockBody",
    "board.gate.publishAnyway",
    "board.gate.startAnyway",
    "board.gate.dismiss",
  ];

  it.each(["es", "fr", "nl"])("%s carries all nine keys, translated", async (locale) => {
    const dict = (await import(`@/dictionaries/${locale}/ui.json`)).default as Record<
      string,
      string
    >;
    for (const key of KEYS) {
      // A flat lookup: these files are flat dotted-key JSON, and a nested walk
      // false-negatives on every one of them.
      expect(dict, `${locale} is missing ${key}`).toHaveProperty(key);
      expect(dict[key]).toBeTruthy();
    }
    // Short labels are plausible loanwords; the two SENTENCES are not.
    expect(dict["board.gate.blockBody"]).not.toBe(enDict["board.gate.blockBody"]);
    expect(dict["board.gate.warnBodyStart"]).not.toBe(enDict["board.gate.warnBodyStart"]);
  });
});
