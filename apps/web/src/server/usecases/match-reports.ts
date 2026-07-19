import "server-only";
// SPEC-3 / PROMPT-80 — official-filed match reports (free portal principle,
// D5). The official writes a short report with structured incident rows on the
// cross-org superuser rail (an official is not an org member — same rail as
// V284 official_availability / me-officiating.ts). Draft → submitted; a
// submitted report is immutable. On submit, misconduct incidents feed SPEC-1
// (V292) as *suggested* pending suspensions via a soft, idempotent bridge that
// ships dark when discipline is absent. The organiser-console read
// (fixtureReports) runs on the tenant rail and sees submitted reports only.
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature } from "@/lib/entitlements";
import { sendReportSubmittedEmail } from "@/lib/email";
import type { Locale } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";

type Tx = postgres.TransactionSql;
const superuser = sql as unknown as Tx;

export type IncidentKind = "red_card" | "misconduct" | "injury" | "other";

export interface ReportIncident {
  kind: IncidentKind;
  person_id?: string;
  entrant_id?: string;
  note: string;
}

export interface MatchReport {
  id: string;
  fixtureOfficialId: string;
  status: "draft" | "submitted";
  body: string;
  incidents: ReportIncident[];
  submittedAt: string | null;
}

// Reports matter exactly when a match ends — including an abandonment (SPEC-3).
const REPORTABLE = ["decided", "finalized", "abandoned"] as const;
// Only dismissals/misconduct suggest a ban; injury/other never do.
const SUSPENDABLE: IncidentKind[] = ["red_card", "misconduct"];

interface ReportRow {
  id: string;
  fixture_official_id: string;
  status: "draft" | "submitted";
  body: string;
  incidents: ReportIncident[] | null;
  submitted_at: Date | null;
}

function mapReport(r: ReportRow): MatchReport {
  return {
    id: r.id,
    fixtureOfficialId: r.fixture_official_id,
    status: r.status,
    body: r.body,
    incidents: r.incidents ?? [],
    submittedAt: r.submitted_at ? r.submitted_at.toISOString() : null,
  };
}

interface ReportAssignment {
  fixture_official_id: string;
  org_id: string;
  official_id: string;
  fixture_id: string;
  division_id: string;
  response: string;
  fixture_status: string;
}

/** Resolve the assignment behind a fixtureOfficialId, proving the caller's
 *  claimed-official identity (persons.user_id = me → officials.person_id).
 *  404 when it isn't the caller's assignment (never a state oracle). */
async function myAssignment(userId: string, foId: string): Promise<ReportAssignment> {
  const [row] = await superuser<ReportAssignment[]>`
    select fo.id as fixture_official_id, fo.org_id, fo.official_id, fo.fixture_id,
           f.division_id, fo.response, f.status as fixture_status
    from fixture_officials fo
    join officials o on o.id = fo.official_id
    join persons p on p.id = o.person_id
    join fixtures f on f.id = fo.fixture_id
    where fo.id = ${foId} and p.user_id = ${userId}`;
  if (!row) throw new HttpError(404, "This match isn't assigned to you", "NOT_YOUR_ASSIGNMENT");
  return row;
}

function assertReportWindow(a: ReportAssignment): void {
  if (a.response !== "accepted") {
    throw new HttpError(403, "Only an accepted assignment can file a report", "REPORT_WINDOW_CLOSED");
  }
  if (!REPORTABLE.includes(a.fixture_status as (typeof REPORTABLE)[number])) {
    throw new HttpError(
      403,
      "File a report once the fixture is decided or abandoned",
      "REPORT_WINDOW_CLOSED",
    );
  }
}

/** The caller's report for an assignment, or null when none exists yet. Proves
 *  identity first (404 otherwise). */
export async function getMyReport(userId: string, fixtureOfficialId: string): Promise<MatchReport | null> {
  await myAssignment(userId, fixtureOfficialId);
  const [row] = await superuser<ReportRow[]>`
    select id, fixture_official_id, status, body, incidents, submitted_at
    from match_reports where fixture_official_id = ${fixtureOfficialId}`;
  return row ? mapReport(row) : null;
}

/** Save the draft body + incidents. Draft only — a submitted report is
 *  immutable (409). Window: accepted + fixture decided/finalized/abandoned. */
