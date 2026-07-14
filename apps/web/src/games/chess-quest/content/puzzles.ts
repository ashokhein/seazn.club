// Chess Quest puzzle packs — transcribed verbatim from the original app
// (chess-quest js/puzzles.js). Every entry is machine-verified by
// content/__tests__/puzzles.test.ts; do not edit data to make tests pass.

export type MatePuzzle = { fen: string; solution: string; name: string; hint: string };
export type HuntPuzzle = { fen: string; answer: string; story: string };
export type TacticPuzzle = { fen: string; solution: string; story: string };

// Mate-in-1 puzzle pack. White to move in every puzzle.
// solution is the move we hint toward; the game accepts ANY legal move
// that delivers checkmate.
export const MATE1: MatePuzzle[] = [
  {
    fen: "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1",
    solution: "e1e8",
    name: "Sneak down the hallway",
    hint: "The back row is wide open — slide all the way!",
  },
  {
    fen: "6k1/5ppp/8/8/8/8/8/3Q2K1 w - - 0 1",
    solution: "d1d8",
    name: "Queen takes the hallway",
    hint: "Same trick, stronger piece.",
  },
  {
    fen: "6k1/8/6K1/8/8/8/8/Q7 w - - 0 1",
    solution: "a1a8",
    name: "The queen's fence",
    hint: "Lock the whole top row. Your king guards the doors.",
  },
  {
    fen: "7k/R7/1R6/8/8/8/8/6K1 w - - 0 1",
    solution: "b6b8",
    name: "The lawnmower",
    hint: "One rook holds the row — the other one finishes the job.",
  },
  {
    fen: "k7/6R1/8/8/8/8/8/5K1R w - - 0 1",
    solution: "h1h8",
    name: "Lawnmower, other side",
    hint: "Rooks take turns. Whose turn is it?",
  },
  {
    fen: "7k/Q7/6K1/8/8/8/8/8 w - - 0 1",
    solution: "a7g7",
    name: "The royal hug",
    hint: "The queen stands right next to the king — bodyguard behind her.",
  },
  {
    fen: "7k/6p1/5N2/8/8/8/8/R5K1 w - - 0 1",
    solution: "a1a8",
    name: "Knight and rook team up",
    hint: "The pony already guards the escape squares.",
  },
  {
    fen: "6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1",
    solution: "g5f7",
    name: "The smother",
    hint: "The king is trapped by his own friends. Who can jump in?",
  },
  {
    fen: "kr6/p7/P7/1N6/8/8/8/6K1 w - - 0 1",
    solution: "b5c7",
    name: "Corner pony",
    hint: "The king's own army boxes him in. One hop ends it.",
  },
  {
    fen: "6rk/6p1/8/8/3Q4/8/8/6K1 w - - 0 1",
    solution: "d4h4",
    name: "The side door",
    hint: "The h-file is a wide-open corridor.",
  },
  {
    fen: "k7/p1K5/1P6/8/8/8/8/8 w - - 0 1",
    solution: "b6b7",
    name: "The little giant",
    hint: "Even the smallest soldier can win the war.",
  },
  {
    fen: "2k5/P7/2K5/8/8/8/8/8 w - - 0 1",
    solution: "a7a8",
    name: "Crowned!",
    hint: "Walk one more step and the pawn becomes a queen — with checkmate!",
  },
  {
    fen: "k7/p7/2K5/8/8/8/8/1Q6 w - - 0 1",
    solution: "b1b7",
    name: "The bodyguard queen",
    hint: "Stand right next to the king — your own king protects you.",
  },
  {
    fen: "5k2/8/5K2/8/8/8/8/7R w - - 0 1",
    solution: "h1h8",
    name: "Box on the edge",
    hint: "Your king blocks the whole row below. Slide across the top!",
  },
  {
    fen: "4k3/4p3/4K3/8/8/8/8/7R w - - 0 1",
    solution: "h1h8",
    name: "Trapped in the middle",
    hint: "His own pawn is in the way — and your king does the rest.",
  },
  {
    fen: "k7/8/8/8/7R/8/1R6/6K1 w - - 0 1",
    solution: "h4a4",
    name: "Ladder lying down",
    hint: "The ladder works sideways too. One rook holds the b-file…",
  },
  {
    fen: "3k4/8/3K4/8/8/8/8/Q7 w - - 0 1",
    solution: "a1a8",
    name: "Queen slam",
    hint: "The kings are staring at each other. Slam the back row!",
  },
  {
    fen: "6k1/6p1/6P1/8/8/8/8/R5K1 w - - 0 1",
    solution: "a1a8",
    name: "Pawn locks the gate",
    hint: "Your little pawn guards both escape doors already.",
  },
];

