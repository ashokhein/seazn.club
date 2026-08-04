import Link from "@/components/ui/console-link";
import { fixtureConfigPanel } from "@/server/usecases/admin-fixture-config";
import { ResnapshotForm } from "./resnapshot-form";

export const dynamic = "force-dynamic";

/**
 * Fixture config snapshot (V347) — the only staff surface for a single fixture.
 *
 * Lookup-by-id rather than a browsable list on purpose: staff arrive here from a
 * support ticket holding a fixture id, and there is no useful "all fixtures"
 * ordering across every org. Functional bar, per the /admin rule — no polish,
 * but it must still work at 375px, hence the wrapping toolbar and the JSON
 * blocks in their own overflow-x containers.
 */
export default async function AdminFixtureConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const trimmed = (id ?? "").trim();
  // Look up only when it PARSES as a uuid: `fixtureConfigPanel` would otherwise
  // hand Postgres a malformed uuid and 500 the page on a typo.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
  const panel = isUuid ? await fixtureConfigPanel(trimmed) : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">
            Admin
          </Link>{" "}
          / Fixture config
        </p>
        <h1 className="text-xl font-bold text-white">Fixture config snapshot</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          A fixture freezes the config it is scored under on its first event, so a later division
          edit cannot rescore it or make it unreadable. Re-snapshot only when the frozen config was
          genuinely wrong — the discarded config survives nowhere but the audit log.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          name="id"
          defaultValue={trimmed}
          aria-label="Fixture id"
          data-testid="fixture-id-input"
          placeholder="Fixture UUID"
          className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-white placeholder:text-slate-500"
        />
        <button
          type="submit"
          className="rounded bg-slate-700 px-3 py-1 text-sm font-semibold text-white"
        >
          Look up
        </button>
      </form>

      {trimmed.length > 0 && !isUuid && (
        <p className="text-sm text-amber-400" data-testid="fixture-not-found">
          That is not a fixture UUID.
        </p>
      )}
      {isUuid && panel === null && (
        <p className="text-sm text-amber-400" data-testid="fixture-not-found">
          No fixture with that id.
        </p>
      )}

      {panel && (
        <div
          data-testid="fixture-config-panel"
          data-diverged={panel.diverged ? "yes" : "no"}
          data-can-resnapshot={panel.canResnapshot ? "yes" : "no"}
          className="space-y-4 rounded-lg border border-slate-700 bg-slate-900 p-4"
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Field label="Org" value={panel.orgName} />
            <Field label="Competition" value={panel.competitionName} />
            <Field label="Division" value={`${panel.divisionName} (${panel.sportKey})`} />
            <Field
              label="Fixture"
              value={`#${panel.fixtureNo ?? "—"} · ${panel.status} · ${panel.eventCount} events`}
            />
            <Field label="Frozen at" value={panel.snapshotAt ?? "never — folds against live config"} />
          </dl>

          <p
            className={`rounded border px-3 py-2 text-sm ${
              panel.snapshot === null
                ? "border-slate-700 bg-slate-800/50 text-slate-400"
                : panel.diverged
                  ? "border-amber-700 bg-amber-900/20 text-amber-300"
                  : "border-emerald-800 bg-emerald-900/20 text-emerald-300"
            }`}
            data-testid="divergence-banner"
          >
            {panel.snapshot === null
              ? "No snapshot yet — this fixture has no events, so it still reads live config."
              : panel.diverged
                ? "The division/stage config has moved since this fixture was scored. The fixture is folding against the frozen copy, which is the point."
                : "The frozen config still matches live config."}
          </p>

          <ConfigBlock label="Frozen (what this fixture folds against)" value={panel.snapshot} />
          <ConfigBlock label="Live (division + stage overlay)" value={panel.live} />

          {panel.canResnapshot ? (
            <ResnapshotForm fixtureId={panel.fixtureId} />
          ) : (
            <p className="text-xs text-slate-500" data-testid="resnapshot-blocked">
              {panel.snapshot === null
                ? "Nothing frozen to correct."
                : `Reopen this fixture first — it is ${panel.status}.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="break-words text-slate-200">{value}</dd>
    </div>
  );
}

function ConfigBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs uppercase tracking-wide text-slate-500">{label}</p>
      {/* Its OWN overflow-x container: a wide config must scroll inside the
          card, never widen the page at 375px. */}
      <pre className="max-w-full overflow-x-auto rounded bg-slate-950 p-2 text-xs text-slate-300">
        {value === null ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
