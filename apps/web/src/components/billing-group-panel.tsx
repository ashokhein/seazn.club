"use client";

// The organisations on one bill (spec 2026-07-21 billing-groups §Operations).
//
// The information design is the feature here. A group has TWO counts —
// organisations on the bill, and seats already paid for — and they can differ,
// because a slot that has been paid for and freed stays yours until renewal.
// Showing one number ("4 of 5") would make a free re-add look like a purchase,
// which is the opposite of what the customer was promised. So both are stated,
// and the freed slot gets a line of its own when it exists.
//
// Payer-only: it is mounted from the billing page behind `isPayer`, and every
// route it calls re-checks that server-side. Nothing here is a permission gate.
import { useEffect, useState } from "react";
import { Building2, Plus, X } from "lucide-react";
import { Tip } from "@/components/ui/tip";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { asCurrency, formatMinor } from "@/lib/currency";
import { TransferOfferAccept } from "@/components/transfer-offer-accept";
// The decisions live in a pure module so they can be tested. This component's
// data arrives in an effect and the vitest environment here is `node` with no
// jsdom, so a render test would assert against the null returned before the
// fetch lands — see lib/billing-group-view.ts.
import {
  attachConfirmKey,
  groupView,
  transferConfirmKey,
  transferExplainerKey,
  type ViewGroup as Group,
  type ViewGroupOrg as GroupOrg,
  type ViewOffer as Offer,
} from "@/lib/billing-group-view";

/** The "what this also does" list under a confirm dialog's headline sentence.
 *  Kept small and quiet — it informs the decision, it is not the decision. */
