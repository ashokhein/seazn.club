import "server-only";
// Rich exports (Jul3/06 §4–§6): assemble read-model data → pure DocModel →
// PDF/XLSX bytes. Branding is nulled for non-Pro AT THE MODEL LAYER (doc 10
// §2.3), and `printedAt` is the request time injected here so the engine
// stays clock-free.
import type postgres from "postgres";
import {
  buildAdmitTickets,
  buildOfficialsRota,
  buildParticipants,
  buildRoster,
  buildStandings,
  buildTimetable,
  DocModel,
  type DocBranding,
  type DocSection,
  type ExportFixture,
  type ExportOfficialSchedule,
  type ExportTicket,
  type PageBreaks,
} from "@seazn/engine/exports";
import type { StandingsRow } from "@seazn/engine/competition";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { fixtureWhen } from "@/lib/email-templates/official-assigned";
import { maskDisplayName, resolveNameDisplay } from "@/lib/name-display";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";
import { participantRows } from "./clubs";
import { resolveSponsors } from "./sponsors";
import { getMyOfficiating } from "./me-officiating";

type Tx = postgres.TransactionSql;

export interface ExportOpts {
  pageBreaks?: PageBreaks;
  landscape?: boolean;
  blank?: boolean;
  printedAt: string; // request time — injected, never Date.now() in the engine
}

interface DivisionMeta {
  id: string;
  name: string;
  org_id: string;
  org_name: string;
  competition_id: string;
  competition_name: string;
  branding: Record<string, unknown> | null;
  sport_key: string;
  module_version: string;
  config: unknown;
}

