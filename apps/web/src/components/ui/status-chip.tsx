// Status-chip vocabulary (v3/03 §1): the ONE way lifecycle state renders —
// cards, page headers, fixture rows. Copy comes from lib/messages so the
// vocabulary is a data table, not scattered class strings.
import { msg, type MessageKey } from "@/lib/messages";

export type ChipState =
  | "draft"
  | "registration"
  | "scheduled"
  | "live"
  | "completed"
  | "archived"
  | "frozen";

const CHIP_STYLE: Record<ChipState, string> = {
  draft: "bg-slate-100 text-slate-600",
  registration: "border border-purple-300 bg-white text-purple-700",
  scheduled: "border border-purple-200 bg-purple-50 text-purple-700",
  live: "bg-purple-600 text-white",
  completed: "bg-slate-100 text-slate-500",
  archived: "border border-slate-200 bg-transparent text-slate-400",
  frozen: "bg-sky-100 text-sky-700",
};

const CHIP_KEY: Record<ChipState, MessageKey> = {
  draft: "chip.draft",
  registration: "chip.registration",
  scheduled: "chip.scheduled",
  live: "chip.live",
  completed: "chip.completed",
  archived: "chip.archived",
  frozen: "chip.frozen",
};

/** Sort weight: Live first, then Registration open, Draft, rest (v3/03 §2). */
export const CHIP_SORT: Record<ChipState, number> = {
  live: 0,
  registration: 1,
  scheduled: 2,
  draft: 3,
  completed: 4,
  frozen: 4,
  archived: 5,
};

export function competitionChipState(
  status: string,
  opts: { archived?: boolean } = {},
): ChipState {
  if (opts.archived || status === "archived") return "archived";
  if (status === "live") return "live";
  if (status === "published") return "registration";
  if (status === "completed") return "completed";
  return "draft";
}

export function divisionChipState(
  status: string,
  opts: { archived?: boolean; registrationOpen?: boolean } = {},
): ChipState {
  if (opts.archived) return "archived";
  if (status === "active") return "live";
  if (status === "completed") return "completed";
  if (status === "scheduled") return "scheduled";
  // 'setup' — registration window promotes the chip (the organiser's real state)
  return opts.registrationOpen ? "registration" : "draft";
}

export function StatusChip({ state, className = "" }: { state: ChipState; className?: string }) {
  return (
    <span
      data-chip={state}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${CHIP_STYLE[state]} ${className}`}
    >
      {state === "live" && (
        <span aria-hidden className="chip-pulse-dot h-1.5 w-1.5 rounded-full bg-white" />
      )}
      {msg(CHIP_KEY[state])}
    </span>
  );
}
