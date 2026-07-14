// Certificate title/line by tracks completed (port of js/app.js printCertificate).
export function certTitle(t1: number, t2: number): { title: string; line: string } {
  if (t1 === 24 && t2 === 24) {
    return {
      title: "Chess Quest Champion",
      line: "has completed the entire Chess Quest — all 48 lessons, from the first square to Rising Player strength",
    };
  }
  if (t1 === 24) {
    return {
      title: "First Steps Champion",
      line: "has completed Track 1 “First Steps” — 24 lessons, from the empty board to full, careful games",
    };
  }
  if (t2 === 24) {
    return {
      title: "Rising Player Champion",
      line: "has completed Track 2 “Rising Player” — 24 lessons of combinations, openings, endgames and strategy",
    };
  }
  return {
    title: "Chess Quest Adventurer",
    line: `has bravely conquered ${t1 + t2} of 48 quest days — and the journey continues`,
  };
}
