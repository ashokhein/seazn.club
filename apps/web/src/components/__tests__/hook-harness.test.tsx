// The harness has five consumers and no test of its own — so a harness bug
// looks like five suites quietly agreeing with each other (v17 gap #293 review).
//
// The one pinned here: `useMemo` used to ignore its `deps` and call `create()`
// on every render, documented as "a cache, never a behaviour". That is false
// the moment a memo result becomes a `useEffect` dependency — the ordinary
// React idiom for a stable options object. Production runs the effect once;
// the harness ran it on every render, and an effect that sets state would have
// looped for ever. Any assertion about how many times an island fetched, or
// about state that an effect writes, was measuring the harness.
import { describe, expect, it } from "vitest";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { propsOf, renderIsland, walk } from "./_hook-harness";

const clickButton = (tree: ReactElement[]) => {
  const button = tree.find((el) => el.type === "button");
  if (!button) throw new Error("no button rendered — the island did not mount");
  (propsOf(button).onClick as () => void)();
};

describe("_hook-harness useMemo (v17 gap #293 review)", () => {
  it("holds a memo across renders, so its result is stable as a useEffect dep", () => {
    let effectRuns = 0;
    let memoRuns = 0;

    function Island() {
      const [n, setN] = useState(0);
      // Constant deps: React computes this exactly once for the island's life.
      const options = useMemo(() => {
        memoRuns += 1;
        return { scope: "billing" };
      }, []);
      useEffect(() => {
        effectRuns += 1;
      }, [options]);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {String(n)}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    expect(memoRuns).toBe(1);
    expect(effectRuns).toBe(1);

    clickButton(island.tree());

    // Positive discriminator FIRST: the island really did re-render, so the
    // two counts below are a memo that held — not a click that never landed.
    expect(island.text()).toContain("1");
    expect(memoRuns).toBe(1);
    expect(effectRuns).toBe(1);
  });

  it("recomputes a memo when its deps DO change", () => {
    // The other direction, so the fix above cannot be "return the first value
    // for ever" — which would be just as wrong and just as invisible.
    const seen: number[] = [];

    function Island() {
      const [n, setN] = useState(0);
      const doubled = useMemo(() => n * 2, [n]);
      seen.push(doubled as number);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {String(doubled)}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    expect(island.text()).toContain("0");
    clickButton(island.tree());
    expect(island.text()).toContain("2");
    clickButton(island.tree());
    expect(island.text()).toContain("4");
    expect(seen).toEqual([0, 2, 4]);
  });

  it("keeps memo cells positional across sibling memos", () => {
    // Two memos in one component share the cursor; swapping their cells would
    // hand each the other's value, and a single-memo test cannot see it.
    function Island() {
      const [n, setN] = useState(0);
      const a = useMemo(() => "alpha", []);
      const b = useMemo(() => `beta-${n}`, [n]);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {`${a}|${b}`}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    expect(island.text()).toContain("alpha|beta-0");
    clickButton(island.tree());
    expect(island.text()).toContain("alpha|beta-1");
  });
});

describe("_hook-harness walk (the tree every assertion reads)", () => {
  it("returns nested elements, not just the root", () => {
    const tree = walk(
      <div>
        <span>one</span>
        <p>
          <em>two</em>
        </p>
      </div>,
    );
    expect(tree.map((el) => el.type)).toEqual(["div", "span", "p", "em"]);
  });
});
