// Driving a stateful client island without a DOM — shared test harness.
//
// vitest runs `environment: "node"` here and the workspace has no jsdom, so a
// `useState` component cannot be clicked: calling it directly throws "Invalid
// hook call". That leaves the JOIN between a component's state and whatever it
// posts unwitnessed by every other layer — the class of bug where one token
// ("event_pass" for `passKey`; the generic error key for `extraOrgsErrorKey`)
// passes every suite AND `tsc`, and only a human clicking would notice.
//
// So this supplies React's hook dispatcher itself. `useState` is one slot of
// `internals.H`; it needs a cursor, an array of cells, and a re-render on `set`.
// `useEffect`, `useMemo` and `useContext` are here too — an island that FETCHES
// its data on mount (the create-org form's billing groups) renders an empty
// shell without effects, so every assertion about what it draws would be
// vacuous, and `useMsg` reads a context to find its copy. It is deliberately
// NOT a general React renderer — it renders one function component one level
// deep and returns the element tree, which is all a click needs.
//
// Why this rather than adding jsdom: jsdom is a dependency for every suite in
// the workspace and a build-time cost forever, to cover a handful of lines.
// This is ~40 test-only lines that touch nothing else.
//
// How it fails when React changes: `react` is pinned to an exact version
// (package.json "react": "19.2.4", no caret). If a future upgrade moves the
// dispatcher slot, the guard below throws with a message naming this file, and
// every test using it reds — loudly, not silently.
//
// Extracted from pass-upgrade.test.tsx (v17 #294) when the Add-ons control
// (v17 gap #293) needed the same thing, rather than copied: two hand-maintained
// copies of a dispatcher shim is precisely the drift this repo keeps a
// duplicate-resolver test about.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import * as ReactRuntime from "react";

type Cell = unknown;
type Deps = unknown[] | undefined;

interface HookDispatcher {
  useState: (initial: Cell) => [Cell, (next: Cell) => void];
  /** Mount/update effects. Collected during render and run after it, exactly
   *  as React does — a component that LOADS its data in an effect (the create-
   *  org form's billing groups) renders an empty shell without this, and every
   *  assertion about what it draws afterwards would be vacuous. */
  useEffect: (create: () => void | (() => void), deps: Deps) => void;
  /** Straight through: `useMemo` is a cache, never a behaviour. */
  useMemo: (create: () => Cell, deps: Deps) => Cell;
  /** The context's DEFAULT value — there is no provider tree here. That is the
   *  production path for the copy hooks (`useMsg` falls back to the English
   *  catalog outside a `DictProvider`), so the sentences a test reads are the
   *  shipped English ones. */
  useContext: (context: { _currentValue: Cell }) => Cell;
}

export type Props = Record<string, unknown>;

/** Props of an element, typed for the `find`/`filter` idiom below. */
export const propsOf = (el: ReactElement): Props => el.props as Props;

/** Every element in a returned tree, so handlers can be found and invoked. */
export function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  return walk((node.props as { children?: ReactNode }).children, out);
}

/** Every STRING rendered anywhere in a tree, joined. Lets a test assert on the
 *  sentence a customer actually reads rather than on a dictionary key — which
 *  is the difference between pinning copy and pinning a lookup. */
export function textOf(node: ReactNode): string {
  const out: string[] = [];
  const visit = (n: ReactNode) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const child of n) visit(child);
      return;
    }
    if (!isValidElement(n)) return;
    visit((n.props as { children?: ReactNode }).children);
  };
  visit(node);
  return out.join(" ");
}

function hookDispatcherSlot(): { H: HookDispatcher | null } {
  const slot = (
    ReactRuntime as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
        H: HookDispatcher | null;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!slot) {
    throw new Error(
      "React's hook dispatcher slot has moved — the useState harness in " +
        "components/__tests__/_hook-harness.tsx needs updating (see its comment).",
    );
  }
  return slot;
}

/**
 * Render a `useState`-only function component and keep re-rendering it as its
 * state changes, so its handlers can be invoked the way a browser would.
 *
 * @param expand how to flatten the rendered output. Defaults to `walk`; a
 *   caller passes its own when a CHILD component also has to be expanded (only
 *   safe for hookless children — expanding one that mounts a provider or a
 *   third-party widget would need a real renderer).
 */
export function renderIsland<P>(
  Component: (props: P) => ReactNode,
  props: P,
  expand: (node: ReactNode) => ReactElement[] = (node) => walk(node),
) {
  const slot = hookDispatcherSlot();
  const cells: Cell[] = [];
  let cursor = 0;
  let output: ReactNode = null;
  // Effects are keyed by call order like every other hook. `deps` is the
  // PREVIOUS render's array, so an effect re-runs only when its dependencies
  // change — `[]` runs once. Re-running everything on every render would put a
  // component that sets state from an effect into an infinite loop.
  const effects: { deps: Deps; cleanup: void | (() => void) }[] = [];
  let effectCursor = 0;
  let pending: { index: number; create: () => void | (() => void) }[] = [];

  const dispatcher: HookDispatcher = {
    useState(initial) {
      const index = cursor++;
      if (index >= cells.length) {
        cells.push(typeof initial === "function" ? (initial as () => Cell)() : initial);
      }
      const set = (next: Cell) => {
        cells[index] =
          typeof next === "function" ? (next as (previous: Cell) => Cell)(cells[index]) : next;
        run();
      };
      return [cells[index], set];
    },
    useEffect(create, deps) {
      const index = effectCursor++;
      const before = effects[index];
      const changed =
        !before ||
        deps === undefined ||
        before.deps === undefined ||
        deps.length !== before.deps.length ||
        deps.some((d, i) => !Object.is(d, (before.deps as unknown[])[i]));
      if (!before) effects[index] = { deps, cleanup: undefined };
      else effects[index] = { deps, cleanup: before.cleanup };
      if (changed) pending.push({ index, create });
    },
    useMemo(create) {
      return create();
    },
    useContext(context) {
      return context._currentValue;
    },
  };

  function run() {
    cursor = 0;
    effectCursor = 0;
    pending = [];
    const previous = slot.H;
    slot.H = dispatcher;
    try {
      output = Component(props);
    } finally {
      slot.H = previous;
    }
    // After the render, like React's commit phase — and OUTSIDE the dispatcher,
    // so an effect that calls setState re-renders through the normal path.
    const queued = pending;
    pending = [];
    for (const { index, create } of queued) {
      effects[index]?.cleanup?.();
      const cleanup = create();
      const slotEntry = effects[index];
      if (slotEntry) slotEntry.cleanup = cleanup;
    }
  }

  run();
  // Functions, not values: every interaction re-renders, and reading a stale
  // tree would let assertions pass against markup the user never saw.
  return { tree: () => expand(output), text: () => textOf(output) };
}
