"use client";

// Officiating lane in /me (PROMPT-57): assignments with accept/decline,
// blackout dates, and the score-pad door. Sibling of the player lane — same
// card/section grammar; the one signature is the response rail (left edge of
// each card: amber = awaiting you, lime = accepted, red = declined).
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { Zoned } from "@/components/client-time";
import { routes } from "@/lib/routes";
import type {
  MyBlackout,
  MyOfficiatingAssignment,
  OfficiatingResponse,
  PendingOfficiatingClaim,
} from "@/server/usecases/me-officiating";

const RAIL: Record<OfficiatingResponse, string> = {
  pending: "border-l-amber-400",
  accepted: "border-l-lime-500",
  declined: "border-l-red-400",
};

/**
 * Officials belong to multiple orgs (v11.1 follow-up): the lane now renders
 * whenever there's EITHER a linked officials row OR a pending invite waiting
 * on this email — a brand-new official with no link yet still needs to see
 * (and accept) their very first invite. `isOfficial` gates the
 * assignments/blackouts sections; pendingClaims renders independently of it.
 */
export function OfficiatingLane({
  isOfficial,
  assignments,
  blackouts,
  pendingClaims,
}: {
  isOfficial: boolean;
  assignments: MyOfficiatingAssignment[];
  blackouts: MyBlackout[];
  pendingClaims: PendingOfficiatingClaim[];
}) {
  const msg = useMsg();
  return (
    <section className="mb-8" aria-label={msg("me.off.title")}>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {msg("me.off.title")}
        {isOfficial ? ` · ${msg("me.off.assignments")}` : ""}
      </h2>

      {pendingClaims.length > 0 && <PendingInvites claims={pendingClaims} />}

      {isOfficial && (
        <>
          {assignments.length === 0 ? (
            <p className="card p-4 text-sm text-slate-500">{msg("me.off.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {assignments.map((a) => (
                <AssignmentCard key={`${a.fixture_id}:${a.official_id}:${a.role_key}`} a={a} />
              ))}
            </ul>
          )}
          <BlackoutEditor blackouts={blackouts} />
          <p className="mt-3 text-xs text-slate-400">
            <span className="cursor-not-allowed opacity-70" aria-disabled title={msg("me.off.comingSoon")}>
              {msg("me.off.rota")}
            </span>{" "}
            · {msg("me.off.comingSoon")}
          </p>
        </>
      )}
    </section>
  );
}

/** "Pending invites" card (v11.1): one row per open officiating invite, each
 *  accepted independently by id — no token in this URL, the session's
 *  verified login email is what proves it. */
