// Issue #230 item 5 — a conflicts check that FAILED must not read as "no
// conflicts".
//
// `useBoardActions.runValidate` swallowed every failure in a bare `catch {}`.
// The board kept working, which was the intent — but the visible consequence
// was that a 500, an expired session or a dropped connection left the badge
// hidden and the panel empty, which is byte-for-byte what a clean board looks
// like. An organiser then drags a fixture onto an occupied court and is told
// nothing, because nobody asked.
//
// Two halves, and the tests below are split the same way, because either half
// alone is still the bug:
//
//   1. the hook has to REMEMBER that the last check failed (and forget it again
//      once one succeeds);
//   2. the toolbar has to SAY so at zero conflicts — the badge returns `null`
//      when the count is 0, so a state carried only into the panel is a state
//      nobody can reach.
//
// There is no jsdom in this workspace (vitest `environment: "node"`), so the
// hook is driven through the shared dispatcher harness and the two presentation
// components are rendered with `renderToStaticMarkup` under a real DictProvider
// — the sentences asserted here are the shipped English ones, not dict keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict, Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import { renderIsland } from "@/components/__tests__/_hook-harness";

/**
 * Every validate call the hook made, and the answer it gets next.
 *
 * `defer` parks a call instead of answering it, so a test can choose the ORDER
 * two overlapping checks settle in. Nothing else can observe last-resolved-wins:
 * with both promises already settled the interleaving is fixed.
 */
