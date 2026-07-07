export const dynamic = "force-dynamic";
// Drag-and-drop schedule board for one division (doc 12 §2, PROMPT-17).
// Community renders it view-only (doc 12 §5 — scheduling.board).
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { listStages } from "@/server/usecases/stages";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { listEntrants } from "@/server/usecases/entrants";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { hasFeature } from "@/lib/entitlements";
import { withTenant } from "@/lib/db";
import { ScheduleBoard } from "@/components/v2/schedule-board";
import { OfficialsPanel } from "@/components/v2/officials-panel";
import { HistoryPanel } from "@/components/v2/history-panel";
import { ConstraintsPanel } from "@/components/v2/constraints-panel";
import { listOfficials } from "@/server/usecases/officials";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { UpgradeGate } from "@/components/upgrade-gate";

const TABS = ["board", "officials", "constraints", "history"] as const;
type Tab = (typeof TABS)[number];

export default async function DivisionSchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab: rawTab }] = await Promise.all([params, searchParams]);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "board";
  const { auth, canEdit } = await requireResourcePageAuth("division", id);
  const division = await getDivision(auth, id);
  const [competition, stages, fixtures, entrants, settings, boardEditable, constraints, officials] =
    await Promise.all([
      getCompetition(auth, division.competition_id),
      listStages(auth, id),
      listDivisionFixtures(auth, id),
      listEntrants(auth, id),
      getScheduleSettings(auth, id),
      hasFeature(auth.orgId, "scheduling.board"),
      hasFeature(auth.orgId, "scheduling.constraints"),
      listOfficials(auth),
    ]);

  // Feed wiring for TBD card labels ("Winner of R1 #2" — doc 12 §2).
  const feedRows = await withTenant(auth.orgId, (tx) =>
    tx<FeedRow[]>`
      select id, round_no, seq_in_round, winner_to_fixture, winner_to_slot,
             loser_to_fixture, loser_to_slot
      from fixtures where division_id = ${id}`,
  );

  const frozen = competition.frozen ?? false;
  const editable = canEdit && !frozen && boardEditable;

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-4">
          <p className="text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-purple-600">Competitions</Link>
            {" / "}
            <Link href={`/competitions/${competition.id}`} className="hover:text-purple-600">
              {competition.name}
            </Link>
            {" / "}
            <Link href={`/divisions/${id}`} className="hover:text-purple-600">
              {division.name}
            </Link>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              Schedule — {division.name}
            </h1>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {/* Jul3/06 print templates — raw file endpoints */}
              <a className="btn btn-ghost text-xs" href={`/api/v1/divisions/${id}/exports/timetable?format=pdf`}>Timetable PDF</a>
              <a className="btn btn-ghost text-xs" href={`/api/v1/divisions/${id}/exports/scoresheet?format=pdf&pageBreaks=per_pitch`}>Scoresheets</a>
              <a className="btn btn-ghost text-xs" href={`/api/v1/divisions/${id}/exports/roster?format=pdf`}>Rosters</a>
              <a className="btn btn-ghost text-xs" href={`/api/v1/divisions/${id}/exports/standings?format=pdf&landscape=true`}>Standings PDF</a>
              <a className="btn btn-ghost text-xs" href={`/api/v1/divisions/${id}/exports/participants?format=xlsx`}>Participants XLSX</a>
            </span>
          </div>
        </div>

        {/* Tabs (Jul3): the board + each panel is its own view — the page was
            one long scroll otherwise. */}
        <nav className="mb-6 flex gap-1 border-b border-slate-200">
          {TABS.map((t) => (
            <Link
              key={t}
              href={`/divisions/${id}/schedule?tab=${t}`}
              className={`border-b-2 px-4 py-2 text-sm font-medium capitalize transition ${
                tab === t
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t}
            </Link>
          ))}
        </nav>

        {tab === "board" && (
          <>
            {!boardEditable && canEdit && !frozen && (
              <div className="mb-4">
                <UpgradeGate feature="scheduling.board" compact />
              </div>
            )}
            <ScheduleBoard
              divisions={[{ id: division.id, name: division.name, status: division.status, color: "#7c3aed" }]}
              stages={stages.map((s) => ({ id: s.id, division_id: id, seq: s.seq, kind: s.kind, name: s.name, status: s.status }))}
              fixtures={fixtures}
              entrantNames={Object.fromEntries(entrants.map((e) => [e.id, e.display_name]))}
              feedLabels={feedLabels(feedRows)}
              settings={{ division_id: id, config: settings.config, tz: settings.tz }}
              canEdit={editable}
              constraintsAllowed={constraints}
            />
          </>
        )}

        {tab === "officials" && (
        <OfficialsPanel
          divisionId={id}
          officials={officials.map((o) => ({
            id: o.id,
            display_name: o.display_name,
            role_keys: o.role_keys,
            entrant_id: o.entrant_id,
            max_per_day: o.max_per_day,
          }))}
          fixtures={fixtures.map((f) => {
            const names = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
            const home = f.home_entrant_id ? names[f.home_entrant_id] ?? "TBD" : "TBD";
            const away = f.away_entrant_id ? names[f.away_entrant_id] ?? "TBD" : "TBD";
            return {
              id: f.id,
              label: `${home} vs ${away}`,
              scheduled_at: f.scheduled_at,
              officials: (f.officials ?? []) as {
                official_id: string; name: string; role: string; locked: boolean;
              }[],
            };
          })}
          stages={stages.map((s) => ({ id: s.id, name: s.name, seq: s.seq }))}
          hideNames={division.officials_hide_names}
          canEdit={canEdit && !frozen}
        />
        )}

        {tab === "constraints" && (
        <ConstraintsPanel
          divisionId={id}
          initialSettings={{
            division_id: id,
            config: settings.config as Record<string, unknown>,
            tz: settings.tz,
          }}
          canEdit={canEdit && !frozen && constraints}
        />
        )}

        {tab === "history" && (
        <HistoryPanel
          divisionId={id}
          scheduleLocked={division.schedule_locked}
          canEdit={canEdit && !frozen}
        />
        )}
      </main>
    </>
  );
}
