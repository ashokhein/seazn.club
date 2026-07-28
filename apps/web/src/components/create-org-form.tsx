"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { api } from "@/lib/client";
import { useMsg } from "@/components/i18n/dict-provider";
import { asCurrency, formatMinor } from "@/lib/currency";
import { planSellsExtraOrg } from "@/lib/org-addon-plans";
import { routes } from "@/lib/routes";
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
  orgs: { id: string; name?: string | null; slug?: string | null }[];
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
  memberOrgIds: readonly string[] = [],
): { eligible: boolean; reason?: string; addOnsHref?: string } {
  if (g.status === "past_due")
    return { eligible: false, reason: msg("orgNew.bill.reasonPastDue") };
  if (g.cancel_at_period_end)
    return { eligible: false, reason: msg("orgNew.bill.reasonCancelling") };
  if (g.status !== "active" && g.status !== "trialing")
    return { eligible: false, reason: msg("orgNew.bill.reasonInactive") };
  if (g.max_orgs !== null && g.orgs.length >= g.max_orgs)
    return {
      eligible: false,
      reason: msg("orgNew.bill.reasonFull"),
      // Only the FULL refusal offers a purchase. The three above are ordered
      // above it deliberately: a declining card or a bill winding down is not
      // fixed by buying more capacity on it, and offering that would be a
      // charge the customer cannot use.
      addOnsHref: addOnsHrefFor(g, memberOrgIds),
    };
  return { eligible: true };
}

/**
 * Where a payer whose bill is FULL goes to buy another organisation slot: the
 * Add-ons tab of an organisation ON THAT BILL (v17 gap #293) — never whichever
 * organisation the browser happens to have active. `POST /api/billing/extra-orgs`
 * resolves the group through `requireBillingOwner()`, i.e. the active-org
 * cookie, so a payer with two bills who was offered the purchase against one
 * would otherwise be sold capacity on the other. Landing on an /o page of the
 * refused group is what re-points that cookie (`ActiveOrgSync`).
 *
 * `undefined` — no link at all — whenever the Add-ons tab could only answer
 * with a notice. The three cases below are exactly the tab's own refusals
 * (`app/o/[orgSlug]/settings/add-ons/page.tsx`), and each is REACHABLE from
 * this picker rather than theoretical:
 *
 *  · the plan sells no rider. A Community group is `max_orgs: 1` holding one
 *    organisation, so it is permanently "Full" — it is the most likely group
 *    in this list to reach this line, not an impossible one. Exceeding it is
 *    an upgrade, not a purchase.
 *  · no live paid subscription for a recurring item to ride (a comped or
 *    never-paid group can be `active` with no Stripe subscription).
 *  · no organisation on the bill this user is a MEMBER of. Every /o page is
 *    member-gated — `requireOrgPage` 404s a non-member — and paying for an
 *    organisation does not make you one, which is the normal shape after a
 *    bill transfer. Sending them to a 404 would be a worse dead end than the
 *    plain "Full" pill this link exists to replace.
 */
