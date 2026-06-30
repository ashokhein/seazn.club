import type { ResultMode, TournamentFormat } from "@/lib/types";

/**
 * Whether the progress-score tiebreaker is meaningful for this configuration.
 * It only applies to win/loss league stages (not score entry or pure knockout).
 */
export function supportsProgressScore(opts: {
  result_mode: ResultMode;
  format: TournamentFormat;
}): boolean {
  return opts.result_mode === "win_loss" && opts.format !== "knockout";
}
