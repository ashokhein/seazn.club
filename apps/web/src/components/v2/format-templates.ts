// One-click stage graphs (v8): shared by the division builder and the
// division Settings tab so "format" means the same thing in both places —
// League / Knockout / Groups + Knockout…, i.e. the stage structure.
// Match rules live in match-rules.tsx; this file is only the graph.

export interface StageDraft {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  qualification: Record<string, unknown> | null;
}

export interface TemplateKnobs {
  /** How many advance to stage 2 (finals/knockout templates). */
  qualified: number;
  swissRounds: number;
  poolCount: number;
  legs: number;
}

export const STAGE_TEMPLATES: {
  key: string;
  label: string;
  help: string;
  build: (q: number) => StageDraft[];
}[] = [
  {
    key: "league",
    label: "League",
    help: "Single round robin, table decides.",
    build: () => [{ kind: "league", name: "League", config: { legs: 1 }, qualification: null }],
  },
  {
    key: "league_ko",
    label: "League + Finals",
    help: "Round robin, then top N knockout.",
    build: (q) => [
      { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
      { kind: "knockout", name: "Finals", config: {}, qualification: { topN: q } },
    ],
  },
  {
    key: "groups_ko",
    label: "Groups + Knockout",
    help: "Two pools, top of each cross over.",
    build: (q) => [
      {
        kind: "group",
        name: "Group stage",
        config: { legs: 1, pools: { count: 2 } },
        qualification: null,
      },
      {
        kind: "knockout",
        name: "Knockout",
        config: {},
        qualification: {
          take: Array.from({ length: q }, (_, i) => ({
            pool: i % 2 === 0 ? "A" : "B",
            rank: Math.floor(i / 2) + 1,
          })),
        },
      },
    ],
  },
  {
    key: "group_stepladder",
    label: "Group + Stepladder",
    help: "Round robin, then a stepladder final — lowest seed climbs.",
    build: (q) => [
      { kind: "league", name: "League", config: { legs: 1 }, qualification: null },
      { kind: "stepladder", name: "Stepladder finals", config: {}, qualification: { topN: q } },
    ],
  },
  {
    key: "swiss",
    label: "Swiss",
    help: "Score-group pairings, fixed rounds.",
    build: () => [
      { kind: "swiss", name: "Swiss", config: { rounds: 5 }, qualification: null },
    ],
  },
  {
    key: "knockout",
    label: "Knockout",
    help: "Single elimination bracket.",
    build: () => [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
  },
  {
    key: "double_elim",
    label: "Double elimination",
    help: "Losers bracket + grand final (Pro).",
    build: () => [
      { kind: "double_elim", name: "Double elimination", config: {}, qualification: null },
    ],
  },
  {
    key: "triple_rr",
    label: "Triple round robin",
    help: "Everyone plays everyone three times.",
    build: () => [{ kind: "league", name: "Triple RR", config: { legs: 3 }, qualification: null }],
  },
  {
    key: "americano",
    label: "Americano (padel)",
    help: "Individuals rotate partners each round; personal points (Pro).",
    build: () => [
      { kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 7 }, qualification: null },
    ],
  },
  {
    key: "mexicano",
    label: "Mexicano (padel)",
    help: "Re-rank each round: 1+4 vs 2+3 from live points (Pro).",
    build: () => [
      { kind: "americano", name: "Mexicano", config: { mode: "mexicano", courtCount: 2, rounds: 7 }, qualification: null },
    ],
  },
  {
    key: "ladder",
    label: "Ladder",
    help: "Open standings; players challenge upward over a long window (Pro).",
    build: () => [
      { kind: "ladder", name: "Ladder", config: { challengeRange: 3 }, qualification: null },
    ],
  },
];

/** Template + knob values → the stage specs the API accepts. */
export function buildTemplateStages(templateKey: string, knobs: TemplateKnobs): StageDraft[] {
  const t = STAGE_TEMPLATES.find((s) => s.key === templateKey) ?? STAGE_TEMPLATES[0]!;
  return t.build(knobs.qualified).map((d) => {
    const config = { ...d.config };
    if (d.kind === "swiss") config.rounds = knobs.swissRounds;
    if (d.kind === "league" || d.kind === "group") config.legs = knobs.legs;
    if (d.kind === "group") config.pools = { count: knobs.poolCount };
    return { ...d, config };
  });
}

/** Best-effort reverse map: existing stages → template key (null = custom). */
export function detectTemplate(
  stages: { kind: string; config?: Record<string, unknown> | null }[],
): string | null {
  const kinds = stages.map((s) => s.kind).join("+");
  if (kinds === "league") {
    const legs = (stages[0]?.config as { legs?: number } | undefined)?.legs ?? 1;
    return legs >= 3 ? "triple_rr" : "league";
  }
  if (kinds === "league+knockout") return "league_ko";
  if (kinds === "group+knockout") return "groups_ko";
  if (kinds === "league+stepladder") return "group_stepladder";
  if (kinds === "swiss") return "swiss";
  if (kinds === "knockout") return "knockout";
  if (kinds === "double_elim") return "double_elim";
  if (kinds === "americano") {
    const mode = (stages[0]?.config as { mode?: string } | undefined)?.mode;
    return mode === "mexicano" ? "mexicano" : "americano";
  }
  if (kinds === "ladder") return "ladder";
  return null;
}
