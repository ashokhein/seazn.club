// Format gallery (v3/06 §4): one explainer per format family — prose, a
// hand-authored mind-map diagram (nodes = stages/pools, arrows = progression)
// and a canned 8-entrant stage graph the live preview runs through the REAL
// engine (previewDivisionFixtures). The enumeration test asserts every
// engine StageKind maps to a family here, so a new format can't ship
// undocumented. Client-safe: the picker side panel imports this too.
import uiEn from "@/dictionaries/en/ui.json";

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
  page_playoff: () => (
    <Frame height={180}>
      <Node x={16} y={20} w={118} label="Qualifier 1" sub="1st × 2nd" />
      <Node x={16} y={110} w={118} label="Eliminator" sub="3rd × 4th" />
      <Arrow x1={134} y1={30} x2={356} y2={70} label="winner" />
      <Arrow x1={134} y1={48} x2={198} y2={74} label="loser" />
      <Arrow x1={134} y1={120} x2={198} y2={92} label="winner" />
      <Node x={200} y={64} w={118} label="Qualifier 2" sub="second chance" />
      <Arrow x1={318} y1={81} x2={356} y2={81} label="winner" />
      <Node x={358} y={64} w={90} label="Final" />
      <Arrow x1={450} y1={81} x2={476} y2={81} />
      <Node x={468} y={66} w={38} h={30} label="🏆" accent />
      <text x={16} y={170} className="fill-slate-400 text-[10px]">
        Lose Qualifier 1 and you get a second life in Qualifier 2.
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
// Prose (title/tagline/bestFor/tradeoff/body) lives ONCE in the `ui` catalog
// (dictionaries/*/ui.json, keys `format.<slug>.*`) so it flows through the
// translation pipeline + parity gate — exactly like the tips registry. This
// config keeps only the structure (kinds, canned preview stages, pro flag) and
// stitches the English copy back on from the en catalog, so every existing
// consumer that reads `family.title` keeps working (English). Localized surfaces
// (marketing /formats, the console explainer panel) use familyCopy() instead.
type FamilyStruct = Pick<FormatFamily, "slug" | "kinds" | "cannedStages"> & { pro?: boolean };

const enUi = uiEn as Record<string, string>;
const enCopy = (slug: string, field: string): string => enUi[`format.${slug}.${field}`] ?? "";

const FAMILY_STRUCTS: FamilyStruct[] = [
  {
    slug: "league",
    kinds: ["league"],
    cannedStages: [{ kind: "league", name: "League", config: { legs: 1 }, qualification: null }],
  },
  {
    slug: "groups-knockout",
    kinds: ["group"],
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
    kinds: ["knockout"],
    cannedStages: [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
  },
  {
    slug: "double_elim",
    kinds: ["double_elim"],
    pro: true,
    cannedStages: [
      { kind: "double_elim", name: "Double elimination", config: {}, qualification: null },
    ],
  },
  {
    slug: "swiss",
    kinds: ["swiss"],
    cannedStages: [{ kind: "swiss", name: "Swiss", config: { rounds: 5 }, qualification: null }],
  },
  {
    slug: "stepladder",
    kinds: ["stepladder"],
    cannedStages: [
      { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
      { kind: "stepladder", name: "Stepladder finals", config: {}, qualification: { topN: 4 } },
    ],
  },
  {
    slug: "page_playoff",
    kinds: ["page_playoff"],
    pro: true,
    cannedStages: [
      { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
      { kind: "page_playoff", name: "Playoffs", config: {}, qualification: { topN: 4 } },
    ],
  },
  {
    slug: "americano",
    kinds: ["americano"],
    pro: true,
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
    kinds: ["ladder"],
    pro: true,
    cannedStages: [
      { kind: "ladder", name: "Ladder", config: { challengeRange: 3 }, qualification: null },
    ],
  },
];

export const FORMAT_FAMILIES: FormatFamily[] = FAMILY_STRUCTS.map((s) => ({
  ...s,
  title: enCopy(s.slug, "title"),
  tagline: enCopy(s.slug, "tagline"),
  bestFor: enCopy(s.slug, "bestFor"),
  tradeoff: enCopy(s.slug, "tradeoff"),
  body: [enCopy(s.slug, "body.0"), enCopy(s.slug, "body.1")],
}));

/** Localized prose for a family. `tf` is a bound lookup into the `ui` dict —
 *  `(k) => t(uiDict, k)` on the server, or `useT()` in a client island under a
 *  DictProvider. Falls back to English via the merged dict (getDictionary merges
 *  en), so a not-yet-translated key still renders. */
export interface FormatCopy {
  title: string;
  tagline: string;
  bestFor: string;
  tradeoff: string;
  body: string[];
}
export function familyCopy(family: FormatFamily, tf: (key: string) => string): FormatCopy {
  const k = (field: string) => tf(`format.${family.slug}.${field}`);
  return {
    title: k("title"),
    tagline: k("tagline"),
    bestFor: k("bestFor"),
    tradeoff: k("tradeoff"),
    body: [k("body.0"), k("body.1")],
  };
}

export function formatFamily(slug: string): FormatFamily | null {
  return FORMAT_FAMILIES.find((f) => f.slug === slug) ?? null;
}

/** Family that explains a given engine stage kind (enumeration-test hook). */
export function familyForKind(kind: string): FormatFamily | null {
  return FORMAT_FAMILIES.find((f) => f.kinds.includes(kind)) ?? null;
}
