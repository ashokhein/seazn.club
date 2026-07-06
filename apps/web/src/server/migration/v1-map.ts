// v1 → v2 migration mapping (PROMPT-15 task 2, doc 07 note 5). PURE: no DB,
// no server-only — the migration script (scripts/migrate-v1-to-v2.ts) does the
// IO, these functions decide the shapes. The v1 interfaces mirror the dropped
// tables' rows, not app types (the v1 app code is deleted at cutover).

// ---------------------------------------------------------------------------
// v1 row shapes (the v1 baseline, db/migration/V001–V028, before V113)
// ---------------------------------------------------------------------------

export interface V1Tournament {
  id: string;
  org_id: string;
  season_id: string | null;
  sport: string;
  name: string;
  category: string; // 'kids' | 'adult' | 'open'
  format: string; // 'swiss_knockout' | 'progress_stepladder' | 'knockout' | 'round_robin'
  num_group_rounds: number;
  status: string; // 'setup' | 'group' | 'knockout' | 'final' | 'completed'
  result_mode: string; // 'win_loss' | 'score'
  points_win: number;
  points_draw: number;
  points_loss: number;
  allow_draws: boolean;
  use_progress_score: boolean;
  is_public: boolean;
  public_slug: string | null;
  starts_at: string | Date | null;
  created_at: string | Date;
}

export interface V1Player {
  id: string;
  tournament_id: string;
  name: string;
  seed: number;
  checked_in: boolean;
  image_storage_path?: string | null;
}

export interface V1Round {
  id: string;
  round_number: number;
  stage: string; // 'group' | 'playoff' | 'knockout' | 'final'
  name: string;
}

export interface V1Match {
  id: string;
  round_id: string;
  board_number: number;
  player1_id: string | null;
  player2_id: string | null;
  winner_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  is_draw: boolean;
  next_match_id: string | null;
  next_slot: number | null;
  is_bye: boolean;
  created_at: string | Date;
}

export interface V1SportPreset {
  sport_key: string;
  sport_name: string;
  result_mode: string;
  points_win: number;
  points_draw: number;
  points_loss: number;
  allow_draws: boolean;
  use_progress_score: boolean;
  is_system: boolean;
}

// ---------------------------------------------------------------------------
// Config & status mapping
// ---------------------------------------------------------------------------

export interface GenericConfig {
  resultMode: "win_loss" | "score";
  allowDraws: boolean;
  points: { w: number; d: number; l: number };
  progressScore: boolean;
}

/**
 * Every v1 tournament migrates to the `generic` module (spec 04 §8 ≈ v1
 * semantics). Deviation from doc 07 note 5's "or a real module when the old
 * sport key maps cleanly": no v1 sport maps without changing standings
 * semantics (v1 recorded only results/scores; real modules score differently),
 * and the acceptance bar is refolded outcomes == stored winners — generic
 * guarantees it. The old sport key survives as the org variant key (see
 * variantFromPreset) and in the division name.
 */
export function genericConfigFor(t: {
  result_mode: string;
  allow_draws: boolean;
  points_win: number;
  points_draw: number;
  points_loss: number;
  use_progress_score: boolean;
}): GenericConfig {
  return {
    resultMode: t.result_mode === "score" ? "score" : "win_loss",
    allowDraws: t.allow_draws,
    points: { w: t.points_win, d: t.points_draw, l: t.points_loss },
    progressScore: t.use_progress_score,
  };
}

/** v2 generic system variant the division points at (sync-sports seeds both). */
export function genericVariantFor(t: { result_mode: string }): string {
  return t.result_mode === "score" ? "score" : "win_loss";
}

export function divisionStatusFor(v1Status: string): "setup" | "active" | "completed" {
  if (v1Status === "setup") return "setup";
  if (v1Status === "completed") return "completed";
  return "active";
}

/** Competition status aggregated over its member tournaments. */
export function competitionStatusFor(v1Statuses: readonly string[]): string {
  if (v1Statuses.length === 0) return "draft";
  if (v1Statuses.every((s) => s === "completed")) return "completed";
  if (v1Statuses.every((s) => s === "setup")) return "draft";
  return "live";
}

/**
 * Consent for migrated persons (doc 07: minors default false). v1 showed
 * player names on public pages, so migration preserves that visibility —
 * except for kids-category tournaments, which stay private.
 */
