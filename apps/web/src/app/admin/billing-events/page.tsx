import type Stripe from "stripe";
import { requireStaff, logStaffAction } from "@/lib/admin";
import { getStripe } from "@/lib/stripe";
import {
  HANDLED_EVENT_TYPES,
  eventStatus,
  ledgerByIds,
  stuckLedgerEvents,
  type EventStatus,
  type LedgerRow,
} from "@/server/usecases/billing-events";
import { ProcessEventButton } from "@/components/admin-process-event";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<EventStatus, { label: string; cls: string }> = {
  processed: { label: "✓ processed", cls: "bg-emerald-500/10 text-emerald-400" },
  received: { label: "⏳ received, not processed", cls: "bg-amber-500/10 text-amber-400" },
  missing: { label: "✖ never received", cls: "bg-red-500/10 text-red-400" },
};

interface Row {
  id: string;
  type: string;
  created: string;
  orgName: string | null;
  status: EventStatus;
}

/** Live events straight from Stripe (the diff source). Null = no key or the
 *  call failed — the page degrades to the ledger-only view. */
async function liveEvents(): Promise<Stripe.Event[] | null> {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    const page = await getStripe().events.list({
      limit: 50,
      types: [...HANDLED_EVENT_TYPES],
    });
    return page.data;
  } catch {
    return null;
  }
}

/** Org names for events the ledger has never seen (metadata is all we have). */
async function orgNamesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name from organizations where id in ${sql(ids)}`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function AdminBillingEventsPage() {
  const staff = await requireStaff();
  await logStaffAction(staff.id, "billing_events_viewed", "platform", "billing_events");

  const live = await liveEvents();
  const ledger = await ledgerByIds((live ?? []).map((e) => e.id));
  const stuck = await stuckLedgerEvents((live ?? []).map((e) => e.id));

  const metaOrgIds = (live ?? [])
    .map((e) => (e.data.object as { metadata?: { org_id?: string } }).metadata?.org_id)
    .filter((id): id is string => !!id && UUID_RE.test(id));
  const orgNames = await orgNamesByIds([...new Set(metaOrgIds)]);

  const liveRows: Row[] = (live ?? []).map((e) => {
    const row = ledger.get(e.id);
    const metaOrg = (e.data.object as { metadata?: { org_id?: string } }).metadata?.org_id;
    return {
      id: e.id,
      type: e.type,
      created: new Date(e.created * 1000).toISOString(),
      orgName: row?.org_name ?? (metaOrg ? (orgNames.get(metaOrg) ?? null) : null),
      status: eventStatus(row),
    };
  });
  const stuckRows: Row[] = stuck.map((r: LedgerRow) => ({
    id: r.id,
    type: r.type,
    created: new Date(r.received_at).toISOString(),
    orgName: r.org_name ?? null,
    status: "received" as const,
  }));
  const pendingCount =
    liveRows.filter((r) => r.status !== "processed").length + stuckRows.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Stripe events</h1>
        <p className="mt-1 text-xs text-slate-500">
          The last 50 handled-type events straight from Stripe, checked against the
          billing_events ledger. <span className="text-red-400">✖ never received</span> means
          the webhook missed it entirely; <span className="text-amber-400">⏳ received</span>{" "}
          means the handler didn&apos;t finish. Process now re-fetches the event from Stripe
          and runs the normal handler — every handler is idempotent.
        </p>
      </div>

      {live === null && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
          Stripe isn&apos;t reachable (no STRIPE_SECRET_KEY or the API call failed) — showing
          the local ledger only. Events Stripe sent but this app never received can&apos;t be
          listed without the key.
        </p>
      )}

      <p className="text-xs text-slate-400">
        {pendingCount === 0
          ? "Nothing pending — every event listed has been processed."
          : `${pendingCount} pending event${pendingCount === 1 ? "" : "s"} need${pendingCount === 1 ? "s" : ""} attention.`}
      </p>

      <EventTable title={live === null ? "Stuck ledger events" : "Live from Stripe"} rows={liveRows.length ? liveRows : stuckRows} />
      {live !== null && stuckRows.length > 0 && (
        <EventTable title="Older stuck ledger events" rows={stuckRows} />
      )}
    </div>
  );
}

function EventTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h2>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-900 text-slate-400">
            <tr>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Event</th>
              <th className="px-3 py-2">Organisation</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No events.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="text-slate-300">
                <td className="whitespace-nowrap px-3 py-2 text-slate-400">
                  {r.created.slice(0, 16).replace("T", " ")}
                </td>
                <td className="px-3 py-2 font-mono">{r.type}</td>
                <td className="px-3 py-2 font-mono text-slate-500">{r.id}</td>
                <td className="px-3 py-2">{r.orgName ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 ${STATUS_CHIP[r.status].cls}`}>
                    {STATUS_CHIP[r.status].label}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  {r.status !== "processed" && <ProcessEventButton eventId={r.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