// Hanging-piece positions for the Piece Detective game. White to move;
// exactly one black piece (never the king) is attacked and undefended.
// Uniqueness is machine-verified by the tests.
export const HUNTS: HuntPuzzle[] = [
  {
    fen: "6k1/3n1ppp/8/8/8/8/8/3Q2K1 w - - 0 1",
    answer: "d7",
    story: "The queen stares down the d-file. Someone forgot their bodyguard…",
  },
  {
    fen: "6k1/1p2bppp/n7/8/8/8/8/4R1K1 w - - 0 1",
    answer: "e7",
    story: "One black piece has a friend nearby. The other is all alone.",
  },
  {
    fen: "6k1/5ppp/8/1q6/8/2N5/8/6K1 w - - 0 1",
    answer: "b5",
    story: "Even a queen can be free stuff if nobody guards her!",
  },
  {
    fen: "2r3k1/5ppp/8/8/8/7B/8/6K1 w - - 0 1",
    answer: "c8",
    story: "The bishop peeks all the way down the long diagonal.",
  },
  {
    fen: "6k1/5ppp/8/3n4/2P5/8/8/6K1 w - - 0 1",
    answer: "d5",
    story: "The littlest attacker! Pawns love catching big ponies.",
  },
  {
    fen: "6k1/5ppp/8/8/8/2r5/8/2R3K1 w - - 0 1",
    answer: "c3",
    story: "Two rooks on one road — but only one of them is safe.",
  },
  {
    fen: "3b2k1/5ppp/8/8/8/8/3R4/3R2K1 w - - 0 1",
    answer: "d8",
    story: "Double trouble on the d-file. The bishop never saw it coming.",
  },
  {
    fen: "6k1/5ppp/2n5/8/3N4/8/8/6K1 w - - 0 1",
    answer: "c6",
    story: "Pony vs. pony! One of them wandered too far from home.",
  },
];

