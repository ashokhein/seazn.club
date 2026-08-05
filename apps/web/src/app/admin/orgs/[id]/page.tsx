import Link from "@/components/ui/console-link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { AdminOrgActions } from "@/components/admin-org-actions";
import { AdminPlanPanel } from "@/components/admin-plan-panel";
import { AdminCreditsPanel } from "@/components/admin-credits-panel";
import { AdminDiscoveryActions } from "@/components/admin-discovery-actions";
import { hasFeature } from "@/lib/entitlements";
import { cardsForCustomer, planPanel } from "@/server/usecases/admin-plan";
import { feePercentFor } from "@/server/usecases/registrations";
import { requireStaff } from "@/lib/admin";
import { walletIdFor, balance as walletBalance } from "@/lib/credits";
import { adjustmentsForOrg } from "@/server/usecases/admin-adjustments-log";
import { slotConsumingDivisions } from "@/server/usecases/admin-divisions";
import { SlotWaiverButton } from "./slot-waiver-button";
import { ADJUSTMENT_LABELS } from "./adjustment-labels";

export default async function AdminOrgPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [org] = await sql<{
    id: string; name: string; slug: string; status: string;
    created_at: string; deleted_at: string | null;
  }[]>`select id, name, slug, status, created_at, deleted_at from organizations where id = ${id}`;
  if (!org) notFound();

  const plan = await planPanel(id);
  // Task 6C: cards live on the org's Stripe customer, fetched separately from
  // the plain-DB planPanel read — planPanel is also the shared "before"
  // snapshot for compToPro/adminDowngrade/extendTrial, none of which touch
  // cards, so this Stripe round trip must not ride along with theirs.
  const cards = await cardsForCustomer(plan.stripe_customer_id);

  const members = await sql<{
    user_id: string; email: string; display_name: string; role: string; joined_at: string;
  }[]>`
    select m.user_id, u.email, u.display_name, m.role, m.created_at as joined_at
    from org_members m join users u on u.id = m.user_id
    where m.org_id = ${id} order by m.created_at asc`;

  // Discovery curation (doc 15 §3): public competitions of this org with
  // their showcase state — featured (Pro-eligible) and abuse block.
  const competitions = await sql<{
    id: string; name: string; visibility: string; discoverable: boolean;
    discovery_blocked: boolean; discovery_featured: boolean;
  }[]>`
    select id, name, visibility, discoverable, discovery_blocked, discovery_featured
    from competitions where org_id = ${id}
    order by created_at desc limit 50`;
  const featureEligible = await hasFeature(id, "discovery.featured");

  const overrides = await sql<{
    feature_key: string; bool_value: boolean | null; int_value: number | null;
    expires_at: string | null; reason: string | null;
  }[]>`
    select feature_key, bool_value, int_value, expires_at, reason
    from org_entitlement_overrides where org_id = ${id} order by feature_key`;

  const auditLog = await sql<{ id: string; actor_email: string; action: string; created_at: string }[]>`
    select s.id, u.email as actor_email, s.action, s.created_at
    from staff_audit_log s join users u on u.id = s.actor_id
    where s.target_id = ${id} order by s.created_at desc limit 20`;

  // SPEC-6 C2/C4 — AI credit wallet + unified adjustments log. The wallet is
  // the group pool (coalesce(subscription_id, id)); count how many orgs share
  // it so a grant's blast radius is visible. Caller's staff_role drives the
  // modal's ≤50 hint only — the route still server-enforces the cap.
  const staff = await requireStaff();
  const walletId = await walletIdFor(id);
  const walletBal = await walletBalance(walletId);
  const [{ n: sharedByOrgs }] = await sql<{ n: number }[]>`
    select count(*)::int as n from organizations
    where coalesce(subscription_id, id)::text = ${walletId}`;
  const adjustments = await adjustmentsForOrg(id, { limit: 50 });

  // V354: archived divisions still holding a `divisions.per_competition.max`
  // slot, because they have recorded results. The only rows the waiver means
  // anything on.
  const heldSlots = await slotConsumingDivisions(id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500 mb-1">
            <Link href="/admin" className="hover:text-white">Admin</Link> / Org
          </p>
          <h1 className="text-xl font-bold text-white">{org.name}</h1>
          <p className="font-mono text-xs text-slate-400">{org.id}</p>
        </div>
        <span className={`rounded px-2 py-1 text-xs font-medium ${
          org.status === "active" ? "bg-emerald-900 text-emerald-300" :
          org.status === "suspended" ? "bg-red-900 text-red-300" :
          "bg-slate-700 text-slate-300"
        }`}>{org.status}</span>
      </div>

      {/* Plan panel (v3/08 §1): plan + source + Stripe links + all plan
          actions — comp, trial, downgrade, overrides. */}
      <AdminPlanPanel orgId={id} orgName={org.name} plan={{ ...plan, cards }} overrides={overrides} />

      {/* Effective entry-fee cut (spec §5): resolution result for THIS org.
          Per-org deals ride the overrides editor above with feature key
          registration.fee_percent.

          Deliberately called WITHOUT a competition id. `registration.fee_percent`
          is Event-Pass-lifted (8% community → 5% pass), so the rate is per
          competition and there is no single true number for an org page. The
          org-level resolution is the right thing to show here; the sentence below
          names the exception so staff reconciling a 5% charge are not left
          hunting for an override that does not exist. */}
      <p className="text-xs text-slate-400">
        Entry-fee platform cut for this org:{" "}
        <span className="font-semibold text-slate-200">{await feePercentFor(id)}%</span>
        {" — "}override via <code className="text-slate-300">registration.fee_percent</code> in
        the plan panel; the global default lives under{" "}
        <Link href="/admin/settings" className="text-purple-300 hover:text-white">
          Settings
        </Link>
        . Competitions with an Event Pass bill at the pass rate instead, so a charge on one
        of those will not match this number.
      </p>

      {/* AI credits (SPEC-6 C2): wallet balance + Grant/deduct modal. */}
      <AdminCreditsPanel
        orgId={id}
        walletId={walletId}
        sharedByOrgs={sharedByOrgs}
        balance={walletBal}
        staffRole={staff.staff_role}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Stats */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Usage</h2>
          <p className="text-sm text-slate-300">{members.length} members</p>
          <p className="text-sm text-slate-300">{competitions.length}+ competitions</p>
          <p className="text-sm text-slate-300">Created {new Date(org.created_at).toLocaleDateString()}</p>
        </div>

        {/* Actions */}
        <div className="rounded-lg bg-slate-800 p-4">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Actions</h2>
          <AdminOrgActions
            orgId={id}
            currentStatus={org.status}
          />
        </div>
      </div>

      {/* Members */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-400">Members</h2>
        <div className="rounded-lg border border-slate-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-xs text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Role</th>
                <th className="px-3 py-2 text-left">Joined</th>
                <th className="px-3 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {members.map((m) => (
                <tr key={m.user_id} className="hover:bg-slate-800/50">
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${m.user_id}`} className="text-purple-300 hover:text-white">
                      {m.email}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{m.role}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{new Date(m.joined_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${m.user_id}`} className="text-xs text-slate-400 hover:text-white">View →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Discovery curation (doc 15 §3) */}
      {competitions.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-400">Discovery showcase</h2>
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Competition</th>
                  <th className="px-3 py-2 text-left">State</th>
                  <th className="px-3 py-2 text-left">Curation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {competitions.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-800/50">
                    <td className="px-3 py-2 text-slate-300">{c.name}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="text-slate-400">{c.visibility}</span>
                      {c.discoverable && <span className="ml-2 text-emerald-400">discoverable</span>}
                      {c.discovery_featured && <span className="ml-2 text-amber-400">featured</span>}
                      {c.discovery_blocked && <span className="ml-2 text-red-400">blocked</span>}
                    </td>
                    <td className="px-3 py-2">
                      <AdminDiscoveryActions
                        competitionId={c.id}
                        featured={c.discovery_featured}
                        blocked={c.discovery_blocked}
                        featureEligible={featureEligible}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Division slots held by archived divisions (V354). The slot rule has no
          timer by design — any window long enough to close the
          archive-and-recreate loop is short enough to punish an honest mistake
          — so a stray recorded result gets THIS support path instead. Audited.
          Rendered only when there is something to waive. */}
      {heldSlots.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-300">Division slots held</h2>
          <p className="mb-2 text-xs text-slate-400">
            These divisions are archived but still count against{" "}
            <code className="text-slate-300">divisions.per_competition.max</code>, because they
            have recorded results. Waive a slot only to undo a genuine mistake — it is audited.
          </p>
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Division</th>
                  <th className="px-3 py-2 text-left">Archived</th>
                  <th className="px-3 py-2 text-left">Slot</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {heldSlots.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-800/50">
                    {/* Competition rides UNDER the division name rather than in
                        a column of its own: at 375px a fourth column pushes the
                        button off the visible strip of the scroll container,
                        which is the one cell staff came here to reach. */}
                    <td className="px-3 py-2">
                      <span className="text-slate-200">{d.name}</span>
                      <span className="block text-xs text-slate-500">{d.competitionName}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                      {new Date(d.archivedAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <SlotWaiverButton divisionId={d.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Adjustments log (SPEC-6 C4): the SPEC-3 §3 unified per-org log —
          actor · action · category · reason · when · reversible, newest first.
          Scroll container is keyboard-reachable (tabIndex/role/aria) so axe
          does not flag an unfocusable scrollable region. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-300">Adjustments log</h2>
        {adjustments.length === 0 ? (
          <p className="text-xs text-slate-400">No staff adjustments recorded for this org.</p>
        ) : (
          <div
            className="rounded-lg border border-slate-800 overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Adjustments log"
          >
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Actor</th>
                  <th className="px-3 py-2 text-left">Action</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-left">Reversible</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {adjustments.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-800/50">
                    <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                      {new Date(a.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-slate-300">{a.actorName ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-200">
                      {ADJUSTMENT_LABELS[a.action]}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-300">{a.category}</td>
                    <td className="px-3 py-2 text-xs text-slate-300">{a.reason ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      {a.reversible ? (
                        <span className="text-emerald-300">reversible</span>
                      ) : (
                        <span className="text-slate-400">final</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Staff audit */}
      {auditLog.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-400">Staff history</h2>
          <div className="space-y-1">
            {auditLog.map((e) => (
              <div key={e.id} className="flex gap-3 text-xs text-slate-400">
                <span className="text-slate-600">{new Date(e.created_at).toLocaleString()}</span>
                <span className="text-purple-400">{e.actor_email}</span>
                <span>{e.action}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
