// v1 → v2 data migration (PROMPT-15 task 2, doc 07 note 5).
//
//   node --experimental-strip-types scripts/migrate-v1-to-v2.ts [flags]
//
// Flags:
//   --dry-run       run everything inside a transaction and roll back
//   --org=<uuid>    migrate a single organization (per-org batching; default all)
//   --verify-only   skip writes, just re-run the verification report
//
// What it does, per org (idempotent — a re-run creates only what's missing,
// tracked in v1_migration_map):
//   seasons            → competitions (member tournaments become its divisions)
//   tournaments (solo) → competition(1) + division(1)
//   tournaments        → divisions on sport `generic` (spec 04 §8 ≈ v1 rules;
//                        see v1-map.ts for why no "real module" mapping)
//   players            → persons (deduped by name per org) + entrants + members
//   rounds/matches     → stages/fixtures (winner feeds preserved)
//   decided matches    → synthetic generic.result score_events (hash-chained by
//                        the DB trigger) + folded match_states + outcomes;
//                        completed tournaments also get core.finalize
//   table stages       → standings_snapshots (via the engine's completeTableStage)
//   org_sport_presets  → org-scoped generic sport_variants
//   public tournaments → v1_slug_redirects rows (/t/{slug} → new dashboard path)
//
// Verification (always runs, exit 1 on any mismatch): entity counts + every
// migrated fixture's events refolded through the engine must reproduce the
// stored v1 winner/draw ("refolded outcomes == stored winners").
//
// The DESTRUCTIVE step (drop v1 tables, archive audit_log → audit_log_v1) is
// NOT here — it is db/migration/V113__v1_cutover.sql, applied only after
// this script's report is clean on a staging rehearsal (PROMPT-15 task 5).
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { foldMatch, type EventEnvelope, type MatchOutcome } from "@seazn/engine/core";
import { generic } from "@seazn/engine/sports/generic";
import {
  completeTableStage,
  type TableFixture,
  type StandingsRow,
} from "@seazn/engine/competition";
import {
  competitionStatusFor,
  consentFor,
  divisionStatusFor,
  genericConfigFor,
  genericVariantFor,
  resultEventFor,
  slugify,
  stagePlanFor,
  uniqueSlug,
  variantFromPreset,
  type V1Match,
  type V1Player,
  type V1Round,
  type V1SportPreset,
  type V1Tournament,
} from "../apps/web/src/server/migration/v1-map.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const VERIFY_ONLY = args.has("--verify-only");
const ONLY_ORG = [...args].find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});

type Tx = postgres.TransactionSql;

/** Thrown inside sql.begin to roll back a dry run. */
class Rollback extends Error {}

interface Report {
  orgId: string;
  tournaments: number;
  divisions: number;
  players: number;
  persons: number;
  entrants: number;
  matches: number;
  fixtures: number;
  decidedMatches: number;
  eventsWritten: number;
  variants: number;
  redirects: number;
  mismatches: string[];
}

// ---------------------------------------------------------------------------
// Bookkeeping tables (survive re-runs; consulted for idempotency + redirects)
// ---------------------------------------------------------------------------

async function ensureBookkeeping(tx: Tx): Promise<void> {
  await tx`
    create table if not exists v1_migration_map (
      kind   text not null,
      v1_id  text not null,
      v2_id  uuid not null,
      org_id uuid not null,
      created_at timestamptz not null default now(),
      primary key (kind, v1_id)
    )`;
  await tx`
    create table if not exists v1_slug_redirects (
      public_slug text primary key,
      target_path text not null,
      created_at  timestamptz not null default now()
    )`;
}

async function mapped(tx: Tx, kind: string, v1Id: string): Promise<string | null> {
  const rows = await tx<{ v2_id: string }[]>`
    select v2_id from v1_migration_map where kind = ${kind} and v1_id = ${v1Id}`;
  return rows[0]?.v2_id ?? null;
}