function PendingInvites({ claims }: { claims: PendingOfficiatingClaim[] }) {
  const msg = useMsg();
  const router = useRouter();
  const [items, setItems] = useState(claims);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiV1(`/api/v1/me/officiating-claims/${id}/accept`, { method: "POST" });
      setItems((prev) => prev.filter((c) => c.id !== id));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("me.off.failed"));
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="mb-3 space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {msg("me.off.pendingInvites")}
      </p>
      <ul className="space-y-2">
        {items.map((c) => (
          <li
            key={c.id}
            className="card flex flex-wrap items-center justify-between gap-3 border-l-4 border-l-purple-400 p-4"
          >
            <p className="min-w-0 text-sm text-slate-700">
              {msg("me.off.pendingInvite", { org: c.org_name, name: c.official_name })}
            </p>
            <button
              type="button"
              className="btn btn-primary py-1.5 text-sm"
              disabled={busyId === c.id}
              onClick={() => void accept(c.id)}
            >
              {msg("me.off.accept")}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

function AssignmentCard({ a }: { a: MyOfficiatingAssignment }) {
  const msg = useMsg();
  const router = useRouter();
  const [response, setResponse] = useState<OfficiatingResponse>(a.response);
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function respond(next: "accepted" | "declined") {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/me/assigned-fixtures/${a.fixture_id}/response`, {
        method: "PATCH",
        json: { response: next, decline_reason: next === "declined" ? reason.trim() || null : null },
      });
      setResponse(next);
      setDeclining(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("me.off.failed"));
    } finally {
      setBusy(false);
    }
  }

  const matchdayPassed =
    a.scheduled_at !== null && new Date(a.scheduled_at).getTime() <= Date.now();

  return (
    <li className={`card space-y-2 border-l-4 p-4 ${RAIL[response]}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-800">
            {a.home_name ?? msg("me.tbd")} <span className="text-slate-400">vs</span>{" "}
            {a.away_name ?? msg("me.tbd")}{" "}
            <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] capitalize text-slate-500">
              {msg("me.off.role", { role: a.role_key })}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {a.competition_name} · {a.division_name} · {a.org_name}
            {a.venue ? ` · ${a.venue}` : ""}
            {a.court_label ? ` · ${a.court_label}` : ""}
          </p>
          <p className="mt-0.5 text-xs font-medium text-slate-600">
            {a.scheduled_at ? (
              <Zoned
                value={a.scheduled_at}
                tz={a.venue_tz ?? "UTC"}
                mode="datetime"
                showZone
                you="subtitle"
              />
            ) : (
              msg("me.unscheduled")
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {response === "pending" && !declining && (
            <>
              <span className="text-xs text-amber-600">{msg("me.off.pending")}</span>
              <button
                type="button"
                className="btn btn-primary py-1.5 text-sm"
                disabled={busy}
                onClick={() => void respond("accepted")}
              >
                {msg("me.off.accept")}
              </button>
              <button
                type="button"
                className="btn btn-ghost py-1.5 text-sm"
                disabled={busy}
                onClick={() => setDeclining(true)}
              >
                {msg("me.off.decline")}
              </button>
            </>
          )}
          {response === "accepted" && (
            <span className="badge bg-lime-100 text-lime-800">{msg("me.off.accepted")}</span>
          )}
          {response === "declined" && (
            <>
              <span className="badge bg-red-100 text-red-700">{msg("me.off.declined")}</span>
              {!matchdayPassed && (
                <button
                  type="button"
                  className="btn btn-ghost py-1.5 text-sm"
                  disabled={busy}
                  onClick={() => void respond("accepted")}
                >
                  {msg("me.off.accept")}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {declining && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1 py-1.5 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={msg("me.off.reasonPlaceholder")}
            aria-label={msg("me.off.reasonPlaceholder")}
          />
          <button
            type="button"
            className="btn btn-primary py-1.5 text-sm"
            disabled={busy}
            onClick={() => void respond("declined")}
          >
            {msg("me.off.confirmDecline")}
          </button>
          <button
            type="button"
            className="btn btn-ghost py-1.5 text-sm"
            disabled={busy}
            onClick={() => setDeclining(false)}
          >
            {msg("me.off.cancel")}
          </button>
        </div>
      )}

      {response !== "declined" && (a.fixture_status === "scheduled" || a.fixture_status === "in_play") && (
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={routes.fixture(a.org_slug, a.competition_slug, a.division_slug, a.fixture_no)}
            className="text-xs font-medium text-purple-600 hover:underline"
          >
            {msg("me.off.score")} →
          </Link>
        </div>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </li>
  );
}

function BlackoutEditor({ blackouts }: { blackouts: MyBlackout[] }) {
  const msg = useMsg();
  const router = useRouter();
  const [items, setItems] = useState(blackouts);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!date) return;
    setBusy(true);
    setError(null);
    try {
      const row = await apiV1<MyBlackout>("/api/v1/me/availability/officiating", {
        method: "POST",
        json: { date, note: note.trim() || null },
      });
      setItems((prev) => [...prev.filter((b) => b.date !== row.date), row].sort((x, y) => x.date.localeCompare(y.date)));
      setDate("");
      setNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("me.off.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(d: string) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/me/availability/officiating?date=${d}`, { method: "DELETE" });
      setItems((prev) => prev.filter((b) => b.date !== d));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("me.off.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-3 space-y-2 p-4">
      <p className="text-sm font-medium text-slate-800">{msg("me.off.blackouts")}</p>
      <p className="text-xs text-slate-400">{msg("me.off.blackoutHint")}</p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">{msg("me.off.blackoutEmpty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((b) => (
            <li
              key={b.date}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-surface px-3 py-1 text-xs text-slate-600"
            >
              <span className="font-medium text-slate-800">{b.date}</span>
              {b.note && <span className="text-slate-400">· {b.note}</span>}
              <button
                type="button"
                aria-label={`${msg("me.off.remove")} ${b.date}`}
                className="text-slate-400 hover:text-red-500"
                disabled={busy}
                onClick={() => void remove(b.date)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          className="input py-1.5 text-sm"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label={msg("me.off.blackoutAdd")}
        />
        <input
          className="input min-w-0 flex-1 py-1.5 text-sm"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={msg("me.off.blackoutNotePlaceholder")}
          aria-label={msg("me.off.blackoutNotePlaceholder")}
        />
        <button type="button" className="btn btn-ghost py-1.5 text-sm" disabled={busy || !date} onClick={() => void add()}>
          {msg("me.off.blackoutAdd")}
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
