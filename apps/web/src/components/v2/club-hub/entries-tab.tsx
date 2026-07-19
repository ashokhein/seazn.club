"use client";

// Club hub → Entries tab (W1 §5.2): a read-only grid of where this club's teams
// are entered. Only teams with at least one division entry show; the W4 enroll
// wizard and W3 approval inbox mount on this tab later. Division names render as
// quiet chips (not links) — the entries payload carries ids only, console hrefs
// must be built from slugs via routes.* (eslint bans id-keyed console paths),
// and the Teams tab shows the same chips, so we stay consistent.
import { useMsg } from "@/components/i18n/dict-provider";

interface EntryRef {
  division_id: string;
  division_name: string;
}
interface HubTeam {
  id: string;
  name: string;
  entries: EntryRef[];
}

/** The teams the grid renders: those entered in at least one division. Pure so
 *  the "hidden until entered" rule is unit-tested without a DOM. Input order is
 *  preserved — getClub already orders teams by name. */
export function enteredTeams(teams: HubTeam[]): HubTeam[] {
  return teams.filter((t) => t.entries.length > 0);
}

export function EntriesTab({ club }: { club: { teams: HubTeam[] } }) {
  const msg = useMsg();
  const entered = enteredTeams(club.teams);

  return (
    <section className="card p-4">
      {entered.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
          {msg("clubs.entries.empty")}
        </p>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>{msg("clubs.entries.team")}</th>
                <th>{msg("clubs.entries.divisions")}</th>
              </tr>
            </thead>
            <tbody>
              {entered.map((t) => (
                <tr key={t.id}>
                  <td className="font-medium text-slate-800">{t.name}</td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {t.entries.map((e) => (
                        <span
                          key={e.division_id}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                        >
                          {e.division_name}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