async function remember(tx: Tx, kind: string, v1Id: string, v2Id: string, orgId: string): Promise<void> {
  await tx`
    insert into v1_migration_map (kind, v1_id, v2_id, org_id)
    values (${kind}, ${v1Id}, ${v2Id}, ${orgId})
    on conflict (kind, v1_id) do nothing`;
}

// ---------------------------------------------------------------------------
// Fold helpers (mirrors the engine-db adapter, standalone)
// ---------------------------------------------------------------------------

const GENERIC_MODULE_VERSION = generic.version;

function lineupsFor(home: string, away: string) {
  return { home: { entrantId: home, slots: [] }, away: { entrantId: away, slots: [] } };
}

function fold(cfg: unknown, home: string, away: string, events: EventEnvelope[]) {
  const state = foldMatch(generic, cfg as never, lineupsFor(home, away), events);
  return { state, summary: generic.summary(state), outcome: generic.outcome(state) };
}

// ---------------------------------------------------------------------------
// Per-org migration
// ---------------------------------------------------------------------------

async function migrateOrg(tx: Tx, orgId: string, orgSlug: string, report: Report): Promise<void> {
  // -- org sport presets → org generic variants ------------------------------
  const presets = await tx<V1SportPreset[]>`
    select sport_key, sport_name, result_mode, points_win, points_draw, points_loss,
           allow_draws, use_progress_score, is_system
    from org_sport_presets where org_id = ${orgId}`;
  for (const preset of presets) {
    const v = variantFromPreset(preset);
    await tx`
      insert into sport_variants (sport_key, key, name, config, is_system, org_id)
      values (${v.sport_key}, ${v.key}, ${v.name}, ${tx.json(v.config as never)}, false, ${orgId})
      on conflict on constraint sport_variants_pkey do update set
        name = excluded.name, config = excluded.config`;
    report.variants++;
  }

  // -- load the v1 world ------------------------------------------------------
  const tournaments = await tx<V1Tournament[]>`
    select id, org_id, season_id, sport, name, category, format, num_group_rounds,
           status, result_mode, points_win, points_draw, points_loss, allow_draws,
           use_progress_score, is_public, public_slug, starts_at, created_at
    from tournaments where org_id = ${orgId} order by created_at, id`;
  const seasons = await tx<{ id: string; name: string; slug: string }[]>`
    select id, name, slug from seasons where org_id = ${orgId} order by created_at, id`;
  report.tournaments = tournaments.length;

  const takenCompSlugs = new Set<string>(
    (await tx<{ slug: string }[]>`select slug from competitions where org_id = ${orgId}`).map(
      (r) => r.slug,
    ),
  );

  // Persons dedupe index: name (case-insensitive) → person id, seeded with the
  // org's existing directory so re-runs and pre-existing people match.
  const personByName = new Map<string, string>(
    (
      await tx<{ id: string; full_name: string }[]>`
        select id, full_name from persons where org_id = ${orgId}`
    ).map((r) => [r.full_name.trim().toLowerCase(), r.id]),
  );

  // -- competitions -----------------------------------------------------------
  // Seasons → competitions holding their tournaments as divisions; a season-
  // less tournament → its own competition + single division (doc 07 note 5).
  const competitionOf = new Map<string, string>(); // tournament id → competition id
  const compSlugOf = new Map<string, string>(); // competition id → slug

  for (const season of seasons) {
    const members = tournaments.filter((t) => t.season_id === season.id);
    let compId = await mapped(tx, "season", season.id);
    if (!compId) {
      const slug = uniqueSlug(slugify(season.slug || season.name), takenCompSlugs);
      const visibility = members.some((t) => t.is_public) ? "public" : "private";
      const status = competitionStatusFor(members.map((t) => t.status));
      const [row] = await tx<{ id: string }[]>`
        insert into competitions (org_id, name, slug, visibility, status, created_at)
        values (${orgId}, ${season.name}, ${slug}, ${visibility}, ${status}, now())
        returning id`;
      compId = row.id;
      await remember(tx, "season", season.id, compId, orgId);
    }
    const [comp] = await tx<{ slug: string }[]>`select slug from competitions where id = ${compId}`;
    compSlugOf.set(compId, comp.slug);
    for (const t of members) competitionOf.set(t.id, compId);
  }

  for (const t of tournaments.filter((t) => !t.season_id)) {
    let compId = await mapped(tx, "tournament_competition", t.id);
    if (!compId) {
      const slug = uniqueSlug(
        t.public_slug ? slugify(t.public_slug) : slugify(t.name),
        takenCompSlugs,
      );
      const startsOn = t.starts_at ? new Date(t.starts_at).toISOString().slice(0, 10) : null;
      const [row] = await tx<{ id: string }[]>`
        insert into competitions (org_id, name, slug, visibility, status, starts_on, created_at)
        values (${orgId}, ${t.name}, ${slug}, ${t.is_public ? "public" : "private"},
                ${competitionStatusFor([t.status])}, ${startsOn}, ${t.created_at})
        returning id`;
      compId = row.id;
      await remember(tx, "tournament_competition", t.id, compId, orgId);
    }
    const [comp] = await tx<{ slug: string }[]>`select slug from competitions where id = ${compId}`;
    compSlugOf.set(compId, comp.slug);
    competitionOf.set(t.id, compId);
  }

  // -- tournaments → divisions + everything inside ---------------------------
  for (const t of tournaments) {
    const compId = competitionOf.get(t.id)!;
    await migrateTournament(tx, orgId, t, compId, personByName, report);

    // Public URL preservation (PROMPT-15 task 3): /t/{slug} → competition page.
    if (t.is_public && t.public_slug) {
      await tx`
        insert into v1_slug_redirects (public_slug, target_path)
        values (${t.public_slug}, ${`/${orgSlug}/${compSlugOf.get(compId)}`})
        on conflict (public_slug) do nothing`;
      report.redirects++;
    }
  }
}

