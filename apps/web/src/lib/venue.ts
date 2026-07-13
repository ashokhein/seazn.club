// The playing area is called different things per sport — a football "pitch",
// a table-tennis "table", a badminton "court", a chess "board". Labels,
// placeholders and default names in the scheduling UI use the right word.

const VENUE_BY_SPORT: Record<string, string> = {
  football: "pitch",
  soccer: "pitch",
  cricket: "pitch",
  rugby: "pitch",
  hockey: "pitch",
  icehockey: "rink",
  tabletennis: "table",
  table_tennis: "table",
  "table-tennis": "table",
  badminton: "court",
  tennis: "court",
  squash: "court",
  padel: "court",
  basketball: "court",
  netball: "court",
  volleyball: "court",
  boardgame: "board",
  chess: "board",
  carrom: "board",
  draughts: "board",
  checkers: "board",
};

/** Singular playing-area noun for a sport (lowercase). Defaults to "court". */
export function venueNoun(sportKey?: string | null): string {
  return VENUE_BY_SPORT[(sportKey ?? "").toLowerCase()] ?? "court";
}

/** Capitalised singular, e.g. "Pitch". */
export function venueLabel(sportKey?: string | null): string {
  const n = venueNoun(sportKey);
  return n.charAt(0).toUpperCase() + n.slice(1);
}
