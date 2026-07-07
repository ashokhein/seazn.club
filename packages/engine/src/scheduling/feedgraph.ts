// Cross-format feed graph validation (Jul3/08 §4/§9): winner_to/loser_to may
// target fixtures in a DIFFERENT stage (CL loser → EL slot). The graph over
// stages must stay a DAG — validated at config time, fail closed.
import { EngineError } from "../core/errors.ts";

export interface FeedEdge {
  from: string; // stage key (e.g. seq or id)
  to: string;
}

/** Throws CONFIG_INVALID when the feed graph has a cycle. */
export function validateFeedGraph(edges: readonly FeedEdge[]): void {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  }
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (node: string, path: string[]): void => {
    const s = state.get(node);
    if (s === 2) return;
    if (s === 1) {
      throw new EngineError("CONFIG_INVALID", "cross-format feeds form a cycle", {
        cycle: [...path, node],
      });
    }
    state.set(node, 1);
    for (const next of adj.get(node) ?? []) visit(next, [...path, node]);
    state.set(node, 2);
  };
  for (const node of adj.keys()) visit(node, []);
}