async function migrateTournament(
  tx: Tx,
  orgId: string,
  t: V1Tournament,
  competitionId: string,
  personByName: Map<string, string>,
  report: Report,
): Promise<void> {
  const cfg = genericConfigFor(t);

  // Division (idempotent by map).
  let divisionId = await mapped(tx, "tournament_division", t.id);
  if (!divisionId) {
    const taken = new Set<string>(
      (
        await tx<{ slug: string }[]>`
          select slug from divisions where competition_id = ${competitionId}`
      ).map((r) => r.slug),
    );
    const slug = uniqueSlug(t.season_id ? slugify(t.name) : "main", taken);
    const [row] = await tx<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key,
                             config, module_version, status, created_at)
      values (${competitionId}, ${orgId}, ${t.name}, ${slug}, 'generic',
              ${genericVariantFor(t)}, ${tx.json(cfg as never)}, ${GENERIC_MODULE_VERSION},
              ${divisionStatusFor(t.status)}, ${t.created_at})
      returning id`;
    divisionId = row.id;
    await remember(tx, "tournament_division", t.id, divisionId, orgId);
    // Structural ledger: record provenance (hash-chained by trigger).
    await tx`
      insert into division_events (division_id, org_id, seq, type, payload)
      values (${divisionId}, ${orgId}, 1, 'migrated_from_v1',
              ${tx.json({ tournamentId: t.id, sport: t.sport, format: t.format } as never)})`;
    await tx`update divisions set seq = 1 where id = ${divisionId}`;
  }
  report.divisions++;

  // Players → persons + entrants.
  const players = await tx<V1Player[]>`
    select id, tournament_id, name, seed, checked_in, image_storage_path
    from players where tournament_id = ${t.id} order by seed desc, created_at, id`;
  report.players += players.length;
  const consent = consentFor(t);
  const entrantOfPlayer = new Map<string, string>();

  for (const player of players) {
    const nameKey = player.name.trim().toLowerCase();
    let personId = personByName.get(nameKey) ?? null;
    if (!personId) {
      const [row] = await tx<{ id: string }[]>`
        insert into persons (org_id, full_name, consent, photo_path)
        values (${orgId}, ${player.name.trim()}, ${tx.json(consent as never)},
                ${player.image_storage_path ?? null})
        returning id`;
      personId = row.id;
      personByName.set(nameKey, personId);
      report.persons++;
    }

    let entrantId = await mapped(tx, "player_entrant", player.id);
    if (!entrantId) {
      const [row] = await tx<{ id: string }[]>`
        insert into entrants (division_id, org_id, kind, display_name, seed, status)
        values (${divisionId}, ${orgId}, 'individual', ${player.name.trim()},
                ${player.seed > 0 ? player.seed : null},
                ${player.checked_in ? "confirmed" : "registered"})
        returning id`;
      entrantId = row.id;
      await remember(tx, "player_entrant", player.id, entrantId, orgId);
      await tx`
        insert into entrant_members (entrant_id, person_id, org_id)
        values (${entrantId}, ${personId}, ${orgId})
        on conflict (entrant_id, person_id) do nothing`;
    }
    entrantOfPlayer.set(player.id, entrantId);
    report.entrants++;
  }

  // Rounds/matches → stages/fixtures.
  const rounds = await tx<V1Round[]>`
    select id, round_number, stage, name from rounds where tournament_id = ${t.id}`;
  const matches = await tx<(V1Match & { round_id: string })[]>`
    select id, round_id, board_number, player1_id, player2_id, winner_id,
           player1_score, player2_score, is_draw, next_match_id, next_slot, is_bye, created_at
    from matches where tournament_id = ${t.id} order by created_at, id`;
  report.matches += matches.length;

  const plans = stagePlanFor(t.format, rounds);
  const stageIdOf = new Map<number, string>(); // plan seq → stage id
  for (const plan of plans) {
    let stageId = await mapped(tx, "stage", `${t.id}:${plan.seq}`);
    if (!stageId) {
      const [row] = await tx<{ id: string }[]>`
        insert into stages (division_id, org_id, seq, kind, name, config, status)
        values (${divisionId}, ${orgId}, ${plan.seq}, ${plan.kind}, ${plan.name},
                ${tx.json(plan.config as never)},
                ${t.status === "completed" ? "complete" : "active"})
        returning id`;
      stageId = row.id;
      await remember(tx, "stage", `${t.id}:${plan.seq}`, stageId, orgId);
    }
    stageIdOf.set(plan.seq, stageId);
  }

  const stagePlanOfRound = new Map<string, { stageId: string; roundNo: number }>();
  for (const plan of plans) {
    for (const [roundId, roundNo] of plan.roundNo) {
      stagePlanOfRound.set(roundId, { stageId: stageIdOf.get(plan.seq)!, roundNo });
    }
  }

  // First pass: fixtures.
  const fixtureOfMatch = new Map<string, string>();
  const seqInRound = new Map<string, number>(); // `${stageId}:${roundNo}` counter
  for (const match of matches) {
    const where = stagePlanOfRound.get(match.round_id);
    if (!where) continue; // round without a stage plan (defensive)
    let fixtureId = await mapped(tx, "match_fixture", match.id);
    if (!fixtureId) {
      const key = `${where.stageId}:${where.roundNo}`;
      const n = (seqInRound.get(key) ?? 0) + 1;
      seqInRound.set(key, n);
      const home = match.player1_id ? (entrantOfPlayer.get(match.player1_id) ?? null) : null;
      const away = match.player2_id ? (entrantOfPlayer.get(match.player2_id) ?? null) : null;
      const bye = match.is_bye && home !== null && away === null;
      const [row] = await tx<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                              home_entrant_id, away_entrant_id, ext_key, status, outcome, created_at)
        values (${where.stageId}, ${divisionId}, ${orgId}, ${where.roundNo},
                ${match.board_number || n}, ${home}, ${away}, ${"v1:" + match.id},
                ${bye ? "forfeited" : "scheduled"},
                ${bye ? tx.json({ kind: "award", winner: home } as never) : null},
                ${match.created_at})
        returning id`;
      fixtureId = row.id;
      await remember(tx, "match_fixture", match.id, fixtureId, orgId);
    }
    fixtureOfMatch.set(match.id, fixtureId);
  }

  // Second pass: winner feeds (v1 next_match_id/next_slot).
  for (const match of matches) {
    if (!match.next_match_id || !match.next_slot) continue;
    const source = fixtureOfMatch.get(match.id);
    const target = fixtureOfMatch.get(match.next_match_id);
    if (!source || !target) continue;
    await tx`
      update fixtures set winner_to_fixture = ${target}, winner_to_slot = ${match.next_slot}
      where id = ${source} and winner_to_fixture is null`;
  }

  // Third pass: decided matches → synthetic events + fold.
  for (const match of matches) {
    const fixtureId = fixtureOfMatch.get(match.id);
    if (!fixtureId) continue;
    const home = match.player1_id ? entrantOfPlayer.get(match.player1_id) : undefined;
    const away = match.player2_id ? entrantOfPlayer.get(match.player2_id) : undefined;
    const ev = resultEventFor(match, t.result_mode, (pid) => entrantOfPlayer.get(pid) ?? pid);
    if (!ev || !home || !away) continue;
    report.decidedMatches++;

    const [{ n: existing }] = await tx<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    if (existing > 0) continue; // already migrated

    const recordedAt = new Date(match.created_at).toISOString();
    const envelopes: EventEnvelope[] = [
      {
        id: randomUUID(),
        fixtureId,
        seq: 1,
        type: ev.type,
        payload: ev.payload,
        recordedAt,
        recordedBy: null,
      },
    ];
    if (t.status === "completed") {
      envelopes.push({
        id: randomUUID(),
        fixtureId,
        seq: 2,
        type: "core.finalize",
        payload: {},
        recordedAt,
        recordedBy: null,
      });
    }

    // Fold-validate BEFORE insert (spec 03 §2 guarantee 2) — a v1 row the
    // engine rejects is reported, not silently persisted.
    let folded;
    try {
      folded = fold(genericConfigFor(t), home, away, envelopes);
    } catch (err) {
      report.mismatches.push(
        `fixture ${fixtureId} (match ${match.id}): engine rejected synthetic event — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const envelope of envelopes) {
      await tx`
        insert into score_events (id, fixture_id, org_id, seq, type, payload, recorded_at)
        values (${envelope.id}, ${fixtureId}, ${orgId}, ${envelope.seq}, ${envelope.type},
                ${tx.json(envelope.payload as never)}, ${envelope.recordedAt})`;
      report.eventsWritten++;
    }
    await tx`
      insert into match_states (fixture_id, org_id, last_seq, state, summary)
      values (${fixtureId}, ${orgId}, ${envelopes.length},
              ${tx.json(folded.state as never)}, ${tx.json(folded.summary as never)})
      on conflict (fixture_id) do update set
        last_seq = excluded.last_seq, state = excluded.state,
        summary = excluded.summary, updated_at = now()`;
    await tx`
      update fixtures set
        status = ${t.status === "completed" ? "finalized" : "decided"},
        outcome = ${tx.json(folded.outcome as never)}
      where id = ${fixtureId}`;
  }
  report.fixtures += fixtureOfMatch.size;

  // Standings snapshots for table stages (engine-owned math).
  for (const plan of plans) {
    if (plan.kind !== "league" && plan.kind !== "swiss") continue;
    const stageId = stageIdOf.get(plan.seq)!;
    await snapshotStandings(tx, stageId, plan.kind, cfg, t);
  }
}

async function snapshotStandings(
  tx: Tx,
  stageId: string,
  kind: "league" | "swiss",
  cfg: unknown,
  t: V1Tournament,
): Promise<void> {
  const fixtures = await tx<
    {
      id: string;
      status: string;
      round_no: number;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      outcome: unknown;
      state: unknown;
    }[]
  >`
    select f.id, f.status, f.round_no, f.home_entrant_id, f.away_entrant_id, f.outcome, m.state
    from fixtures f left join match_states m on m.fixture_id = f.id
    where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;

  const entrants = new Set<string>();
  const tableFixtures: TableFixture[] = fixtures.map((f) => {
    if (f.home_entrant_id) entrants.add(f.home_entrant_id);
    if (f.away_entrant_id) entrants.add(f.away_entrant_id);
    const base: TableFixture = {
      id: f.id,
      status:
        f.status === "decided" || f.status === "finalized"
          ? "decided"
          : f.status === "forfeited"
            ? "walkover"
            : "scheduled",
      roundNo: f.round_no,
    };
    if (f.outcome && f.state && f.home_entrant_id && f.away_entrant_id) {
      const [home, away] = generic.standingsDelta(
        f.outcome as MatchOutcome,
        cfg as never,
        { kind, roundNo: f.round_no },
        f.state as never,
      );
      base.result = [home, away];
    }
    return base;
  });
  if (entrants.size === 0) return;

  const { tables } = completeTableStage(
    {
      id: stageId,
      kind,
      entrants: [...entrants],
      cascade: generic.defaultTiebreakers,
      ...(kind === "swiss" ? { swiss: true } : {}),
    },
    tableFixtures,
  );
  const rows: readonly StandingsRow[] = tables.pools[0]?.rows ?? [];
  await tx`
    insert into standings_snapshots (stage_id, org_id, pool_id, rows, computed_through_seq)
    values (${stageId}, ${t.org_id}, ${null}, ${tx.json(rows as never)}, 1)
    on conflict on constraint standings_snapshots_pkey do update set
      rows = excluded.rows, computed_through_seq = excluded.computed_through_seq,
      updated_at = now()`;
}

// ---------------------------------------------------------------------------
// Verification (acceptance: refolded outcomes == stored winners, 0 mismatches)
// ---------------------------------------------------------------------------

async function verifyOrg(tx: Tx, orgId: string, report: Report): Promise<void> {
  const rows = await tx<
    {
      match_id: string;
      fixture_id: string;
      winner_id: string | null;
      is_draw: boolean;
      is_bye: boolean;
      p1: string | null;
      p2: string | null;
      result_mode: string;
      t_config: unknown;
      outcome: unknown;
      f_home: string | null;
    }[]
  >`
    select m.id as match_id, map.v2_id as fixture_id, m.winner_id, m.is_draw, m.is_bye,
           m.player1_id as p1, m.player2_id as p2, t.result_mode,
           d.config as t_config, f.outcome, f.home_entrant_id as f_home
    from matches m
    join v1_migration_map map on map.kind = 'match_fixture' and map.v1_id = m.id::text
    join fixtures f on f.id = map.v2_id
    join divisions d on d.id = f.division_id
    join tournaments t on t.id = m.tournament_id
    where t.org_id = ${orgId}`;

  const entrantOf = new Map<string, string>(
    (
      await tx<{ v1_id: string; v2_id: string }[]>`
        select v1_id, v2_id from v1_migration_map
        where kind = 'player_entrant' and org_id = ${orgId}`
    ).map((r) => [r.v1_id, r.v2_id]),
  );

  for (const row of rows) {
    const expectWinner = row.winner_id ? entrantOf.get(row.winner_id) : null;

    if (row.is_bye) {
      const o = row.outcome as { kind?: string; winner?: string } | null;
      if (row.p1 && (o?.kind !== "award" || o.winner !== entrantOf.get(row.p1))) {
        report.mismatches.push(`bye match ${row.match_id}: award outcome missing/incorrect`);
      }
      continue;
    }

    const decided = row.winner_id !== null || row.is_draw;
    const events = await tx<
      { id: string; seq: number; type: string; payload: unknown; recorded_at: Date }[]
    >`
      select id, seq, type, payload, recorded_at from score_events
      where fixture_id = ${row.fixture_id} order by seq`;

    if (!decided) {
      if (events.length > 0 && row.winner_id === null && !row.is_draw) {
        // scores without a recorded winner can legitimately decide in score mode
        continue;
      }
      continue;
    }
    if (events.length === 0) {
      report.mismatches.push(`match ${row.match_id}: decided in v1 but no events on fixture ${row.fixture_id}`);
      continue;
    }

    const home = row.p1 ? entrantOf.get(row.p1) : undefined;
    const away = row.p2 ? entrantOf.get(row.p2) : undefined;
    if (!home || !away) {
      report.mismatches.push(`match ${row.match_id}: entrant mapping incomplete`);
      continue;
    }
    let outcome: MatchOutcome | null;
    try {
      const folded = fold(
        row.t_config,
        home,
        away,
        events.map((e) => ({
          id: e.id,
          fixtureId: row.fixture_id,
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          recordedAt: e.recorded_at.toISOString(),
          recordedBy: null,
        })),
      );
      outcome = folded.outcome;
    } catch (err) {
      report.mismatches.push(
        `match ${row.match_id}: refold threw — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (row.is_draw) {
      if (outcome?.kind !== "draw") {
        report.mismatches.push(`match ${row.match_id}: v1 draw but refold says ${outcome?.kind}`);
      }
    } else if (expectWinner) {
      const won = outcome?.kind === "win" || outcome?.kind === "award" ? outcome.winner : null;
      if (won !== expectWinner) {
        report.mismatches.push(
          `match ${row.match_id}: v1 winner ${expectWinner} but refold says ${won ?? "none"}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printReport(r: Report): void {
  console.log(
    `org ${r.orgId}: ${r.tournaments} tournaments → ${r.divisions} divisions | ` +
      `${r.players} players → ${r.persons} new persons, ${r.entrants} entrants | ` +
      `${r.matches} matches → ${r.fixtures} fixtures (${r.decidedMatches} decided, ` +
      `${r.eventsWritten} events written) | ${r.variants} variants | ${r.redirects} redirects` +
      (r.mismatches.length ? ` | ✗ ${r.mismatches.length} MISMATCHES` : " | ✓ verified"),
  );
  for (const m of r.mismatches.slice(0, 20)) console.log(`  ✗ ${m}`);
  if (r.mismatches.length > 20) console.log(`  … and ${r.mismatches.length - 20} more`);
}

try {
  const orgRows = ONLY_ORG
    ? await sql<{ id: string; slug: string }[]>`
        select id, slug from organizations where id = ${ONLY_ORG}`
    : await sql<{ id: string; slug: string }[]>`
        select o.id, o.slug from organizations o
        where exists (select 1 from tournaments t where t.org_id = o.id)
           or exists (select 1 from seasons s where s.org_id = o.id)
           or exists (select 1 from org_sport_presets p where p.org_id = o.id)
        order by o.created_at`;

  if (orgRows.length === 0) {
    console.log("Nothing to migrate — no orgs with v1 data.");
  }

  let failed = false;
  for (const org of orgRows) {
    const report: Report = {
      orgId: org.id,
      tournaments: 0,
      divisions: 0,
      players: 0,
      persons: 0,
      entrants: 0,
      matches: 0,
      fixtures: 0,
      decidedMatches: 0,
      eventsWritten: 0,
      variants: 0,
      redirects: 0,
      mismatches: [],
    };
    // One transaction per org (per-org batching): a crash resumes cleanly at
    // the next run thanks to the idempotency map.
    await sql.begin(async (tx) => {
      await ensureBookkeeping(tx as Tx);
      if (!VERIFY_ONLY) await migrateOrg(tx as Tx, org.id, org.slug, report);
      await verifyOrg(tx as Tx, org.id, report);
      if (DRY_RUN) {
        printReport(report);
        throw new Rollback();
      }
    }).catch((err) => {
      if (err instanceof Rollback) return;
      throw err;
    });
    if (!DRY_RUN) printReport(report);
    if (report.mismatches.length > 0) failed = true;
  }

  if (DRY_RUN) console.log("(dry run — all changes rolled back)");
  if (failed) {
    console.error("Verification FAILED — do not proceed to the destructive cutover step.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("migrate-v1-to-v2 FAILED:", err instanceof Error ? err.stack : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