function addOnsHrefFor(
  g: CreateOrgGroup,
  memberOrgIds: readonly string[],
): string | undefined {
  if (!planSellsExtraOrg(g.plan_key)) return undefined;
  if (!g.has_live_subscription) return undefined;
  const reachable = g.orgs.find((o) => !!o.slug && memberOrgIds.includes(o.id));
  return reachable?.slug ? routes.addOns(reachable.slug) : undefined;
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

/**
 * A recognisable name for a bill in the picker: the FIRST organisation on it
 * plus a count of the rest — never the whole join.
 *
 * Joining every name is unbounded in a place that has to fit. The archetypal
 * customer for this entire feature is a 5/5 Pro bill, and five real names join
 * to ~119 characters — three wrapped lines at 375px once the offer interpolates
 * the label into a sentence. The picker ROW has always capped with `truncate`;
 * the offer's sentence cannot, so the cap belongs in the label itself and both
 * surfaces get it.
 *
 * Falls back to the plan when every organisation has lost its name.
 */
function groupLabel(g: CreateOrgGroup, msg: Msg): string {
  const names = g.orgs.map((o) => o.name).filter((n): n is string => Boolean(n));
  if (names.length === 0) return g.plan_key;
  const rest = names.length - 1;
  if (rest === 0) return names[0];
  // Not `usePlural`: it throws outside a `DictProvider`, and this island is
  // rendered without one. That is safe here rather than a shortcut — `rest` is
  // never 0 on this branch, and all four shipped locales (en/es/fr/nl) put the
  // one/other boundary at exactly 1, so the ternary IS the plural rule for
  // every locale this product has. A locale with a dual/paucal form would need
  // the real `Intl.PluralRules` path.
  return msg(rest === 1 ? "orgNew.bill.andMore.one" : "orgNew.bill.andMore.other", {
    name: names[0],
    count: rest,
  });
}

/** Plan name for a bill's subline in the picker (e.g. "Pro Plus", "Pro"). */
function planLabel(plan: string): string {
  if (plan === "pro_plus") return "Pro Plus";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * The bills that are full and CAN be bought out of, for the state where the
 * picker itself is unreachable (v17 gap #293 review).
 *
 * The picker's rows only render under `choice === "add"`, and the toggle that
 * sets it is disabled while no bill has an open slot. So the payer this whole
 * feature is for — ONE Pro bill at 5/5 — could never open the list the link
 * lives in, and met "No eligible bills" with no way forward. When nothing is
 * eligible the offer therefore has to be made next to that sentence instead.
 *
 * Empty whenever at least one bill IS eligible: the rows are reachable then and
 * carry their own links, and offering the same purchase twice on one screen
 * would read as two different things to buy.
 */
export function fullBillOffers(
  groups: CreateOrgGroup[],
  msg: Msg,
  memberOrgIds: readonly string[],
): { group: CreateOrgGroup; href: string }[] {
  if (groups.some((g) => eligibility(g, msg, memberOrgIds).eligible)) return [];
  return groups.flatMap((g) => {
    const { addOnsHref } = eligibility(g, msg, memberOrgIds);
    return addOnsHref ? [{ group: g, href: addOnsHref }] : [];
  });
}

/**
 * One bill in the picker: the selectable card, plus — when the bill is full and
 * the payer can actually buy their way out of it — a link to the Add-ons tab.
 *
 * Hookless and exported so the RENDERED branch is testable. The form itself
 * only draws this list after an effect fetches the groups, which the node-env
 * test environment never runs; without this seam the link's condition would be
 * pinned by nothing, and rendering it unconditionally (on a Community bill, on
 * an overdue one) would pass every suite.
 *
 * The link sits OUTSIDE the row button, not next to the reason pill inside it,
 * for two reasons that both make it dead on arrival otherwise: an anchor inside
 * a button is not valid HTML, and a `disabled` button — which every row
 * carrying this link is — swallows pointer events for its whole subtree.
 */
export function BillRow({
  g,
  msg,
  selectedId,
  memberOrgIds,
  onPick,
}: {
  g: CreateOrgGroup;
  msg: Msg;
  selectedId: string;
  memberOrgIds: readonly string[];
  onPick: (id: string) => void;
}) {
  const { eligible, reason, addOnsHref } = eligibility(g, msg, memberOrgIds);
  const on = eligible && selectedId === g.id;
  return (
    <li className="space-y-0.5">
      <button
        type="button"
        onClick={() => onPick(g.id)}
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
          <span
            id={`bill-name-${g.id}`}
            className="block truncate text-sm font-medium text-slate-900"
          >
            {groupLabel(g, msg)}
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
      {/* Indented to the row's text column so it reads as this bill's way out,
          and at full opacity — the card is dimmed because it cannot be picked,
          but this is the one live action on it. */}
      {addOnsHref && (
        <Link
          href={addOnsHref}
          // Several full bills would otherwise put several identically-named
          // links on one page. The bill's own name describes each without a
          // second sentence to translate.
          aria-describedby={`bill-name-${g.id}`}
          className="inline-flex rounded-sm py-1.5 pl-[2.625rem] text-xs font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
        >
          {msg("orgNew.bill.reasonFullCta")}
        </Link>
      )}
    </li>
  );
}

/** Create an organization; the creator becomes its owner. Slug is automatic. */
export function CreateOrgForm({
  memberOrgIds,
}: {
  /** Ids of the organisations this user can actually OPEN — their memberships,
   *  minus scorer roles, which `requireOrgPage` bounces to /my-matches. Passed
   *  from the page (which already loads them) because the payer-gated group
   *  payload this form fetches names organisations the payer may not belong
   *  to, and a link into one of those is a 404. */
  memberOrgIds: readonly string[];
}) {
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
  const offers = fullBillOffers(groups ?? [], msg, memberOrgIds);
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
            <div className="space-y-1.5">
              <p className="px-1 text-xs text-slate-400">
                {msg("orgNew.bill.noneEligible")}
              </p>
              {/* The picker below cannot be opened in this state, so this is the
                  only place the way out can be offered. Each link NAMES its
                  bill: with no rows on screen there is nothing else to say
                  which one it would raise. */}
              {offers.length > 0 && (
                <ul className="space-y-0.5">
                  {offers.map(({ group, href }) => (
                    <li key={group.id}>
                      <Link
                        href={href}
                        // This label INTERPOLATES a name, and at 375px a long
                        // unbroken organisation name runs it ~860px past the
                        // right edge, where it is CLIPPED rather than scrolled
                        // — unreadable, and invisible to an overflow check.
                        // `overflow-wrap: anywhere`, not `break-words`
                        // (`break-word`): only the former shrinks the element's
                        // min-content width, which is what an inline-block is
                        // sized from. Measured both. The row's own link takes
                        // no name and needs none.
                        className="inline-block [overflow-wrap:anywhere] rounded-sm px-1 py-1.5 text-xs font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
                      >
                        {msg("orgNew.bill.reasonFullCtaFor", {
                          name: groupLabel(group, msg),
                        })}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {choice === "add" && (
            <div className="space-y-2">
              <p className="px-1 text-xs text-emerald-700">
                {msg("orgNew.bill.addToExistingHint")}
              </p>
              <ul className="space-y-2">
                {(groups ?? []).map((g) => (
                  <BillRow
                    key={g.id}
                    g={g}
                    msg={msg}
                    selectedId={selectedId}
                    memberOrgIds={memberOrgIds}
                    onPick={pickGroup}
                  />
                ))}
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
