// Certificate title/line by tracks completed (port of js/app.js printCertificate,
// extended for Track 3 "Opening Range").
export function certTitle(t1: number, t2: number, t3: number): { title: string; line: string } {
  if (t1 === 24 && t2 === 24 && t3 === 5) {
    return {
      title: "Chess Quest Grandmaster",
      line: "has completed the entire Chess Quest — all 53 lessons, from the first square to a real opening repertoire",
    };
  }
  if (t1 === 24 && t2 === 24) {
    return {
      title: "Chess Quest Champion",
      line: "has completed Tracks 1 and 2 — 48 lessons, from the empty board to confident club play",
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
  if (t3 === 5) {
    return {
      title: "Opening Range Champion",
      line: "has completed Track 3 “Opening Range” — five sound openings played by hand",
    };
  }
  return {
    title: "Chess Quest Adventurer",
    line: `has bravely conquered ${t1 + t2 + t3} of 53 quest days — and the journey continues`,
  };
}