// Trick Shots packs. White to move; playing the solution (or any move that
// pulls off the same trick — the engine judges) wins the case.
export const TACTICS: Record<"fork" | "pin" | "skewer" | "disco", TacticPuzzle[]> = {
  fork: [
    {
      fen: "r3k3/8/8/1N6/8/8/8/6K1 w - - 0 1",
      solution: "b5c7",
      story: "The pony sees the king AND the rook. One hop, two dinners!",
    },
    {
      fen: "6k1/8/8/2n1n3/8/3P4/8/6K1 w - - 0 1",
      solution: "d3d4",
      story: "The littlest soldier can poke two ponies at once.",
    },
    {
      fen: "6k1/1n6/8/8/8/8/8/3Q2K1 w - - 0 1",
      solution: "d1d5",
      story: "Find the magic square where the queen shouts CHECK and grabs the pony next turn.",
    },
    {
      fen: "2k1q3/8/8/8/2N5/8/8/6K1 w - - 0 1",
      solution: "c4d6",
      story: "The royal family fork — king and queen on one fork. The fanciest trick in chess!",
    },
  ],
  pin: [
    {
      fen: "4k3/8/2n5/8/8/8/8/5BK1 w - - 0 1",
      solution: "f1b5",
      story: "Freeze the pony! If it moves, the king behind it is in trouble.",
    },
    {
      fen: "3k4/8/8/3q4/8/8/8/R3K3 w - - 0 1",
      solution: "a1d1",
      story: "Pin the queen to her king. If she takes you, your king takes her back!",
    },
    {
      fen: "k7/8/2q5/8/2B2N2/8/8/6K1 w - - 0 1",
      solution: "c4d5",
      story: "The bishop lines up queen and king. Your pony guards the landing spot.",
    },
  ],
  skewer: [
    {
      fen: "4r3/8/8/4k3/8/8/8/R5K1 w - - 0 1",
      solution: "a1e1",
      story: "Check! The king must step aside — and look what was hiding behind him.",
    },
    {
      fen: "q7/8/8/3k4/8/8/4B3/6K1 w - - 0 1",
      solution: "e2f3",
      story: "A shish-kebab on the long diagonal: king in front, queen behind.",
    },
    {
      fen: "4q3/8/4k3/8/8/8/8/3Q2K1 w - - 0 1",
      solution: "d1e2",
      story: "Queens face off — but their king is standing in the middle of the road.",
    },
  ],
  disco: [
    {
      fen: "4k3/8/8/8/4N3/8/8/4R1K1 w - - 0 1",
      solution: "e4d6",
      story: "Move the pony and — surprise! — the rook behind him was aiming all along.",
    },
    {
      fen: "3k4/8/8/3B4/8/8/8/3R2K1 w - - 0 1",
      solution: "d5c6",
      story: "The bishop steps off the road and the rook thunders down it.",
    },
    {
      fen: "6k1/8/8/3P4/8/8/B7/6K1 w - - 0 1",
      solution: "d5d6",
      story: "Even a tiny pawn step can open the curtain for the archer.",
    },
  ],
};

// Mate-in-2 pack (Track 2). White to move; the engine accepts ANY move that
// forces mate in two (isMateIn2After), then plays black's toughest defense.
// Every entry is machine-verified: no mate-in-1 exists, and the solution
// forces mate against every reply.
export const MATE2: MatePuzzle[] = [
  {
    fen: "8/7k/R7/1R6/8/8/8/6K1 w - - 0 1",
    solution: "b5b7",
    name: "The ladder, one rung early",
    hint: "Check on the 7th row first — then the back row slams shut.",
  },
  {
    fen: "8/k7/7R/6R1/8/8/8/6K1 w - - 0 1",
    solution: "g5g7",
    name: "Ladder from the left",
    hint: "Same ladder, other side. Which rook gives the check?",
  },
  {
    fen: "8/7k/R7/1Q6/8/8/8/6K1 w - - 0 1",
    solution: "b5b7",
    name: "Queen joins the ladder",
    hint: "The queen takes the 7th row — the rook finishes on the 8th.",
  },
  {
    fen: "7k/8/8/4K3/8/8/6Q1/8 w - - 0 1",
    solution: "e5f6",
    name: "The king lends a hand",
    hint: "A quiet king step first. Then the queen lands right next door.",
  },
  {
    fen: "k7/8/2K5/8/8/8/4Q3/8 w - - 0 1",
    solution: "c6b6",
    name: "Walk, then strike",
    hint: "March your king one step closer — the queen sweeps the back row.",
  },
  {
    fen: "7k/5K2/6P1/6P1/8/8/8/8 w - - 0 1",
    solution: "g6g7",
    name: "Crowning with check",
    hint: "Push! The brand-new queen arrives with checkmate — the little brother guards the exit.",
  },
  {
    fen: "k7/2K5/1P6/1P6/8/8/8/8 w - - 0 1",
    solution: "b6b7",
    name: "Coronation corner",
    hint: "One more pawn step. Where does the king have to go?",
  },
  {
    fen: "4k3/8/8/8/8/8/1R6/R5K1 w - - 0 1",
    solution: "b2b7",
    name: "Cut, then slam",
    hint: "First cut off the 7th row — no check needed. Then slam the 8th.",
  },
  {
    fen: "8/2K5/8/8/1Q6/R7/7k/8 w - - 0 1",
    solution: "b4b2",
    name: "Ladder, going down",
    hint: "The ladder works downhill too. Queen checks, rook finishes.",
  },
  {
    fen: "7k/8/8/6K1/8/8/8/R7 w - - 0 1",
    solution: "g5g6",
    name: "Shoulder to shoulder",
    hint: "Step your king up close first. Then the rook delivers the letter.",
  },
  {
    fen: "k7/8/8/1K6/8/8/8/7R w - - 0 1",
    solution: "b5b6",
    name: "Cornered by teamwork",
    hint: "King to b6 takes every door away. The rook does the rest.",
  },
  {
    fen: "k7/2K5/8/1P5p/3B4/8/8/8 w - - 0 1",
    solution: "b5b6",
    name: "The quiet squeeze",
    hint: "No check at all! Take away the last free square and wait one move.",
  },
];

