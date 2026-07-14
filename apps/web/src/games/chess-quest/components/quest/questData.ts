// Shared quest helpers/constants for the map + card.
import { GameId, Lesson } from "../../content/lessons";

// Lessons run every other day: lesson 1 = Day 1, lesson 2 = Day 3, …
export function dayOf(n: number): number {
  return 2 * n - 1;
}

export const GAME_LABEL: Record<GameId, string> = {
  squareRace: "▶ Play Square Race",
  coinHop: "▶ Play Coin Hop",
  pawnWars: "▶ Play Pawn Wars",
  mateInOne: "▶ Play Mate in 1",
  mateInTwo: "▶ Play Mate in 2",
  hangingHunt: "▶ Play Piece Detective",
  tacticTrainer: "▶ Play Trick Shots",
  rookMaze: "▶ Play Rook Maze",
  openingTrainer: "▶ Play the opening",
};

// The active register's copy for a lesson.
export function lessonCopy(lesson: Lesson, story: boolean): {
  learn: string;
  play: string;
  spark: string;
} {
  return story ? { learn: lesson.learn, play: lesson.play, spark: lesson.spark } : lesson.classic;
}
