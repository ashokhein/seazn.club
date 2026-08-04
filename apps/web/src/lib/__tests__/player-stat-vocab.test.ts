// Gap 1 — player-stat labels. The engine ships an English `label` on every
// declared metric, so the public player page and /me have never LOOKED broken:
// a French visitor sees "Goals", "Balls faced", "PIM" and nothing signals that
// copy is missing. That invisibility is the defect.
//
// Why these keys are per-sport (`stat.<sportKey>.<metricKey>`) and not flat:
// five metric keys are declared by more than one sport with DIFFERENT English
// wording — `sanctions` is "Sanctions" in volleyball and "Cards" in badminton,
// `points` is "Points won" in tennis, `so_*` are "GWS *" on ice and "SO *" on
// grass. A flat `stat.sanctions` would force one sport's word on another, in
// four languages, invisibly. `collidingMetricKeys()` below derives that set
// from the engine and pins that the dictionary keeps them distinct — so the
// justification for the scheme is itself a test, not a comment.
//
// Every expected set here is DERIVED from `builtinModules` at test time. A
// hand-copied list goes stale the moment a wave adds a metric (W4a added
// tennis `medical_timeouts`), which is exactly the failure this file closes.
import { describe, it, expect } from "vitest";
import { PLAYER_STAT_KEY, playerStatLabel, type MsgFn } from "@/lib/scoring-vocab";
import { labelPlayerStats } from "@/server/player-stats";
import { builtinModules } from "@seazn/engine/sports";
import { aggregatePlayerStats, type PlayerStatsModel } from "@seazn/engine/stats";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const LOCALES = {
  en: uiEn as Record<string, string>,
  es: uiEs as Record<string, string>,
  fr: uiFr as Record<string, string>,
  nl: uiNl as Record<string, string>,
};
/** Stub translator: echoes the key, so we can prove a label came from a key. */
const echo: MsgFn = (k) => `«${k}»`;
const at = (locale: keyof typeof LOCALES): MsgFn => (k) => LOCALES[locale][k];

interface StatsModule {
  key: string;
  version: string;
  playerStats?: {
    metrics?: readonly { key: string; label: string }[];
    derived?: readonly { key: string; label: string }[];
    awards?: readonly { key: string; label: string }[];
  };
}

interface StatRow {
  sport: string;
  version: string;
  /** The key as it appears in a snapshot row — awards carry the `_awards` suffix. */
  row: string;
  engineLabel: string;
}

/**
 * Every stat row `labelPlayerStats` can emit, read off the modules' own
 * declarations in the same order and with the same `_awards` suffixing the
 * production helper applies. Deduped per sport because a module may declare one
 * metric key twice with two credit paths (boardgame's `games` counts both
 * `homePerson` and `awayPerson`) — that is one displayed row, not two.
 */
function declaredStatRows(): StatRow[] {
  const out: StatRow[] = [];
  for (const m of builtinModules as unknown as StatsModule[]) {
    const ps = m.playerStats;
    if (!ps) continue;
    const seen = new Map<string, string>();
    for (const [row, label] of [
      ...(ps.metrics ?? []).map((x) => [x.key, x.label] as const),
      ...(ps.derived ?? []).map((x) => [x.key, x.label] as const),
      ...(ps.awards ?? []).map((x) => [`${x.key}_awards`, x.label] as const),
    ]) {
      seen.set(row, label);
    }
    for (const [row, engineLabel] of seen) out.push({ sport: m.key, version: m.version, row, engineLabel });
  }
  return out;
}

/** Metric keys >1 sport declares with DIFFERENT English — the collision set. */
function collidingMetricKeys(): Map<string, Set<string>> {
  const byRow = new Map<string, Set<string>>();
  for (const { row, engineLabel } of declaredStatRows()) {
    if (!byRow.has(row)) byRow.set(row, new Set());
    byRow.get(row)!.add(engineLabel);
  }
  return new Map([...byRow].filter(([, labels]) => labels.size > 1));
}

const rowsBySport = (): Map<string, StatRow[]> => {
  const m = new Map<string, StatRow[]>();
  for (const r of declaredStatRows()) {
    if (!m.has(r.sport)) m.set(r.sport, []);
    m.get(r.sport)!.push(r);
  }
  return m;
};

