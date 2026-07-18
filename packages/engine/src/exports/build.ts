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
