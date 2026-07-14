// Chess Quest grown-ups drawer — transcribed verbatim from the original app
// (chess-quest js/curriculum.js GROWN_UPS / GROWN_UPS_CLASSIC). Story register
// addresses the coaching parent; Classic register reads as self-coaching.

export type GrownUps = {
  recipe: [string, string][];
  rules: string[];
  toolbox: [string, string][];
  stuck: [string, string][];
};

export const GROWN_UPS: GrownUps = {
  recipe: [
    ["3 min", "Warm-up: one puzzle or “show me how the knight moves”"],
    ["7 min", "One new thing (today’s topic — never two)"],
    ["10 min", "Play a game or mini-game together"],
    ["1 min", "High-five + one thing she did well"],
  ],
  rules: [
    "Let her win about half the time at first — losing every game kills the spark. Shrink the help slowly.",
    "Praise the thinking, not the talent: “I love that you checked if your queen was safe.”",
    "Mistakes are detective clues, never scoldings. Ask “what did that piece want to do?”",
    "Every few days, she teaches you something from the plan. Explaining it is how it sticks.",
    "Speed doesn’t matter. A lesson that takes three tries is still a win. Skip nothing, rush nothing.",
  ],
  toolbox: [
    ["ChessKid", "Kid-safe app: lessons, puzzles, games vs. other kids. Worth the Gold upgrade."],
    ["Lichess", "Free unlimited puzzles; enable kid mode."],
    [
      "Story Time Chess",
      "Board game that teaches pieces through stories — great for the first lessons.",
    ],
    ["No Stress Chess", "Card-guided starter game, perfect bridge to real chess."],
    ["“Chess Is Child’s Play”", "The parent’s handbook for teaching this age."],
  ],
  stuck: [
    ["Stuck on a lesson?", "Repeat it with different mini-games. Never push forward on a shaky topic."],
    ["Bored?", "More playing, less teaching. Add extra rest days before dropping to zero."],
    ["Knight moves won’t click?", "Totally normal — five minutes of Coin Hop any day."],
    ["Loves it?", "Add puzzles, not lectures. Then find her a club — kids her age are rocket fuel."],
  ],
};

// Classic-mode replacement for the grown-ups drawer: the learner IS the
// grown-up, so it reads as a self-coaching guide.
export const GROWN_UPS_CLASSIC: GrownUps = {
  recipe: [
    ["3 min", "Warm-up: one puzzle from a pack you’ve already finished"],
    ["7 min", "One new idea (today’s lesson — never two)"],
    ["10 min", "Play: the mini-game here, or a real game"],
    ["1 min", "Note one thing that worked and one thing to fix"],
  ],
  rules: [
    "Consistency beats bulk: twenty focused minutes every other day outruns a weekend binge.",
    "Blunder-check before every move — the highest-value habit below 1200.",
    "Review every loss for five minutes: find the one move where it turned.",
    "Play slightly stronger opposition. Comfort games don’t teach.",
    "Repeat a lesson until it feels boring. Boring means learned.",
  ],
  toolbox: [
    ["Lichess", "Free unlimited puzzles, analysis board, and rated games at every speed."],
    ["Lichess studies", "Free interactive courses on every endgame and tactic in this quest."],
    ["ChessKid", "If you’re coaching a child alongside your own training."],
    ["A physical board", "Set the diagrams up for real — board vision transfers better from 3D."],
    ["Your own games", "The only opening book that never lies. Save and review them."],
  ],
  stuck: [
    ["Stuck on a lesson?", "Re-run it with the mini-game until you beat par, then move on."],
    ["Bored?", "More playing, less theory. Add one rapid game after each session."],
    ["Blundering pieces?", "Return to Day 33’s blunder-check for a week — it resets fast."],
    ["Hooked?", "Join a club or an online arena. Real opponents are rocket fuel."],
  ],
};
