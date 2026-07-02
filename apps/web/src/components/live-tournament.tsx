"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import {
  buildCsv,
  findChampionPlayer,
  playerName,
  roundWindow,
  sortedGroupRounds,
  sortedKoRounds,
} from "@/lib/format";
import { MatchClock } from "@/components/match-clock";
import { ConfirmModal } from "@/components/modal";
import { AuditModal } from "@/components/audit-modal";
import { Avatar } from "@/components/avatar";
import { ClientTime } from "@/components/client-time";
import type { Match, Player, Round, StandingRow, TournamentState } from "@/lib/types";
import { useTournamentRealtime } from "@/hooks/use-tournament-realtime";

function imageOf(players: Player[], pid: string | null): string | null {
  const p = players.find((pl) => pl.id === pid);
  if (!p) return null;
  if (p.image_storage_path) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (url) return `${url}/storage/v1/object/public/assets/${p.image_storage_path}`;
  }
  if (p.image_url?.startsWith("https://")) return p.image_url;
  return null;
}

interface ClockTarget {
  match: Match;
  p1: string;
  p2: string;
}

export function LiveTournament({
  id,
  canEdit,
  initial,
  realtimeEnabled = false,
  canExport = false,
}: {
  id: string;
  canEdit: boolean;
  initial: TournamentState;
  realtimeEnabled?: boolean;
  canExport?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<TournamentState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState<ClockTarget | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    try {
      setState(await api<TournamentState>(`/api/tournaments/${id}/state`));
    } catch {
      /* keep last good state */
    }
  }, [id]);

  // Realtime: Pro orgs get broadcast push; Community falls back to polling.
  useTournamentRealtime(id, refresh, realtimeEnabled);

  useEffect(() => {
    if (realtimeEnabled) return; // realtime handles updates
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, realtimeEnabled]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, opts?: { skipRefresh?: boolean }) => {
      setError(null);
      setBusy(true);
      inFlight.current = true;
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action failed");
        inFlight.current = false;
        setBusy(false);
        return;
      }
      inFlight.current = false;
      setBusy(false);
      if (!opts?.skipRefresh) await refresh();
    },
    [refresh],
  );

  const { tournament: t } = state;
  const nameOf = (pid: string | null) => playerName(state.players, pid);
  const groupRounds = sortedGroupRounds(state.rounds);
  const koRounds = sortedKoRounds(state.rounds);
  const matchesByRound = (roundId: string) =>
    state.matches
      .filter((m) => m.round_id === roundId)
      .sort((a, b) => a.board_number - b.board_number);

  const result = (matchId: string, payload: Record<string, unknown>) =>
    act(
      async () => {
        const next = await api<TournamentState>(
          `/api/tournaments/${id}/result`,
          { method: "POST", json: { match_id: matchId, ...payload } },
        );
        setState(next);
      },
      { skipRefresh: true },
    );

  const champion = t.status === "completed" ? findChampion(state, nameOf) : null;
  const formatLabel =
    t.format === "knockout"
      ? "single elimination"
      : t.format === "round_robin"
        ? "round robin"
        : t.format === "progress_stepladder"
          ? "progress + stepladder"
          : "progress + knockout";

  function roundsSummary(t: typeof state.tournament): string | null {
    if (t.format === "knockout") {
      return `${t.knockout_size}-player bracket`;
    }
    if (t.format === "round_robin") {
      return `${t.num_group_rounds} rounds`;
    }
    if (t.format === "swiss_knockout") {
      return `${t.num_group_rounds} group rounds + top ${t.knockout_size}`;
    }
    if (t.format === "progress_stepladder") {
      return `${t.num_group_rounds} group rounds + stepladder`;
    }
    return null;
  }

  function currentRoundChip(
    group: typeof groupRounds,
    ko: typeof koRounds,
  ): React.ReactNode {
    if (t.status === "setup" || t.status === "completed") return null;
    const active = group.find((r) => r.status === "active") ?? ko.find((r) => r.status === "active");
    if (!active) return null;
    const totalGroup = t.format !== "knockout" ? t.num_group_rounds : 0;
    const idx = group.indexOf(active);
    if (idx !== -1 && totalGroup > 0) {
      return <span className="chip font-medium text-purple-700">Round {idx + 1} of {totalGroup}</span>;
    }
    return <span className="chip font-medium text-purple-700">{active.name}</span>;
  }

  function exportCsv() {
    const blob = new Blob([buildCsv(state)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t.name.replace(/\s+/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {clock && (
        <MatchClock
          p1={clock.p1}
          p2={clock.p2}
          minutes={t.clock_minutes}
          onClose={() => setClock(null)}
          onWinner={(side) => {
            const winnerId =
              side === 1 ? clock.match.player1_id : clock.match.player2_id;
            setClock(null);
            if (winnerId) result(clock.match.id, { winner_id: winnerId });
          }}
        />
      )}

      {showAudit && <AuditModal id={id} onClose={() => setShowAudit(false)} />}

      {confirmReset && (
        <ConfirmModal
          title="Reset tournament?"
          message="This clears every result and returns the tournament to setup. This cannot be undone."
          confirmLabel="Reset everything"
          danger
          typeToConfirm="RESET"
          onClose={() => setConfirmReset(false)}
          onConfirm={() =>
            act(() => api(`/api/tournaments/${id}/reset`, { method: "POST" }))
          }
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete tournament?"
          message={`Permanently delete "${t.name}"? All players and settings will be removed. This cannot be undone.`}
          confirmLabel="Delete tournament"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={() =>
            act(
              async () => {
                await api(`/api/tournaments/${id}`, { method: "DELETE" });
                router.push("/dashboard");
              },
              { skipRefresh: true },
            )
          }
        />
      )}

      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-purple-900 sm:text-2xl">
            {t.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
            <span className="chip">{t.sport}</span>
            <span className="chip">{t.category}</span>
            <span className="chip">{formatLabel}</span>
            <StatusBadge status={t.status} />
            {t.venue && <span className="chip">📍 {t.venue}</span>}
            {t.starts_at && (
              <span className="chip">
                <ClientTime value={t.starts_at} mode="datetime" />
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span className="chip">{state.players.length} players</span>
            {roundsSummary(t) && <span className="chip">{roundsSummary(t)}</span>}
            {t.round_minutes > 0 && <span className="chip">⏱ {t.round_minutes} min/round</span>}
            {t.clock_minutes > 0 && <span className="chip">⏰ {t.clock_minutes} min clock</span>}
            {t.allow_draws && <span className="chip">draws allowed</span>}
            {t.points_win !== 1 || t.points_draw !== 0 ? (
              <span className="chip">
                {t.points_win}W / {t.points_draw}D / {t.points_loss}L pts
              </span>
            ) : null}
            {currentRoundChip(groupRounds, koRounds)}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          <SharePanel
            id={id}
            name={t.name}
            isPublic={t.is_public}
            publicSlug={t.public_slug}
            canEdit={canEdit}
            onPublicChanged={(p, s) =>
              setState((prev) => ({
                ...prev,
                tournament: { ...prev.tournament, is_public: p, public_slug: s },
              }))
            }
          />
          <Link
            href={`/tournaments/${id}/slideshow`}
            target="_blank"
            className="btn btn-ghost"
          >
            🖥 <span className="hidden xs:inline">Slideshow</span>
          </Link>
          <Link
            href={`/tournaments/${id}/print`}
            target="_blank"
            className="btn btn-ghost"
          >
            🖨 <span className="hidden xs:inline">Print</span>
          </Link>
          {canExport ? (
            <button onClick={exportCsv} className="btn btn-ghost">⬇ CSV</button>
          ) : (
            <a href="/settings/billing" className="btn btn-ghost text-xs text-slate-400" title="Upgrade to Pro to export CSV">⬇ CSV ✦</a>
          )}
          {canEdit && (
            <button onClick={() => setShowAudit(true)} className="btn btn-ghost">
              📜 <span className="hidden xs:inline">History</span>
            </button>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          {t.status === "setup" && (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  act(() =>
                    api(`/api/tournaments/${id}/start`, { method: "POST" }),
                  )
                }
                className="btn btn-primary"
              >
                ▶ Start tournament
              </button>
              <button
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
                className="btn btn-danger"
                title="Permanently delete this tournament"
              >
                🗑 Delete
              </button>
            </>
          )}
          {t.status !== "setup" && (
            <button
              disabled={busy || t.undo_remaining <= 0}
              onClick={() =>
                act(() => api(`/api/tournaments/${id}/undo`, { method: "POST" }))
              }
              className="btn btn-ghost"
              title="Undo the last step (up to 3 times)"
            >
              ↶ Undo ({t.undo_remaining})
            </button>
          )}
          <button
            disabled={busy || t.status === "completed"}
            onClick={() => setConfirmReset(true)}
            className="btn btn-danger"
            title={
              t.status === "completed"
                ? "This tournament is finished — reset is disabled"
                : "Clear all results and return to setup"
            }
          >
            ⟲ Reset
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {champion && (
        <div className="rounded-2xl border border-purple-200 bg-gradient-to-r from-purple-100 to-fuchsia-100 p-6 text-center">
          <p className="text-sm uppercase tracking-widest text-purple-600">
            Champion
          </p>
          <p className="mt-1 text-3xl font-extrabold text-purple-900">
            🏆 {champion}
          </p>
        </div>
      )}

      {t.status === "setup" && (
        <SetupView
          players={state.players}
          canEdit={canEdit}
          busy={busy}
          onToggle={(playerId, checked) =>
            act(() =>
              api(`/api/tournaments/${id}/checkin`, {
                method: "POST",
                json: { player_id: playerId, checked_in: checked },
              }),
            )
          }
          onAdd={(players) =>
            act(() =>
              api(`/api/tournaments/${id}/players`, {
                method: "POST",
                json: { players },
              }),
            )
          }
          onRemove={(playerId) =>
            act(() =>
              api(`/api/tournaments/${id}/players/${playerId}`, {
                method: "DELETE",
              }),
            )
          }
        />
      )}

      {t.status !== "setup" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {groupRounds.length > 0 && (
              <section>
                <h2 className="mb-3 text-lg font-semibold text-purple-900">
                  {t.format === "round_robin" ? "Fixtures" : "Progress rounds"}
                </h2>
                <div className="space-y-4">
                  {groupRounds.map((r) => (
                    <RoundBlock
                      key={r.id}
                      round={r}
                      window={roundWindow(
                        t.starts_at,
                        t.round_minutes,
                        r.round_number - 1,
                      )}
                      matches={matchesByRound(r.id)}
                      state={state}
                      canEdit={canEdit}
                      busy={busy}
                      onResult={result}
                      onClock={setClock}
                    />
                  ))}
                </div>
              </section>
            )}

            {koRounds.length > 0 && (
              <section>
                <h2 className="mb-3 text-lg font-semibold text-purple-900">
                  {t.format === "progress_stepladder" ? "Stepladder finals" : "Knockout"}
                </h2>
                <div className="space-y-4">
                  {koRounds.map((r) => {
                    const accent = koAccent(r);
                    return (
                      <div key={r.id} className="space-y-2">
                        <div className={koHeaderClass(accent)}>
                          {accent === "final" ? "🏆 " : accent === "semi" ? "⚔ " : ""}
                          {r.name}
                        </div>
                        <div className="space-y-3">
                          {matchesByRound(r.id).map((m) => (
                            <MatchCard
                              key={m.id}
                              match={m}
                              state={state}
                              canEdit={canEdit}
                              busy={busy}
                              accent={accent}
                              onResult={result}
                              onClock={setClock}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          <div className="lg:col-span-1">
            <StandingsTable
              standings={state.standings}
              scoreMode={t.result_mode === "score"}
              progressMode={t.use_progress_score}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type Accent = "final" | "semi" | null;

function koAccent(round: Round): Accent {
  if (round.stage === "final") return "final";
  if (/semi/i.test(round.name)) return "semi";
  return null;
}

function koHeaderClass(accent: Accent): string {
  const base =
    "mb-2 rounded-lg px-3 py-1.5 text-center text-xs font-bold uppercase tracking-wide";
  if (accent === "final")
    return `${base} bg-gradient-to-r from-amber-100 to-yellow-100 text-amber-800 ring-1 ring-amber-300`;
  if (accent === "semi")
    return `${base} bg-purple-100 text-purple-800 ring-1 ring-purple-300`;
  return `${base} bg-purple-50 text-purple-500 ring-1 ring-purple-100`;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    setup: "bg-slate-100 text-slate-600",
    group: "bg-sky-100 text-sky-700",
    knockout: "bg-amber-100 text-amber-700",
    final: "bg-amber-100 text-amber-700",
    completed: "bg-emerald-100 text-emerald-700",
  };
  return <span className={`badge ${map[status] ?? map.setup}`}>{status}</span>;
}

function SharePanel({
  id,
  name,
  isPublic,
  publicSlug,
  canEdit,
  onPublicChanged,
}: {
  id: string;
  name: string;
  isPublic: boolean;
  publicSlug: string | null;
  canEdit: boolean;
  onPublicChanged: (isPublic: boolean, slug: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);

  const privateUrl = typeof window !== "undefined"
    ? `${window.location.origin}/tournaments/${id}`
    : "";
  const publicUrl = publicSlug && typeof window !== "undefined"
    ? `${window.location.origin}/t/${publicSlug}`
    : null;

  const activeUrl = publicUrl ?? privateUrl;

  useEffect(() => {
    if (!open || !activeUrl) return;
    import("qrcode").then((QR) =>
      QR.toDataURL(activeUrl, { width: 200, margin: 1 }).then(setQr).catch(() => {}),
    );
  }, [open, activeUrl]);

  async function togglePublic() {
    setToggling(true);
    try {
      const res = await api<{ is_public: boolean; public_slug: string | null }>(
        `/api/tournaments/${id}/public`,
        { method: "PATCH", body: JSON.stringify({ is_public: !isPublic }) },
      );
      onPublicChanged(res.is_public, res.public_slug);
      setQr(""); // regenerate QR for new URL
    } catch {
      /* ignore */
    } finally {
      setToggling(false);
    }
  }

  function copyUrl(u: string) {
    navigator.clipboard.writeText(u).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="btn btn-ghost">
        🔗 <span className="hidden xs:inline">Share</span>
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-purple-100 bg-white p-4 shadow-xl sm:left-auto sm:right-0">
          <p className="mb-3 text-sm font-semibold text-purple-900">{name}</p>

          {/* Public page toggle */}
          {canEdit && (
            <div className="mb-3 flex items-center justify-between rounded-lg bg-purple-50 px-3 py-2">
              <div>
                <p className="text-xs font-medium text-slate-700">Public live page</p>
                <p className="text-[11px] text-slate-400">Anyone with link can view</p>
              </div>
              <button
                onClick={togglePublic}
                disabled={toggling}
                className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${isPublic ? "bg-purple-600" : "bg-slate-300"}`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isPublic ? "left-4" : "left-0.5"}`}
                />
              </button>
            </div>
          )}

          {/* QR + link */}
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR code" className="mx-auto mb-3 rounded-lg border border-purple-100 p-1" width={200} height={200} />
          )}

          {publicUrl && (
            <div className="mb-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-purple-500">Public link</p>
              <p className="break-all rounded-lg bg-purple-50 px-2 py-1.5 text-xs text-slate-600">{publicUrl}</p>
              <button onClick={() => copyUrl(publicUrl)} className="btn btn-primary mt-2 w-full text-sm">
                {copied ? "Copied!" : "Copy public link"}
              </button>
            </div>
          )}

          <div className={publicUrl ? "mt-2 border-t border-purple-50 pt-2" : ""}>
            {publicUrl && <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Private link (requires login)</p>}
            <p className="break-all rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-500">{privateUrl}</p>
            {!publicUrl && (
              <button onClick={() => copyUrl(privateUrl)} className="btn btn-primary mt-2 w-full text-sm">
                {copied ? "Copied!" : "Copy link"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SetupView({
  players,
  canEdit,
  busy,
  onToggle,
  onAdd,
  onRemove,
}: {
  players: Player[];
  canEdit: boolean;
  busy: boolean;
  onToggle: (playerId: string, checked: boolean) => void;
  onAdd: (players: { name: string; image_url: string | null }[]) => void;
  onRemove: (playerId: string) => void;
}) {
  const [nameInput, setNameInput] = useState("");
  const [imageInput, setImageInput] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const present = players.filter((p) => p.checked_in).length;

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    try {
      setImageInput(await fileToDataUrl(file, 160));
    } catch {
      setAddError("Could not read that image");
    }
  }

  function submitAdd() {
    const n = nameInput.trim();
    if (!n) return;
    setAddError(null);
    onAdd([{ name: n, image_url: imageInput }]);
    setNameInput("");
    setImageInput(null);
  }

  return (
    <div className="card p-5">
      <h2 className="mb-1 text-lg font-semibold text-purple-900">
        Check-in — {present} of {players.length} present
      </h2>
      <p className="mb-4 text-sm text-slate-500">
        Tap <span className="font-medium text-purple-700">Check in</span> for
        each player who has arrived. Only checked-in players are included when
        you start.
      </p>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {players.map((p) => (
          <div
            key={p.id}
            className={`relative flex w-[7.5rem] shrink-0 flex-col items-center gap-2 rounded-xl border p-3 transition ${
              p.checked_in
                ? "border-purple-200 bg-purple-50/80"
                : "border-slate-200 bg-white"
            }`}
          >
            {canEdit && players.length > 2 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onRemove(p.id)}
                aria-label={`Remove ${p.name}`}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-white text-xs text-slate-400 shadow ring-1 ring-slate-200 transition hover:bg-red-50 hover:text-red-600"
              >
                ×
              </button>
            )}
            <Avatar name={p.name} src={p.image_url} size={40} />
            <span
              className="w-full truncate text-center text-sm font-medium text-slate-800"
              title={p.name}
            >
              {p.name}
            </span>
            {canEdit ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onToggle(p.id, !p.checked_in)}
                className={`w-full rounded-lg px-2 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                  p.checked_in
                    ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-200"
                    : "bg-purple-600 text-white hover:bg-purple-700"
                }`}
              >
                {p.checked_in ? "Present ✓" : "Check in"}
              </button>
            ) : (
              <span
                className={`w-full rounded-lg px-2 py-1.5 text-center text-xs font-semibold ${
                  p.checked_in
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {p.checked_in ? "Present" : "Absent"}
              </span>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="mt-5 border-t border-purple-100 pt-4">
          <p className="mb-2 text-sm font-medium text-purple-900">
            Add a player
          </p>
          <p className="mb-3 text-xs text-slate-500">
            Forgot someone? Add them here before you start the tournament.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label
              className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-lg border border-purple-200 bg-purple-50 text-purple-400 transition hover:bg-purple-100"
              title="Add image"
            >
              {imageInput ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageInput}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-lg">🖼</span>
              )}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={busy}
                onChange={(e) => onPickImage(e.target.files?.[0])}
              />
            </label>
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitAdd();
                }
              }}
              placeholder="Player name"
              disabled={busy}
              className="input min-w-[10rem] flex-1"
            />
            <button
              type="button"
              onClick={submitAdd}
              disabled={busy || !nameInput.trim()}
              className="btn btn-primary shrink-0"
            >
              Add
            </button>
          </div>
          {addError && (
            <p className="mt-2 text-xs text-red-600">{addError}</p>
          )}
        </div>
      )}

      {canEdit && (
        <p className="mt-4 text-sm text-slate-500">
          Press{" "}
          <span className="font-medium text-purple-700">Start tournament</span>{" "}
          to generate the first round.
        </p>
      )}
    </div>
  );
}

async function fileToDataUrl(file: File, max: number): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("bad image"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  const hasAlpha = file.type === "image/png" || file.type === "image/webp";
  return canvas.toDataURL(hasAlpha ? "image/png" : "image/jpeg", 0.85);
}

function RoundBlock({
  round,
  window,
  matches,
  state,
  canEdit,
  busy,
  onResult,
  onClock,
}: {
  round: Round;
  window: { start: Date; end: Date } | null;
  matches: Match[];
  state: TournamentState;
  canEdit: boolean;
  busy: boolean;
  onResult: (matchId: string, payload: Record<string, unknown>) => void;
  onClock: (target: ClockTarget) => void;
}) {
  const done = matches.every((m) => m.status === "completed");
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-purple-900">
          {round.name}
          {window && (
            <span className="ml-2 text-xs font-normal text-slate-400">
              <ClientTime value={window.start} />–<ClientTime value={window.end} />
            </span>
          )}
        </h3>
        <span
          className={`badge ${
            done ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"
          }`}
        >
          {done ? "completed" : "in progress"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {matches.map((m) => (
          <MatchCard
            key={m.id}
            match={m}
            state={state}
            canEdit={canEdit}
            busy={busy}
            board
            onResult={onResult}
            onClock={onClock}
          />
        ))}
      </div>
    </div>
  );
}

function MatchCard({
  match,
  state,
  canEdit,
  busy,
  board,
  accent = null,
  onResult,
  onClock,
}: {
  match: Match;
  state: TournamentState;
  canEdit: boolean;
  busy: boolean;
  board?: boolean;
  accent?: Accent;
  onResult: (matchId: string, payload: Record<string, unknown>) => void;
  onClock: (target: ClockTarget) => void;
}) {
  const t = state.tournament;
  const p1 = playerName(state.players, match.player1_id);
  const p2 = playerName(state.players, match.player2_id);
  const img1 = imageOf(state.players, match.player1_id);
  const img2 = imageOf(state.players, match.player2_id);
  const completed = match.status === "completed";
  const round = state.rounds.find((r) => r.id === match.round_id);
  const isGroup = round?.stage === "group";
  const ready =
    canEdit && !busy && !completed && !!match.player1_id && !!match.player2_id;
  const scoreMode = t.result_mode === "score";

  const [s1, setS1] = useState("");
  const [s2, setS2] = useState("");

  if (match.is_bye) {
    return (
      <div className="rounded-xl border border-purple-100 bg-purple-50/50 p-3">
        {board && (
          <p className="mb-1 text-[11px] text-slate-400">Board {match.board_number}</p>
        )}
        <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Avatar name={p1} src={img1} size={22} />
          {p1}
        </p>
        <p className="text-xs text-purple-600">advances on a bye</p>
      </div>
    );
  }

  const accentClass =
    accent === "final"
      ? "border-amber-300 ring-2 ring-amber-200 shadow-sm"
      : accent === "semi"
        ? "border-purple-300 ring-2 ring-purple-200 shadow-sm"
        : "border-purple-100";

  return (
    <div className={`overflow-hidden rounded-xl border bg-white ${accentClass}`}>
      {board && (
        <p className="px-3 pt-2 text-[11px] text-slate-400">Board {match.board_number}</p>
      )}
      {!board && match.label && (
        <p className="px-3 pt-2 text-[11px] text-slate-400">{match.label}</p>
      )}

      <PlayerRow
        name={p1}
        image={img1}
        score={match.player1_score}
        isWinner={completed && match.winner_id === match.player1_id}
        isLoser={completed && !match.is_draw && match.winner_id !== match.player1_id}
        isDraw={completed && match.is_draw}
        clickable={ready && !scoreMode}
        onClick={() => match.player1_id && onResult(match.id, { winner_id: match.player1_id })}
      />
      <div className="border-t border-purple-50 text-center text-[10px] text-slate-400">vs</div>
      <PlayerRow
        name={p2}
        image={img2}
        score={match.player2_score}
        isWinner={completed && match.winner_id === match.player2_id}
        isLoser={completed && !match.is_draw && match.winner_id !== match.player2_id}
        isDraw={completed && match.is_draw}
        clickable={ready && !scoreMode}
        onClick={() => match.player2_id && onResult(match.id, { winner_id: match.player2_id })}
      />

      {ready && scoreMode && (
        <div className="flex items-center gap-2 border-t border-purple-50 p-3">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={s1}
            onChange={(e) => setS1(e.target.value)}
            placeholder={t.score_label}
            aria-label={`${p1} ${t.score_label}`}
            className="w-20 min-w-[5rem] rounded-lg border border-purple-200 bg-white px-3 py-2 text-center font-mono text-base tabular-nums text-slate-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
          />
          <span className="text-slate-400">:</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={s2}
            onChange={(e) => setS2(e.target.value)}
            placeholder={t.score_label}
            aria-label={`${p2} ${t.score_label}`}
            className="w-20 min-w-[5rem] rounded-lg border border-purple-200 bg-white px-3 py-2 text-center font-mono text-base tabular-nums text-slate-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
          />
          <button
            disabled={s1 === "" || s2 === ""}
            onClick={() =>
              onResult(match.id, {
                player1_score: Number(s1),
                player2_score: Number(s2),
              })
            }
            className="btn btn-primary ml-auto px-4 py-2"
          >
            Save
          </button>
        </div>
      )}

      {ready && ((isGroup && t.allow_draws) || t.clock_minutes > 0) && (
        <div className="flex items-center gap-2 border-t border-purple-50 px-2 py-1.5">
          {isGroup && t.allow_draws && (
            <button
              onClick={() => onResult(match.id, { is_draw: true })}
              className="rounded-md border border-purple-200 px-2 py-1 text-xs text-purple-700 hover:bg-purple-50"
            >
              Draw
            </button>
          )}
          {t.clock_minutes > 0 && (
            <button
              onClick={() => onClock({ match, p1, p2 })}
              className="rounded-md border border-purple-200 px-2 py-1 text-xs text-purple-700 hover:bg-purple-50"
            >
              ⏱ Clock
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PlayerRow({
  name,
  image,
  score,
  isWinner,
  isLoser,
  isDraw,
  clickable,
  onClick,
}: {
  name: string | null;
  image?: string | null;
  score: number | null;
  isWinner: boolean;
  isLoser: boolean;
  isDraw: boolean;
  clickable: boolean;
  onClick: () => void;
}) {
  const base =
    "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition";
  const label = (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={name} src={image} size={24} />
      <span className="truncate">
        {name ?? <span className="text-slate-400">TBD</span>}
      </span>
    </span>
  );
  if (clickable) {
    return (
      <button onClick={onClick} className={`${base} text-slate-700 hover:bg-purple-50`}>
        {label}
        <span className="shrink-0 whitespace-nowrap text-xs text-purple-500">
          tap to win
        </span>
      </button>
    );
  }
  return (
    <div
      className={`${base} ${
        isWinner
          ? "bg-purple-50 font-semibold text-purple-800"
          : isDraw
            ? "text-sky-600"
            : isLoser
              ? "text-slate-400"
              : "text-slate-700"
      }`}
    >
      {label}
      <span className="flex shrink-0 items-center gap-2">
        {score != null && <span className="font-mono text-slate-600">{score}</span>}
        {isWinner && <span className="text-purple-600">✓</span>}
        {isDraw && <span className="text-xs text-sky-500">draw</span>}
      </span>
    </div>
  );
}

function StandingsTable({
  standings,
  scoreMode,
  progressMode,
}: {
  standings: StandingRow[];
  scoreMode: boolean;
  progressMode: boolean;
}) {
  if (!standings.length) return null;
  return (
    <div className="card p-4">
      <h2 className="mb-3 text-lg font-semibold text-purple-900">Standings</h2>
      <div className="overflow-hidden rounded-lg border border-purple-100">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th className="text-right" title="Played">P</th>
              <th className="text-right" title="Win-Draw-Loss">W/D/L</th>
              <th className="text-right" title="League points (wins)">Pts</th>
              {progressMode && (
                <th className="text-right" title="Progress score (streak)">
                  Prog
                </th>
              )}
              {scoreMode && (
                <th className="text-right" title="Score difference">+/-</th>
              )}
            </tr>
          </thead>
          <tbody>
            {standings.map((s) => (
              <tr key={s.player.id}>
                <td className="text-slate-400">{s.rank}</td>
                <td className="font-medium text-slate-800">
                  <span className="flex items-center gap-2">
                    <Avatar name={s.player.name} src={s.player.image_url} size={22} />
                    {s.player.name}
                  </span>
                </td>
                <td className="text-right">{s.played}</td>
                <td className="text-right">
                  {s.wins}/{s.draws}/{s.losses}
                </td>
                <td className="text-right font-semibold text-purple-700">
                  {s.points}
                </td>
                {progressMode && (
                  <td className="text-right font-semibold text-fuchsia-700">
                    {s.progressScore}
                  </td>
                )}
                {scoreMode && (
                  <td className="text-right">
                    {s.scoreDiff > 0 ? `+${s.scoreDiff}` : s.scoreDiff}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        Ranked by points
        {progressMode ? ", then progress score" : ""}
        {scoreMode ? ", then score difference" : ""}, then Buchholz and
        head-to-head. Losses and rests do not add league points.
      </p>
    </div>
  );
}

function findChampion(
  state: TournamentState,
  nameOf: (pid: string | null) => string | null,
): string | null {
  const player = findChampionPlayer(state);
  return player ? nameOf(player.id) : null;
}
