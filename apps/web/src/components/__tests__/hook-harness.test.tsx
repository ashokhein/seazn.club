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
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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

describe("_hook-harness useRef (#350 Task 8)", () => {
  it("hands back the SAME box on every render, so a value written to it survives", () => {
    // A ref is the only in-flight guard that works: component state is read
    // through a closure a second click can beat. A harness that minted a fresh
    // box per render would show every double-spend guard on the branch passing
    // — the box the second click reads would never be the one the first wrote.
    const seen: { current: number }[] = [];

    function Island() {
      const [n, setN] = useState(0);
      const box = useRef(0);
      seen.push(box);
      return (
        <button
          type="button"
          onClick={() => {
            box.current += 1;
            setN(n + 1);
          }}
        >
          {`${n}:${box.current}`}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    expect(island.text()).toContain("0:0");
    clickButton(island.tree());
    // The write the click made is visible on the next render — which it is only
    // if the box is the same object.
    expect(island.text()).toContain("1:1");
    clickButton(island.tree());
    expect(island.text()).toContain("2:2");
    expect(seen.every((b) => b === seen[0])).toBe(true);
  });

  it("keeps ref cells positional across sibling refs", () => {
    // Two refs in one component share the cursor; swapping their cells would
    // hand each the other's box, and a single-ref test cannot see it.
    function Island() {
      const [n, setN] = useState(0);
      const a = useRef("alpha");
      const b = useRef("beta");
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {`${a.current}|${b.current}|${n}`}
        </button>
      );
    }
    const island = renderIsland(Island, {});
    expect(island.text()).toContain("alpha|beta|0");
    clickButton(island.tree());
    expect(island.text()).toContain("alpha|beta|1");
  });
});

describe("_hook-harness useCallback (#350 Task 8)", () => {
  it("holds a callback across renders while its deps hold, and re-makes it when they change", () => {
    // Same contract as useMemo, and it matters for the same reason: a callback
    // handed to a child is an ordinary useEffect dependency. A harness that
    // returned a new function every render would re-run every effect keyed on
    // one, every render.
    const seen: (() => number)[] = [];

    function Island() {
      // `n` never changes here — the click below moves the OTHER cell, which is
      // what makes this render a deps-unchanged one.
      const [n] = useState(0);
      const [other, setOther] = useState(0);
      const cb = useCallback(() => n, [n]);
      seen.push(cb as () => number);
      return (
        <div>
          <button type="button" onClick={() => setOther(other + 1)}>
            {`${cb()}|${other}`}
          </button>
        </div>
      );
    }

    const island = renderIsland(Island, {});
    // A render that did NOT change `n` must reuse the identical function…
    clickButton(island.tree());
    expect(island.text()).toContain("0|1");
    expect(seen[1]).toBe(seen[0]);
    // …and the callback must still close over live state, not a frozen copy of
    // the first render's — the direction "return the first value for ever"
    // would be just as wrong and just as invisible.
    expect(seen[1]()).toBe(0);
  });

  it("re-makes the callback when its deps change, so it never closes over stale state", () => {
    const seen: (() => number)[] = [];

    function Island() {
      const [n, setN] = useState(0);
      const cb = useCallback(() => n, [n]);
      seen.push(cb as () => number);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {String(cb())}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    clickButton(island.tree());
    expect(island.text()).toContain("1");
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[1]()).toBe(1);
  });
});

describe("_hook-harness useReducer (#400 Task 6b)", () => {
  // The board's AI console holds its whole state in `useReducer`, and the gate
  // that decides whether a run may be POSTed is a line inside one of its
  // callbacks. Without this hook the console cannot be driven at all, and that
  // gate — the wave's headline guarantee — rests on nothing.
  it("reduces an action into the next state and re-renders with it", () => {
    function Island() {
      const [n, dispatch] = useReducer(
        (state: number, action: { by: number }) => state + action.by,
        0,
      );
      return (
        <button type="button" onClick={() => dispatch({ by: 2 })}>
          {String(n)}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    expect(island.text()).toContain("0");
    clickButton(island.tree());
    expect(island.text()).toContain("2");
    clickButton(island.tree());
    // Four, not two: the second dispatch must read the state the FIRST one
    // produced. A dispatcher that reduced from the initial value every time
    // would sit here at 2 and look like a working hook.
    expect(island.text()).toContain("4");
  });

  it("hands back the SAME dispatch on every render", () => {
    // React guarantees this, and components depend on it: `dispatch` is the
    // canonical stable dep. A new identity per render would re-fire every
    // effect and re-make every callback that lists it — the harness would then
    // be measuring itself.
    const seen: unknown[] = [];

    function Island() {
      const [n, dispatch] = useReducer((state: number) => state + 1, 0);
      seen.push(dispatch);
      return (
        <button type="button" onClick={() => dispatch()}>
          {String(n)}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    clickButton(island.tree());
    expect(island.text()).toContain("1");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[1]).toBe(seen[0]);
  });

  it("runs the lazy initialiser once, with the initial argument", () => {
    let inits = 0;

    function Island() {
      const [n, dispatch] = useReducer(
        (state: number) => state + 1,
        5,
        (seed: number) => {
          inits += 1;
          return seed * 10;
        },
      );
      return (
        <button type="button" onClick={() => dispatch()}>
          {String(n)}
        </button>
      );
    }

    const island = renderIsland(Island, {});
    expect(island.text()).toContain("50");
    clickButton(island.tree());
    expect(island.text()).toContain("51");
    expect(inits).toBe(1);
  });

  it("keeps reducer cells positional across sibling reducers", () => {
    function Island() {
      const [a, bumpA] = useReducer((s: number) => s + 1, 0);
      const [b, bumpB] = useReducer((s: number) => s + 10, 0);
      return (
        <div>
          <button type="button" onClick={() => bumpA()}>
            {`a${a}`}
          </button>
          <span onClick={() => bumpB()}>{`b${b}`}</span>
        </div>
      );
    }

    const island = renderIsland(Island, {});
    clickButton(island.tree());
    expect(island.text()).toContain("a1");
    expect(island.text()).toContain("b0");
    const span = island.tree().find((el) => el.type === "span")!;
    (propsOf(span).onClick as () => void)();
    expect(island.text()).toContain("a1");
    expect(island.text()).toContain("b10");
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

describe("_hook-harness render-phase updates (the 'derive from props' pattern)", () => {
  // React sanctions `setX(...)` from inside the component body as the way to
  // adjust state when a prop changes, and this repo relies on it — the board's
  // day tab re-derives that way, `useBoardActions` clears its optimistic
  // overrides that way. React does not RE-ENTER for it: it throws the
  // half-finished pass away and runs the body again from the top.
  //
  // The harness used to call `run()` re-entrantly, which reset the hook cursors
  // underneath the render still executing. Every hook read AFTER the set landed
  // on the wrong cell, and the component rendered garbage with no error at all —
  // `useState<Density>("board")` came back as none of its three legal values.
  it("re-runs from the top instead of re-entering, so later hooks keep their cells", () => {
    const seen: { colour: string; label: string }[] = [];

    function Island({ tag }: { tag: string }) {
      const [seenTag, setSeenTag] = useState(tag);
      const [colour, setColour] = useState("red");
      // Two hooks AFTER the adjustment: a re-entrant re-render shifts both onto
      // the wrong cells, so their values are what discriminates.
      const [label] = useState("hello");
      const box = useRef("box");
      if (seenTag !== tag) {
        setSeenTag(tag);
        setColour("blue");
      }
      seen.push({ colour, label });
      return (
        <button type="button" data-box={box.current}>
          {`${colour}/${label}`}
        </button>
      );
    }

    const island = renderIsland(Island, { tag: "a" });
    expect(island.text()).toContain("red/hello");
    expect(seen).toHaveLength(1);

    island.rerender({ tag: "b" });

    // The adjusted value renders in the SAME commit — no intermediate output is
    // observable, exactly as in React.
    expect(island.text()).toContain("blue/hello");
    // …and the hooks below the adjustment still hold their own values, which is
    // the thing re-entrancy destroyed.
    const button = island.tree().find((el) => el.type === "button")!;
    expect(propsOf(button)["data-box"]).toBe("box");
    // Two passes for the second render (the discarded one, then the survivor)
    // and neither of them corrupted: `label` is "hello" every time.
    expect(seen.map((s) => s.label)).toEqual(["hello", "hello", "hello"]);
    expect(seen.map((s) => s.colour)).toEqual(["red", "red", "blue"]);
  });

  it("runs an effect whose deps changed on the pass that was thrown away", () => {
    // The bookkeeping half. A discarded pass must not record its dependency
    // array: if it does, the surviving pass compares against ITSELF, reads
    // "unchanged", and the effect never runs at all.
    const ran: string[] = [];

    function Island({ tag }: { tag: string }) {
      const [seenTag, setSeenTag] = useState(tag);
      if (seenTag !== tag) setSeenTag(tag);
      useEffect(() => {
        ran.push(tag);
      }, [tag]);
      return <button type="button">{tag}</button>;
    }

    const island = renderIsland(Island, { tag: "a" });
    expect(ran).toEqual(["a"]);

    island.rerender({ tag: "b" });
    expect(ran).toEqual(["a", "b"]);
  });

  /**
   * The CACHE half of the same bookkeeping, and the one that survived the first
   * fix. `useState`/`useReducer` writes made during a discarded pass MUST stand
   * — React queues render-phase updates and applies them, which is the whole
   * mechanism (the test above pins it: `colour` really does become "blue").
   * `useMemo`/`useCallback` are the opposite: on the re-run React compares
   * against the LAST COMMITTED render's deps, not against the pass it threw
   * away. So a memo whose deps moved since the commit but not between the two
   * passes recomputes in React and did NOT here — the harness handed back a
   * value computed before the adjustment, closing over pre-adjustment state.
   *
   * Deps naming the prop but not the adjusted state is exactly the shape that
   * makes this observable, and exactly what production writes when a value is
   * "derived once per prop change".
   */
  it("re-derives a memo whose deps moved since the COMMIT, not since the last pass", () => {
    const computed: string[] = [];

    function Island({ tag }: { tag: string }) {
      const [seenTag, setSeenTag] = useState(tag);
      const [colour, setColour] = useState("red");
      if (seenTag !== tag) {
        setSeenTag(tag);
        setColour("blue");
      }
      // The omitted `colour` IS the mechanism: with it in the deps the array
      // moves between the two passes and the memo recomputes for that reason
      // instead, so "fixing" this lint warning deletes the test.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const badge = useMemo(() => `${tag}-${colour}`, [tag]);
      computed.push(badge);
      return <button type="button">{badge}</button>;
    }

    const island = renderIsland(Island, { tag: "a" });
    expect(island.text()).toContain("a-red");

    island.rerender({ tag: "b" });

    // The discarded pass computed "b-red" — `colour` was still the pre-
    // adjustment value when that pass ran. Keeping it made the surviving pass
    // read a cache entry from a render that never happened.
    expect(island.text()).toContain("b-blue");
    expect(computed[computed.length - 1]).toBe("b-blue");
  });

  it("re-derives a callback the same way, so it cannot close over pre-adjustment state", () => {
    // Same rule, other cell list. A stale callback is worse than a stale memo:
    // nothing renders it, so it is invisible until it fires.
    const fired: string[] = [];

    function Island({ tag }: { tag: string }) {
      const [seenTag, setSeenTag] = useState(tag);
      const [colour, setColour] = useState("red");
      if (seenTag !== tag) {
        setSeenTag(tag);
        setColour("blue");
      }
      // Omitted deliberately — see the memo case above.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const onPick = useCallback(() => fired.push(`${tag}-${colour}`), [tag]);
      return (
        <button type="button" onClick={onPick}>
          {colour}
        </button>
      );
    }

    const island = renderIsland(Island, { tag: "a" });
    clickButton(island.tree());
    expect(fired).toEqual(["a-red"]);

    island.rerender({ tag: "b" });
    clickButton(island.tree());
    expect(fired).toEqual(["a-red", "b-blue"]);
  });

  it("fails loudly rather than hanging when an adjustment never converges", () => {
    function Island() {
      const [n, setN] = useState(0);
      setN(n + 1);
      return <button type="button">{String(n)}</button>;
    }

    expect(() => renderIsland(Island, {})).toThrow(/Too many re-renders/);
  });
});