export function consentFor(t: { is_public: boolean; category: string }): {
  public_name: boolean;
  public_photo: boolean;
} {
  const visible = t.is_public && t.category !== "kids";
  return { public_name: visible, public_photo: visible };
}

// ---------------------------------------------------------------------------
// Stage graph mapping
// ---------------------------------------------------------------------------

export interface StagePlan {
  seq: number;
  kind: "league" | "swiss" | "knockout" | "stepladder";
  name: string;
  config: Record<string, unknown>;
  /** v1 round ids → v2 round_no within this stage (renumbered from 1). */
  roundNo: Map<string, number>;
}

const STAGE_BUCKETS: Record<string, "table" | "playoff" | "knockout"> = {
  group: "table",
  playoff: "playoff",
  knockout: "knockout",
  final: "knockout",
};

/**
 * v1 rounds (flat, stage-labelled) → v2 stage graph. Buckets in play order:
 * group rounds → one table stage (league for round_robin, swiss otherwise),
 * playoff rounds → stepladder, knockout+final rounds → one knockout stage.
 */
export function stagePlanFor(
  format: string,
  rounds: readonly V1Round[],
): StagePlan[] {
  const ordered = [...rounds].sort((a, b) => a.round_number - b.round_number);
  const buckets = new Map<"table" | "playoff" | "knockout", V1Round[]>();
  for (const round of ordered) {
    const bucket = STAGE_BUCKETS[round.stage] ?? "table";
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(round);
  }

  const plans: StagePlan[] = [];
  let seq = 0;
  for (const bucket of ["table", "playoff", "knockout"] as const) {
    const bucketRounds = buckets.get(bucket);
    if (!bucketRounds || bucketRounds.length === 0) continue;
    seq += 1;
    const roundNo = new Map<string, number>();
    bucketRounds.forEach((r, i) => roundNo.set(r.id, i + 1));
    if (bucket === "table") {
      const kind = format === "round_robin" ? "league" : "swiss";
      plans.push({
        seq,
        kind,
        name: kind === "league" ? "League" : "Group rounds",
        config: kind === "swiss" ? { rounds: bucketRounds.length } : { legs: 1 },
        roundNo,
      });
    } else if (bucket === "playoff") {
      plans.push({ seq, kind: "stepladder", name: "Stepladder", config: {}, roundNo });
    } else {
      plans.push({ seq, kind: "knockout", name: "Knockout", config: {}, roundNo });
    }
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Result event mapping
// ---------------------------------------------------------------------------

export interface ResultEvent {
  type: "generic.result";
  payload: {
    winnerId?: string;
    p1Score?: number;
    p2Score?: number;
    isDraw?: boolean;
  };
}

/**
 * A decided v1 match → one synthetic generic.result payload (doc 07 note 5),
 * expressed in v2 entrant ids. Returns null for undecided matches and byes
 * (byes become award outcomes with no ledger, mirroring v2 generation).
 */
export function resultEventFor(
  match: V1Match,
  resultMode: string,
  entrantOf: (playerId: string) => string,
): ResultEvent | null {
  if (match.is_bye || !match.player1_id || !match.player2_id) return null;
  const hasScores = match.player1_score !== null && match.player2_score !== null;
  const decided = match.winner_id !== null || match.is_draw || hasScores;
  if (!decided) return null;

  if (resultMode === "score" && hasScores) {
    return {
      type: "generic.result",
      payload: {
        p1Score: match.player1_score as number,
        p2Score: match.player2_score as number,
      },
    };
  }
  if (match.is_draw) return { type: "generic.result", payload: { isDraw: true } };
  if (match.winner_id) {
    return { type: "generic.result", payload: { winnerId: entrantOf(match.winner_id) } };
  }
  // score rows recorded under win_loss mode: fall back to the score shape.
  if (hasScores) {
    return {
      type: "generic.result",
      payload: {
        p1Score: match.player1_score as number,
        p2Score: match.player2_score as number,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slugs & org variants
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

/** First free slug: base, base-2, base-3… against the taken set (mutates it). */
export function uniqueSlug(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`.slice(0, 80);
  taken.add(candidate);
  return candidate;
}

/** org_sport_preset → org-scoped generic sport_variant (doc 07 note 5). */
export function variantFromPreset(preset: V1SportPreset): {
  sport_key: "generic";
  key: string;
  name: string;
  config: GenericConfig;
} {
  return {
    sport_key: "generic",
    key: slugify(preset.sport_key),
    name: preset.sport_name,
    config: genericConfigFor(preset),
  };
}
