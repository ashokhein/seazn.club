// Scheduling constraints v2 (Jul3/04 §3) — the richer constraint family the
// calendar pass honours. Times inside the engine are epoch ms (injected); the
// API layer converts ISO strings. Zod schema first (PROMPT-00 §3).
import { z } from "zod";

export const StartWindowTarget = z.object({
  kind: z.enum(["entrant", "pool", "division"]),
  id: z.string(),
});
export type StartWindowTarget = z.infer<typeof StartWindowTarget>;

export const StartWindow = z.object({
  target: StartWindowTarget,
  notBefore: z.number().optional(), // epoch ms lower bound (14 Apr, 10 May)
  notAfter: z.number().optional(), // epoch ms upper bound on the START
});
export type StartWindow = z.infer<typeof StartWindow>;

export const SchedulingConstraints = z.object({
  restMin: z.number().int().nonnegative().optional(), // min minutes between an entrant's fixtures
  restByGroup: z.record(z.string(), z.number().int().nonnegative()).optional(), // per pool/division id (20 Oct)
  noBackToBack: z.boolean().default(false), // ≥1 fixture gap (4 Jun)
  startWindows: z.array(StartWindow).default([]),
  fieldFairness: z.enum(["off", "balance", "rotate"]).default("off"), // 14 Apr
  parallelism: z.enum(["block", "mixed"]).default("mixed"), // 29 May
  crossPersonClash: z.enum(["warn", "hard"]).default("warn"), // Jul3/04 §2
});
export type SchedulingConstraints = z.infer<typeof SchedulingConstraints>;
