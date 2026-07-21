"use client";

// Admin plan panel (v3/08 §1): comp-to-Pro, downgrade-with-freeze-preview,
// extend trial, entitlement overrides with expiry. Every action demands a
// reason (audited); the destructive one (downgrade) is a typed-name confirm.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ui/confirm-provider";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { cardRemovalConsequence, type PaymentMethodRow } from "@/lib/billing-manage";

interface Plan {
  plan_key: string;
  status: string;
  source: "stripe" | "comped" | "none";
  trial_end: string | null;
  comped_until: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  // One-trial-per-org stamp (V277). Independent of status/plan_key — a
  // departed org (status: canceled) can still carry a pro plan_key AND a
  // trial_used_at date; neither hides the other here.
  trial_used_at: string | null;
  // Task 6C: cards on the org's Stripe customer, so staff can remove one —
  // including the default, which the customer-facing surface refuses on
  // purpose (billing-manage.ts). Empty for an org with no Stripe customer.
  cards: PaymentMethodRow[];
  // How many live orgs bill through this group, and who the others are. Every
  // control here writes the shared subscriptions row, so these drive the
  // blast-radius warning above the actions.
  group_org_count: number;
  group_other_orgs: { id: string; name: string }[];
}

interface Override {
  feature_key: string;
  bool_value: boolean | null;
  int_value: number | null;
  expires_at: string | null;
  reason: string | null;
}

const inputCls =
  "rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-white placeholder:text-slate-500";

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-GB") : "—";
}

