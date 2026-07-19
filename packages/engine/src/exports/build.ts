// buildDocModel (Jul3/06 §2) — pure view-model builders for the sport-neutral
// document kinds. Scoping/page-break knobs mirror the scoped-clear filters
// (Jul3/03 §5). Sport-specific fragments (scoresheets, match reports) come
// from SportModule.exportTemplates (§3).
import type {
  BuildOpts,
  DocModel,
  DocSection,
  ExportFixture,
  ExportOfficialSchedule,
  ExportParticipantRow,
  ExportRosterTeam,
  ExportStandingsRow,
  ExportTicket,
} from "./types.ts";
import { EngineError } from "../core/errors.ts";
import { doubleElimBracket, twoSidedBracket } from "../scheduling/bracket-layout.ts";

function base(
  kind: DocModel["kind"],
  title: string,
  sections: DocSection[],
  opts: BuildOpts,
): DocModel {
  return {
    kind,
    title,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    meta: {
      printedAt: opts.printedAt,
      ...(opts.footerNote !== undefined ? { footerNote: opts.footerNote } : {}),
      ...(opts.liveUrl !== undefined ? { liveUrl: opts.liveUrl } : {}),
    },
    ...(opts.branding !== undefined ? { branding: opts.branding } : {}),
    sections,
    pageBreaks: opts.pageBreaks ?? "auto",
  };
}

const timeOf = (f: ExportFixture): string => (f.at === null ? "TBD" : f.at);

function fixtureRows(fixtures: readonly ExportFixture[]): (string | number)[][] {
  return fixtures.map((f) => [
    timeOf(f),
    f.court ?? "—",
    f.home,
    f.result ?? "vs",
    f.away,
    f.stageName,
  ]);
}

const TIMETABLE_COLUMNS = ["Time", "Court", "Home", "", "Away", "Stage"];

/** Timetable (2 Jul "pretty PDF"): grouped by page-break scope; stages keep
 *  their own headings so prelim vs KO read separately (1 Sep). */
