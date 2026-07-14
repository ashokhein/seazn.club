// Opening mainlines for the Opening Trainer. Each line is 3–5 development plies
// (no castling — the engine doesn't model it, and the setup is the beginner
// takeaway). Every move is verified engine-legal by content/__tests__.

export type OpeningMove = { from: string; to: string; san: string };
export type Opening = {
  id: string;
  name: string;
  learnerSide: "white" | "black";
  line: OpeningMove[]; // full sequence, both sides, in play order
  idea: string;
};

const m = (from: string, to: string, san: string): OpeningMove => ({ from, to, san });

export const OPENINGS: Record<string, Opening> = {
  italian: {
    id: "italian",
    name: "The Italian Game",
    learnerSide: "white",
    line: [
      m("e2", "e4", "e4"),
      m("e7", "e5", "e5"),
      m("g1", "f3", "Nf3"),
      m("b8", "c6", "Nc6"),
      m("f1", "c4", "Bc4"),
      m("f8", "c5", "Bc5"),
    ],
    idea: "Take the centre, aim the bishop at f7, and get ready to castle.",
  },
  ruyLopez: {
    id: "ruyLopez",
    name: "The Ruy Lopez",
    learnerSide: "white",
    line: [
      m("e2", "e4", "e4"),
      m("e7", "e5", "e5"),
      m("g1", "f3", "Nf3"),
      m("b8", "c6", "Nc6"),
      m("f1", "b5", "Bb5"),
      m("a7", "a6", "a6"),
    ],
    idea: "Pin the knight that guards e5 — long-term pressure on Black's centre.",
  },
  scotch: {
    id: "scotch",
    name: "The Scotch Game",
    learnerSide: "white",
    line: [
      m("e2", "e4", "e4"),
      m("e7", "e5", "e5"),
      m("g1", "f3", "Nf3"),
      m("b8", "c6", "Nc6"),
      m("d2", "d4", "d4"),
      m("e5", "d4", "exd4"),
      m("f3", "d4", "Nxd4"),
    ],
    idea: "Blast the centre open early and get a big lead in development.",
  },
  london: {
    id: "london",
    name: "The London System",
    learnerSide: "white",
    line: [
      m("d2", "d4", "d4"),
      m("d7", "d5", "d5"),
      m("g1", "f3", "Nf3"),
      m("g8", "f6", "Nf6"),
      m("c1", "f4", "Bf4"),
    ],
    idea: "A calm, solid setup you can play against almost anything.",
  },
  scandinavian: {
    id: "scandinavian",
    name: "The Scandinavian Defense",
    learnerSide: "black",
    line: [
      m("e2", "e4", "e4"),
      m("d7", "d5", "d5"),
      m("e4", "d5", "exd5"),
      m("d8", "d5", "Qxd5"),
      m("b1", "c3", "Nc3"),
      m("d5", "a5", "Qa5"),
    ],
    idea: "Hit the centre at once as Black — then tuck the queen safely on a5.",
  },
};

export const OPENING_IDS = Object.keys(OPENINGS);
