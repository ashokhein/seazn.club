// Chess Quest lands — transcribed verbatim from the original app
// (chess-quest js/curriculum.js LANDS). 5 Track 1 lands + 4 Track 2 lands.

export type Land = {
  id: number;
  glyph: string;
  name: string;
  weeks: [number, number]; // inclusive lesson range
  goal: string;
  check: string; // Story register
  checkClassic: string; // Classic register
  track?: 2; // present on Track 2 lands only
};

export const LANDS: Land[] = [
  {
    id: 1,
    glyph: "♙",
    name: "Pawn Meadow",
    weeks: [1, 4],
    goal: "The board becomes a familiar place and every piece becomes a character.",
    check: "She sets up the board alone, moves every piece correctly, and wins Pawn Wars sometimes.",
    checkClassic:
      "You set up the board unaided, move every piece correctly, and win Pawn Wars regularly.",
  },
  {
    id: 2,
    glyph: "♘",
    name: "Knight Forest",
    weeks: [5, 8],
    goal: "The moves become a real game: values, check, and how games actually end.",
    check: "She plays a full legal game, castles without reminders, and calls check.",
    checkClassic: "You play a full legal game, castle without prompting, and announce check.",
  },
  {
    id: 3,
    glyph: "♖",
    name: "Rook Mountain",
    weeks: [9, 12],
    goal: "Most kids can start a game; few can finish one. This land is checkmate school.",
    check: "She mates with two rooks and with the queen, and opens by the golden rules.",
    checkClassic: "You mate with two rooks and with the queen, and open by the golden rules.",
  },
  {
    id: 4,
    glyph: "♕",
    name: "Queen Castle",
    weeks: [13, 17],
    goal: "One tactic trick per lesson — every one feels like a magic move.",
    check: "She names forks, pins and skewers, and rarely leaves big pieces hanging.",
    checkClassic: "You name forks, pins and skewers on sight, and rarely hang material.",
  },
  {
    id: 5,
    glyph: "♔",
    name: "King Peak",
    weeks: [18, 24],
    goal: "Everything comes together: her opening, real endgames, and games against other kids.",
    check: "Full careful games with an opening, tactics and endgame finishes. Club-ready!",
    checkClassic:
      "Complete, careful games: an opening plan, tactical awareness, endgame technique. Club-ready.",
  },
  {
    id: 6,
    glyph: "♗",
    name: "Combination Canyon",
    weeks: [25, 30],
    track: 2,
    goal: "Single tricks become chains: forcing moves that plan two steps ahead.",
    check: "She solves mate-in-2s before touching a piece, and her tricks start from safe squares.",
    checkClassic:
      "You solve mate-in-2s in your head and land tactics from squares nobody can punish.",
  },
  {
    id: 7,
    glyph: "♞",
    name: "Opening Harbor",
    weeks: [31, 36],
    track: 2,
    goal: "From memorized moves to real plans: why the Italian pieces go where they go.",
    check: "She reaches a castled, developed position every game and shuts down the f7 raids.",
    checkClassic:
      "You reach a sound middlegame from the Italian every game, and defend the classic traps cold.",
  },
  {
    id: 8,
    glyph: "♜",
    name: "Endgame Glacier",
    weeks: [37, 42],
    track: 2,
    goal: "Cold, precise technique: the endings that decide every close game.",
    check: "She wins K+P with the opposition, holds Philidor’s fence, and builds Lucena’s bridge.",
    checkClassic:
      "You convert K+P endings with the opposition and know both rook-ending walls by name.",
  },
  {
    id: 9,
    glyph: "♛",
    name: "Strategy Summit",
    weeks: [43, 48],
    track: 2,
    goal: "Positions without tactics still have answers: squares, files, structure, and a thinking method.",
    check: "She picks moves from a candidate list, and her own games become her study book.",
    checkClassic:
      "You choose from candidate moves, exploit outposts and files, and mine every game you play for lessons.",
  },
];