export function buildTimetable(
  title: string,
  fixtures: readonly ExportFixture[],
  opts: BuildOpts,
): DocModel {
  const mode = opts.pageBreaks ?? "auto";
  const sections: DocSection[] = [];
  const keyOf = (f: ExportFixture): string =>
    mode === "per_pitch"
      ? (f.court ?? "Unassigned")
      : mode === "per_division"
        ? (f.divisionName ?? "")
        : "";
  const groups = new Map<string, ExportFixture[]>();
  for (const f of fixtures) {
    const k = keyOf(f);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  for (const [group, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // stage sub-grouping inside each page group (prelim vs KO)
    const byStage = new Map<string, ExportFixture[]>();
    for (const f of list) {
      (byStage.get(f.stageName) ?? byStage.set(f.stageName, []).get(f.stageName)!).push(f);
    }
    let first = true;
    for (const [stageName, stageFixtures] of byStage) {
      sections.push({
        ...(group !== "" && first ? { heading: group } : {}),
        subheading: stageName,
        table: { columns: TIMETABLE_COLUMNS, rows: fixtureRows(stageFixtures) },
        ...(group !== "" && first && sections.length > 0 ? { pageBreakBefore: true } : {}),
      });
      first = false;
    }
  }
  return base("timetable", title, sections, opts);
}

/** Standings (29 May landscape): base columns + the sport's metric ledger. */
export function buildStandings(
  title: string,
  rows: readonly ExportStandingsRow[],
  opts: BuildOpts,
): DocModel {
  const metricColumns = opts.metricColumns ?? [];
  const columns = ["#", "Team", "P", "W", "D", "L", ...metricColumns, "Pts"];
  const hasBadges = rows.some((r) => r.badgeUrl != null);
  const table = {
    columns,
    rows: rows.map((r, i) => [
      i + 1,
      r.name,
      r.played,
      r.won,
      r.drawn,
      r.lost,
      ...metricColumns.map((m) => r.metrics[m] ?? 0),
      r.points,
    ]),
    ...(opts.landscape === true ? { landscape: true } : {}),
    // PROMPT-60: aligned per-row crest URLs; omitted when nobody has one so
    // the plain (badge-free) output is byte-identical to before.
    ...(hasBadges ? { rowBadges: rows.map((r) => r.badgeUrl ?? null) } : {}),
  };
  return base("standings", title, [{ table }], opts);
}

/** Roster form (13 May): team + player list with sign-at-start lines. */
export function buildRoster(
  title: string,
  teams: readonly ExportRosterTeam[],
  opts: BuildOpts,
): DocModel {
  const perTeam = (opts.pageBreaks ?? "auto") === "per_team";
  const sections: DocSection[] = teams.map((t, i) => ({
    heading: t.clubName !== undefined ? `${t.clubName} — ${t.teamName}` : t.teamName,
    table: {
      columns: ["#", "Name", "DOB", "Signature"],
      rows: t.players.map((p) => [p.number ?? "", p.name, p.dob ?? "", ""]),
    },
    signatures: ["Team captain", "Official"],
    ...(perTeam && i > 0 ? { pageBreakBefore: true } : {}),
  }));
  return base("roster", title, sections, opts);
}

/** Participant overview (17 Mar / 30 Jan): club + division columns, Empty-
 *  Spot labels never blank. */
export function buildParticipants(
  title: string,
  rows: readonly ExportParticipantRow[],
  opts: BuildOpts,
): DocModel {
  return base(
    "participants",
    title,
    [
      {
        table: {
          columns: ["Club", "Team", "Division", "Entrant", "Player", "#", "Position"],
          rows: rows.map((r) => [
            r.club,
            r.team,
            r.division,
            r.entrant,
            r.player,
            r.number ?? "",
            r.position,
          ]),
        },
      },
    ],
    opts,
  );
}

const ROTA_COLUMNS = ["When", "Court", "Competition · Division", "Role", "Match", "Response"];

/** Officials rota (v12/PROMPT-58): one section per official, duties table +
 *  sign-on/off block; zero-duty officials still get a page (13 May pattern). */
export function buildOfficialsRota(
  title: string,
  officials: readonly ExportOfficialSchedule[],
  opts: BuildOpts,
): DocModel {
  const perOfficial = (opts.pageBreaks ?? "auto") === "per_team";
  const sections: DocSection[] = officials.map((o, i) => ({
    heading: o.officialName,
    ...(o.duties.length === 0 ? { subheading: "No duties assigned" } : {}),
    ...(o.duties.length > 0
      ? {
          table: {
            columns: ROTA_COLUMNS,
            rows: o.duties.map((d) => [
              d.at,
              d.court ?? "—",
              d.compDivision,
              d.role,
              d.opponents,
              d.response === "accepted" ? "Accepted" : d.response === "declined" ? "Declined" : "Pending",
            ]),
            landscape: true,
          },
        }
      : {}),
    signatures: ["Official signature", "Time on", "Time off"],
    ...(perOfficial && i > 0 ? { pageBreakBefore: true } : {}),
  }));
  return base("officials_rota", title, sections, opts);
}

/** Admit tickets (v12/Task 11): one 2-up section per ticket; the QR is carried
 *  as a URL on the model — pixels are never generated here (Task 12 draws it). */
export function buildAdmitTickets(
  title: string,
  tickets: readonly ExportTicket[],
  opts: BuildOpts,
): DocModel {
  const sections: DocSection[] = tickets.map((t) => ({ columnsHint: 2, ticket: t }));
  return base("admit_ticket", title, sections, opts);
}

// ---------------------------------------------------------------------------
// Bracket results-poster (PROMPT-62 §4) — the twoSidedBracket layout with
// names/headlines resolved into a DocBracket payload. Landscape by nature;
// the renderer scales it onto ONE sheet. Throws CONFIG_INVALID for shapes the
// two-sided geometry can't lay out (double-elim, stepladder, partial data).
// ---------------------------------------------------------------------------

export interface ExportBracketFixture {
  id: string;
  round_no: number;
  seq_in_round: number;
  home: string | null; // resolved display name; null = unresolved feed
  away: string | null;
  headline: string | null;
  decided: boolean;
}

function bracketRoundLabel(fromEnd: number): string {
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi-finals";
  if (fromEnd === 2) return "Quarter-finals";
  return `Round of ${2 ** (fromEnd + 1)}`;
}

export function buildBracket(
  title: string,
  fixtures: readonly ExportBracketFixture[],
  opts: BuildOpts,
): DocModel {
  const result = twoSidedBracket(fixtures);
  if (!result.ok) {
    throw new EngineError("CONFIG_INVALID", `bracket poster: ${result.reason}`, {});
  }
  const layout = result.layout;
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const rowsPerSide = Math.max(
    1,
    layout.nodes.filter((n) => n.col === 0 && n.side === "L").length,
  );
  return {
    ...base("bracket", title, [], opts),
    bracket: {
      nodes: layout.nodes.map((n) => {
        const f = byId.get(n.fixtureId)!;
        return {
          fixtureId: n.fixtureId,
          side: n.side,
          col: n.col,
          row: n.row,
          home: f.home ?? "TBD",
          away: f.away ?? "TBD",
          headline: f.headline,
          decided: f.decided,
        };
      }),
      connectors: layout.connectors,
      rounds: layout.rounds,
      colsPerSide: layout.colsPerSide,
      rowsPerSide,
      roundLabels: Array.from({ length: layout.rounds }, (_, i) =>
        bracketRoundLabel(layout.rounds - 1 - i),
      ),
      ...(layout.thirdPlaceId !== undefined ? { thirdPlaceId: layout.thirdPlaceId } : {}),
    },
  };
}

export function buildBracketDe(
  title: string,
  fixtures: readonly ExportBracketFixture[],
  laneLabels: { winners: string; losers: string; grandFinal: string; reset: string },
  opts: BuildOpts,
): DocModel {
  const result = doubleElimBracket(fixtures);
  if (!result.ok) {
    throw new EngineError("CONFIG_INVALID", `double-elim poster: ${result.reason}`, {});
  }
  const layout = result.layout;
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return {
    ...base("bracket", title, [], opts),
    bracketDe: {
      nodes: layout.nodes.map((n) => {
        const f = byId.get(n.fixtureId)!;
        return {
          fixtureId: n.fixtureId,
          lane: n.lane,
          col: n.col,
          row: n.row,
          home: f.home ?? "TBD",
          away: f.away ?? "TBD",
          headline: f.headline,
          decided: f.decided,
        };
      }),
      connectors: layout.connectors,
      k: layout.k,
      wbRows: layout.wbRows,
      lbRows: layout.lbRows,
      lbCols: layout.lbCols,
      laneLabels,
      ...(layout.resetId !== undefined ? { resetId: layout.resetId } : {}),
    },
  };
}

export function buildLadderPoster(
  title: string,
  fixtures: readonly ExportBracketFixture[],
  rungLabel: (i: number) => string,
  opts: BuildOpts,
): DocModel {
  if (fixtures.length === 0) {
    throw new EngineError("CONFIG_INVALID", "stepladder poster: no fixtures", {});
  }
  const rungs = [...fixtures].sort((a, b) => a.round_no - b.round_no);
  return {
    ...base("bracket", title, [], opts),
    ladder: {
      rungs: rungs.map((f, i) => ({
        fixtureId: f.id,
        label: rungLabel(i),
        home: f.home ?? "TBD",
        away: f.away ?? "TBD",
        headline: f.headline,
        decided: f.decided,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Signed audit ledger, human-readable (PROMPT-63 §2): the per-fixture event
// stream as a table, with the verification verdict + head hash + signature
// carried in the description (the standard title block renders them — no
// bespoke renderer code, so the stamp can never drift from the chrome).
// ---------------------------------------------------------------------------

export interface ExportAuditEvent {
  seq: number;
  at: string; // preformatted timestamp
  actor: string;
  type: string;
  detail: string; // compact payload, pre-truncated
  voids: string; // "" or "voids #N"
}

export function buildAuditLedger(
  title: string,
  input: {
    events: readonly ExportAuditEvent[];
    verified: boolean;
    firstTamperedSeq: number | null;
    headHash: string | null;
    signature: { key_id: string; issued_at: string } | null;
  },
  opts: BuildOpts,
): DocModel {
  const stamp = input.verified
    ? "VERIFIED ✓ — hash chain intact"
    : `TAMPERED — chain breaks at #${input.firstTamperedSeq ?? "?"}`;
  const sig =
    input.signature === null
      ? "unsigned export"
      : `signed ed25519 key ${input.signature.key_id} at ${input.signature.issued_at}`;
  const description = [
    stamp,
    input.headHash !== null ? `head ${input.headHash.slice(0, 16)}…` : "empty ledger",
    sig,
  ].join(" · ");
  return base(
    "audit",
    title,
    [
      {
        table: {
          columns: ["#", "Time", "Actor", "Event", "Detail", "Void"],
          rows: input.events.map((e) => [e.seq, e.at, e.actor, e.type, e.detail, e.voids]),
        },
      },
    ],
    { ...opts, description },
  );
}