// Tier-2 Trick Shots (Track 2): same detectors, trickier boards — poisoned
// squares, defended targets, double threats. Verified like TACTICS.
export const TACTICS2: Record<"fork2" | "pin2" | "skewer2" | "disco2", TacticPuzzle[]> = {
  fork2: [
    {
      fen: "4q1k1/5p1p/8/3N4/8/8/8/6K1 w - - 0 1",
      solution: "d5f6",
      story: "The pony leaps in with CHECK — and lands on the queen's fork too!",
    },
    {
      fen: "r5k1/6pp/8/8/8/8/8/3Q2K1 w - - 0 1",
      solution: "d1d5",
      story: "One magic square sees two windows: the king down one diagonal, the rook down the other.",
    },
    {
      fen: "4k3/8/8/6p1/R6b/8/8/6K1 w - - 0 1",
      solution: "a4e4",
      story: "Don't grab the guarded bishop — slide to the crossroads and fork it with the king!",
    },
  ],
  pin2: [
    {
      fen: "1k6/pp6/3q4/8/7B/8/7P/6K1 w - - 0 1",
      solution: "h4g3",
      story: "Tuck the bishop behind your own pawn — now the queen is frozen to her king.",
    },
    {
      fen: "q3k3/3p4/2n5/8/8/8/4B3/6K1 w - - 0 1",
      solution: "e2f3",
      story: "The long diagonal! Freeze the pony to the queen hiding in the corner.",
    },
    {
      fen: "6k1/6pp/4r3/8/8/8/8/2Q3K1 w - - 0 1",
      solution: "c1c4",
      story: "Pin the rook from the side — it can't step off the king's diagonal.",
    },
  ],
  skewer2: [
    {
      fen: "8/pr6/8/3k4/8/7B/8/6K1 w - - 0 1",
      solution: "h3g2",
      story: "Check from the corner pocket! The king must step aside — his rook was hiding behind.",
    },
    {
      fen: "4r2k/7p/8/4q3/8/8/8/R4K2 w - - 0 1",
      solution: "a1e1",
      story: "Poke the queen down the open file. When she runs, grab what stood behind her.",
    },
    {
      fen: "8/8/5kp1/8/8/8/1q6/6KQ w - - 0 1",
      solution: "h1h8",
      story: "The longest skewer in chess: corner to corner, king in front, queen behind.",
    },
  ],
  disco2: [
    {
      fen: "6k1/3q1p1p/8/8/6N1/8/8/6RK w - - 0 1",
      solution: "g4f6",
      story: "The pony jumps away, the rook shouts CHECK — and the pony pokes the queen. Double magic!",
    },
    {
      fen: "3k4/5p2/8/8/8/3B4/8/3Q2K1 w - - 0 1",
      solution: "d3b5",
      story: "Step the bishop aside with a threat — the queen was aiming down the road all along.",
    },
    {
      fen: "3r2k1/7p/4P3/8/8/1B6/8/6K1 w - - 0 1",
      solution: "e6e7",
      story: "One tiny pawn step: the bishop checks the king AND the pawn attacks the rook!",
    },
  ],
};