async function divisionMeta(tx: Tx, divisionId: string): Promise<DivisionMeta> {
  const [row] = await tx<DivisionMeta[]>`
    select d.id, d.name, d.org_id, org.name as org_name,
           d.competition_id, c.name as competition_name,
           c.branding, d.sport_key, d.module_version, d.config
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations org on org.id = d.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}

// Jul3/06 §6 / v12: branding (club colours, sponsor logos, tournament
// styling) is the Pro layer — resolved server-side and simply absent
// otherwise. Shared by every caller so `resolveSponsors` is only ever
// called once per export: `brandingFor` layers division-level colour/logo
// overrides on top for the per-division exports; `buildCompetitionTimetable`
// (no DivisionMeta in hand) calls this directly.
async function orgBranding(
  orgId: string,
  orgName: string,
  competitionId: string,
): Promise<DocBranding | undefined> {
  if (!(await hasFeature(orgId, "exports.branded"))) return undefined;
  const sponsors = (await resolveSponsors(orgId, competitionId)).map((s) => ({
    name: s.name,
    tier: s.tier,
  }));
  return {
    orgName,
    ...(sponsors.length > 0 ? { sponsors } : {}),
  };
}

async function brandingFor(auth: AuthCtx, meta: DivisionMeta): Promise<DocBranding | undefined> {
  const base = await orgBranding(auth.orgId, meta.org_name, meta.competition_id);
  if (base === undefined) return undefined;
  const branding = meta.branding ?? {};
  const colors: Record<string, string> = {};
  if (typeof branding.primary_color === "string") colors.primary = branding.primary_color;
  return {
    ...base,
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(typeof branding.logo_path === "string" ? { logos: [branding.logo_path] } : {}),
  };
}

interface FixtureExportRow {
  id: string;
  scheduled_at: string | null;
  court_label: string | null;
  round_no: number | null;
  stage_name: string;
  home_label: string;
  away_label: string;
  home_color: string | null;
  away_color: string | null;
  summary: { sides?: { line: string }[] } | null;
  status: string;
}

async function exportFixtures(tx: Tx, divisionId: string): Promise<FixtureExportRow[]> {
  return tx<FixtureExportRow[]>`
    select f.id, f.scheduled_at::text as scheduled_at, f.court_label, f.round_no,
           s.name as stage_name,
           coalesce(he.display_name, 'TBD') as home_label,
           coalesce(ae.display_name, 'TBD') as away_label,
           htd.colors->>'primary' as home_color,
           atd.colors->>'primary' as away_color,
           m.summary, f.status
    from fixtures f
    join stages s on s.id = f.stage_id
    left join entrants he on he.id = f.home_entrant_id
    left join entrants ae on ae.id = f.away_entrant_id
    left join team_display_v htd on htd.team_id = he.team_id
    left join team_display_v atd on atd.team_id = ae.team_id
    left join match_states m on m.fixture_id = f.id
    where f.division_id = ${divisionId}
    order by s.seq, f.round_no, f.seq_in_round`;
}

function toExportFixture(f: FixtureExportRow, divisionName: string): ExportFixture {
  const sides = f.summary?.sides;
  return {
    id: f.id,
    at: f.scheduled_at,
    court: f.court_label,
    stageName: f.stage_name,
    round: f.round_no,
    home: f.home_label,
    away: f.away_label,
    ...(f.home_color !== null ? { homeColor: f.home_color } : {}),
    ...(f.away_color !== null ? { awayColor: f.away_color } : {}),
    divisionName,
    ...(f.status === "decided" && sides !== undefined && sides.length === 2
      ? { result: `${sides[0]!.line} – ${sides[1]!.line}` }
      : {}),
  };
}

// v12: per-kind blurb shown under the masthead (doc-render §Task 3).
const DESCRIPTIONS: Record<string, string> = {
  timetable: "All fixtures across every court, in play order.",
  standings: "Current table, updated as results land.",
  roster: "Squads by team — sign each player in before play.",
  participants: "All registered players by club and division.",
  scoresheet: "One sheet per match — record the score and sign off.",
};

/** The pure model for a division export — separated for golden-style tests;
 *  the route renders it to bytes. */
export async function buildDivisionDocModel(
  auth: AuthCtx,
  divisionId: string,
  kind: "timetable" | "standings" | "roster" | "participants" | "scoresheet",
  opts: ExportOpts,
): Promise<DocModel> {
  // Exports unlock via plan or an Event Pass on this competition (v3/07 §3).
  const [expComp] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  await requireFeature(auth.orgId, "exports", expComp?.competition_id);
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const branding = await brandingFor(auth, meta);
    const title = `${meta.competition_name} — ${meta.name}`;
    const common = {
      printedAt: opts.printedAt,
      description: DESCRIPTIONS[kind],
      ...(branding !== undefined ? { branding } : {}),
      ...(opts.pageBreaks !== undefined ? { pageBreaks: opts.pageBreaks } : {}),
      ...(opts.landscape !== undefined ? { landscape: opts.landscape } : {}),
    };

    switch (kind) {
      case "timetable": {
        const fixtures = await exportFixtures(tx, divisionId);
        return buildTimetable(title, fixtures.map((f) => toExportFixture(f, meta.name)), common);
      }
      case "standings": {
        const [snapshot] = await tx<{ rows: StandingsRow[] }[]>`
          select ss.rows from standings_snapshots ss
          join stages s on s.id = ss.stage_id
          where s.division_id = ${divisionId}
          order by s.seq desc, ss.updated_at desc limit 1`;
        if (!snapshot) throw new HttpError(404, "no standings yet");
        const names = await tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where division_id = ${divisionId}`;
        const nameById = new Map(names.map((n) => [n.id, n.display_name]));
        const sportModule = resolveModule(meta.sport_key, meta.module_version);
        const metricColumns = sportModule.metrics.slice(0, 4).map((m) => m.key);
        const rows = [...snapshot.rows]
          .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
          .map((r) => ({
            name: nameById.get(r.entrantId) ?? r.entrantId,
            played: r.played,
            won: r.won,
            drawn: r.drawn,
            lost: r.lost,
            points: r.points,
            metrics: r.metrics,
          }));
        return buildStandings(title, rows, { ...common, metricColumns });
      }
      case "roster": {
        const teams = await tx<{
          entrant: string; club_name: string | null;
          players: { name: string; dob: string | null; number: number | null }[] | null;
        }[]>`
          select e.display_name as entrant, td.club_name,
                 (select json_agg(json_build_object(
                    'name', p.full_name, 'dob', p.dob::text, 'number', em.squad_number)
                    order by em.squad_number nulls last, p.full_name)
                  from entrant_members em join persons p on p.id = em.person_id
                  where em.entrant_id = e.id) as players
          from entrants e
          left join team_display_v td on td.team_id = e.team_id
          where e.division_id = ${divisionId} and e.status in ('registered','confirmed')
          order by e.display_name`;
        return buildRoster(
          title,
          teams.map((t) => ({
            teamName: t.entrant,
            ...(t.club_name !== null ? { clubName: t.club_name } : {}),
            players: (t.players ?? []).map((p) => ({
              name: p.name,
              ...(p.dob !== null ? { dob: p.dob } : {}),
              ...(p.number !== null ? { number: p.number } : {}),
            })),
          })),
          common,
        );
      }
      case "participants": {
        const rows = await participantRows(auth, { divisionId });
        return buildParticipants(
          title,
          rows.map((r) => ({
            club: r.club, team: r.team, division: r.division, entrant: r.entrant,
            player: r.player, number: r.squad_number, position: r.position,
          })),
          common,
        );
      }
      case "scoresheet": {
        const sportModule = resolveModule(meta.sport_key, meta.module_version);
        const fixtures = await exportFixtures(tx, divisionId);
        const sections: DocSection[] = [];
        for (const f of fixtures.filter((x) => x.status !== "decided")) {
          const input = {
            home: f.home_label,
            away: f.away_label,
            ...(f.home_color !== null ? { homeColor: f.home_color } : {}),
            ...(f.away_color !== null ? { awayColor: f.away_color } : {}),
            ...(f.scheduled_at !== null ? { at: f.scheduled_at } : {}),
            ...(f.court_label !== null ? { court: f.court_label } : {}),
            stageName: f.stage_name,
            ...(opts.blank === true ? { blank: true } : {}),
          };
          const fragment = sportModule.exportTemplates?.scoresheet;
          if (fragment !== undefined) {
            sections.push(...fragment(input, meta.config as never));
          } else {
            // sport without a bespoke sheet: a generic result form
            sections.push({
              heading: `${f.home_label} vs ${f.away_label}`,
              subheading: [f.scheduled_at, f.court_label, f.stage_name]
                .filter((x): x is string => x !== null)
                .join(" · "),
              formLines: ["Result: ________________", "Notes: ________________"],
              signatures: ["Referee", `Captain — ${f.home_label}`, `Captain — ${f.away_label}`],
            });
          }
        }
        // per_pitch: fresh page whenever the court changes (30 Sep, 20 Oct)
        if ((opts.pageBreaks ?? "auto") === "per_pitch") {
          let lastCourt: string | null = null;
          const undecided = fixtures.filter((x) => x.status !== "decided");
          sections.forEach((s, i) => {
            const court = undecided[i]?.court_label ?? null;
            if (i > 0 && court !== lastCourt) s.pageBreakBefore = true;
            lastCourt = court;
          });
        }
        return DocModel.parse({
          kind: "scoresheet",
          title,
          description: DESCRIPTIONS.scoresheet,
          meta: { printedAt: opts.printedAt },
          ...(branding !== undefined ? { branding } : {}),
          sections,
          pageBreaks: opts.pageBreaks ?? "auto",
        });
      }
    }
  });
}