function EffectsList({ items }: { items: string[] }) {
  return (
    <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-500">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

async function api(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: res.ok && json.ok !== false, error: json.error };
}

export function BillingGroupPanel({
  subscriptionId,
  currentUserId,
}: {
  subscriptionId: string;
  currentUserId: string;
}) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The incoming offer whose card form is open (setup_intent_id), if any.
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  async function load() {
    const [gRes, oRes] = await Promise.all([
      fetch("/api/billing/groups"),
      fetch("/api/billing/group/transfer"),
    ]);
    const gJson = (await gRes.json().catch(() => ({}))) as { ok?: boolean; data?: Group[] };
    const oJson = (await oRes.json().catch(() => ({}))) as { ok?: boolean; data?: Offer[] };
    setGroups(gJson.ok ? (gJson.data ?? []) : []);
    // Offers are a Stripe round trip and can fail on their own; a broken offer
    // list must not blank the organisation list, which is the panel's main job.
    setOffers(oJson.ok ? (oJson.data ?? []) : []);
  }

  useEffect(() => {
    void load();
  }, []);

  if (groups === null) return null;

  const view = groupView({ groups, offers, subscriptionId, currentUserId });
  if (!view || view.hidden) return null;

  const group = groups.find((g) => g.id === subscriptionId)!;
  const {
    onBill,
    seatsPaid,
    freeSlots,
    atCap,
    hasLive,
    candidates,
    blocked,
    recipients,
    outgoing,
    incoming,
  } = view;

  async function offer(to: { id: string; name: string | null }) {
    const ok = await confirm({
      title: msg("billing.group.transfer.confirmTitle", { person: to.name ?? "" }),
      // Two DIFFERENT promises, because two different things happen — see
      // transferConfirmKey, which is where that choice is tested.
      body: msg(transferConfirmKey(hasLive), { person: to.name ?? "" }),
      confirmLabel: msg("billing.group.transfer.confirmAction"),
      // Type-to-confirm on every org-level billing act: handing a bill to
      // someone else is irreversible from the payer's side, so a click is too
      // cheap for it.
      typedName: "CONFIRM",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const res = await api("/api/billing/group/transfer", {
      subscription_id: subscriptionId,
      new_owner_user_id: to.id,
    });
    if (!res.ok) setError(res.error ?? msg("billing.group.error"));
    await load();
    setBusy(false);
  }

  async function revoke(setupIntentId: string) {
    setBusy(true);
    setError(null);
    const res = await api("/api/billing/group/transfer/revoke", {
      setup_intent_id: setupIntentId,
    });
    if (!res.ok) setError(res.error ?? msg("billing.group.error"));
    await load();
    setBusy(false);
  }

  async function attach(org: GroupOrg & { from: Group }) {
    // The EXACT prorated cost, previewed before the click, so the dialog states
    // a figure ("£9.00 now") rather than "half your plan's rate". Best-effort: a
    // preview that fails or is null (a free move) falls back to the rate copy,
    // never blocking the attach.
    let priceLine = msg(attachConfirmKey(freeSlots), { org: org.name });
    try {
      const res = await fetch("/api/billing/group/attach/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription_id: subscriptionId }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { preview?: { amount_minor: number; currency: string } | null };
      };
      const preview = json.data?.preview;
      if (preview) {
        priceLine = msg("billing.group.attach.confirmChargeAmount", {
          org: org.name,
          amount: formatMinor(preview.amount_minor, asCurrency(preview.currency)),
        });
      }
    } catch {
      /* keep the rate-based fallback */
    }
    const ok = await confirm({
      title: msg("billing.group.attach.confirmTitle", { org: org.name }),
      // The price comes FIRST, then the short list of what else moving an
      // organisation onto the bill changes — the fee-rate and Connect
      // consequences a payer would otherwise meet by surprise.
      body: (
        <>
          <p>{priceLine}</p>
          <EffectsList
            items={[
              msg("billing.group.attach.effects.plan"),
              msg("billing.group.attach.effects.feeLock"),
              msg("billing.group.attach.effects.connect"),
            ]}
          />
        </>
      ),
      confirmLabel: msg("billing.group.attach.confirmAction"),
      // Attaching charges money and moves an org's plan; type to confirm.
      typedName: "CONFIRM",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const res = await api("/api/billing/group/attach", {
      org_id: org.id,
      subscription_id: subscriptionId,
    });
    if (!res.ok) setError(res.error ?? msg("billing.group.error"));
    await load();
    setBusy(false);
  }

  async function detach(org: GroupOrg) {
    const ok = await confirm({
      title: msg("billing.group.detach.confirmTitle", { org: org.name }),
      // No refund and the slot stays paid (confirmBody), then what removal does
      // to the org itself: the downgrade at period end, which competitions keep
      // their locked fee rate, and that Connect is untouched.
      body: (
        <>
          <p>{msg("billing.group.detach.confirmBody", { org: org.name })}</p>
          <EffectsList
            items={[
              msg("billing.group.detach.effects.downgrade"),
              msg("billing.group.detach.effects.feeLock"),
              msg("billing.group.detach.effects.connect"),
            ]}
          />
        </>
      ),
      confirmLabel: msg("billing.group.detach.confirmAction"),
      tone: "danger",
      // Removing an org drops it to Community at period end with no refund; the
      // slowest, most deliberate of the three, so type to confirm here too.
      typedName: "CONFIRM",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const res = await api("/api/billing/group/detach", { org_id: org.id });
    if (!res.ok) setError(res.error ?? msg("billing.group.error"));
    await load();
    setBusy(false);
  }

  return (
    // Test id rather than the heading text: e2e scopes every assertion in
    // billing-groups.spec.ts to this container, and this panel's whole job is
    // wording that is expected to be revised.
    <section data-testid="billing-group-panel" className="card mb-6 p-5">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-purple-600">
        {msg("billing.group.title")}
        <Tip id="billing.groups" className="ml-1 align-middle" small />
      </h2>

      {/* The two counts, stated plainly and never merged. */}
      <p className="mb-4 text-sm text-slate-500 tabular-nums">
        {msg("billing.group.counts", { orgs: String(onBill), seats: String(seatsPaid) })}
        {group.max_orgs !== null && (
          <> · {msg("billing.group.capacity", { max: String(group.max_orgs) })}</>
        )}
      </p>

      {freeSlots > 0 && (
        <p className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {msg("billing.group.freedSlot", { count: String(freeSlots) })}
          <Tip id="billing.freed-slot" className="ml-1 align-middle" />
        </p>
      )}

      <ul className="divide-y divide-slate-100 border-y border-slate-100">
        {group.orgs.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 py-3">
            <span className="flex min-w-0 items-center gap-2">
              <Building2 className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <span className="truncate text-sm text-slate-800">{o.name}</span>
              {o.status === "suspended" && (
                // Suspension is moderation, not billing: the slot is still paid
                // for. Saying so here stops "why am I being charged for it".
                <span className="badge bg-amber-100 text-amber-700">
                  {msg("billing.group.suspended")}
                </span>
              )}
            </span>
            {/* Deliberately quiet. Bordered buttons on every row made the
                remove action the loudest thing in a panel whose job is to tell
                you what you are paying for — three outlined boxes stacked down
                the card, competing with the counts above them. The action is
                secondary and slightly destructive; it should be findable, not
                offered. */}
            <button
              type="button"
              onClick={() => void detach(o)}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-purple-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-4 w-4" aria-hidden />
              {msg("billing.group.remove")}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {msg("billing.group.add")}
          <Tip id="billing.extra-org" className="ml-1 align-middle" small />
        </p>

        {atCap ? (
          <p className="text-sm text-slate-500">
            {msg("billing.group.atCap", { max: String(group.max_orgs) })}
          </p>
        ) : candidates.length === 0 && blocked.length === 0 ? (
          // Not an error and not a dead control: there is simply nothing of
          // theirs to move, and the sentence says what would make one appear.
          <p className="text-sm text-slate-500">{msg("billing.group.noCandidates")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {candidates.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => void attach(o)}
                  disabled={busy}
                  className="btn btn-secondary text-sm"
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden />
                  {o.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Organisations that cannot move yet. Stated, not silently dropped:
            the payer knows they own it and would go looking for why it is
            missing, and the server's 409 would otherwise arrive only after
            they had agreed to a charge. */}
        {blocked.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {blocked.map((o) => (
              <li
                key={o.id}
                className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600"
              >
                {msg("billing.group.blocked", { org: o.name })}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* A bill someone wants to hand to YOU. Shown wherever this panel renders
          so an incoming offer is never missed, and the recipient enters a card
          (their own) before it moves — the second phase of the handover. */}
      {incoming.length > 0 && (
        <div className="mt-5 rounded-xl border border-purple-200 bg-purple-50 p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-700">
            {msg("billing.group.transfer.incomingTitle")}
          </p>
          {incoming.map((o) => (
            <div key={o.setup_intent_id} className="text-sm text-slate-700">
              <p>{msg("billing.group.transfer.incomingBody")}</p>
              {acceptingId === o.setup_intent_id && o.client_secret ? (
                <TransferOfferAccept
                  clientSecret={o.client_secret}
                  setupIntentId={o.setup_intent_id}
                  onDone={() => {
                    setAcceptingId(null);
                    void load();
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAcceptingId(o.setup_intent_id)}
                  disabled={busy || !o.client_secret}
                  className="btn btn-primary mt-2 text-sm"
                >
                  {msg("billing.group.transfer.incomingAccept")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Hand the whole bill to someone else. Separated by a rule because it is
          a different kind of act from moving one organisation: it changes who
          pays for all of them, and it is the only control here that leaves the
          payer with nothing. */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {msg("billing.group.transfer.title")}
        </p>

        {outgoing.length > 0 ? (
          // An outstanding offer is a live claim on this subscription, so it is
          // shown and withdrawable rather than left invisible until it lapses.
          <ul className="flex flex-col gap-2">
            {outgoing.map((o) => (
              <li
                key={o.setup_intent_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
              >
                <span>
                  {msg("billing.group.transfer.pending", {
                    person:
                      recipients.find((r) => r.id === o.to_user_id)?.name ??
                      msg("billing.group.transfer.someone"),
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => void revoke(o.setup_intent_id)}
                  disabled={busy}
                  className="rounded-lg px-2 py-1 text-sm font-medium text-amber-900 underline underline-offset-2 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {msg("billing.group.transfer.withdraw")}
                </button>
              </li>
            ))}
          </ul>
        ) : recipients.length === 0 ? (
          <p className="text-sm text-slate-500">{msg("billing.group.transfer.noRecipients")}</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-slate-500">
              {msg(transferExplainerKey(hasLive))}
            </p>
            <ul className="flex flex-wrap gap-2">
              {recipients.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => void offer(r)}
                    disabled={busy}
                    className="btn btn-ghost text-sm"
                  >
                    {r.name}
                    <span className="ml-1 text-slate-400">· {r.via}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
