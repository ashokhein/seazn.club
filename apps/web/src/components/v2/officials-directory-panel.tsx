"use client";

// Officials directory tab (v11.1 follow-up): the org-wide officials pool now
// manages here — add/roster/invite/bulk-invite — instead of on every
// division's schedule page. The schedule's Officials tab keeps assignment
// (auto-assign, per-fixture pick, blackout warnings) and links back here to
// manage the roster. Same usecases + API routes as before (officials CRUD +
// /api/v1/officials/{id}/invite) — no new mechanisms, just a new home.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import { OfficialAvatar, OfficialInviteEditor, RoleChipPicker } from "@/components/v2/officials-shared";
import { ALL_OFFICIAL_ROLES } from "@/lib/official-roles";

export interface DirectoryOfficial {
  id: string;
  display_name: string;
  role_keys: string[];
  entrant_id: string | null;
  email: string | null;
  max_per_day: number | null;
  claimed: boolean;
  invite_pending: boolean;
}

export function OfficialsDirectoryPanel({
  officials,
  canEdit,
  rolesMultiAllowed,
}: {
  officials: DirectoryOfficial[];
  canEdit: boolean;
  /** Pro entitlement `officials.roles_multi` (v11.1): free plan picks one
   *  role; the chip picker enforces this client-side to match the server. */
  rolesMultiAllowed: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>(["referee"]);
  const [bulkDone, setBulkDone] = useState<number | null>(null);

  const bulkTargets = officials.filter((o) => o.email && !o.claimed && !o.invite_pending);

  async function run(fn: () => Promise<unknown>, refresh = true) {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      await fn();
      if (refresh) router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : msg("officials.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function bulkInvite() {
    await run(async () => {
      let sent = 0;
      for (const o of bulkTargets) {
        await apiV1(`/api/v1/officials/${o.id}/invite`, {
          method: "POST",
          json: { email: o.email },
        });
        sent++;
      }
      setBulkDone(sent);
    });
  }

  return (
    <div className="space-y-4">
      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">{msg("officials.roster")}</h3>
          <span className="flex items-center gap-2">
            {canEdit && bulkTargets.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost py-1 text-xs"
                disabled={busy}
                onClick={() => void bulkInvite()}
              >
                {msg("officials.bulkInvite")} ({bulkTargets.length})
              </button>
            )}
            {bulkDone !== null && (
              <span className="text-xs text-lime-700">{msg("officials.bulkDone", { n: bulkDone })}</span>
            )}
            {officials.length > 0 && (
              <span className="text-xs text-slate-400">{msg("officials.total", { n: officials.length })}</span>
            )}
          </span>
        </div>

        {officials.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
            {msg("officials.empty")}
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {officials.map((o) => (
              <li key={o.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-white p-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <OfficialAvatar name={o.display_name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{o.display_name}</p>
                    {/* review fix 2026-07-17: an official's email is contact
                        info for whoever manages the roster — viewers browsing
                        Directory should not see it. */}
                    {canEdit && o.email && <p className="truncate text-xs text-slate-400">{o.email}</p>}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      {o.role_keys.map((r) => (
                        <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] capitalize text-slate-500">
                          {r.replace(/_/g, " ")}
                        </span>
                      ))}
                      {o.entrant_id && (
                        <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-600">
                          {msg("officials.teamRef")}
                        </span>
                      )}
                      {o.max_per_day != null && (
                        <span className="rounded bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-400">
                          {msg("officials.maxPerDay", { n: o.max_per_day })}
                        </span>
                      )}
                      {o.claimed ? (
                        <span className="rounded bg-lime-100 px-1.5 py-0.5 text-[11px] text-lime-700">
                          {msg("officials.linked")}
                        </span>
                      ) : o.invite_pending ? (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                          {msg("officials.invited")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {canEdit && !o.claimed && (
                    <OfficialInviteEditor officialId={o.id} initialEmail={o.email} disabled={busy} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form
            className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void run(async () => {
                await apiV1("/api/v1/officials", {
                  method: "POST",
                  json: {
                    display_name: name.trim(),
                    role_keys: roles.length ? roles : ["referee"],
                  },
                });
                setName("");
                setRoles(["referee"]);
              });
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {msg("officials.name")}
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <RoleChipPicker
              value={roles}
              onChange={setRoles}
              suggestions={ALL_OFFICIAL_ROLES}
              multiAllowed={rolesMultiAllowed}
            />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {msg("officials.add")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