const net = vi.hoisted(() => ({
  calls: [] as string[],
  fail: false,
  defer: false,
  pending: [] as { ok: () => void; boom: () => void }[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string) => {
      net.calls.push(url);
      if (net.defer) {
        return new Promise((resolve, reject) => {
          net.pending.push({
            ok: () => resolve({ conflicts: [] }),
            boom: () => reject(new Error("network is down")),
          });
        });
      }
      if (net.fail) return Promise.reject(new Error("network is down"));
      return Promise.resolve({ conflicts: [] });
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

import { useBoardActions, type BoardActions } from "../use-board-actions";
import { ConflictsBadge, ConflictsPanel } from "../conflicts-panel";
import type { BoardDivision, BoardFixture } from "../types";

const enDict = en as unknown as Dict;

const DIVISION: BoardDivision = {
  id: "d1",
  name: "Under 12s",
  seq: 3,
  status: "draft",
  schedule_locked: false,
} as unknown as BoardDivision;

const FIXTURE: BoardFixture = {
  id: "f1",
  division_id: "d1",
  status: "scheduled",
  scheduled_at: null,
  court_label: null,
  schedule_locked: false,
} as unknown as BoardFixture;

/** The hook, driven one level deep. The probe hands the live actions object
 *  back out on every render, so assertions read the CURRENT state rather than
 *  the mount's. */
function driveHook() {
  let latest: BoardActions | null = null;
  const island = renderIsland(
    (props: { fixtures: BoardFixture[] }) => {
      latest = useBoardActions([DIVISION], props.fixtures, {}, {}, true);
      return null;
    },
    { fixtures: [FIXTURE] },
  );
  return { island, actions: () => latest as BoardActions };
}

describe("#230 item 5 — the hook remembers a failed conflicts check", () => {
  beforeEach(() => {
    net.calls = [];
    net.fail = false;
    net.defer = false;
    net.pending = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a validate that throws leaves the check marked unavailable, not clean", async () => {
    net.fail = true;
    const { actions } = driveHook();
    // The load-time check is debounced 400ms; nothing has been asked yet.
    expect(actions().checkFailed).toBe(false);

    await vi.advanceTimersByTimeAsync(400);

    expect(net.calls).toEqual(["/api/v1/divisions/d1/schedule/validate"]);
    expect(actions().checkFailed).toBe(true);
  });

  it("a validate that succeeds leaves it clean", async () => {
    const { actions } = driveHook();
    await vi.advanceTimersByTimeAsync(400);

    expect(net.calls).toHaveLength(1);
    expect(actions().checkFailed).toBe(false);
  });

  it("revalidate() retries immediately and clears the failure once one succeeds", async () => {
    net.fail = true;
    const { actions } = driveHook();
    await vi.advanceTimersByTimeAsync(400);
    expect(actions().checkFailed).toBe(true);

    // The manual retry must not be the debounced one: an organiser who presses
    // "check again" and waits half a second for nothing to happen presses it
    // again, and a retry that needs a timer to fire is indistinguishable from a
    // dead button.
    net.fail = false;
    const inflight = actions().revalidate();
    expect(net.calls).toHaveLength(2);
    await inflight;

    expect(actions().checkFailed).toBe(false);
  });

  /**
   * The ordering hazard the ticket counter exists for.
   *
   * Two checks overlap all the time here — the 400ms debounce fires while the
   * organiser is pressing "check again". If the answers are applied in the
   * order they RESOLVE, a failing check that started first and answered last
   * turns the notice back on over a fresh, successful one, and the organiser is
   * told the list is stale immediately after refreshing it.
   *
   * The interleaving is forced rather than hoped for: the first call is parked
   * and only released AFTER the second has already settled.
   */
  it("a stale failing check that answers LAST cannot overwrite the newer success", async () => {
    net.defer = true;
    const { actions } = driveHook();
    await vi.advanceTimersByTimeAsync(400);
    expect(net.pending).toHaveLength(1); // check #1 is parked, unanswered

    // Check #2 starts and finishes while #1 is still in flight.
    net.defer = false;
    net.fail = false;
    await actions().revalidate();
    expect(net.calls).toHaveLength(2);
    expect(actions().checkFailed).toBe(false);

    // …and only now does the older one fail.
    net.pending[0]!.boom();
    await vi.advanceTimersByTimeAsync(0);

    expect(actions().checkFailed).toBe(false);
    // The spinner belongs to the newer check too, which has already finished.
    expect(actions().checking).toBe(false);
  });
});

function markup(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <DictProvider locale={"en" as Locale} dict={enDict}>
      {node}
    </DictProvider>,
  );
}

const FAILED = enDict["board.conflicts.checkFailed"] as string;
const RETRY = enDict["board.conflicts.retryCheck"] as string;
const FRESH = enDict["board.conflicts.checkedJustNow"] as string;

describe("#230 item 5 — the toolbar says so at ZERO conflicts", () => {
  it("renders the unavailable state and a retry control with no conflicts to show", () => {
    const html = markup(
      <ConflictsBadge
        count={0}
        open={false}
        onToggle={() => undefined}
        checkFailed
        checking={false}
        onRetry={() => undefined}
      />,
    );
    // The whole point of the item: at count 0 the badge used to be `null`, so
    // this state had nowhere to live.
    expect(html).toContain(FAILED);
    expect(html).toContain(RETRY);
  });

  it("a clean check at zero conflicts still renders nothing (no new permanent chrome)", () => {
    const html = markup(
      <ConflictsBadge
        count={0}
        open={false}
        onToggle={() => undefined}
        checkFailed={false}
        checking={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).toBe("");
  });

  it("keeps the conflict count alongside the failure when both are true", () => {
    const html = markup(
      <ConflictsBadge
        count={2}
        open={false}
        onToggle={() => undefined}
        checkFailed
        checking={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain("2 conflicts");
    expect(html).toContain(FAILED);
  });

  /** With the panel open the SAME notice renders inside it. Both at once is two
   *  `role="status"` regions announcing one sentence and two buttons answering
   *  to "Check again" — a strict locator resolves neither, and a screen reader
   *  hears it twice. The badge itself must stay, so this is not "render
   *  nothing": the count is still the panel's toggle. */
  it("yields the notice to the panel while the panel is open, keeping the count badge", () => {
    const html = markup(
      <ConflictsBadge
        count={2}
        open
        onToggle={() => undefined}
        checkFailed
        checking={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain("2 conflicts");
    expect(html).not.toContain(FAILED);
    expect(html).not.toContain(RETRY);
  });

  it("disables the retry while a check is in flight", () => {
    const html = markup(
      <ConflictsBadge
        count={0}
        open={false}
        onToggle={() => undefined}
        checkFailed
        checking
        onRetry={() => undefined}
      />,
    );
    // Anchored on the ATTRIBUTE, not the bare word: `disabled:opacity-50` in a
    // Tailwind className satisfies a naive `toContain("disabled")`.
    expect(html).toContain('disabled=""');
  });
});

const PANEL_PROPS = {
  conflicts: [],
  board: [],
  entrantNames: {},
  feedLabels: {},
  divisionNames: {},
  onJump: () => undefined,
  onClose: () => undefined,
  checking: false,
  onRetryCheck: () => undefined,
};

describe("#230 item 5 — the panel dates its own list", () => {
  it("says when it was last checked", () => {
    const html = markup(<ConflictsPanel {...PANEL_PROPS} checkFailed={false} />);
    expect(html).toContain(FRESH);
    expect(html).not.toContain(FAILED);
  });

  it("says the list is not an answer when the check failed, and offers the retry", () => {
    const html = markup(<ConflictsPanel {...PANEL_PROPS} checkFailed />);
    expect(html).toContain(FAILED);
    expect(html).toContain(RETRY);
    expect(html).not.toContain(FRESH);
  });
});

describe("#230 item 5 — the copy exists in every locale", () => {
  it.each(["es", "fr", "nl"])("%s carries all three keys, translated", async (locale) => {
    const dict = (await import(`@/dictionaries/${locale}/ui.json`)).default as Record<string, string>;
    for (const key of [
      "board.conflicts.checkFailed",
      "board.conflicts.retryCheck",
      "board.conflicts.checkedJustNow",
    ]) {
      expect(dict[key], `${locale} is missing ${key}`).toBeTruthy();
    }
    // "Retry" is a plausible loanword; the two SENTENCES are not.
    expect(dict["board.conflicts.checkFailed"]).not.toBe(FAILED);
    expect(dict["board.conflicts.checkedJustNow"]).not.toBe(FRESH);
  });
});