describe("player-stat vocabulary derivation", () => {
  // Vacuity guard. Every assertion below loops over `declaredStatRows()`; a
  // derivation that silently returned [] — a renamed `playerStats`, a module
  // list that stopped exporting — would make all of them pass while proving
  // nothing. Pin the shape and the members that were added most recently.
  it("reaches every shipped module's declared stat model", () => {
    const rows = declaredStatRows();
    expect(rows.length).toBeGreaterThanOrEqual(74);
    expect([...new Set(rows.map((r) => r.sport))].sort()).toEqual([
      "badminton", "boardgame", "carrom", "cricket", "football", "generic",
      "hockey", "icehockey", "tabletennis", "tennis", "volleyball",
    ]);
    // W4a's own addition, and the three award rows (suffixed, unlike metrics).
    expect(rows).toContainEqual(
      expect.objectContaining({ sport: "tennis", row: "medical_timeouts", engineLabel: "Medical timeouts" }),
    );
    expect(rows.filter((r) => r.row.endsWith("_awards")).map((r) => `${r.sport}.${r.row}`).sort())
      .toEqual(["football.motm_awards", "hockey.potm_awards", "icehockey.mvp_awards"]);
  });

  it("finds the cross-sport collisions that force per-sport keying", () => {
    // If this set ever empties, the per-sport scheme has lost its justification
    // and someone should be told — so pin it by name, derived side and all.
    expect([...collidingMetricKeys().keys()].sort()).toEqual(
      ["points", "sanctions", "so_attempts", "so_goals", "so_saves"],
    );
    expect([...collidingMetricKeys().get("sanctions")!].sort()).toEqual(["Cards", "Sanctions"]);
  });
});

describe("scoring-vocab covers every player stat the engine declares", () => {
  it("exports the map the coverage assertions read", () => {
    // Vite resolves a missing named export to `undefined`, which would make
    // every `toHaveProperty` below throw rather than assert — but a missing
    // FUNCTION export would make `playerStatLabel(...)` a TypeError only on
    // the lines that call it. Prove both exist first.
    expect(PLAYER_STAT_KEY).toBeTypeOf("object");
    expect(playerStatLabel).toBeTypeOf("function");
    expect(Object.keys(PLAYER_STAT_KEY).length).toBeGreaterThanOrEqual(74);
  });

  it("keys every declared stat row, scoped by sport", () => {
    for (const { sport, row } of declaredStatRows()) {
      expect(PLAYER_STAT_KEY, `no label key for ${sport}.${row}`).toHaveProperty([`${sport}.${row}`]);
    }
  });

  it("ships copy for every key in ALL FOUR dictionaries", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of Object.values(PLAYER_STAT_KEY)) {
        // Dictionaries are FLAT dotted-key JSON — toHaveProperty matches the
        // literal key before attempting a path walk, so this is a flat lookup.
        expect(dict, `missing ${locale} copy for ${key}`).toHaveProperty(key);
      }
    }
  });

  it("keeps colliding metric keys distinct in every locale", () => {
    // The point of the scheme. `sanctions` must not read the same word in
    // badminton and volleyball just because the metric key matches.
    for (const [row] of collidingMetricKeys()) {
      const sports = declaredStatRows().filter((r) => r.row === row);
      for (const [locale, dict] of Object.entries(LOCALES)) {
        const byEnglish = new Map<string, Set<string>>();
        for (const s of sports) {
          const eng = s.engineLabel;
          if (!byEnglish.has(eng)) byEnglish.set(eng, new Set());
          byEnglish.get(eng)!.add(dict[PLAYER_STAT_KEY[`${s.sport}.${row}`]]);
        }
        // Sports whose English differs must not collapse to one localized word.
        const localized = [...byEnglish.values()].map((s) => [...s][0]);
        expect(
          new Set(localized).size,
          `${locale}: "${row}" collapsed ${[...byEnglish.keys()].join(" / ")} into one word`,
        ).toBe(byEnglish.size);
      }
    }
  });

  it("falls back to the engine's English for a metric it has no key for", () => {
    // An unkeyed metric must degrade to the engine's own label, never blank —
    // a new sport ships stats before its copy does.
    expect(playerStatLabel("kabaddi", "raids", echo, "Raids")).toBe("Raids");
    // No engine label either: humanize the token rather than render nothing.
    expect(playerStatLabel("kabaddi", "super_raids", echo)).toBe("Super raids");
    expect(playerStatLabel("football", "goals", echo, "Goals")).toBe("«stat.football.goals»");
  });
});

