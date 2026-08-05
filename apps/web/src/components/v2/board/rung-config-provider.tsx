"use client";

// #385 — the rung weights and token budgets the SERVER resolved, carried to the
// client surfaces that price a run.
//
// Why a provider rather than a prop: `schedule-board.tsx` is itself a client
// module, so there is no server component in the console's own tree to hand the
// value down from. The RSC that renders the board calls `resolveRungConfig()`
// and wraps the board; everything below reads it from context.
import { createContext, useContext, type ReactNode } from "react";
import type { RungConfig } from "@/lib/ai-rung";

const Ctx = createContext<RungConfig | null>(null);

/** Seeded by the RSC that renders the board — see `resolveRungConfig` (#385). */
export function RungConfigProvider({ value, children }: { value: RungConfig; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * No default value, deliberately.
 *
 * A fallback here would reintroduce the exact silent divergence #385 is about:
 * the card would quietly price on the built-in defaults while the server priced
 * on its overrides, and nothing on screen or in a test would say so. A missing
 * provider is a bug in the tree, so it throws where it happens rather than
 * surfacing later as a support ticket about being overcharged.
 */
export function useRungConfig(): RungConfig {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useRungConfig requires a RungConfigProvider");
  return v;
}
