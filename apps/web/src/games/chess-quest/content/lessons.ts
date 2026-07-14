// Chess Quest lessons — transcribed verbatim from the original app
// (chess-quest js/curriculum.js WEEKS, renamed LESSONS). 48 lessons:
// Track 1 = 1–24, Track 2 "Rising Player" = 25–48. Both copy registers
// (Story for kids, Classic for adult learners) carried over unchanged.

export type GameId =
  | "squareRace"
  | "coinHop"
  | "pawnWars"
  | "mateInOne"
  | "mateInTwo"
  | "hangingHunt"
  | "tacticTrainer"
  | "rookMaze"
  | "openingTrainer";

export type LessonCopy = { learn: string; play: string; spark: string };

export type Lesson = {
  n: number; // 1..48
  land: number; // owning land id (1..9)
  title: string;
  game: GameId | null; // null = play on a real board
  gameOpts?: { pieces?: string[]; pack?: string; opening?: string };
  learn: string;
  play: string;
  spark: string; // Story register
  classic: LessonCopy; // Classic register
  diagram?: { fen: string; from?: string; caption: string };
};

export const LESSONS: Lesson[] = [
  {
    n: 1,
    land: 1,
    title: "Board Land",
    game: "squareRace",
    learn:
      "Light and dark squares, files a–h, ranks 1–8, diagonals. Set up the board with “white square on the right.”",
    play: "Square Race: someone calls “e4!” and she taps it fast. Then a board-setup race against the clock.",
    spark:
      "The board is a kingdom map. Let her name the four corner squares — they’re her watchtowers.",
    classic: {
      learn:
        "Light and dark squares, files a–h, ranks 1–8, diagonals. Set up with “white square on the right”, queen on her own color.",
      play: "Square Race until naming any square is instant, then a timed board-setup drill.",
      spark:
        "Coordinates are the language of every book, video and engine — make them automatic, not “pretty sure”.",
    },
  },
  {
    n: 2,
    land: 1,
    title: "Rooks & Bishops",
    game: "rookMaze",
    gameOpts: { pieces: ["R", "B"] },
    learn:
      "Rooks slide in straight lines; bishops slide diagonally and live on one color forever. Sliders can never jump over anything.",
    play: "Rook Maze: the prize hides behind walls, so slide AROUND them and catch it in as few moves as you can. Bishop mode too!",
    spark: "Rook is a tower on wheels; bishop is the zig-zag runner who can’t step off his color.",
    classic: {
      learn:
        "Rooks move on files and ranks; bishops on diagonals, locked to one color forever. Sliders never jump.",
      play: "Rook Maze in both modes — plan the whole detour before touching the piece.",
      spark:
        "Count controlled squares, not vibes: a rook on an open file and a bishop on a long diagonal are worth more than their price tags.",
    },
    diagram: {
      fen: "8/8/8/3R4/8/8/8/8 w - - 0 1",
      from: "d5",
      caption: "Every square the rook can slide to — until a wall gets in the way.",
    },
  },
  {
    n: 3,
    land: 1,
    title: "Queen & Knight",
    game: "coinHop",
    gameOpts: { pieces: ["N", "Q"] },
    learn:
      "Queen = rook powers + bishop powers. Knight hops in an L and is the only piece that jumps. Count out loud: “one, two, turn.”",
    play: "Knight Coin Hop — the pony collects every coin. Then queen vs. eight pawns on the real board.",
    spark:
      "The knight is a pony that jumps fences. Knights take the most practice — extra hops for a few days is normal.",
    classic: {
      learn:
        "Queen = rook + bishop combined. The knight jumps in an L and is the only piece that leaps. Learn its eight-square wheel.",
      play: "Coin Hop with knight, then queen — fewest moves wins.",
      spark:
        "Knight routes reward calculation: pick the target square first, then find the two-hop path backwards.",
    },
    diagram: {
      fen: "8/8/8/4N3/8/8/8/8 w - - 0 1",
      from: "e5",
      caption: "The knight’s eight secret landing spots.",
    },
  },
  {
    n: 4,
    land: 1,
    title: "Pawns & the King",
    game: "pawnWars",
    learn:
      "Pawns walk one step (two from home), capture diagonally, and promote at the end. The king steps one square and can never be captured.",
    play: "Pawn Wars, lots of it: pawns only, first to promote wins. It secretly teaches captures, races and planning.",
    spark:
      "Every pawn dreams of becoming a queen. Cheer out loud the first time one of hers makes it.",
    classic: {
      learn:
        "Pawns: one step (two from home), capture diagonally, promote on the last rank. The king steps one square and can never be captured.",
      play: "Pawn Wars — races, captures, breakthroughs; first promotion wins.",
      spark: "Pawn structure starts here. Every push is permanent, so push with a reason.",
    },
  },
  {
    n: 5,
    land: 2,
    title: "Piece Prices",
    game: "coinHop",
    gameOpts: { pieces: ["Q", "R", "B", "N", "K"] },
    learn:
      "Pawn 1, knight 3, bishop 3, rook 5, queen 9. A good trade wins points; a bad trade loses them.",
    play: "Capture battles with mixed pieces on the real board. After every trade, count the points out loud together.",
    spark:
      "Pieces cost candy: never pay nine candies to get one. She’ll never forget the queen costs nine.",
    classic: {
      learn:
        "Pawn 1, knight 3, bishop 3, rook 5, queen 9. Every trade is arithmetic — count before you take.",
      play: "Mixed capture battles on a real board; total the material after every trade.",
      spark: "Most club games are decided by one bad trade. Count, then move.",
    },
  },
  {
    n: 6,
    land: 2,
    title: "Check!",
    game: null,
    learn:
      "Check means the king is attacked. Three escapes: run (move the king), shield (block), or fight (capture the attacker).",
    play: "Set up check positions on the real board and let her find all the escapes. She announces “check!” politely in every game.",
    spark: "Run, shield, or fight — let her pick which superhero move fits each puzzle.",
    classic: {
      learn:
        "Check means the king is attacked. Three answers, always: move the king, block, or capture the attacker.",
      play: "Set up check positions and enumerate every legal answer before choosing one.",
      spark:
        "Strong players test the three answers in the same order every time. Build the routine now.",
    },
  },
  {
    n: 7,
    land: 2,
    title: "Checkmate vs. the Sneaky Tie",
    game: "mateInOne",
    learn:
      "Checkmate: the king is attacked and has no escape — game over. Stalemate: not in check but no legal moves — a draw that steals wins.",
    play: "Her first mate-in-1 puzzles right here on this page, plus a “mate or stalemate?” quiz on the real board.",
    spark: "Stalemate is the sneaky trap. Make her the trap detective who spots it before it happens.",
    classic: {
      learn:
        "Checkmate: attacked with no legal answer. Stalemate: NOT attacked but no legal move — a draw that rescues lost positions.",
      play: "The mate-in-1 pack here, plus a “mate or stalemate?” quiz on a real board.",
      spark:
        "When you're up huge material, stalemate is the only way to drop the half point. Leave the defending king one legal square until the net is closed.",
    },
  },
  {
    n: 8,
    land: 2,
    title: "Secret Moves + First Real Game",
    game: "pawnWars",
    learn:
      "Castling — the king’s one-time safety jump with the rook. En passant, quickly and lightly. Promotion recap.",
    play: "Her first full game, start to finish, with you playing gently. Castle in every game from now on.",
    spark: "Take a photo of game #1 and start a post-game high-five ritual, win or lose.",
    classic: {
      learn:
        "Castling — the one-time king-safety move, with both legality rules. En passant, briefly. Promotion recap.",
      play: "A full slow game, start to finish. Castle by move ten in every game from now on.",
      spark:
        "Uncastled kings lose to the tactics coming in Land 4. Make castling a habit, not a decision.",
    },
  },
  {
    n: 9,
    land: 3,
    title: "The Lawnmower",
    game: "mateInOne",
    learn:
      "The two-rook ladder mate: rooks take turns pushing the lonely king back, row by row, to the edge.",
    play: "King + two rooks vs. king on the real board until it’s easy, then race a two-minute timer. Ladder puzzles here too.",
    spark: "The rooks mow the lawn, one row at a time. Vroom.",
    classic: {
      learn: "The two-rook ladder: alternate rank cuts and walk the lone king to the edge.",
      play: "K+2R vs K on a real board until it takes under a minute, then the ladder puzzles here.",
      spark:
        "When the king attacks a rook, shift that rook to the far side of the board — the ladder keeps working.",
    },
    diagram: {
      fen: "7k/R7/1R6/8/8/8/8/6K1 w - - 0 1",
      caption: "The ladder: one rook holds a row, the other pushes the king back.",
    },
  },
  {
    n: 10,
    land: 3,
    title: "The Queen’s Box",
    game: "mateInOne",
    learn:
      "King + queen vs. king: the queen shrinks the box around the enemy king, her king walks over to help finish. Watch out for stalemate!",
    play: "Repetitions from different corners. Bonus point every time she pauses to ask “is this stalemate?” before moving.",
    spark: "The queen builds the fence; the king closes the gate.",
    classic: {
      learn:
        "K+Q vs K: shrink the box, bring your king to help, mate on the edge — and know the stalemate trap.",
      play: "Repetitions from all four corners. Ask “stalemate?” before every queen move.",
      spark:
        "Keep the queen a knight's move from the cornered king: perfect box, zero stalemate risk.",
    },
  },
  {
    n: 11,
    land: 3,
    title: "Puzzle Storm",
    game: "mateInOne",
    learn: "Mate-in-1 with every piece — queen, rook, bishop, knight, even a pawn.",
    play: "Five to ten puzzles a day: the pack here, plus ChessKid or Lichess. Start a puzzle sticker chart.",
    spark: "Beat-your-own-record days: how many puzzles solved by Sunday?",
    classic: {
      learn:
        "Mate-in-1 with every piece — queen, rook, bishop, knight, pawn. Pattern speed is real strength.",
      play: "Five to ten puzzles a day, here or on Lichess. Track the streak.",
      spark:
        "Volume beats difficulty right now: easy mates build the pattern library that hard combinations draw on later.",
    },
  },
  {
    n: 12,
    land: 3,
    title: "Five Golden Opening Rules",
    game: "squareRace",
    learn:
      "1) Fight for the center. 2) Knights and bishops out. 3) Castle early. 4) Queen stays home early. 5) Don’t move the same piece twice.",
    play: "Full games where every golden rule she follows scores a point — she can win the points even if she loses the game.",
    spark: "“Wake up the whole army before the battle.” Sleeping bishops lose wars.",
    classic: {
      learn:
        "1) Fight for the center. 2) Develop knights and bishops. 3) Castle early. 4) Keep the queen modest. 5) Don't move the same piece twice.",
      play: "Play full games scored on rule-following, not results.",
      spark: "Every opening you will ever study is these five rules with move orders attached.",
    },
  },
  {
    n: 13,
    land: 4,
    title: "The Fork",
    game: "tacticTrainer",
    gameOpts: { pack: "fork" },
    learn: "One piece attacks two things at once — the opponent can only save one.",
    play: "Fork puzzles, especially knight forks. Hunt for the famous “royal fork” — king and queen at the same time.",
    spark: "The knight pokes two dinners with one fork. Which one gets eaten?",
    classic: {
      learn:
        "One piece attacks two targets at once — only one can be saved. Knights fork best; pawns fork cheapest.",
      play: "The fork pack here, then hunt double attacks in your own games.",
      spark:
        "Before each move ask: from its new square, what does this piece attack — one thing, or two?",
    },
    diagram: {
      fen: "3q3k/8/4N3/8/8/8/8/6K1 w - - 0 1",
      from: "e6",
      caption: "Knight on e6 hits the king AND the queen. Royal fork!",
    },
  },
  {
    n: 14,
    land: 4,
    title: "The Pin",
    game: "tacticTrainer",
    gameOpts: { pack: "pin" },
    learn:
      "A piece can’t move because something more precious hides behind it. Pinned pieces are frozen.",
    play: "Pin puzzles, then games where she shouts “frozen!” whenever she pins one of your pieces.",
    spark: "Freeze tag, chess edition.",
    classic: {
      learn:
        "A piece that can't move because something more valuable stands behind it. Absolute pins (king behind) are laws; relative pins are advice.",
      play: "The pin pack, then pile attackers onto pinned pieces in your games — they can't run.",
      spark: "A pinned piece is a fake defender: count it out when calculating captures.",
    },
  },
  {
    n: 15,
    land: 4,
    title: "The Skewer",
    game: "tacticTrainer",
    gameOpts: { pack: "skewer" },
    learn:
      "The pin’s big sister: attack the precious piece in front so it must run, then grab what was hiding behind it.",
    play: "Skewer puzzles, plus “pin or skewer?” — she names which trick each position shows.",
    spark: "A shish-kebab: two pieces on one stick.",
    classic: {
      learn:
        "The pin reversed: attack the valuable piece in front so it must move, then take what stood behind it.",
      play: "The skewer pack, plus “pin or skewer?” naming drills.",
      spark: "King and queen on one line is a skewer alarm. Scan every check for what it exposes.",
    },
  },
  {
    n: 16,
    land: 4,
    title: "Discovered Attack",
    game: "tacticTrainer",
    gameOpts: { pack: "disco" },
    learn:
      "Move one piece and — surprise! — the piece behind it attacks. Two threats from one move.",
    play: "Discovered attack and discovered check puzzles. These feel like actual magic.",
    spark: "The curtain opens and the archer was hiding behind it all along.",
    classic: {
      learn:
        "Move one piece and the piece behind it attacks — two threats in a single tempo. Discovered check is nearly unanswerable.",
      play: "The discovery pack. The moving piece can go anywhere — send it to its most annoying square.",
      spark:
        "Batteries (rook+rook, bishop+queen) are stored discoveries. Build them and the tactic plays itself.",
    },
  },
  {
    n: 17,
    land: 4,
    title: "The Free-Stuff Detector",
    game: "hangingHunt",
    learn:
      "Before every move, two questions: “Is my piece safe there?” and “Is anything free to take?” This habit beats everything else at this age.",
    play: "Games with a slow-move rule: hand hovers, both questions out loud, then move.",
    spark: "Award an official Free-Stuff Detector badge once she catches you hanging a piece.",
    classic: {
      learn:
        "The blunder-check: after choosing a move — is my piece safe there? Did they just leave anything loose?",
      play: "Slow games with a hover rule: both questions answered before the hand commits.",
      spark:
        "Below 1200 this routine is worth more rating points than any opening study. It is most of the game.",
    },
  },
  {
    n: 18,
    land: 5,
    title: "Stop the Four-Move Trick",
    game: null,
    learn:
      "Scholar’s Mate — the four-move queen-and-bishop attack on f7 that beats every unprepared kid. See it coming, shut it down.",
    play: "You try the four-move trick in every game until blocking it is automatic.",
    spark:
      "f7 is the castle’s weak gate. She’s the guard who never falls for it — a superpower at school chess club.",
    classic: {
      learn:
        "Scholar's Mate — the four-move queen-and-bishop strike on f7 — and its calm refutations.",
      play: "Defend against it until automatic, then punish the early queen with developing moves.",
      spark:
        "An early queen loses time. Chase her with development and you win the opening for free.",
    },
  },
  {
    n: 19,
    land: 5,
    title: "Her First Opening",
    game: "openingTrainer",
    gameOpts: { opening: "italian" },
    learn:
      "One recipe, both colors. White: e4, knight f3, bishop c4, castle (the Italian Game). Black against e4: mirror it.",
    play: "The same opening in every game. No memorizing — just a familiar, safe start.",
    spark: "Make her an illustrated “opening recipe card” to keep next to the board.",
    classic: {
      learn:
        "One opening recipe, both colors. White: e4, Nf3, Bc4, castle — the Italian Game. Black vs e4: mirror it.",
      play: "The same opening every game. Ideas over memorization: center, pressure on f7, king safety.",
      spark: "One opening played fifty times teaches more than five openings played ten.",
    },
    diagram: {
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1",
      caption: "The Italian Game: both sides developed, ready to castle.",
    },
  },
  {
    n: 20,
    land: 5,
    title: "The Pawn Race",
    game: "pawnWars",
    learn:
      "King + pawn vs. king: the king walks in front of his pawn as a bodyguard and escorts it to promotion. First taste of the kings’ staring contest (opposition).",
    play: "King-and-pawn endings from both sides on the real board; Pawn Wars rematches here.",
    spark: "The bodyguard king walks the little pawn all the way home to be crowned.",
    classic: {
      learn:
        "K+P vs K: the king escorts from IN FRONT of its pawn; the opposition decides. Rook pawns draw.",
      play: "Play both sides until conversion is automatic; Pawn Wars rematches here.",
      spark:
        "Opposition — kings facing, one square between, opponent to move — decides most pawn endings. Learn to count it.",
    },
  },
  {
    n: 21,
    land: 5,
    title: "Winning the Won Game",
    game: "hangingHunt",
    learn:
      "When ahead in points: trade pieces, keep pawns, push the passed pawn. Simpler board = safer win.",
    play: "Start positions where she’s up a rook and must convert the win. Being winning and actually winning are different skills.",
    spark: "“You have a full wallet — stop shopping, walk to the checkout.”",
    classic: {
      learn:
        "Ahead in material: trade pieces (not pawns), activate the king, push the passed pawn.",
      play: "Start up a rook and convert against real resistance.",
      spark:
        "Won positions don't win themselves. Simplify into an ending you already mastered — ladder, box, or escort.",
    },
  },
  {
    n: 22,
    land: 5,
    title: "Think Like a Champ",
    game: "mateInOne",
    learn:
      "The champion’s checklist before every move: Checks, Captures, Threats — mine and theirs. Plus simple notation, so she can write “e4!” like the pros.",
    play: "One slow game with the checklist said out loud both ways. She writes her first scoresheet.",
    spark: "Her own scorebook. Game #1 goes on the fridge.",
    classic: {
      learn:
        "Checks, captures, threats — theirs and yours — before every move. Plus simple algebraic notation.",
      play: "One notated slow game with the checklist spoken aloud both ways.",
      spark: "Notation turns every game into study material. Your losses become your best textbook.",
    },
  },
  {
    n: 23,
    land: 5,
    title: "Game Day",
    game: null,
    learn:
      "Tournament manners: handshake before and after, touch-move, no takebacks, gracious in victory and defeat.",
    play: "Real games against other kids — ChessKid online, school chess club, or a local club’s kids’ night.",
    spark:
      "Pick a chess hero together — show her Judit Polgár, the girl who grew up to beat world champions.",
    classic: {
      learn:
        "Tournament habits: touch-move, clocks, handshakes, recording results — and composure either way.",
      play: "Real opponents: a club evening or online rapid games.",
      spark: "Play up. Losing to stronger players teaches faster than beating weaker ones.",
    },
  },
  {
    n: 24,
    land: 5,
    title: "Boss Battle & Crown",
    game: "mateInOne",
    learn: "Review her favorite tricks from the whole quest — she picks the highlights.",
    play: "A best-of-three match against you, playing honestly (spot her a piece if needed). Then celebrate, whatever the score.",
    spark:
      "Print a certificate: “Chess Quest Champion.” Then plan the next adventure — a rated tournament, club membership, or coaching.",
    classic: {
      learn:
        "Review the whole track — assemble your personal highlight reel of patterns that won you games.",
      play: "A best-of-three match, full rules, notated, then an honest review together.",
      spark:
        "Finish here, then start Track 2: the climb from “knows the moves” to “wins on purpose”.",
    },
  },

  /* ---- Track 2: Rising Player (lessons 25–48, Days 49–95) ---- */
  {
    n: 25,
    land: 6,
    title: "Forcing Moves: Mate in 2",
    game: "mateInTwo",
    learn:
      "A forcing move leaves the enemy almost no answers: checks first, captures second, big threats third. Mate-in-2 is forcing moves in a chain: your check, their only reply, your mate.",
    play: "The new Mate in 2 pack. Say the whole plan out loud BEFORE touching a piece: “I check here, the king must go there, then I mate.”",
    spark:
      "You’re not finding a move anymore — you’re telling the future. Two moves ahead is real wizard stuff.",
    classic: {
      learn:
        "Forcing moves — checks, captures, threats — cut the reply tree down to almost nothing. A mate-in-2 is a forced line: your move, every defense, your mate.",
      play: "The Mate in 2 pack. Calculate the full line before touching a piece; moving first is guessing.",
      spark:
        "“I go here, he must go there, I mate” — that sentence, said before you move, is the core skill of all calculation.",
    },
  },
  {
    n: 26,
    land: 6,
    title: "The Back-Rank Story",
    game: "mateInTwo",
    learn:
      "A castled king behind his own pawns is safe from everything — except a rook or queen crashing through the back door. Cut the row, then slam it.",
    play: "Back-rank mates in the Mate in 2 pack, then real-board setups: when does the king need a “window” (a pawn moved to let him breathe)?",
    spark: "The king’s pawn shield is also his prison. You’re the one holding the key.",
    classic: {
      learn:
        "The castled king’s pawn shield is also a trap: back-rank mates win more club games than any other pattern. Learn both sides — attack it, and make luft in time.",
      play: "Back-rank puzzles in the Mate in 2 pack, then check every game: does either king need luft right now?",
      spark:
        "Before simplifying into “safe” positions, count the defenders of the back rank. Most one-move blunders live there.",
    },
    diagram: {
      fen: "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1",
      from: "e1",
      caption: "The back door is wide open — the pawn shield became a prison.",
    },
  },
  {
    n: 27,
    land: 6,
    title: "Master Forks",
    game: "tacticTrainer",
    gameOpts: { pack: "fork2" },
    learn:
      "Level-2 forks: the fork square must be SAFE, the targets must be worth it, and sometimes the fork comes with check so nothing can be saved.",
    play: "The master fork pack — every wrong square gets punished. Then hunt forks-with-check in your own games.",
    spark: "A fork with check is a robbery where the police can’t even come.",
    classic: {
      learn:
        "Advanced forks: verify the landing square is unguarded, the targets outweigh your piece, and prefer forks with check — they remove all counterplay.",
      play: "The fork2 pack, where careless squares are punished. In games, scan every check for a double attack.",
      spark:
        "Strong players don’t “spot” forks — they generate candidate checks and captures, then test each for a second target.",
    },
  },
  {
    n: 28,
    land: 6,
    title: "Pins & the Fake Defender",
    game: "tacticTrainer",
    gameOpts: { pack: "pin2" },
    learn:
      "A pinned piece is frozen — so it defends NOTHING. Removing the defender: capture or chase the guard, then take what it was guarding.",
    play: "The master pin pack, then real-board drills: find the piece that only PRETENDS to defend.",
    spark: "The pinned bodyguard is a statue of a bodyguard. Walk right past him.",
    classic: {
      learn:
        "Pinned pieces don’t defend. Combine with removing the defender: eliminate or deflect the guard, then collect. Count captures with pinned pieces excluded.",
      play: "The pin2 pack, then find “fake defenders” in your own games — defenders that are pinned, overloaded, or chaseable.",
      spark: "Recount every exchange with pinned defenders removed from the math. Positions transform.",
    },
  },
  {
    n: 29,
    land: 6,
    title: "Master Skewers",
    game: "tacticTrainer",
    gameOpts: { pack: "skewer2" },
    learn:
      "Level-2 skewers: force the big piece onto the bad line first — a check that MAKES the king step in front of his treasure.",
    play: "The master skewer pack. Then a real-board game where every check you give, you ask: what does it expose?",
    spark: "Sometimes you build the shish-kebab yourself: push the king onto the stick, then skewer.",
    classic: {
      learn:
        "Skewers are often prepared: a forcing check drives king or queen onto the fatal line first. Every check you consider — ask what it exposes behind the moving piece.",
      play: "The skewer2 pack, then review your last games for missed line-up moments.",
      spark:
        "Kings and queens drift onto shared lines constantly in time trouble. The skewer is the punishment clause.",
    },
  },
  {
    n: 30,
    land: 6,
    title: "Discovered Double Trouble",
    game: "tacticTrainer",
    gameOpts: { pack: "disco2" },
    learn:
      "The master discovery: the piece that steps aside ALSO attacks something. Two threats, one move — only one can be answered.",
    play: "The master discovery pack, then build batteries on purpose in a real game: rook behind rook, bishop behind queen.",
    spark: "The curtain opens AND the person opening it throws a pie. Nobody can stop both.",
    classic: {
      learn:
        "The refined discovery: the unmasking piece makes its own threat, so one move creates two problems. Batteries are discoveries in storage.",
      play: "The disco2 pack, then deliberately build one battery per game and watch what it generates.",
      spark:
        "When a discovery is available, calculate the unmasking piece’s BEST square, not its first safe one. That choice is free tempo.",
    },
  },

  {
    n: 31,
    land: 7,
    title: "The Italian, With a Plan",
    game: "openingTrainer",
    gameOpts: { opening: "italian" },
    learn:
      "You know the Italian moves — now the WHY: the bishop eyes f7, the knight guards e5, castling connects the rooks. Every move has a job.",
    play: "Play the Italian and say each piece’s job out loud as it develops. Then swap colors and say black’s jobs.",
    spark: "An opening isn’t a password — it’s a seating plan for your army before the battle starts.",
    classic: {
      learn:
        "Beyond move orders: Bc4 pressures f7, Nf3 controls e5 and enables castling, d3/c3 builds the pawn duo. Plans: c3+d4 break, or a kingside build with Re1/Nbd2/Nf1/Ng3.",
      play: "Play the Italian saying each move’s purpose aloud. Then play black and state the mirror logic.",
      spark:
        "When you know a move’s job, you know what to do when the opponent deviates — that’s the difference between theory and understanding.",
    },
    diagram: {
      fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1",
      caption: "The Italian: every piece has a job — the bishop watches f7, the knight guards e5.",
    },
  },
  {
    n: 32,
    land: 7,
    title: "Develop Like Clockwork",
    game: "coinHop",
    gameOpts: { pieces: ["N", "B", "Q", "R"] },
    learn:
      "Development is a race you can count: minor pieces out, castle, connect rooks — about 7 moves. Every wasted move is a lap you gave away.",
    play: "Coin Hop with all the pieces — fastest routes only. Then count development moves in a real game: who finished the race first?",
    spark: "Count your sleeping pieces after move 10. Zero sleepers = you win the race.",
    classic: {
      learn:
        "Development is countable: two minors, castle, queen connect — roughly seven moves. Compare “developed armies” after move 10 in any game and the better position is usually obvious.",
      play: "Coin Hop for efficient piece routes, then audit development counts in your recent games.",
      spark:
        "Tempo is a currency. Recapture toward development, chase with developing moves, never move twice without a reason you can say aloud.",
    },
  },
  {
    n: 33,
    land: 7,
    title: "Guard the Gate: Trap Defense",
    game: "hangingHunt",
    learn:
      "Every kid-beating trap aims at f7/f2: Scholar’s Mate, the Fried Liver raid. The cures are calm: develop, castle, don’t grab poisoned pawns.",
    play: "Piece Detective to sharpen your threat-scanning, then a grown-up plays trap openings at you until none of them land.",
    spark: "Traps only catch players who move fast. Your superpower is one slow look at f7 every turn.",
    classic: {
      learn:
        "The classic raids — Scholar's Mate, Fried Liver patterns, early Ng5 — all target f7. Defense is principled: develop, castle early, decline suspicious gifts, meet Ng5 with d5.",
      play: "Piece Detective for threat scanning, then have a partner play trap lines at you until each refutation is automatic.",
      spark:
        "You don’t memorize refutations — you learn the smell of a raid: early queen, repeated aim at f7, gifts that cost tempo to take.",
    },
  },
  {
    n: 34,
    land: 7,
    title: "Fight for the Center",
    game: "pawnWars",
    learn:
      "The center squares e4-d4-e5-d5 are the hill in king-of-the-hill: pieces there see everything. Pawn breaks (c3+d4!) are how you claim it.",
    play: "Pawn Wars with a new eye: watch how the middle pawns decide everything. Then play a real game where every move must touch the center somehow.",
    spark: "A knight in the center sees 8 squares; in the corner, 2. Same pony, different kingdom.",
    classic: {
      learn:
        "Central control is piece activity: a centralized knight covers 8 squares, a rim knight 2–4. Pawn breaks (c3-d4 in the Italian) convert development leads into space.",
      play: "Pawn Wars focused on central files, then a game where every move must fight for a central square — directly or by supporting a break.",
      spark:
        "When you don’t know what to do, improve your worst piece toward the center. It’s never wrong by much.",
    },
  },
  {
    n: 35,
    land: 7,
    title: "Open Files & the Rook Lift",
    game: "rookMaze",
    learn:
      "Rooks are useless behind their own pawns and monsters on open files. Find (or make) the open file, double up, invade the 7th row.",
    play: "Rook Maze — feel how walls choke a rook. Then in a real game: get ONE rook to an open file before move 15.",
    spark:
      "A rook on the 7th row eats pawns like popcorn. Two rooks there is called “pigs on the seventh.” Really.",
    classic: {
      learn:
        "Rook value is file-dependent. Plan: identify the file that will open, put a rook there FIRST, double, invade the 7th. Rook lifts (Re1-e3-g3) create attacks from quiet positions.",
      play: "Rook Maze for pathing instinct, then in games: one rook to an open or opening file before move 15.",
      spark:
        "“Pigs on the seventh” — doubled rooks on the 7th rank — routinely outweigh a whole extra piece.",
    },
  },
  {
    n: 36,
    land: 7,
    title: "Punish Opening Mistakes",
    game: "mateInOne",
    learn:
      "When the enemy breaks the golden rules — queen too early, king stuck in the middle, greedy pawn grabs — there’s usually a punishment. Open lines at the uncastled king!",
    play: "Mate in 1 pack for finishing instincts, then real games where a grown-up deliberately breaks one opening rule — find the punishment.",
    spark: "An uncastled king in an open middle is a boss fight with the shields down.",
    classic: {
      learn:
        "Punishing deviations: open the center against uncastled kings, gain tempi on early queens, accept sound gambits and return material for development.",
      play: "The Mate in 1 pack for killer instinct, then games where your partner deliberately violates one principle — find the refutation over the board.",
      spark:
        "The punishment for most opening crimes is the same: open lines faster than the offender can organize.",
    },
  },

  {
    n: 37,
    land: 8,
    title: "The Opposition",
    game: null,
    learn:
      "Kings can never touch — so when they stand face to face with one square between, whoever must move LOSES ground. That staring contest is called the opposition.",
    play: "Kings-only staring contests on the real board: take the opposition, force the other king backwards, feel the zugzwang.",
    spark: "It’s the only fight in chess you win by standing still and saying “you first.”",
    classic: {
      learn:
        "Opposition: kings face off, one square apart, and the side NOT to move controls the position. Direct, distant, and diagonal opposition all reduce to counting.",
      play: "Kings-only drills: take the opposition, outflank, force passage. Then apply it to K+P endings from both sides.",
      spark:
        "Zugzwang — “your turn, unfortunately” — decides most pawn endings. Opposition is how you hand it to the opponent.",
    },
    diagram: {
      fen: "4k3/8/4K3/8/8/8/8/8 b - - 0 1",
      caption: "The staring contest: black must move — and lose ground. That’s the opposition.",
    },
  },
  {
    n: 38,
    land: 8,
    title: "Escort the Pawn Home",
    game: "pawnWars",
    learn:
      "K+P vs K, mastered: king IN FRONT of the pawn, use the opposition, and know the draw zones — rook pawns and stubborn defending kings.",
    play: "Pawn Wars rematches, then the full escort on a real board from ten different starting spots — both sides!",
    spark: "The pawn is the little sibling walking to school; the king walks AHEAD checking every corner first.",
    classic: {
      learn:
        "The complete K+P vs K map: king in front + opposition = win; king behind or rook pawn = draw. Key squares make it instant arithmetic.",
      play: "Escort drills from varied positions, defending side too — knowing WHEN it’s drawn saves half-points.",
      spark:
        "Every trade you make from now on should be checked against this map: which pawn ending am I trading into?",
    },
  },
  {
    n: 39,
    land: 8,
    title: "Philidor’s Fence",
    game: "rookMaze",
    learn:
      "Rook endings, the drawing wall: park your rook on the third row like a fence — the enemy king can’t cross. When the pawn steps in, chase the king with checks from behind.",
    play: "Rook Maze to warm the rook up, then defend Philidor on the real board until the fence feels solid.",
    spark: "You’re building an invisible electric fence. The king touches it — bzzt — checks forever.",
    classic: {
      learn:
        "Philidor’s position: defending rook on the 3rd rank fences the king out; once the pawn advances, swing behind for endless checks. The most valuable half-point in chess.",
      play: "Defend Philidor repeatedly against a motivated attacker until it’s mechanical.",
      spark:
        "Rook endings are the most common endings in real chess. Philidor + Lucena cover the majority of them.",
    },
    diagram: {
      fen: "4k3/8/8/3KP3/8/r7/8/4R3 b - - 0 1",
      caption: "The fence on the third row: the white king may not cross while the rook patrols.",
    },
  },
  {
    n: 40,
    land: 8,
    title: "Lucena’s Bridge",
    game: null,
    learn:
      "The winning wall: your pawn is one step from queening but your king is stuck in front. Build a bridge — rook to the 4th row, king steps out, checks get blocked by the bridge.",
    play: "Build the bridge on the real board from both colors until the four steps are automatic: rook up, king out, walk, block.",
    spark: "Your rook literally becomes a bridge the king walks across while arrows (checks) bounce off it.",
    classic: {
      learn:
        "Lucena: pawn on the 7th, king in front, defender checking. Technique: Rf1-f4 (“building the bridge”), king emerges, interpose at the right moment. Win every time.",
      play: "Drill the bridge from both sides until the move sequence is reflex, then mix Lucena/Philidor positions and name which is which.",
      spark:
        "Lucena wins the won rook endings; Philidor saves the lost ones. Together they’re most of a rating class.",
    },
    diagram: {
      fen: "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",
      caption: "Pawn on the 7th, king boxed in — time to build the bridge.",
    },
  },
  {
    n: 41,
    land: 8,
    title: "Queen vs the Runner Pawn",
    game: "coinHop",
    gameOpts: { pieces: ["Q"] },
    learn:
      "A queen can catch almost any runaway pawn: zigzag closer with checks, park in front, bring the king. The sneaky draws: bishop and rook pawns on the 7th.",
    play: "Coin Hop in queen mode for zigzag feel, then queen-vs-pawn races on the real board — learn which pawns escape!",
    spark: "The queen is a police helicopter chasing a getaway car. Only two streets in town lead to a hideout.",
    classic: {
      learn:
        "Q vs P on the 7th: win by checking closer and occupying the promotion square, EXCEPT bishop/rook pawns where stalemate tricks draw. Know the two exceptions cold.",
      play: "Queen maneuvering in Coin Hop, then Q vs P races across all four pawn types.",
      spark:
        "The stalemate defense (rook/bishop pawn) is one of few endgame facts that reverses results instantly. Check the pawn’s file before you relax.",
    },
  },
  {
    n: 42,
    land: 8,
    title: "Endgame Habits",
    game: "mateInTwo",
    learn:
      "The endgame rulebook: activate the king (he’s a fighter now!), rooks BEHIND passed pawns, cut the enemy king off, and never rush.",
    play: "Mate in 2 pack to keep the finishing sharp, then a full endgame from a real game replayed with the habit list next to the board.",
    spark: "In the endgame the king takes off his crown and puts on boxing gloves.",
    classic: {
      learn:
        "Endgame principles: king activity is worth a pawn, rooks belong behind passed pawns (yours AND theirs), cut off kings, push candidates first, don’t hurry.",
      play: "The Mate in 2 pack for finishing, then replay one of your real endings against the principles list.",
      spark:
        "“Don’t hurry” is technical advice: improving every piece before committing wins endings without calculation.",
    },
  },

  {
    n: 43,
    land: 9,
    title: "Outposts: A Home for the Pony",
    game: "coinHop",
    gameOpts: { pieces: ["N"] },
    learn:
      "An outpost is a square in enemy land where no enemy pawn can ever kick you. A knight living there is worth a rook. Find it, escort him there, watch him rule.",
    play: "Coin Hop knight mode for route-finding, then a real game with one mission: plant a knight on an outpost and keep him there.",
    spark: "You’re building the pony a castle in enemy territory. He pays rent in checkmate threats.",
    classic: {
      learn:
        "Outposts: squares no enemy pawn can attack, ideally protected by yours. Knights on 5th/6th-rank outposts dominate bishops and win games slowly. Create them by inducing pawn moves.",
      play: "Knight-route drills in Coin Hop, then a game with one strategic mission: create and occupy an outpost.",
      spark:
        "You can CREATE outposts — every enemy pawn push leaves squares behind forever. Provoke, then occupy.",
    },
    diagram: {
      fen: "6k1/8/8/3N4/8/8/8/6K1 w - - 0 1",
      from: "d5",
      caption: "A knight on a protected central outpost — eight squares of trouble, forever.",
    },
  },
  {
    n: 44,
    land: 9,
    title: "Files, Ranks & Pigs",
    game: "rookMaze",
    learn:
      "The rook plan, complete: open the file (or trade onto it), double the rooks, invade the 7th. Two rooks on the 7th row win by themselves.",
    play: "Rook Maze at speed, then replay a real game hunting one thing only: the moment a file opened and who grabbed it first.",
    spark: "Files are highways. Whoever owns the highway delivers all the packages.",
    classic: {
      learn:
        "The full rook program: provoke or force a file open, seize it first, double, invade. Doubled rooks on the 7th (“pigs”) generate perpetual threats and win material by themselves.",
      play: "Speed Rook Maze, then audit a real game: every file that opened — who took it, and what did it cost?",
      spark: "File control compounds like interest. One tempo spent claiming a file early pays material later.",
    },
    diagram: {
      fen: "6k1/R7/8/8/8/8/8/6K1 w - - 0 1",
      from: "a7",
      caption: "The seventh rank: every enemy pawn lives there, and the king hides there.",
    },
  },
  {
    n: 45,
    land: 9,
    title: "Pawn Shapes",
    game: "pawnWars",
    learn:
      "Pawns write the story of the position: passed pawns (heroes), isolated pawns (orphans), doubled pawns (twins in one bed), pawn chains (walls with a weak base).",
    play: "Pawn Wars one more time — now NAME every shape as it appears. Then find each shape in one of your real games.",
    spark: "Pawns can’t move backwards, so every pawn shape is a promise you can’t take back.",
    classic: {
      learn:
        "Structures: passed (push it), isolated (blockade, then attack), doubled (target the front one), backward (park a knight in front), chains (attack the base).",
      play: "Pawn Wars while naming every structure aloud, then classify the structures in your last three games.",
      spark:
        "Trade pieces when your structure is better; trade pawns when it’s worse. That one rule is half of strategy.",
    },
  },
  {
    n: 46,
    land: 9,
    title: "Candidate Moves",
    game: "hangingHunt",
    learn:
      "Champions don’t look at one move — they list THREE candidates (checks, captures, threats first), peek one move deep into each, THEN choose.",
    play: "Piece Detective for the scanning habit, then a slow game with the rule: say three candidate moves out loud before every single move.",
    spark: "One idea is a guess. Three ideas is a choice. Champions always get to choose.",
    classic: {
      learn:
        "The candidate-move discipline: generate 2–4 plausible moves (forcing ones first), calculate each briefly, compare landing positions, then commit. It prevents both blunders and autopilot.",
      play: "Piece Detective for scan discipline, then a slow game verbalizing three candidates every move, with a partner auditing.",
      spark: "Blunders happen on moves that were never compared to an alternative. The list IS the safety net.",
    },
  },
  {
    n: 47,
    land: 9,
    title: "Your Games, Your Textbook",
    game: null,
    learn:
      "Every game you play hides three lessons: the move where it turned, the tactic someone missed, the habit that cracked. Finding them is called analysis — champions do it after EVERY game.",
    play: "Replay your last real game from the scoresheet. Find the turning point together. One sentence: “next time I will…”",
    spark: "Losing a game costs nothing if you keep the receipt. Analysis is the receipt.",
    classic: {
      learn:
        "Post-game analysis, the method: replay without an engine first, mark the turning point, find the missed tactic for BOTH sides, extract one habit-level fix.",
      play: "Analyze your most recent serious game: turning point, missed shots, one-sentence lesson. Only then check with an engine if you use one.",
      spark: "One honestly analyzed loss teaches more than ten wins. The rating is downstream of the notebook.",
    },
  },
  {
    n: 48,
    land: 9,
    title: "Boss Battle: Rising Player",
    game: "mateInTwo",
    learn:
      "Everything, together: opening plan, candidate moves, tactics from safe squares, a real endgame finish. This is the whole mountain in one game.",
    play: "The final challenge: a best-of-three match, slow, notated, analyzed after. Then the Mate in 2 pack one last time — all twelve, no hints.",
    spark:
      "Print the Rising Player certificate. Then look up — club ladders, rated tournaments, the whole chess world is open now.",
    classic: {
      learn:
        "Integration: opening plan into middlegame method into endgame technique, with the blunder-check running underneath the whole time.",
      play: "A notated best-of-three at slow pace, fully analyzed afterwards. Then the Mate in 2 pack clean — no hints, no misses.",
      spark:
        "From here it’s rated games, a club, and a puzzle habit. The method you built is the same one titled players use — just add miles.",
    },
  },

  /* ---- Track 3: Opening Range (lessons 49–53, Days 97–105) ---- */
  {
    n: 49,
    land: 10,
    title: "The Italian Game",
    game: "openingTrainer",
    gameOpts: { opening: "italian" },
    learn: "e4, Knight f3, Bishop c4 — the friendly Italian. The bishop stares at f7.",
    play: "Play the Italian in the trainer until the moves feel automatic. No reading — just play!",
    spark: "Same three moves every game. Soon your hands know them before your head does.",
    classic: {
      learn: "1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — the Italian: rapid development, pressure on f7.",
      play: "Drill the line in the trainer until it’s reflex, both the moves and the reason.",
      spark: "Repetition, not theory. One opening played fifty times beats five played ten.",
    },
  },
  {
    n: 50,
    land: 10,
    title: "The Ruy Lopez",
    game: "openingTrainer",
    gameOpts: { opening: "ruyLopez" },
    learn: "Like the Italian, but the bishop goes to b5 to bother the knight guarding e5.",
    play: "Play the Ruy Lopez line in the trainer. Feel how Bb5 pins the defender.",
    spark: "The “Spanish torture” — slow, sound pressure the pros still play today.",
    classic: {
      learn:
        "1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 — the Ruy Lopez: pressure the e5 defender, keep long-term bind.",
      play: "Drill it; note how Bb5 targets the knight, not the pawn directly.",
      spark: "The most respected 1.e4 e5 opening — worth owning even at club level.",
    },
  },
  {
    n: 51,
    land: 10,
    title: "The Scotch Game",
    game: "openingTrainer",
    gameOpts: { opening: "scotch" },
    learn: "Punch the centre open early with d4, then grab the pawn back with the knight.",
    play: "Play the Scotch in the trainer: e4, Nf3, d4, take, take with the knight.",
    spark: "Open lines fast — great when you like lively, attacking games.",
    classic: {
      learn:
        "1.e4 e5 2.Nf3 Nc6 3.d4 exd4 4.Nxd4 — the Scotch: early central break, quick development lead.",
      play: "Drill the capture sequence until the recapture on d4 is automatic.",
      spark: "A clean way to avoid heavy Ruy Lopez theory while staying principled.",
    },
  },
  {
    n: 52,
    land: 10,
    title: "The London System",
    game: "openingTrainer",
    gameOpts: { opening: "london" },
    learn: "A calm setup with d4, Nf3 and the bishop out to f4 — plays against almost anything.",
    play: "Play the London in the trainer. Same easy setup, game after game.",
    spark: "Low-stress, high-reward: a system you can lean on when you’re tired.",
    classic: {
      learn: "1.d4 d5 2.Nf3 Nf6 3.Bf4 — the London: a solid, low-theory system with a clear plan.",
      play: "Drill the setup; the move order is flexible but the pieces always land the same.",
      spark: "Ideal one-system repertoire for busy players — minimal memorization.",
    },
  },
  {
    n: 53,
    land: 10,
    title: "The Scandinavian Defense",
    game: "openingTrainer",
    gameOpts: { opening: "scandinavian" },
    learn: "Now you’re Black! Answer e4 with d5 right away, take, then bring the queen to a5 safely.",
    play: "Play the Scandinavian in the trainer as Black. Hit the centre from move one.",
    spark: "One opening that works against e4 every single time — no surprises.",
    classic: {
      learn:
        "1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5 — the Scandinavian: immediate central challenge as Black, queen tucked on a5.",
      play: "Drill it as Black; learn to develop with tempo after the queen settles.",
      spark: "A dependable, low-theory answer to 1.e4 you can rely on under pressure.",
    },
  },
];