export function AdminPlanPanel({
  orgId,
  orgName,
  plan,
  overrides,
}: {
  orgId: string;
  orgName: string;
  plan: Plan;
  overrides: Override[];
}) {
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // form state
  const [compUntil, setCompUntil] = useState("");
  const [compReason, setCompReason] = useState("");
  const [trialDays, setTrialDays] = useState("14");
  const [trialReason, setTrialReason] = useState("");
  const [restoreReason, setRestoreReason] = useState("");
  const [downReason, setDownReason] = useState("");
  // Keyed by card id, NOT one shared string — a reason typed while looking at
  // one card must never be able to ride along with a different card's Remove
  // click (the two controls used to share a single input).
  const [cardReasons, setCardReasons] = useState<Record<string, string>>({});
  const [ov, setOv] = useState({ key: "", value: "", expires: "", reason: "" });

  async function call(path: string, init: RequestInit, tag: string) {
    setBusy(tag);
    setError("");
    try {
      const res = await fetch(`/api/admin/orgs/${orgId}/${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
      router.refresh();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function downgrade() {
    setBusy("preview");
    setError("");
    let frozenNames: string[] = [];
    try {
      const res = await fetch(`/api/admin/orgs/${orgId}/downgrade`);
      // handler() wraps every successful payload as { ok, data } (lib/http.ts)
      // — the preview lives under body.data, not on the response body itself.
      const body = (await res.json()) as {
        ok: boolean;
        data?: { frozen?: { name: string }[]; active: number; limit: number | null };
        error?: string;
      };
      if (!res.ok || !body.ok || !body.data) throw new Error(body.error ?? "Preview failed");
      // Guard .frozen itself too: a shape surprise degrades into the "nothing
      // will freeze" confirm-dialog branch below instead of throwing.
      frozenNames = (body.data.frozen ?? []).map((f) => f.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
      setBusy(null);
      return;
    }
    setBusy(null);
    const ok = await confirmDialog({
      title: "Downgrade to Free — immediately?",
      body:
        frozenNames.length > 0
          ? `These competitions become read-only until the org upgrades or archives something: ${frozenNames.join(", ")}. Nothing is deleted.`
          : "The org is within Free limits — nothing will freeze. Pro features switch off immediately.",
      confirmLabel: "Downgrade org",
      tone: "danger",
      typedName: orgName,
    });
    if (!ok) return;
    await call("downgrade", { method: "POST", body: JSON.stringify({ reason: downReason }) }, "downgrade");
  }

  // Staff-only card removal (Task 6C), including the default — the
  // customer-facing page refuses that on purpose. States the consequence
  // BEFORE the click via a danger confirm, not after.
  async function removeCard(card: PaymentMethodRow) {
    const remainingAfter = plan.cards.length - 1;
    const ok = await confirmDialog({
      title: `Remove ${card.brand} •••• ${card.last4}?`,
      body: cardRemovalConsequence(remainingAfter, plan.status),
      confirmLabel: "Remove card",
      tone: "danger",
    });
    if (!ok) return;
    const done = await call(
      "remove-payment-method",
      {
        method: "POST",
        body: JSON.stringify({ payment_method_id: card.id, reason: cardReasons[card.id] ?? "" }),
      },
      `pm-${card.id}`,
    );
    if (done) {
      setCardReasons((prev) => {
        const next = { ...prev };
        delete next[card.id];
        return next;
      });
    }
  }

  async function saveOverride() {
    const trimmed = ov.value.trim().toLowerCase();
    const body: Record<string, unknown> = {
      feature_key: ov.key.trim(),
      reason: ov.reason,
      expires_at: ov.expires || null,
    };
    if (trimmed === "true" || trimmed === "false") body.bool_value = trimmed === "true";
    else if (/^-?\d+$/.test(trimmed)) body.int_value = Number(trimmed);
    else {
      setError("Value must be true, false or an integer.");
      return;
    }
    const done = await call(
      "entitlement-override",
      { method: "POST", body: JSON.stringify(body) },
      "override",
    );
    if (done) setOv({ key: "", value: "", expires: "", reason: "" });
  }

  // Liveness, not id presence: a cancelled subscription keeps its id for ever
  // (V277), so a departed org must see these three forms exactly like the
  // Restore-trial control does — same rule, one voice across the panel.
  const stripeBilled = hasLiveSubscription(plan);

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      {/* ── Plan summary ── */}
      <div className="rounded-lg bg-slate-800 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Plan
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded bg-purple-900/70 px-2.5 py-1 text-sm font-semibold text-purple-200">
            {plan.plan_key}
          </span>
          <span className="text-sm text-slate-300">status: {plan.status}</span>
          <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            source: {plan.source}
          </span>
          {plan.comped_until && (
            <span className="text-xs text-amber-300">comped until {fmtDate(plan.comped_until)}</span>
          )}
          {plan.trial_end && (
            <span className="text-xs text-slate-400">trial ends {fmtDate(plan.trial_end)}</span>
          )}
          {/* Independent of status/plan_key on purpose: a departed org (status
              canceled) can still show trial used here alongside a leftover
              pro plan_key above — neither fact papers over the other. */}
          {plan.trial_used_at && (
            <span className="text-xs text-slate-500">trial used {fmtDate(plan.trial_used_at)}</span>
          )}
        </div>
        <div className="mt-2 flex gap-3 text-xs">
          {plan.stripe_customer_id && (
            <a
              className="text-purple-300 hover:text-white"
              href={`https://dashboard.stripe.com/customers/${plan.stripe_customer_id}`}
              target="_blank"
              rel="noreferrer"
            >
              Stripe customer ↗
            </a>
          )}
          {plan.stripe_subscription_id && (
            <a
              className="text-purple-300 hover:text-white"
              href={`https://dashboard.stripe.com/subscriptions/${plan.stripe_subscription_id}`}
              target="_blank"
              rel="noreferrer"
            >
              Stripe subscription ↗
            </a>
          )}
        </div>

        {/* Every control on this page writes the SHARED subscriptions row, so a
            comp, a downgrade or a trial extension applied here moves the plan
            for every org on the bill. The usecases have always been group-wide
            (their invalidations fan out); the panel said nothing, so staff
            comping "one club" could hand free Pro to a federation without a
            hint on screen. Amber, not red: this is correct behaviour that has
            to be seen, not an error. */}
        {plan.group_org_count > 1 && (
          <p className="mt-3 rounded border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            <span className="font-semibold">
              This bill covers {plan.group_org_count} organisations.
            </span>{" "}
            Every plan change below applies to all of them, not just this one — including{" "}
            {plan.group_other_orgs.map((o) => o.name).join(", ")}
            {plan.group_other_orgs.length < plan.group_org_count - 1 &&
              ` and ${plan.group_org_count - 1 - plan.group_other_orgs.length} more`}
            .
          </p>
        )}
      </div>

      {/* Payment methods (Task 6C): staff-only removal of the DEFAULT card —
          customers can remove a non-default card themselves, but only staff
          may remove the default (billing-manage.tsx hides that control from
          customers and the server 400s a customer attempt). A customer with
          `stripe_customer_id` set but an empty card list is otherwise
          invisible here: nothing renders, and staff working a fraud-cleanup
          or erasure request can't tell "no cards" from "Stripe didn't
          answer" — so that state gets its own explicit line below. */}
      {plan.stripe_customer_id && plan.cards.length === 0 && (
        <div className="rounded-lg bg-slate-800 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Payment methods
          </h3>
          <p className="mt-2 text-xs text-slate-500">
            No cards on file — or Stripe could not be reached.
          </p>
        </div>
      )}
      {plan.cards.length > 0 && (
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Payment methods
          </h3>
          <ul className="divide-y divide-slate-700/60">
            {plan.cards.map((c) => (
              <li key={c.id} className="space-y-1.5 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-300">
                    {c.brand} •••• {c.last4} ({c.expMonth}/{c.expYear})
                    {c.isDefault && (
                      <span className="ml-2 rounded bg-purple-900/70 px-1.5 py-0.5 text-[11px] text-purple-200">
                        default
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => removeCard(c)}
                    disabled={!cardReasons[c.id] || busy === `pm-${c.id}`}
                    className="rounded bg-red-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy === `pm-${c.id}` ? "…" : "Remove card"}
                  </button>
                </div>
                {/* Per-card reason, scoped by id — see cardReasons above. */}
                <input
                  value={cardReasons[c.id] ?? ""}
                  onChange={(e) =>
                    setCardReasons((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }
                  placeholder="Reason (required)"
                  className={`${inputCls} w-full`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-4">
        {/* Comp to Pro */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Comp to Pro
          </h3>
          {stripeBilled ? (
            <p className="text-xs text-slate-500">
              Stripe-billed — adjust the subscription in Stripe instead.
            </p>
          ) : (
            <>
              <label className="block text-xs text-slate-400">
                Until (empty = forever)
                <input
                  type="date"
                  value={compUntil}
                  onChange={(e) => setCompUntil(e.target.value)}
                  className={`${inputCls} mt-1 w-full`}
                />
              </label>
              <input
                value={compReason}
                onChange={(e) => setCompReason(e.target.value)}
                placeholder="Reason (required)"
                className={`${inputCls} w-full`}
              />
              <button
                onClick={() =>
                  call(
                    "comp-to-pro",
                    {
                      method: "POST",
                      body: JSON.stringify({ until: compUntil || null, reason: compReason }),
                    },
                    "comp",
                  )
                }
                disabled={!compReason || busy === "comp"}
                className="rounded bg-purple-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50"
              >
                {busy === "comp" ? "…" : plan.plan_key === "pro" ? "Update comp" : "Comp to Pro"}
              </button>
            </>
          )}
        </div>

        {/* Extend trial */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Extend trial
          </h3>
          <div className="flex gap-1.5">
            {[7, 14].map((d) => (
              <button
                key={d}
                onClick={() => setTrialDays(String(d))}
                className={`rounded px-2 py-1 text-xs ${
                  trialDays === String(d)
                    ? "bg-purple-700 text-white"
                    : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                }`}
              >
                +{d}d
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={365}
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              className={`${inputCls} w-16`}
            />
          </div>
          <input
            value={trialReason}
            onChange={(e) => setTrialReason(e.target.value)}
            placeholder="Reason (required)"
            className={`${inputCls} w-full`}
          />
          <button
            onClick={() =>
              call(
                "grant-trial",
                {
                  method: "POST",
                  body: JSON.stringify({ days: Number(trialDays), reason: trialReason }),
                },
                "trial",
              )
            }
            disabled={!trialReason || busy === "trial"}
            className="rounded bg-purple-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50"
          >
            {busy === "trial" ? "…" : "Extend trial"}
          </button>
          {stripeBilled && (
            <p className="text-[11px] text-slate-500">Also updates trial_end in Stripe.</p>
          )}
        </div>

        {/* Restore trial — the undo for one-trial-per-org. Every route that
            grants Pro (checkout sync, comp, grant) burns the trial, so staff
            need a sanctioned way back instead of editing SQL. Not gated on
            stripeBilled: a departed org (dead subscription id, canceled
            status) is exactly the case this exists for, and the usecase
            itself refuses a LIVE subscription with a clear 400. */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Restore trial
          </h3>
          <p className="text-xs text-slate-400">
            Clears the one-trial-per-org stamp, so this org can start a 14-day
            trial again. The next comp or grant burns it once more.
          </p>
          <p className="text-[11px] text-slate-500">
            {plan.trial_used_at
              ? `Trial used ${fmtDate(plan.trial_used_at)}.`
              : "This org has not used its trial yet — nothing to restore."}
          </p>
          <input
            value={restoreReason}
            onChange={(e) => setRestoreReason(e.target.value)}
            placeholder="Reason (required)"
            className={`${inputCls} w-full`}
          />
          <button
            onClick={() =>
              call(
                "restore-trial",
                { method: "POST", body: JSON.stringify({ reason: restoreReason }) },
                "restore",
              )
            }
            disabled={!restoreReason || busy === "restore"}
            className="rounded bg-purple-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50"
          >
            {busy === "restore" ? "…" : "Restore trial"}
          </button>
        </div>

        {/* Downgrade */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Downgrade to Free
          </h3>
          {stripeBilled ? (
            <p className="text-xs text-slate-500">
              Stripe-billed — cancellation must go through the subscription.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-slate-500">
                Shows what will freeze before anything happens.
              </p>
              <input
                value={downReason}
                onChange={(e) => setDownReason(e.target.value)}
                placeholder="Reason (required)"
                className={`${inputCls} w-full`}
              />
              <button
                onClick={downgrade}
                disabled={!downReason || busy === "preview" || busy === "downgrade"}
                className="rounded bg-red-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy === "preview" || busy === "downgrade" ? "…" : "Preview & downgrade"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Entitlement overrides ── */}
      <div className="rounded-lg bg-slate-800 p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Entitlement overrides
        </h3>
        {overrides.length > 0 && (
          <table className="mb-3 w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3">Feature</th>
                <th className="py-1 pr-3">Value</th>
                <th className="py-1 pr-3">Expires</th>
                <th className="py-1 pr-3">Reason</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {overrides.map((o) => {
                const lapsed = o.expires_at && new Date(o.expires_at).getTime() <= Date.now();
                return (
                  <tr key={o.feature_key} className={lapsed ? "opacity-50" : ""}>
                    <td className="py-1.5 pr-3 font-mono text-xs text-purple-300">
                      {o.feature_key}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-300">
                      {o.bool_value != null ? String(o.bool_value) : (o.int_value ?? "—")}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-slate-400">
                      {fmtDate(o.expires_at)}
                      {lapsed && <span className="ml-1 text-amber-400">(lapsed)</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-slate-400">{o.reason ?? "—"}</td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={() =>
                          call(
                            "entitlement-override",
                            {
                              method: "DELETE",
                              body: JSON.stringify({ feature_key: o.feature_key }),
                            },
                            `del-${o.feature_key}`,
                          )
                        }
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            value={ov.key}
            onChange={(e) => setOv({ ...ov, key: e.target.value })}
            placeholder="feature_key"
            className={`${inputCls} w-44 font-mono text-xs`}
          />
          <input
            value={ov.value}
            onChange={(e) => setOv({ ...ov, value: e.target.value })}
            placeholder="true / false / 5"
            className={`${inputCls} w-28`}
          />
          <input
            type="date"
            value={ov.expires}
            onChange={(e) => setOv({ ...ov, expires: e.target.value })}
            title="Expiry (optional)"
            className={inputCls}
          />
          <input
            value={ov.reason}
            onChange={(e) => setOv({ ...ov, reason: e.target.value })}
            placeholder="Reason (required)"
            className={`${inputCls} min-w-40 flex-1`}
          />
          <button
            onClick={saveOverride}
            disabled={!ov.key.trim() || !ov.reason.trim() || busy === "override"}
            className="rounded bg-purple-700 px-3 py-1 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50"
          >
            {busy === "override" ? "…" : "Set override"}
          </button>
        </div>
      </div>

      {/* Event passes: lands with PROMPT-36 (competition_passes doesn't exist
          yet) — deliberate gap, tracked in design/v3/README. */}
    </div>
  );
}
