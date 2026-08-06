// The PRIMARY "Start tournament" button and the publish gate.
//
// THE BUG. `startDivision` publishes on its way through, so it refuses the same
// two ways publish does: SCHEDULE_UNACKNOWLEDGED_WARNINGS ("we can, but look at
// this first" — there IS a way through) and SCHEDULE_BLOCKING_CONFLICTS (no way
// through, by design). The gate commit gave the BOARD's start button a dialog
// for both and left this one — the division console's, the one the pro and
// community journeys actually click — rendering `err.message` as a red span.
// The organiser read one flattened sentence, `extra.conflicts` was thrown away,
// and there was no control that could send `acknowledge_warnings`. A dead end.
//
// It survived e2e because those journeys start divisions that were never
// scheduled: with nothing placed there is nothing to conflict, so the refusal
// never fires and the missing dialog is invisible.
//
// WHY THE HARNESS. There is no jsdom here (vitest `environment: "node"`), so
// this is the only way to press production's own `onClick` and read what the
// component did with the rejection. The blocking case then renders the dialog
// from the props LaunchActions itself handed down — asserting the dead end is
// gone must not become "we traded it for a nicer-looking one", so the confirm
// control has to be ABSENT there, not merely disabled.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict, Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { BoardConflict, BoardFixture } from "../board/types";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: nav.push, replace: nav.replace }),
  usePathname: () => "/o/acme/c/champs/d/u12",
}));

/** Every POST the button made, and the answer the next one gets. */
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  /** Consumed in order: `null` succeeds, otherwise the refusal to throw. */
  answers: [] as ({ code: string; conflicts?: unknown[]; message?: string } | null)[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      const next = net.answers.shift();
      if (next) {
        return Promise.reject(
          new actual.ApiV1Error(next.message ?? "refused", 422, next.code, {
            conflicts: next.conflicts ?? [],
          }),
        );
      }
      return Promise.resolve({ generated: 0 });
    },
  };
});

import { LaunchActions } from "../launch-actions";
import { ScheduleGateDialog } from "../board/schedule-gate-dialog";

const enDict = en as unknown as Dict;

const REST_WARNING = {
  fixture_id: "f1",
  code: "warn.rest",
  blocking: false,
  detail: "entrant e1 below rest",
} as unknown as BoardConflict;

const COURT_CLASH = {
  fixture_id: "f1",
  code: "conflict.court",
  blocking: true,
  detail: "court Court 1 double-booked with f2",
} as unknown as BoardConflict;

const FIXTURES = [
  {
    id: "f1",
    stage_id: "s1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  },
] as unknown as BoardFixture[];

type LaunchProps = Parameters<typeof LaunchActions>[0];

const baseProps = (): LaunchProps => ({
  divisionId: "d1",
  orgSlug: "acme",
  compSlug: "champs",
  divSlug: "u12",
  status: "scheduled",
  canEdit: true,
  fixtures: FIXTURES,
  entrantNames: { e1: "Alpha", e2: "Bravo" },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const withTestId = (tree: ReactElement[], id: string): ReactElement => {
  const el = tree.find((node) => propsOf(node)["data-testid"] === id);
  if (!el) throw new Error(`nothing rendered with data-testid="${id}"`);
  return el;
};

/** The dialog's props — LaunchActions' own output, one level deep. */
const gateProps = (tree: ReactElement[]) => {
  const el = tree.find((node) => node.type === ScheduleGateDialog);
  if (!el) throw new Error("the launch actions mount no gate dialog");
  return propsOf(el) as Parameters<typeof ScheduleGateDialog>[0];
};

const pressStart = async (island: { tree: () => ReactElement[] }) => {
  await (propsOf(withTestId(island.tree(), "launch-start-division")).onClick as () => void)();
  await flush();
};

beforeEach(() => {
  net.calls.length = 0;
  net.answers.length = 0;
  nav.refresh.mockClear();
  nav.push.mockClear();
});

describe("the console's Start button routes a gate refusal into the dialog", () => {
  it("warnings open the dialog, and Start anyway re-POSTs with acknowledge_warnings", async () => {
    net.answers.push({ code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS", conflicts: [REST_WARNING] });
    const island = renderIsland(LaunchActions, baseProps());

    await pressStart(island);

    // The first POST carries NO body: /start parses an absent one as `{}` and
    // every existing key client sends none, so the console must not start
    // requiring one.
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("/api/v1/divisions/d1/start");
    expect(net.calls[0]!.json).toBeUndefined();

    const opened = gateProps(island.tree());
    expect(opened.gate).toMatchObject({ kind: "warnings", action: "start" });
    expect(opened.gate!.conflicts).toEqual([REST_WARNING]);

    // …and the dead end is gone: no red span carrying a flattened sentence.
    expect(island.text()).not.toContain("refused");

    opened.onConfirm();
    await flush();

    expect(net.calls).toHaveLength(2);
    expect(net.calls[1]!.url).toBe("/api/v1/divisions/d1/start");
    expect(net.calls[1]!.json).toStrictEqual({ acknowledge_warnings: true });
    // Accepted this time, so the dialog closes and the page re-reads.
    expect(gateProps(island.tree()).gate).toBeNull();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("a blocking refusal offers NO way through — the confirm control is absent", async () => {
    net.answers.push({ code: "SCHEDULE_BLOCKING_CONFLICTS", conflicts: [COURT_CLASH] });
    const island = renderIsland(LaunchActions, baseProps());

    await pressStart(island);

    const opened = gateProps(island.tree());
    expect(opened.gate).toMatchObject({ kind: "blocking", action: "start" });
    // Nothing further is POSTed: there is no control that could.
    expect(net.calls).toHaveLength(1);

    // Rendered from the props the component handed down, so this is the sheet
    // the organiser sees. `ConfirmDialog` derives `${testId}-confirm` only when
    // it has a `confirmLabel`; blocking omits it.
    const html = renderToStaticMarkup(
      <DictProvider locale={"en" as Locale} dict={enDict}>
        <ScheduleGateDialog {...opened} />
      </DictProvider>,
    );
    expect(html).toContain('data-testid="board-gate-cancel"');
    expect(html).not.toContain('data-testid="board-gate-confirm"');
    // The conflict is named by the match it is about, not by "Removed fixture":
    // the page already holds the fixtures and the entrants, so the sheet can say
    // which match without a second round trip.
    expect(html).toContain("Alpha vs Bravo");
  });

  it("still renders an ordinary failure as an error, and opens no dialog", async () => {
    // Non-vacuity for both cases above: a component that swallowed every
    // rejection into the dialog would pass them and lose every real error.
    net.answers.push({ code: "INTERNAL", message: "the database is on fire" });
    const island = renderIsland(LaunchActions, baseProps());

    await pressStart(island);

    expect(gateProps(island.tree()).gate).toBeNull();
    expect(island.text()).toContain("the database is on fire");
  });

  it("dismissing closes the dialog and POSTs nothing", async () => {
    net.answers.push({ code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS", conflicts: [REST_WARNING] });
    const island = renderIsland(LaunchActions, baseProps());

    await pressStart(island);
    gateProps(island.tree()).onDismiss();
    await flush();

    expect(gateProps(island.tree()).gate).toBeNull();
    expect(net.calls).toHaveLength(1);
  });
});
