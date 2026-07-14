// Star formulas — ported 1:1 from the original games (chess-quest js/games.js).
// Pure so thresholds stay pinned by lib/__tests__/stars.test.ts.

export const STAR_RULES = {
  squareRace(score: number): number {
    return score >= 12 ? 3 : score >= 7 ? 2 : score >= 3 ? 1 : 0;
  },
  // Sliders (R/B/Q) reach coins fast; steppers (N/K/P) get looser pars.
  coinHop(moves: number, piece: string): number {
    const easy = piece !== "N" && piece !== "K" && piece !== "P";
    const s3 = easy ? 9 : 14;
    const s2 = easy ? 13 : 20;
    return moves <= s3 ? 3 : moves <= s2 ? 2 : 1;
  },
  pawnWars(whiteWon: boolean): number {
    return whiteWon ? 3 : 1;
  },
  // Mate-in-1, Mate-in-2 and tier-2 tactics all award on solved count.
  packStars(solved: number): number {
    return solved >= 12 ? 3 : solved >= 8 ? 2 : solved >= 4 ? 1 : 0;
  },
  hangingHunt(solved: number): number {
    return solved >= 8 ? 3 : solved >= 5 ? 2 : solved >= 3 ? 1 : 0;
  },
  // Tier-1 tactics: total across fork+pin+skewer+disco (13 cases).
  tacticTier1(total: number): number {
    return total >= 13 ? 3 : total >= 8 ? 2 : total >= 4 ? 1 : 0;
  },
  rookMaze(moves: number, par: number): number {
    return moves <= par ? 3 : moves <= par + 1 ? 2 : 1;
  },
  // Opening Trainer: clean run 3 stars, a slip or two still 2.
  openingTrainer(mistakes: number): number {
    return mistakes === 0 ? 3 : mistakes <= 2 ? 2 : 1;
  },
};
