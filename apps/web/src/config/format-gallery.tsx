// Format gallery (v3/06 §4): one explainer per format family — prose, a
// hand-authored mind-map diagram (nodes = stages/pools, arrows = progression)
// and a canned 8-entrant stage graph the live preview runs through the REAL
// engine (previewDivisionFixtures). The enumeration test asserts every
// engine StageKind maps to a family here, so a new format can't ship
// undocumented. Client-safe: the picker side panel imports this too.

export interface FormatFamily {
  slug: string;
  title: string;
  tagline: string;
  /** Engine stage kinds this family explains. */
  kinds: string[];
  bestFor: string;
  /** The one-sentence trade-off the recommendation strip shows. */
  tradeoff: string;
  body: string[];
  /** Canned 8-entrant stage graph for the live preview. */
  cannedStages: {
    kind: string;
    name: string;
    config: Record<string, unknown>;
    qualification: unknown;
  }[];
  pro?: boolean;
}

// ── Diagram primitives — quiet, theme-aware, mind-map vocabulary ──────────

function Node({
  x, y, w = 118, h = 34, label, sub, accent = false,
}: {
  x: number; y: number; w?: number; h?: number;
  label: string; sub?: string; accent?: boolean;
}) {
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx={9}
        className={accent ? "fill-purple-600" : "fill-white stroke-purple-300"}
        strokeWidth={1.5}
      />
      <text
        x={x + w / 2} y={y + (sub ? 14 : h / 2 + 4)}
        textAnchor="middle"
        className={`text-[11px] font-semibold ${accent ? "fill-white" : "fill-slate-700"}`}
      >
        {label}
      </text>
      {sub ? (
        <text
          x={x + w / 2} y={y + 26} textAnchor="middle"
          className={`text-[9px] ${accent ? "fill-purple-100" : "fill-slate-400"}`}
        >
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, label }: {
  x1: number; y1: number; x2: number; y2: number; label?: string;
}) {
  return (
    <g>
      <line
        x1={x1} y1={y1} x2={x2} y2={y2}
        className="stroke-purple-400" strokeWidth={1.5} markerEnd="url(#fmt-arrow)"
      />
      {label ? (
        <text
          x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle"
          className="fill-purple-500 text-[9px] font-medium"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

function Frame({ children, height = 150 }: { children: React.ReactNode; height?: number }) {
  return (
    <svg
      viewBox={`0 0 520 ${height}`}
      role="img"
      className="w-full max-w-xl"
      aria-hidden={false}
    >
      <defs>
        <marker id="fmt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" className="fill-purple-400" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

// ── One diagram per family ─────────────────────────────────────────────────

const DIAGRAMS: Record<string, () => React.ReactNode> = {
  league: () => (
    <Frame height={120}>
      <Node x={20} y={42} label="8 entrants" sub="everyone enters" />
      <Arrow x1={140} y1={59} x2={195} y2={59} />
      <Node x={197} y={42} w={130} label="Round robin" sub="everyone plays everyone" />
      <Arrow x1={329} y1={59} x2={384} y2={59} label="points" />
      <Node x={386} y={42} w={114} label="Final table" sub="rank 1 wins" accent />
    </Frame>
  ),
  "groups-knockout": () => (
    <Frame height={170}>
      <Node x={16} y={66} w={92} label="8 entrants" />
      <Arrow x1={110} y1={74} x2={160} y2={40} />
      <Arrow x1={110} y1={90} x2={160} y2={124} />
      <Node x={162} y={22} w={122} label="Group A" sub="round robin ×4" />
      <Node x={162} y={106} w={122} label="Group B" sub="round robin ×4" />
      <Arrow x1={286} y1={40} x2={344} y2={70} label="top 2" />
      <Arrow x1={286} y1={124} x2={344} y2={94} label="top 2" />
      <Node x={346} y={66} w={112} label="Semi-finals" sub="A1×B2 · B1×A2" />
      <Arrow x1={458} y1={82} x2={488} y2={82} />
      <Node x={478} y={66} w={38} h={32} label="🏆" accent />
    </Frame>
  ),
  knockout: () => (
    <Frame height={170}>
      <Node x={16} y={10} w={104} h={26} label="Quarter-finals" sub={undefined} />
      <Node x={16} y={46} w={104} h={26} label="4 matches" />
      <Arrow x1={122} y1={41} x2={186} y2={62} label="winners" />
      <Node x={188} y={50} w={104} h={26} label="Semi-finals" />
      <Node x={188} y={84} w={104} h={26} label="2 matches" />
      <Arrow x1={294} y1={80} x2={358} y2={100} label="winners" />
      <Node x={360} y={90} w={90} h={26} label="Final" />
      <Arrow x1={452} y1={103} x2={482} y2={103} />
      <Node x={474} y={88} w={38} h={30} label="🏆" accent />
      <text x={16} y={150} className="fill-slate-400 text-[10px]">
        Lose once and you're out — half the field leaves every round.
      </text>
    </Frame>
  ),
  double_elim: () => (
    <Frame height={180}>
      <Node x={16} y={20} w={126} label="Winners bracket" sub="undefeated path" />
      <Node x={16} y={110} w={126} label="Losers bracket" sub="one life left" />
      <Arrow x1={80} y1={56} x2={80} y2={108} label="first loss" />
      <Arrow x1={144} y1={37} x2={340} y2={75} />
      <Arrow x1={144} y1={127} x2={340} y2={95} label="bracket winner" />
      <Node x={342} y={68} w={116} label="Grand final" sub="losers must win twice" />
      <Arrow x1={460} y1={85} x2={486} y2={85} />
      <Node x={478} y={70} w={38} h={30} label="🏆" accent />
    </Frame>
  ),
  swiss: () => (
    <Frame height={150}>
      <Node x={16} y={54} w={104} label="Round 1" sub="seeded pairs" />
      <Arrow x1={122} y1={71} x2={168} y2={71} />
      <Node x={170} y={54} w={104} label="Round 2" sub="1-0 plays 1-0" />
      <Arrow x1={276} y1={71} x2={322} y2={71} />
      <Node x={324} y={54} w={80} h={34} label="…rounds" sub="equals meet" />
      <Arrow x1={406} y1={71} x2={434} y2={71} />
      <Node x={436} y={54} w={72} label="Table" accent />
      <text x={16} y={130} className="fill-slate-400 text-[10px]">
        Nobody is eliminated; each round pairs entrants on equal scores.
      </text>
    </Frame>
  ),
  stepladder: () => (
    <Frame height={170}>
      <Node x={16} y={120} w={96} h={28} label="Seed 4 × Seed 3" />
      <Arrow x1={114} y1={128} x2={168} y2={96} label="winner" />
      <Node x={170} y={82} w={96} h={28} label="× Seed 2" />
      <Arrow x1={268} y1={90} x2={322} y2={58} label="winner" />
      <Node x={324} y={44} w={96} h={28} label="× Seed 1" />
      <Arrow x1={422} y1={52} x2={452} y2={52} />
      <Node x={446} y={36} w={38} h={30} label="🏆" accent />
      <text x={16} y={30} className="fill-slate-400 text-[10px]">
        The lowest seed climbs the ladder; the top seed waits at the summit.
      </text>
    </Frame>
  ),
  americano: () => (
    <Frame height={160}>
      <Node x={16} y={20} w={130} label="Round 1" sub="A+B vs C+D" />
      <Node x={16} y={62} w={130} label="Round 2" sub="A+C vs B+D" />
      <Node x={16} y={104} w={130} label="Round 3…" sub="partners rotate" />
      <Arrow x1={148} y1={37} x2={330} y2={72} />
      <Arrow x1={148} y1={79} x2={330} y2={80} />
      <Arrow x1={148} y1={121} x2={330} y2={88} label="personal points" />
      <Node x={332} y={64} w={150} label="Individual leaderboard" accent />
    </Frame>
  ),
  ladder: () => (
    <Frame height={170}>
      <Node x={40} y={16} w={90} h={26} label="1. Priya" accent />
      <Node x={40} y={52} w={90} h={26} label="2. Marco" />
      <Node x={40} y={88} w={90} h={26} label="3. Chen" />
      <Node x={40} y={124} w={90} h={26} label="4. Aida" />
      <Arrow x1={160} y1={137} x2={160} y2={70} label="challenge ↑" />
      <Node x={220} y={64} w={170} h={40} label="Winner takes the rung" sub="open-ended season" />
    </Frame>
  ),
};

export function FormatDiagram({ slug }: { slug: string }) {
  const D = DIAGRAMS[slug];
  return D ? <>{D()}</> : null;
}

// ── The families ───────────────────────────────────────────────────────────

export const FORMAT_FAMILIES: FormatFamily[] = [
  {
    slug: "league",
    title: "League (round robin)",
    tagline: "Everyone plays everyone; the table decides.",
    kinds: ["league"],
    bestFor: "Season-long divisions and social groups where everyone wants a full card of matches.",
    tradeoff: "The fairest ranking, but the most matches — n(n−1)/2 fixtures for one leg.",
    body: [
      "Every entrant plays every other entrant a fixed number of times (one leg, two legs, or more). Wins and results feed a points table; the table's final order is the result.",
      "Nobody is eliminated, so it maximises play for everyone — the trade is time: eight entrants in one leg is 28 matches. Ties in the table resolve by your tiebreaker cascade (head-to-head, difference, and so on).",
    ],
    cannedStages: [{ kind: "league", name: "League", config: { legs: 1 }, qualification: null }],
  },
  {
    slug: "groups-knockout",
    title: "Groups + knockout",
    tagline: "Pools qualify their best into a bracket — the World Cup shape.",
    kinds: ["group"],
    bestFor: "One-day tournaments: guaranteed group matches for all, a dramatic bracket for the best.",
    tradeoff: "Great balance of fairness and drama; needs group sizes planned around your court time.",
    body: [
      "Entrants split into pools that each play a round robin. The top of each pool — top 2 is classic — cross over into a knockout bracket: A1 meets B2, B1 meets A2, so group winners are rewarded with the easier semi.",
      "Everyone gets their group matches even on a losing day, and the finish is winner-takes-all. This is the default shape for most one-day multi-court events.",
    ],
    cannedStages: [
      { kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 2 } }, qualification: null },
      {
        kind: "knockout",
        name: "Knockout",
        config: {},
        qualification: {
          take: [
            { pool: "A", rank: 1 }, { pool: "B", rank: 1 },
            { pool: "A", rank: 2 }, { pool: "B", rank: 2 },
          ],
        },
      },
    ],
  },
  {
    slug: "knockout",
    title: "Knockout (single elimination)",
    tagline: "Lose once and you're out.",
    kinds: ["knockout"],
    bestFor: "Big fields on tight time — a 32-draw resolves in five rounds.",
    tradeoff: "Fastest to a champion, but half your entrants play exactly one match.",
    body: [
      "A seeded bracket: winners advance, losers are done. Byes fill the bracket when the entry count isn't a power of two, protecting the top seeds.",
      "It's the most time-efficient format there is, and the least forgiving — an early upset sends a favourite home after one match. Pair it with a group stage if everyone deserves more play.",
    ],
    cannedStages: [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
  },
  {
    slug: "double_elim",
    title: "Double elimination",
    tagline: "Everyone gets a second life in the losers bracket.",
    kinds: ["double_elim"],
    bestFor: "Competitive brackets where one bad match shouldn't end a tournament.",
    tradeoff: "Roughly double the matches of a knockout; the grand final can need two games.",
    pro: true,
    body: [
      "Two brackets run side by side: lose in the winners bracket and you drop to the losers bracket, where a second defeat is final. The survivors of each meet in the grand final — and a losers-bracket champion must beat the winners-bracket champion twice.",
      "Beloved in esports, TT and pool: fairer than single elimination, still bracket-shaped, at about twice the match count.",
    ],
    cannedStages: [
      { kind: "double_elim", name: "Double elimination", config: {}, qualification: null },
    ],
  },
  {
    slug: "swiss",
    title: "Swiss",
    tagline: "Equals play equals for a fixed number of rounds.",
    kinds: ["swiss"],
    bestFor: "Big fields, short time, nobody eliminated — chess's gift to weekend events.",
    tradeoff: "Everyone plays every round and the ranking converges fast; pairings only exist round by round.",
    body: [
      "Round 1 is seeded. From round 2, entrants meet opponents on the same score — winners play winners, strugglers play strugglers. After a fixed number of rounds (5 covers up to 32 entrants well), the table decides.",
      "Nobody is knocked out and blowout mismatches disappear after round one. The schedule can't be printed in advance — each round's pairings come from the live standings, which the app draws for you.",
    ],
    cannedStages: [{ kind: "swiss", name: "Swiss", config: { rounds: 5 }, qualification: null }],
  },
  {
    slug: "stepladder",
    title: "Stepladder finals",
    tagline: "The lowest seed climbs; the top seed waits at the summit.",
    kinds: ["stepladder"],
    bestFor: "Finals night after a league — every match eliminates someone, seeding really matters.",
    tradeoff: "A brilliant finish for 3–5 qualifiers; the top seed plays only once.",
    body: [
      "Seed 4 plays seed 3; the winner plays seed 2; that winner plays seed 1 in the final. Finishing top of the league buys you rest and a single decisive match — finishing fourth means winning three in a row.",
      "Usually staged as the finale after a league stage, turning a table into an event.",
    ],
    cannedStages: [
      { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
      { kind: "stepladder", name: "Stepladder finals", config: {}, qualification: { topN: 4 } },
    ],
  },
  {
    slug: "americano",
    title: "Americano & Mexicano",
    tagline: "Individuals rotate partners; personal points decide.",
    kinds: ["americano"],
    bestFor: "Padel and social doubles — solo sign-ups, everyone plays with everyone.",
    tradeoff: "Maximum mixing and zero elimination; needs a points-based sport and even court usage.",
    pro: true,
    body: [
      "You enter alone. Each round the app deals new pairs — in Americano the rotation is fixed so everyone partners everyone; in Mexicano the pairings re-rank each round from live points (1st + 4th vs 2nd + 3rd), so games stay close.",
      "Every point you win is yours personally, whoever your partner was; the individual leaderboard decides. The dominant format in padel clubs, and a joy for any doubles sport's social night.",
    ],
    cannedStages: [
      {
        kind: "americano",
        name: "Americano",
        config: { mode: "americano", courtCount: 2, rounds: 7 },
        qualification: null,
      },
    ],
  },
  {
    slug: "ladder",
    title: "Ladder",
    tagline: "A living ranking — challenge above you, defend below.",
    kinds: ["ladder"],
    bestFor: "Ongoing club rankings with no fixed schedule — squash boxes, TT clubs.",
    tradeoff: "Runs forever with matches on demand; there's no printed fixture list by design.",
    pro: true,
    body: [
      "Entrants sit on a ranked ladder. Anyone may challenge a player within range above them (three rungs is typical); win and you take their rung. Matches happen whenever the two of you play — the app records the result and reorders the ladder.",
      "Perfect for a club season with no fixture nights: the ladder is always current, and the year-end order is its own trophy.",
    ],
    cannedStages: [
      { kind: "ladder", name: "Ladder", config: { challengeRange: 3 }, qualification: null },
    ],
  },
];

export function formatFamily(slug: string): FormatFamily | null {
  return FORMAT_FAMILIES.find((f) => f.slug === slug) ?? null;
}

/** Family that explains a given engine stage kind (enumeration-test hook). */
export function familyForKind(kind: string): FormatFamily | null {
  return FORMAT_FAMILIES.find((f) => f.kinds.includes(kind)) ?? null;
}