export async function putMyReport(
  userId: string,
  fixtureOfficialId: string,
  input: { body: string; incidents: ReportIncident[] },
): Promise<MatchReport> {
  const a = await myAssignment(userId, fixtureOfficialId);
  // Immutability (409) precedes the window check (403): an already-submitted
  // report can't be edited even if the fixture window has since lapsed.
  const [existing] = await superuser<{ status: string }[]>`
    select status from match_reports where fixture_official_id = ${fixtureOfficialId}`;
  if (existing?.status === "submitted") {
    throw new HttpError(409, "This report is already submitted and can't be edited", "REPORT_SUBMITTED");
  }
  assertReportWindow(a);
  const [row] = await superuser<ReportRow[]>`
    insert into match_reports
      (org_id, fixture_official_id, official_id, fixture_id, status, body, incidents)
    values (${a.org_id}, ${fixtureOfficialId}, ${a.official_id}, ${a.fixture_id}, 'draft',
            ${input.body}, ${sql.json(input.incidents as never)})
    on conflict (fixture_official_id) do update
      set body = excluded.body, incidents = excluded.incidents, updated_at = now()
    returning id, fixture_official_id, status, body, incidents, submitted_at`;
  return mapReport(row!);
}

/** Submit the draft (immutable thereafter, 409 on resubmit). Fires the soft
 *  SPEC-1 bridge. 404 when there is no draft to submit. */
export async function submitMyReport(userId: string, fixtureOfficialId: string): Promise<MatchReport> {
  const a = await myAssignment(userId, fixtureOfficialId);
  const [existing] = await superuser<{ status: string }[]>`
    select status from match_reports where fixture_official_id = ${fixtureOfficialId}`;
  // Immutability (409) precedes the window check (403); "no draft" (404) only
  // makes sense once the window is a valid concept, so it stays after.
  if (existing?.status === "submitted") {
    throw new HttpError(409, "This report is already submitted", "REPORT_SUBMITTED");
  }
  assertReportWindow(a);
  if (!existing) throw new HttpError(404, "There's no draft report to submit", "NO_REPORT");
  const [row] = await superuser<ReportRow[]>`
    update match_reports set status = 'submitted', submitted_at = now(), updated_at = now()
    where fixture_official_id = ${fixtureOfficialId} and status = 'draft'
    returning id, fixture_official_id, status, body, incidents, submitted_at`;
  const report = mapReport(row!);
  await bridgeReportSuspensions(a, report.incidents);
  // After the report is committed, notify the org owner/admins (D-direction:
  // organiser side gets the signal; the official gets no per-mark signal, D4).
  await notifyReportSubmitted(a, report);
  return report;
}

/** Both entrants' squads behind an assignment, for the report's optional person
 *  picker. Cross-org superuser rail with the caller's identity proven first
 *  (404 when the assignment isn't theirs) — an official is not an org member. */
export interface FixtureSquadMember {
  person_id: string;
  full_name: string;
  entrant_id: string;
  entrant_name: string;
}
export async function myFixtureSquad(
  userId: string,
  fixtureOfficialId: string,
): Promise<FixtureSquadMember[]> {
  const a = await myAssignment(userId, fixtureOfficialId);
  return superuser<FixtureSquadMember[]>`
    select distinct p.id as person_id, p.full_name,
           e.id as entrant_id, e.display_name as entrant_name
    from fixtures f
    join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
    join entrant_members em on em.entrant_id = e.id
    join persons p on p.id = em.person_id
    where f.id = ${a.fixture_id}
    order by e.display_name, p.full_name`;
}

/** Fire the report_submitted email to every org owner/admin. Fire-and-forget,
 *  superuser resolve (the official is not an org member); a mail failure never
 *  fails the submit. */
