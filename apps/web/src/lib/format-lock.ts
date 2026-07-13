// v8 (spec 2026-07-13): a division's format is a setting only until play is
// scheduled. Shared by the Settings tab (render state) and patchDivision's
// guard (409 FORMAT_LOCKED) so UI hiding and API enforcement can't drift.

/** True once any stage owns fixtures — the format is then history. */
export function formatLocked(stages: { fixture_count: number }[]): boolean {
  return stages.some((s) => s.fixture_count > 0);
}
