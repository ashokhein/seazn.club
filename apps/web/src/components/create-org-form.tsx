"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useMsg } from "@/components/i18n/dict-provider";
import { asCurrency, formatMinor } from "@/lib/currency";
import type { MessageKey } from "@/lib/messages";

/** A billing group the creator pays for, as returned by GET /api/billing/groups
 *  (payer-gated). Only the fields this form reads are modelled here. */
export interface CreateOrgGroup {
  id: string;
  plan_key: string;
  status: string;
  cancel_at_period_end: boolean;
  has_live_subscription: boolean;
  max_orgs: number | null;
  orgs: { id: string; name?: string | null }[];
}

type BillChoice = "separate" | "add";
type PreviewAmount = { amount_minor: number; currency: string };
type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * Whether a group can take one more organisation right now — a client mirror of
 * the server's `attachOrgToGroup` gates. An ineligible group is still shown (the
 * payer owns it and would go looking for why it is missing), just disabled with
 * the reason the server would give. A community group has `max_orgs === 1` and
 * one org, so it always reads `Full` and never offers itself.
 */
export function eligibility(
  g: CreateOrgGroup,
  msg: Msg,
): { eligible: boolean; reason?: string } {
  if (g.status === "past_due")
    return { eligible: false, reason: msg("orgNew.bill.reasonPastDue") };
  if (g.cancel_at_period_end)
    return { eligible: false, reason: msg("orgNew.bill.reasonCancelling") };
  if (g.status !== "active" && g.status !== "trialing")
    return { eligible: false, reason: msg("orgNew.bill.reasonInactive") };
  if (g.max_orgs !== null && g.orgs.length >= g.max_orgs)
    return { eligible: false, reason: msg("orgNew.bill.reasonFull") };
  return { eligible: true };
}

/**
 * The submit button's label — the one place the exact money moving is stated.
 * Separate → the plain create label; adding to a paid bill → the previewed
 * charge ("Create & add — $9 now"); adding a free move (a paid slot that was
 * freed, or a bill with no live subscription yet) → the price-less variant.
 */
export function submitLabel(args: {
  choice: BillChoice;
  preview: PreviewAmount | null;
  msg: Msg;
}): string {
  const { choice, preview, msg } = args;
  if (choice === "separate") return msg("orgNew.create");
  if (preview)
    return msg("orgNew.createAndAdd", {
      amount: formatMinor(preview.amount_minor, asCurrency(preview.currency)),
    });
  return msg("orgNew.createAndAddFree");
}

/** A recognisable name for a bill in the picker: the organisations already on
 *  it, falling back to the plan when an org has lost its name. */
function groupLabel(g: CreateOrgGroup): string {
  const names = g.orgs.map((o) => o.name).filter(Boolean);
  return names.length > 0 ? names.join(", ") : g.plan_key;
}