/** Competition-wide pretty timetable (Jul3/06 §5): all divisions, one doc. */
export async function buildCompetitionTimetable(
  auth: AuthCtx,
  competitionId: string,
  opts: ExportOpts,
): Promise<DocModel> {
  await requireFeature(auth.orgId, "exports", competitionId);
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ name: string; org_id: string; org_name: string }[]>`
      select c.name, c.org_id, org.name as org_name
      from competitions c join organizations org on org.id = c.org_id
      where c.id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    const branding = await orgBranding(comp.org_id, comp.org_name, competitionId);
    const divisions = await tx<{ id: string; name: string }[]>`
      select id, name from divisions where competition_id = ${competitionId} order by name`;
    const all: ExportFixture[] = [];
    for (const d of divisions) {
      const fixtures = await exportFixtures(tx, d.id);
      all.push(...fixtures.map((f) => toExportFixture(f, d.name)));
    }
    return buildTimetable(comp.name, all, {
      printedAt: opts.printedAt,
      description: "Every fixture across all divisions.",
      ...(branding !== undefined ? { branding } : {}),
      pageBreaks: opts.pageBreaks ?? "per_division",
    });
  });
}

// --- v12: officials rota + admit tickets (Task 13) --------------------------

interface OfficialDutyRow {
  official_id: string;
  official_name: string;
  scheduled_at: string | null;
  venue_tz: string | null;
  court_label: string | null;
  comp_name: string;
  div_name: string;
  role_key: string;
  response: "pending" | "accepted" | "declined";
  home: string | null;
  away: string | null;
}

async function officialDutyRows(tx: Tx, divisionId: string): Promise<OfficialDutyRow[]> {
  return tx<OfficialDutyRow[]>`
    select o.id as official_id, o.display_name as official_name,
           f.scheduled_at::text as scheduled_at, ss.tz as venue_tz, f.court_label,
           c.name as comp_name, d.name as div_name,
           fo.role_key, fo.response,
           h.display_name as home, a.display_name as away
    from fixture_officials fo
    join officials o on o.id = fo.official_id
    join fixtures f on f.id = fo.fixture_id
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    left join schedule_settings ss on ss.division_id = d.id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where f.division_id = ${divisionId}
      and f.status in ('scheduled', 'in_play')
    order by o.display_name, f.scheduled_at nulls last`;
}

/** Officials rota for a single division (v12/Task 13): every official with a
 *  duty on a still-live fixture, grouped by official, one section per page
 *  (13 May pattern). Org-scoped read; branding via the Task 7 helper. */
export async function buildOfficialsRotaDoc(
  auth: AuthCtx,
  divisionId: string,
  opts: ExportOpts,
): Promise<DocModel> {
  // Exports unlock via plan or an Event Pass on this competition (v3/07 §3),
  // same gate as buildDivisionDocModel — deferred at Task 13, added here.
  const [expComp] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  await requireFeature(auth.orgId, "exports", expComp?.competition_id);
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const branding = await brandingFor(auth, meta);
    const rows = await officialDutyRows(tx, divisionId);
    const byOfficial = new Map<string, ExportOfficialSchedule>();
    for (const r of rows) {
      const s = byOfficial.get(r.official_id) ?? { officialName: r.official_name, duties: [] };
      s.duties.push({
        at: fixtureWhen(r.scheduled_at, r.venue_tz),
        court: r.court_label,
        compDivision: `${r.comp_name} · ${r.div_name}`,
        role: r.role_key,
        opponents: `${r.home ?? "TBD"} vs ${r.away ?? "TBD"}`,
        response: r.response,
      });
      byOfficial.set(r.official_id, s);
    }
    return buildOfficialsRota(
      `${meta.competition_name} — Officials rota`,
      [...byOfficial.values()],
      {
        printedAt: opts.printedAt,
        description: "Assigned officials and their duties.",
        ...(branding !== undefined ? { branding } : {}),
        pageBreaks: "per_team",
      },
    );
  });
}

interface CompetitionTicketMeta {
  name: string;
  starts_on: string | null;
  ends_on: string | null;
  org_id: string;
  org_name: string;
}

async function competitionTicketMeta(tx: Tx, competitionId: string): Promise<CompetitionTicketMeta> {
  const [row] = await tx<CompetitionTicketMeta[]>`
    select c.name, c.starts_on::text as starts_on, c.ends_on::text as ends_on,
           c.org_id, org.name as org_name
    from competitions c
    join organizations org on org.id = c.org_id
    where c.id = ${competitionId}`;
  if (!row) throw new HttpError(404, "competition not found");
  return row;
}

interface TicketRegistrationRow {
  ref_code: string;
  display_name: string;
  status: string;
  player_name_display: string | null;
  youth: boolean;
}

async function ticketRegistrationRows(tx: Tx, competitionId: string): Promise<TicketRegistrationRow[]> {
  return tx<TicketRegistrationRow[]>`
    select r.ref_code, r.display_name, r.status, d.player_name_display, d.youth
    from registrations r
    join divisions d on d.id = r.division_id
    where d.competition_id = ${competitionId}
      and r.status = 'confirmed' and r.ref_code is not null
    order by r.created_at`;
}

/** Admit tickets for a competition (v12/Task 13): every confirmed
 *  registration becomes a 2-up ticket, name-masked the same way the public
 *  /r/[ref] status page does; the QR is carried as a URL only (Task 12
 *  draws pixels). Org-scoped read; branding via the Task 7 helper. */
export async function buildAdmitTicketsDoc(
  auth: AuthCtx,
  competitionId: string,
  opts: ExportOpts,
  origin: string,
): Promise<DocModel> {
  await requireFeature(auth.orgId, "exports", competitionId);
  return withTenant(auth.orgId, async (tx) => {
    const meta = await competitionTicketMeta(tx, competitionId);
    const branding = await orgBranding(meta.org_id, meta.org_name, competitionId);
    const rows = await ticketRegistrationRows(tx, competitionId);
    const dates = `${meta.starts_on ?? "—"} – ${meta.ends_on ?? meta.starts_on ?? "—"}`;
    const tickets: ExportTicket[] = rows.map((r, i) => ({
      maskedName: maskDisplayName(r.display_name, resolveNameDisplay(r.player_name_display, r.youth)),
      competition: meta.name,
      dates,
      ref: r.ref_code,
      status: r.status.toUpperCase(),
      qrUrl: `${origin}/r/${r.ref_code}`,
      seq: i + 1,
    }));
    return buildAdmitTickets(meta.name, tickets, {
      printedAt: opts.printedAt,
      description: "Present at check-in — scan or show the reference below.",
      ...(branding !== undefined ? { branding } : {}),
    });
  });
}

/** My officiating rota (v12/Task 13): cross-org, SEAZN-neutral (no org
 *  branding — the reader officiates for many organisations at once).
 *  Sourced from the same superuser read the /me officiating lane uses. */
export async function buildMyRotaDoc(
  userId: string,
  opts: ExportOpts,
  origin: string,
): Promise<DocModel> {
  void origin; // no per-fixture links in this doc yet — kept for signature parity
  const { assignments } = await getMyOfficiating(userId);
  const byOfficial = new Map<string, ExportOfficialSchedule>();
  for (const a of assignments) {
    const key = a.official_id;
    const s = byOfficial.get(key) ?? { officialName: a.org_name, duties: [] };
    s.duties.push({
      at: fixtureWhen(a.scheduled_at, a.venue_tz),
      court: a.court_label,
      compDivision: `${a.competition_name} · ${a.division_name}`,
      role: a.role_key,
      opponents: `${a.home_name ?? "TBD"} vs ${a.away_name ?? "TBD"}`,
      response: a.response,
    });
    byOfficial.set(key, s);
  }
  return buildOfficialsRota("My officiating rota", [...byOfficial.values()], {
    printedAt: opts.printedAt,
    description: "Your upcoming duties across every organisation.",
    pageBreaks: "per_team",
  });
}