describe("labelPlayerStats renders localized copy, not the engine's English", () => {
  it("sources every label from a message key", () => {
    // The strong shape: with an echoing translator NO label may survive as
    // prose. A reintroduced hardcoded English label reds here immediately.
    for (const [sport, rows] of rowsBySport()) {
      const stats = Object.fromEntries(rows.map((r) => [r.row, 1]));
      const labelled = labelPlayerStats(sport, rows[0].version, stats, echo);
      expect(new Set(labelled.map((l) => l.key)), `${sport} rows`).toEqual(
        new Set(rows.map((r) => r.row)),
      );
      for (const l of labelled) {
        // `award.*` is the shared award vocabulary the `*_awards` rows point at
        // rather than minting a second name for "Man of the Match".
        expect(l.label, `${sport}.${l.key} did not come from a message key`)
          .toMatch(/^«(stat|award)\./);
      }
    }
  });

  it("renders a different block of copy in every non-English locale", () => {
    // "No hardcoded English on a non-English page", asserted per sport rather
    // than per key: a few terms are legitimately identical across languages
    // ("Points" is "Points" in French), so only the WHOLE block is required to
    // differ. Fold the block to one string and compare.
    const block = (sport: string, rows: StatRow[], m: MsgFn) =>
      labelPlayerStats(sport, rows[0].version, Object.fromEntries(rows.map((r) => [r.row, 1])), m)
        .map((l) => l.label)
        .join("|");
    for (const [sport, rows] of rowsBySport()) {
      const english = block(sport, rows, at("en"));
      for (const locale of ["es", "fr", "nl"] as const) {
        expect(block(sport, rows, at(locale)), `${locale} ${sport} still reads as English`)
          .not.toBe(english);
      }
    }
  });

  it("emits each key at most once, for every builtin module", () => {
    // As a LIST, not a set — the set assertion above passes in both states and
    // is exactly why this stayed silent. `metrics` is an aggregation spec, so a
    // module legitimately declares one key several times to credit it from
    // several payload fields (boardgame's `games`: homePerson AND awayPerson).
    // The display helper must collapse those to one row: the player pages use
    // `key` as their React key, and duplicate keys make row identity ambiguous
    // on any reorder or animation — and render the same counter twice.
    for (const [sport, rows] of rowsBySport()) {
      const stats = Object.fromEntries(rows.map((r) => [r.row, 1]));
      const keys = labelPlayerStats(sport, rows[0].version, stats, echo).map((l) => l.key);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      expect(dupes, `${sport} emitted duplicate stat rows`).toEqual([]);
    }
  });

  it("credits a repeated metric key from every declared field, not just the first", () => {
    // The other half of the same contract: deduping is a DISPLAY concern only.
    // Deleting one of boardgame's two `games` declarations would also make this
    // pass, while silently halving the counter — every away-side appearance
    // would stop counting. The aggregator must still honour both declarations.
    const boardgame = builtinModules.find((mod) => mod.key === "boardgame");
    const model = (boardgame as unknown as { playerStats: PlayerStatsModel }).playerStats;
    const games = model.metrics.filter((x) => x.key === "games");
    expect(games.map((x) => x.field)).toEqual(["homePerson", "awayPerson"]);

    const rows = aggregatePlayerStats(
      [
        {
          id: "e1",
          fixtureId: "f1",
          seq: 1,
          type: "boardgame.pairing",
          payload: { homePerson: "alice", awayPerson: "bob" },
          recordedAt: "2026-01-01T00:00:00.000Z",
          recordedBy: null,
        },
      ],
      model,
    );
    expect(Object.fromEntries(rows.map((r) => [r.personId, r.stats.games]))).toEqual({
      alice: 1,
      bob: 1,
    });
  });

  it("resolves real copy for the metrics whose keys collide", () => {
    const fr = at("fr");
    const rowsFor = (sport: string) => declaredStatRows().filter((r) => r.sport === sport);
    const one = (sport: string, row: string, m: MsgFn) =>
      labelPlayerStats(sport, "1.0.0", { [row]: 1 }, m).find((l) => l.key === row)?.label;
    expect(rowsFor("badminton").some((r) => r.row === "sanctions")).toBe(true);
    expect(one("badminton", "sanctions", fr)).not.toBe(one("volleyball", "sanctions", fr));
    expect(one("tennis", "points", fr)).not.toBe(one("volleyball", "points", fr));
    expect(one("hockey", "so_goals", fr)).not.toBe(one("icehockey", "so_goals", fr));
  });

  it("still yields [] for a module build that no longer resolves", () => {
    expect(labelPlayerStats("football", "0.0.1-gone", { goals: 3 }, echo)).toEqual([]);
  });
});