/** Plan name for a bill's subline in the picker (e.g. "Pro Plus", "Pro"). */
function planLabel(plan: string): string {
  if (plan === "pro_plus") return "Pro Plus";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Create an organization; the creator becomes its owner. Slug is automatic. */
export function CreateOrgForm() {
  const msg = useMsg();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Terminal success-with-caveat: the org was created but couldn't join the
  // chosen bill. It is on its own bill, so a second submit would only create a
  // duplicate — we withhold the create button and offer navigation instead.
  const [done, setDone] = useState(false);

  // Billing choice state. `groups === null` = not yet loaded; the fieldset is
  // withheld until we know whether the creator owns any bill at all.
  const [groups, setGroups] = useState<CreateOrgGroup[] | null>(null);
  const [choice, setChoice] = useState<BillChoice>("separate");
  const [selectedId, setSelectedId] = useState<string>("");
  const [preview, setPreview] = useState<PreviewAmount | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/billing/groups");
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          data?: CreateOrgGroup[];
        };
        if (live) setGroups(json.ok ? (json.data ?? []) : []);
      } catch {
        if (live) setGroups([]);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const eligibleGroups = (groups ?? []).filter((g) => eligibility(g, msg).eligible);
  const selectedGroup = (groups ?? []).find((g) => g.id === selectedId) ?? null;
  const attaching = choice === "add" && !!selectedGroup;

  /** Preview the exact charge for a paid bill; a bill with no live subscription
   *  is a free move, so it skips the round trip and clears any prior amount. */
  async function loadPreview(group: CreateOrgGroup) {
    if (!group.has_live_subscription) {
      setPreview(null);
      return;
    }
    try {
      const res = await fetch("/api/billing/group/attach/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription_id: group.id }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { preview?: PreviewAmount | null };
      };
      setPreview(json.data?.preview ?? null);
    } catch {
      // A failed preview must not block creating; fall back to the price-less
      // label rather than inventing a number.
      setPreview(null);
    }
  }

  function chooseAdd() {
    setChoice("add");
    const first = eligibleGroups[0];
    if (first) {
      setSelectedId(first.id);
      void loadPreview(first);
    }
  }

  function chooseSeparate() {
    setChoice("separate");
    setPreview(null);
  }

  function pickGroup(id: string) {
    setSelectedId(id);
    const g = (groups ?? []).find((x) => x.id === id);
    if (g) void loadPreview(g);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The org is created on the FIRST submit; once created (busy or done), a
    // resubmit — including Enter in the name field while the button is hidden —
    // must not POST again and create a duplicate.
    if (busy || done) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const data = await api<{ attach?: { ok: boolean; reason?: string } }>(
        "/api/orgs",
        {
          method: "POST",
          json: {
            name,
            attachToGroupId: attaching ? selectedGroup!.id : undefined,
          },
        },
      );
      if (data.attach?.ok === false) {
        // The org was still created — attaching it to the bill is the part that
        // failed. Say so plainly and stay on the page so the message is read,
        // rather than routing away and losing it.
        setNotice(
          msg("orgNew.attachFailed", { reason: data.attach.reason ?? "" }),
        );
        // The org exists on its own bill; block any re-submit that would
        // duplicate it. The page now offers navigation, not another create.
        setDone(true);
        setBusy(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("orgNew.failed"));
      setBusy(false);
    }
  }

  const showBilling = (groups?.length ?? 0) > 0;

  return (
    <form onSubmit={submit} className="card space-y-6 p-6">
      <label className="block">
        <span className="label">{msg("orgNew.nameLabel")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={msg("orgNew.namePlaceholder")}
          className="input"
          autoFocus
        />
        <span className="mt-1 block text-xs text-slate-400">
          {msg("orgNew.renameHint")}
        </span>
      </label>

      {showBilling && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-600">
            {msg("orgNew.bill.legend")}
          </legend>

          {/* Segmented choice: its own bill (default) vs join one the creator
              already pays for. The "add" side is disabled when no bill of the
              creator's can take another organisation. */}
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={chooseSeparate}
              aria-pressed={choice === "separate"}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                choice === "separate"
                  ? "bg-white text-purple-700 shadow-sm"
                  : "text-slate-600 hover:text-slate-800"
              }`}
            >
              {msg("orgNew.bill.separate")}
            </button>
            <button
              type="button"
              onClick={chooseAdd}
              disabled={eligibleGroups.length === 0}
              aria-pressed={choice === "add"}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                choice === "add"
                  ? "bg-white text-purple-700 shadow-sm"
                  : "text-slate-600 hover:text-slate-800"
              }`}
            >
              {msg("orgNew.bill.addToExisting")}
            </button>
          </div>

          {choice === "separate" && (
            <p className="px-1 text-xs text-slate-500">
              {msg("orgNew.bill.separateHint")}
            </p>
          )}

          {eligibleGroups.length === 0 && (
            <p className="px-1 text-xs text-slate-400">
              {msg("orgNew.bill.noneEligible")}
            </p>
          )}

          {choice === "add" && (
            <div className="space-y-2">
              <p className="px-1 text-xs text-emerald-700">
                {msg("orgNew.bill.addToExistingHint")}
              </p>
              <ul className="space-y-2">
                {(groups ?? []).map((g) => {
                  const { eligible, reason } = eligibility(g, msg);
                  const on = eligible && selectedId === g.id;
                  return (
                    <li key={g.id}>
                      <button
                        type="button"
                        onClick={() => pickGroup(g.id)}
                        disabled={!eligible}
                        aria-pressed={on}
                        className={`flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition disabled:cursor-not-allowed ${
                          on
                            ? "border-purple-300 bg-purple-50/70 ring-1 ring-purple-200"
                            : eligible
                              ? "border-slate-200 hover:border-purple-200"
                              : "border-slate-200 opacity-60"
                        }`}
                      >
                        <span
                          className={`grid h-4 w-4 flex-none place-items-center rounded-full border ${
                            on ? "border-purple-600" : "border-slate-300"
                          }`}
                        >
                          {on && <span className="h-2 w-2 rounded-full bg-purple-600" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-900">
                            {groupLabel(g)}
                          </span>
                          <span className="block text-xs text-slate-500">
                            {planLabel(g.plan_key)} · {g.orgs.length}/{g.max_orgs ?? "∞"}
                          </span>
                        </span>
                        {!eligible && (
                          <span className="flex-none rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                            {reason}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {attaching && preview && (
                <p className="px-1 text-sm font-medium text-emerald-700">
                  {msg("orgNew.bill.chargeNow", {
                    amount: formatMinor(
                      preview.amount_minor,
                      asCurrency(preview.currency),
                    ),
                  })}
                  <span className="ml-1 font-normal text-slate-500">
                    · {msg("orgNew.bill.thenPerExtra")}
                  </span>
                </p>
              )}
            </div>
          )}
        </fieldset>
      )}

      {notice && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {notice}
        </p>
      )}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {done ? (
        <button
          type="button"
          onClick={() => {
            router.push("/dashboard");
            router.refresh();
          }}
          className="btn btn-primary w-full py-2.5"
        >
          {msg("orgNew.continueToBoard")}
        </button>
      ) : (
        <button
          disabled={busy || name.trim().length < 1}
          className="btn btn-primary w-full py-2.5"
        >
          {busy
            ? msg("orgNew.creating")
            : submitLabel({ choice, preview: attaching ? preview : null, msg })}
        </button>
      )}
    </form>
  );
}