async function notifyReportSubmitted(a: ReportAssignment, report: MatchReport): Promise<void> {
  const [ctx] = await superuser<
    {
      org_name: string;
      org_slug: string;
      competition_slug: string;
      division_slug: string;
      fixture_no: number;
      home_name: string | null;
      away_name: string | null;
      official_name: string;
    }[]
  >`
    select org.name as org_name, org.slug as org_slug,
           c.slug as competition_slug, d.slug as division_slug, f.fixture_no,
           h.display_name as home_name, aw.display_name as away_name,
           o.display_name as official_name
    from fixtures f
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations org on org.id = f.org_id
    join fixture_officials fo on fo.id = ${a.fixture_official_id}
    join officials o on o.id = fo.official_id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants aw on aw.id = f.away_entrant_id
    where f.id = ${a.fixture_id}`;
  if (!ctx) return;
  const recipients = await superuser<{ email: string | null; locale: string | null }[]>`
    select u.email, u.locale from org_members m
    join users u on u.id = m.user_id
    where m.org_id = ${a.org_id} and m.role in ('owner', 'admin')`;
  const fixtureLine = `${ctx.home_name ?? "TBD"} vs ${ctx.away_name ?? "TBD"}`;
  const args = {
    orgName: ctx.org_name,
    fixtureLine,
    officialName: ctx.official_name,
    incidentCount: report.incidents.length,
    orgSlug: ctx.org_slug,
    competitionSlug: ctx.competition_slug,
    divisionSlug: ctx.division_slug,
  };
  for (const r of recipients) {
    if (!r.email) continue;
    void sendReportSubmittedEmail(r.email, args, (r.locale as Locale) ?? "en").catch(() => {});
  }
}

// Test seam — the suspensions-table existence probe, overridable so tests can
// simulate the pre-V292 dark path without renaming the shared table (a rename
// would flake thread-parallel discipline runs against the one local DB).
type BridgeProbe = () => Promise<boolean>;
const realBridgeProbe: BridgeProbe = async () => {
  const [{ reg }] = await superuser<{ reg: string | null }[]>`select to_regclass('suspensions') as reg`;
  return reg !== null;
};
let bridgeProbe: BridgeProbe = realBridgeProbe;

/** Test-only: override the suspensions-table probe (pass null to restore the
 *  real to_regclass query). Keeps the public putMyReport/submit API unchanged. */
export function __setBridgeProbeForTests(fn: BridgeProbe | null): void {
  bridgeProbe = fn ?? realBridgeProbe;
}

/**
 * Soft bridge into SPEC-1 (V292): for each misconduct/red-card incident that
 * names a person, raise a *pending* suspension the organiser confirms/adjusts.
 * Guarded so it ships dark: (1) the org must have discipline.enforced, (2) the
 * suspensions table must exist at all (to_regclass probe). Idempotent under the
 * V293 suspensions_report_once partial index — rule_key = report:<foId>,
 * bucket = incident index. Never auto-confirms; never blocks the submit.
 */
async function bridgeReportSuspensions(a: ReportAssignment, incidents: ReportIncident[]): Promise<void> {
  const targets = incidents
    .map((inc, idx) => ({ inc, idx }))
    .filter(({ inc }) => SUSPENDABLE.includes(inc.kind) && !!inc.person_id);
  if (targets.length === 0) return;
  if (!(await hasFeature(a.org_id, "discipline.enforced"))) return;
  if (!(await bridgeProbe())) return;
  // Only real persons in this org — a stale picker id must not FK-fail submit.
  const personIds = [...new Set(targets.map((t) => t.inc.person_id!))];
  const valid = new Set(
    (
      await superuser<{ id: string }[]>`
        select id from persons where org_id = ${a.org_id} and id = any(${personIds})`
    ).map((r) => r.id),
  );
  for (const { inc, idx } of targets) {
    const personId = inc.person_id!;
    if (!valid.has(personId)) continue;
    await superuser`
      insert into suspensions
        (org_id, division_id, person_id, status, source, rule_key, bucket, reason,
         matches_total, fixture_id)
      values (${a.org_id}, ${a.division_id}, ${personId}, 'pending', 'report',
              ${"report:" + a.fixture_official_id}, ${idx}, ${inc.note}, 1, ${a.fixture_id})
      on conflict do nothing`;
  }
}

/** Organiser-console read (tenant rail): submitted reports for a fixture, with
 *  the official's name. No entitlement gate — reports are free (D5). */
export async function fixtureReports(
  auth: AuthCtx,
  fixtureId: string,
): Promise<(MatchReport & { officialName: string })[]> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<(ReportRow & { official_name: string })[]>`
      select mr.id, mr.fixture_official_id, mr.status, mr.body, mr.incidents, mr.submitted_at,
             o.display_name as official_name
      from match_reports mr
      join officials o on o.id = mr.official_id
      where mr.fixture_id = ${fixtureId} and mr.status = 'submitted'
      order by mr.submitted_at desc, mr.id`;
    return rows.map((r) => ({ ...mapReport(r), officialName: r.official_name }));
  });
}
