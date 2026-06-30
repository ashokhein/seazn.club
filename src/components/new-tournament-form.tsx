"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { recommendGroupRounds } from "@/lib/pairing";
import { supportsProgressScore } from "@/lib/scoring";
import type {
  ResultMode,
  Season,
  SportPreset,
  Tournament,
  TournamentCategory,
  TournamentFormat,
} from "@/lib/types";

export function NewTournamentForm({
  seasons,
  presets,
  defaultPresetId,
  canUploadImages = false,
}: {
  seasons: Season[];
  presets: SportPreset[];
  defaultPresetId?: string;
  canUploadImages?: boolean;
}) {
  const router = useRouter();
  const initial = (defaultPresetId ? presets.find((p) => p.id === defaultPresetId) : undefined) ?? presets[0];

  const [seasonId, setSeasonId] = useState("");
  const [presetId, setPresetId] = useState(initial?.id ?? "");
  const activePreset =
    presets.find((p) => p.id === presetId) ?? presets[0] ?? null;

  const [sport, setSport] = useState(initial?.sport_name ?? "");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TournamentCategory>(
    initial?.default_category ?? "adult",
  );
  const [format, setFormat] = useState<TournamentFormat>(
    initial?.format ?? "swiss_knockout",
  );
  const [resultMode, setResultMode] = useState<ResultMode>(
    initial?.result_mode ?? "win_loss",
  );
  const [scoreLabel, setScoreLabel] = useState(initial?.score_label ?? "Score");
  const [pointsWin, setPointsWin] = useState(initial?.points_win ?? 1);
  const [pointsDraw, setPointsDraw] = useState(initial?.points_draw ?? 0);
  const [pointsLoss, setPointsLoss] = useState(initial?.points_loss ?? 0);
  const [allowDraws, setAllowDraws] = useState(initial?.allow_draws ?? false);
  const [useProgress, setUseProgress] = useState(
    initial?.use_progress_score ?? false,
  );
  const [clockMinutes, setClockMinutes] = useState(initial?.clock_minutes ?? 0);
  const [venue, setVenue] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [roundMinutes, setRoundMinutes] = useState(initial?.round_minutes ?? 30);
  const [players, setPlayers] = useState<PlayerDraft[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [imageInput, setImageInput] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const entityLabel = activePreset?.entity_label ?? "Players";
  const showProgressScore = supportsProgressScore({ result_mode: resultMode, format });

  useEffect(() => {
    if (!showProgressScore) setUseProgress(false);
  }, [showProgressScore]);

  function addPlayer() {
    const n = nameInput.trim();
    if (!n) return;
    if (players.some((p) => p.name.toLowerCase() === n.toLowerCase())) {
      setNameInput("");
      setImageInput(null);
      return;
    }
    setPlayers((prev) => [...prev, { name: n, image_url: imageInput, _file: imageFile ?? undefined }]);
    setNameInput("");
    setImageInput(null);
    setImageFile(null);
  }
  function removePlayer(index: number) {
    setPlayers((prev) => prev.filter((_, i) => i !== index));
  }
  async function onPickImage(file: File | undefined) {
    if (!file) return;
    try {
      setImageInput(await fileToDataUrl(file, 160));
      setImageFile(file);
    } catch {
      setError("Could not read that image");
    }
  }

  function applyPreset(p: SportPreset) {
    setPresetId(p.id);
    setSport(p.sport_name);
    setCategory(p.default_category);
    setFormat(p.format);
    setResultMode(p.result_mode);
    setScoreLabel(p.score_label);
    setPointsWin(p.points_win);
    setPointsDraw(p.points_draw);
    setPointsLoss(p.points_loss);
    setAllowDraws(p.allow_draws);
    setUseProgress(
      supportsProgressScore({ result_mode: p.result_mode, format: p.format })
        ? p.use_progress_score
        : false,
    );
    setClockMinutes(p.clock_minutes);
    setRoundMinutes(p.round_minutes);
    if (p.default_group_rounds != null) setGroupRounds(p.default_group_rounds);
  }

  const rec = useMemo(
    () => recommendGroupRounds(players.length || 2),
    [players.length],
  );
  const [groupRounds, setGroupRounds] = useState<number | null>(
    initial?.default_group_rounds ?? null,
  );
  const [knockoutSize, setKnockoutSize] = useState<number | null>(
    initial?.default_knockout_size ?? null,
  );
  const [ladderSize, setLadderSize] = useState(4);
  const effGroupRounds = groupRounds ?? rec.groupRounds;
  const effKnockoutSize = knockoutSize ?? rec.knockoutSize;

  const estRounds =
    format === "knockout"
      ? Math.ceil(Math.log2(Math.max(2, players.length || 2)))
      : format === "round_robin"
        ? (players.length || 2) - ((players.length || 2) % 2 === 0 ? 1 : 0) +
          (effKnockoutSize >= 2 ? Math.ceil(Math.log2(effKnockoutSize)) : 0)
        : format === "progress_stepladder"
          ? effGroupRounds + (ladderSize >= 4 ? 3 : 2)
          : effGroupRounds +
            (effKnockoutSize >= 2 ? Math.ceil(Math.log2(effKnockoutSize)) : 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (players.length < 2) {
      setError(`Add at least 2 ${entityLabel.toLowerCase()} (one per line).`);
      return;
    }
    setBusy(true);
    try {
      // When storage upload is available, omit data URLs from creation payload
      const playerPayload = players.map((p) => ({
        name: p.name,
        image_url: canUploadImages && p._file ? null : p.image_url,
      }));

      const res = await api<Tournament & { players: { id: string; name: string; seed: number }[] }>(
        "/api/tournaments",
        {
          method: "POST",
          json: {
            season_id: seasonId || null,
            sport: sport || "Game",
            name: name || `${sport || "Game"} ${category}`,
            category,
            format,
            num_group_rounds:
              format === "swiss_knockout" || format === "progress_stepladder"
                ? effGroupRounds
                : 0,
            knockout_size:
              format === "knockout"
                ? 0
                : format === "progress_stepladder"
                  ? ladderSize
                  : effKnockoutSize,
            players: playerPayload,
            result_mode: resultMode,
            score_label: scoreLabel,
            points_win: pointsWin,
            points_draw: pointsDraw,
            points_loss: pointsLoss,
            allow_draws: allowDraws,
            use_progress_score: showProgressScore ? useProgress : false,
            venue: venue.trim() || null,
            starts_at: startsAt ? new Date(startsAt).toISOString() : null,
            round_minutes: roundMinutes,
            clock_minutes: clockMinutes,
          },
        },
      );

      if (canUploadImages && res.players) {
        // Upload files to storage in parallel (fire-and-forget — navigate even on failure)
        const uploads = players
          .map((p, i) => ({ draft: p, created: res.players[i] }))
          .filter(({ draft }) => !!draft._file);
        void Promise.all(
          uploads.map(async ({ draft, created }) => {
            if (!created?.id || !draft._file) return;
            try {
              const { upload_url, storage_path } = await api<{
                upload_url: string;
                token: string;
                storage_path: string;
              }>(`/api/tournaments/${res.id}/upload-url`, {
                method: "POST",
                json: { player_id: created.id },
              });
              await fetch(upload_url, {
                method: "PUT",
                headers: { "Content-Type": "image/webp" },
                body: draft._file,
              });
              await api(`/api/tournaments/${res.id}/players/${created.id}`, {
                method: "PATCH",
                json: { image_storage_path: storage_path },
              });
            } catch {
              // storage upload failure is non-fatal
            }
          }),
        );
      }

      router.push(`/tournaments/${res.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  if (presets.length === 0) {
    return (
      <p className="card p-6 text-sm text-slate-600">
        No sport presets found. Add presets in{" "}
        <a href="/settings" className="text-purple-600 underline">
          Settings
        </a>
        .
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="card space-y-5 p-6">
        <Labeled label="Sport preset">
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  presetId === p.id
                    ? "border-purple-500 bg-purple-600 text-white shadow-sm"
                    : "border-purple-200 bg-white text-purple-700 hover:bg-purple-50"
                }`}
              >
                {p.sport_name}
              </button>
            ))}
          </div>
        </Labeled>

        <div className="grid gap-4 sm:grid-cols-2">
          <Labeled label="Season (optional)">
            <select
              value={seasonId}
              onChange={(e) => setSeasonId(e.target.value)}
              className="input"
            >
              <option value="">No season</option>
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Labeled>

          <Labeled label="Sport">
            <input
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              placeholder="Chess"
              className="input"
            />
          </Labeled>

          <Labeled label="Tournament name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${sport || "Game"} ${category}`}
              className="input"
            />
          </Labeled>

          <Labeled label="Category">
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as TournamentCategory)
              }
              className="input"
            >
              <option value="adult">Adult</option>
              <option value="kids">Kids</option>
              <option value="open">Open</option>
            </select>
          </Labeled>
        </div>

        <Labeled label="Format">
          <div className="grid gap-2 sm:grid-cols-2">
            <FormatCard
              active={format === "swiss_knockout"}
              onClick={() => setFormat("swiss_knockout")}
              title="Progress league + knockout"
              desc="Several rounds (winners vs winners), ranked by points & progress, then top players enter a knockout. The Seazn Club format."
            />
            <FormatCard
              active={format === "progress_stepladder"}
              onClick={() => setFormat("progress_stepladder")}
              title="Progress league → stepladder finals"
              desc="Progress rounds, then a stepladder: 1st waits in the Final, 2nd in the Semi-final; 3rd v 4th climb up."
            />
            <FormatCard
              active={format === "round_robin"}
              onClick={() => setFormat("round_robin")}
              title="Round robin"
              desc="Everyone plays everyone once. Ranked by points (with optional top-N knockout)."
            />
            <FormatCard
              active={format === "knockout"}
              onClick={() => setFormat("knockout")}
              title="Single elimination"
              desc="Classic bracket. Lose once and you're out. Auto byes for odd counts."
            />
          </div>
        </Labeled>

        <Labeled
          label={`${entityLabel} (${players.length}) — add an optional logo / flag / photo`}
        >
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
                onChange={(e) => onPickImage(e.target.files?.[0])}
              />
            </label>
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPlayer();
                }
              }}
              placeholder={
                entityLabel === "Teams" ? "Team name" : "Player name"
              }
              className="input min-w-[10rem] flex-1"
            />
            <button
              type="button"
              onClick={addPlayer}
              className="btn btn-primary shrink-0"
            >
              Add
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            Or paste an image URL:
            <input
              value={
                imageInput && imageInput.startsWith("data:")
                  ? ""
                  : imageInput ?? ""
              }
              onChange={(e) => setImageInput(e.target.value || null)}
              placeholder="https://…/flag.png"
              className="ml-2 w-56 rounded-md border border-purple-200 bg-white px-2 py-0.5 text-xs text-slate-700 outline-none focus:border-purple-500"
            />
          </p>
          {players.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {players.map((p, i) => (
                <li
                  key={`${p.name}-${i}`}
                  className="flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 py-1 pl-2 pr-1 text-sm text-purple-800"
                >
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.image_url}
                      alt=""
                      className="h-6 w-6 rounded-full object-cover ring-1 ring-purple-200"
                    />
                  ) : (
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-purple-200 text-[10px] font-semibold text-purple-700">
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  {p.name}
                  <button
                    type="button"
                    onClick={() => removePlayer(i)}
                    aria-label={`Remove ${p.name}`}
                    className="grid h-5 w-5 place-items-center rounded-full text-purple-500 transition hover:bg-purple-200 hover:text-purple-900"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Labeled>

        {(format === "swiss_knockout" || format === "round_robin") && (
          <div className="grid gap-4 sm:grid-cols-2">
            {format === "swiss_knockout" && (
              <Labeled
                label={`Progress rounds (recommended ${rec.groupRounds})`}
              >
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={effGroupRounds}
                  onChange={(e) => setGroupRounds(Number(e.target.value))}
                  className="input"
                />
              </Labeled>
            )}
            <Labeled
              label={`Knockout after group (recommended ${rec.knockoutSize})`}
            >
              <select
                value={effKnockoutSize}
                onChange={(e) => setKnockoutSize(Number(e.target.value))}
                className="input"
              >
                {[0, 2, 4, 8, 16].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "No knockout (league only)" : `Top ${n}`}
                  </option>
                ))}
              </select>
            </Labeled>
          </div>
        )}

        {format === "progress_stepladder" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Labeled label={`Progress rounds (recommended ${rec.groupRounds})`}>
              <input
                type="number"
                min={1}
                max={20}
                value={effGroupRounds}
                onChange={(e) => setGroupRounds(Number(e.target.value))}
                className="input"
              />
            </Labeled>
            <Labeled label="Stepladder finalists">
              <select
                value={ladderSize}
                onChange={(e) => setLadderSize(Number(e.target.value))}
                className="input"
              >
                <option value={4}>Top 4 — Eliminator → Semi → Final</option>
                <option value={3}>Top 3 — Semi → Final</option>
              </select>
            </Labeled>
          </div>
        )}

        <p className="rounded-lg bg-purple-50 px-3 py-2 text-xs text-purple-700">
          Estimated ~{estRounds} rounds. At ~{roundMinutes} min/round with
          parallel boards this fits your time window.
        </p>
      </div>

      {/* Separate panel: per-tournament overrides */}
      <div className="card space-y-4 p-6">
        <div>
          <h2 className="text-sm font-semibold text-purple-900">
            Optional overrides for this tournament
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Pre-filled from your{" "}
            {activePreset ? activePreset.sport_name : "sport"} preset. Change
            only what differs for this event.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Labeled label="Result entry">
            <select
              value={resultMode}
              onChange={(e) => setResultMode(e.target.value as ResultMode)}
              className="input"
            >
              <option value="win_loss">Tap the winner (no scores)</option>
              <option value="score">Enter scores</option>
            </select>
          </Labeled>
          {resultMode === "score" && (
            <Labeled label="Score label">
              <input
                value={scoreLabel}
                onChange={(e) => setScoreLabel(e.target.value)}
                placeholder="Goals / Runs / Sets"
                className="input"
              />
            </Labeled>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Labeled label="Points for a win">
            <input
              type="number"
              min={0}
              value={pointsWin}
              onChange={(e) => setPointsWin(Number(e.target.value))}
              className="input"
            />
          </Labeled>
          <Labeled label="Points for a draw">
            <input
              type="number"
              min={0}
              value={pointsDraw}
              onChange={(e) => setPointsDraw(Number(e.target.value))}
              className="input"
            />
          </Labeled>
          <Labeled label="Points for a loss">
            <input
              type="number"
              min={0}
              value={pointsLoss}
              onChange={(e) => setPointsLoss(Number(e.target.value))}
              className="input"
            />
          </Labeled>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="accent-purple-600"
              checked={allowDraws}
              onChange={(e) => setAllowDraws(e.target.checked)}
            />
            Allow draws (group stage only)
          </label>
          {showProgressScore && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                className="accent-purple-600"
                checked={useProgress}
                onChange={(e) => setUseProgress(e.target.checked)}
              />
              Progress score tiebreaker (chess-style win streaks)
            </label>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Labeled label="Venue / location (optional)">
            <input
              type="text"
              placeholder="e.g. City Sports Hall"
              maxLength={120}
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="input"
            />
          </Labeled>
          <Labeled label="Start time (optional)">
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="input"
            />
          </Labeled>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Labeled label="Minutes per round">
            <input
              type="number"
              min={1}
              value={roundMinutes}
              onChange={(e) => setRoundMinutes(Number(e.target.value))}
              className="input"
            />
          </Labeled>
          <Labeled label="Match clock (min/player, 0 = off)">
            <input
              type="number"
              min={0}
              value={clockMinutes}
              onChange={(e) => setClockMinutes(Number(e.target.value))}
              className="input"
            />
          </Labeled>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <button disabled={busy} className="btn btn-primary w-full py-3">
        {busy ? "Creating…" : "Create tournament"}
      </button>
    </form>
  );
}

type PlayerDraft = { name: string; image_url: string | null; _file?: File };

/**
 * Reads an image file and returns a downscaled JPEG/PNG data URL so we can
 * store small logos/flags inline without an external storage bucket.
 */
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

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function FormatCard({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition ${
        active
          ? "border-purple-500 bg-purple-50 ring-1 ring-purple-200"
          : "border-purple-100 bg-white hover:border-purple-300"
      }`}
    >
      <span className="block text-sm font-semibold text-purple-900">
        {title}
      </span>
      <span className="mt-1 block text-xs text-slate-500">{desc}</span>
    </button>
  );
}
