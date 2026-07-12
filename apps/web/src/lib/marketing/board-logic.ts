/** Pure state for the /scheduling demo board (design/v3/12 §5). The clash
 *  rule is the concept the real board enforces (one court, one fixture at a
 *  time), kept client-side — no backend. */
export interface BoardState {
  tray: string[];
  courts: Array<{ placed: string[]; clash: boolean }>;
}

export function createBoard(fixtures: string[], courts: number): BoardState {
  return {
    tray: [...fixtures],
    courts: Array.from({ length: courts }, () => ({ placed: [], clash: false })),
  };
}

export function place(state: BoardState, fixtureIdx: number, court: number): BoardState {
  const fixture = state.tray[fixtureIdx];
  const target = state.courts[court];
  if (fixture === undefined || target === undefined) return state;
  const courts = state.courts.map((c, i) =>
    i === court ? { placed: [...c.placed, fixture], clash: c.placed.length + 1 > 1 } : c,
  );
  return { tray: state.tray.filter((_, i) => i !== fixtureIdx), courts };
}

export function isFull(state: BoardState): boolean {
  return state.tray.length === 0 && state.courts.every((c) => !c.clash);
}
