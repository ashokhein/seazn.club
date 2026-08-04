import "server-only";
import { stageScopedCfg } from "./stage-cfg";

/**
 * WHICH CONFIG DOES THIS FIXTURE FOLD AGAINST — the one decision, in one place.
 *
 * WHY THIS FILE EXISTS. `cfg` used to be rebuilt LIVE from
 * `stageScopedCfg(division.config, stage?.config)` at every call site, and every
 * READ replays the fixture's whole ledger from `init` (there is no incremental
 * fold and no cached partial state). So editing a division's config changed the
 * input to every past fold at once: a finished fixture silently rescored, and —
 * worse — any cfg-derived refusal inside a fold started firing on events ALREADY
 * IN THE LEDGER. Those events were each legal when recorded, so there is no
 * event to void and no scorer action that recovers it; the state endpoint, the
 * score page and standings all throw and the fixture is permanently unviewable.
 * Six instances of that exact shape were found by hand in W4a alone.
 *
 * V347 freezes the resolved cfg onto `fixtures.config_snapshot` when the first
 * event is appended. This resolver is the ONLY reader of that column: both the
 * write fold (`append-event.ts`) and the read fold (`fold.ts`) go through it, so
 * no surface can drift back to live config on its own — and the two stay
 * byte-consistent, which `verifyStateConsistency` depends on (a read that
 * disagreed with the write would read as phantom state drift).
 *
 * A fixture with ZERO events reads LIVE config, deliberately and not by
 * accident: `config_snapshot is null` is precisely "not scored yet", and an
 * organiser still setting the division up must have the format they choose
 * apply. The snapshot begins the moment there is history worth protecting.
 *
 * The snapshot is the RESOLVED cfg — `stageScopedCfg`'s OUTPUT, stage overlay
 * already applied. Freezing the raw division config instead would leave the
 * overlay to be re-applied at read time against a stage config that has since
 * moved, which is the same drift one layer down.
 *
 * @param snapshot `fixtures.config_snapshot` as the driver returns it: the
 *   frozen jsonb, or null/undefined when none has been taken. Presence is the
 *   test, not truthiness — `{}` is a legitimate config for several modules.
 */
export function resolveFixtureCfg(
  snapshot: unknown,
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | null | undefined,
): unknown {
  if (snapshot !== null && snapshot !== undefined) return snapshot;
  return stageScopedCfg(divisionCfg, stageCfg);
}
