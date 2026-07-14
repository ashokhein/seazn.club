// Random square picking for game generators (port of js/games.js randSquares).
export function randSquares(
  n: number,
  exclude: number[],
  allowed?: ((i: number) => boolean) | null,
): number[] {
  const pool: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (exclude.includes(i)) continue;
    if (allowed && !allowed(i)) continue;
    pool.push(i);
  }
  const out: number[] = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

export function emptyBoard(): string[] {
  return new Array(64).fill("");
}
