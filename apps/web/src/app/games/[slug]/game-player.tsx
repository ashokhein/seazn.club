"use client";

import { PLAYER_MAP } from "@/games/player-map";

export function GamePlayer({ slug }: { slug: string }) {
  const Game = PLAYER_MAP[slug];
  // A live registry entry without a PLAYER_MAP entry is a wiring bug —
  // the games-player-map unit test guards it; render nothing rather than crash.
  if (!Game) return null;
  return <Game />;
}
