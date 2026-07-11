/** Club-flavored placeholder names for the home configurator (design/v3/12
 *  §4.4). Deterministic per seed so tests and SSR/CSR agree; the Shuffle
 *  button just passes a new seed. */
const PLACES = [
  "Riverside", "Northside", "Harbour", "Oakwood", "Milltown", "Westgate",
  "Southbank", "Kingsway", "Fernhill", "Redbrick", "Lakeside", "Hillcrest",
  "Eastfield", "Stonebridge", "Maplegrove", "Brookvale",
];
const MASCOTS = [
  "Falcons", "Comets", "Tigers", "Rovers", "Aces", "Smash", "Kings",
  "Arrows", "Titans", "Foxes", "Strikers", "Rockets", "Wolves", "Giants",
  "Chargers", "Rangers",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clubNames(count: number, seed: number): string[] {
  const n = Math.min(Math.max(Math.trunc(count) || 4, 4), 16);
  const rand = mulberry32(seed);
  const places = [...PLACES].sort(() => rand() - 0.5);
  const mascots = [...MASCOTS].sort(() => rand() - 0.5);
  return Array.from({ length: n }, (_, i) => `${places[i]} ${mascots[i]}`);
}
