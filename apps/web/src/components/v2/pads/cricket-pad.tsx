"use client";

// Cricket pad (spec 04 §2): ball-by-ball entry (Tier 3) with over/ball derived
// from the folded state, plus coarse innings totals (Tier 0/1) and the match
// controls (toss, declare, close, interruption, revise). The engine rejects
// anything illegal — the pad only makes the legal path fast.
import { useEffect, useState } from "react";
import type { SendEvent, SideInfo, SportInfo, LiveState } from "@/components/v2/fixture-console";
import { useMsg } from "@/components/i18n/dict-provider";

interface FineView {
  striker: string | null;
  nonStriker: string | null;
  currentBowler: string | null;
  dismissed: string[];
}
interface InningsView {
  battingSide: "home" | "away";
  runs: number;
  wickets: number;
  legalBalls: number;
  closed: boolean;
  fine: FineView | null;
}
interface CricketStateView {
  phase?: string;
  tossTaken?: boolean;
  innings?: InningsView[];
  entrants?: { home: string; away: string };
}

const WICKET_KINDS = [
  "bowled",
  "caught",
  "lbw",
  "runout",
  "stumped",
  "hitwicket",
  "retired",
  "obstructed",
  "timedout",
] as const;
// Bowler is credited per Laws (spec 04 §2.3).
const BOWLER_CREDITED = new Set(["bowled", "caught", "lbw", "stumped", "hitwicket"]);

const EXTRA_KINDS = ["wide", "noball", "bye", "legbye", "penalty"] as const;

export function CricketPad({
  sport,
  home,
  away,
  live,
  send,
  busy,
}: {
  sport: SportInfo;
  home: SideInfo;
  away: SideInfo;
  live: LiveState;
  send: SendEvent;
  busy: boolean;
}) {
  const msg = useMsg();
  const cfg = sport.config as { ballsPerOver?: number; inningsPerSide?: number };
  const bpo = cfg.ballsPerOver ?? 6;
  const state = (live.state ?? {}) as CricketStateView;
  const innings = state.innings ?? [];
  const open = innings.find((i) => !i.closed);
  // Over-by-over is the default (most organisers score coarsely: runs+wickets
  // per over, then close the innings). Ball-by-ball is the advanced toggle.
  const [mode, setMode] = useState<"over" | "ball" | "summary">("over");

  if (state.phase === "pre" || live.status === "scheduled") {
    if (!state.tossTaken) {
      return <TossForm home={home} away={away} send={send} busy={busy} />;
    }
    return <p className="text-sm text-slate-500">{msg("pad.ck.tossRecorded")}</p>;
  }

  const battingSide = open ? (open.battingSide === "home" ? home : away) : null;
  const fieldingSide = open ? (open.battingSide === "home" ? away : home) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ScoreStrip innings={innings} home={home} away={away} bpo={bpo} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setMode("over")}
          className={`rounded-full px-3 py-1 ${mode === "over" ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}
        >
          {msg("pad.ck.overByOver")}
        </button>
        <button
          type="button"
          onClick={() => setMode("summary")}
          className={`rounded-full px-3 py-1 ${mode === "summary" ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}
        >
          {msg("pad.ck.inningsTotal")}
        </button>
        <button
          type="button"
          onClick={() => setMode("ball")}
          className={`rounded-full px-3 py-1 ${mode === "ball" ? "bg-purple-100 text-purple-700" : "text-slate-400 hover:bg-slate-100"}`}
          title={msg("pad.ck.ballByBallTitle")}
        >
          {msg("pad.ck.ballByBall")}
        </button>
      </div>

      {mode === "over" ? (
        <OverByOverForm open={open ?? null} batting={battingSide} bpo={bpo} send={send} busy={busy} />
      ) : mode === "ball" && battingSide && fieldingSide && open ? (
        <BallForm
          key={`${innings.length}-${open.legalBalls}`}
          innings={open}
          batting={battingSide}
          fielding={fieldingSide}
          bpo={bpo}
          send={send}
          busy={busy}
        />
      ) : mode === "ball" ? (
        <p className="text-sm text-slate-500">{msg("pad.ck.noOpenInnings")}</p>
      ) : (
        <SummaryForm bpo={bpo} send={send} busy={busy} />
      )}

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          disabled={busy || !open}
          onClick={() => send("cricket.innings.declare", {})}
          className="btn btn-ghost px-3 py-1.5 text-xs"
        >
          {msg("pad.ck.declare")}
        </button>
        <button
          type="button"
          disabled={busy || !open}
          onClick={() => send("cricket.innings.close", {})}
          className="btn btn-ghost px-3 py-1.5 text-xs"
        >
          {msg("pad.ck.closeInnings")}
        </button>
        {(cfg.inningsPerSide ?? 1) === 2 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => send("cricket.match.close", {})}
            className="btn btn-ghost px-3 py-1.5 text-xs"
            title={msg("pad.ck.closeMatchTitle")}
          >
            {msg("pad.ck.closeMatch")}
          </button>
        )}
        <InterruptionControls send={send} busy={busy} />
      </div>
    </div>
  );
}

function oversText(balls: number, bpo: number): string {
  return `${Math.floor(balls / bpo)}.${balls % bpo}`;
}

function ScoreStrip({
  innings,
  home,
  away,
  bpo,
}: {
  innings: InningsView[];
  home: SideInfo;
  away: SideInfo;
  bpo: number;
}) {
  return (
    <span className="font-mono text-slate-600">
      {innings.map((inn, i) => (
        <span key={i} className="mr-3">
          {(inn.battingSide === "home" ? home : away).name}: {inn.runs}/{inn.wickets} (
          {oversText(inn.legalBalls, bpo)}){inn.closed ? "" : "*"}
        </span>
      ))}
    </span>
  );
}

function TossForm({
  home,
  away,
  send,
  busy,
}: {
  home: SideInfo;
  away: SideInfo;
  send: SendEvent;
  busy: boolean;
}) {
  const msg = useMsg();
  const [wonBy, setWonBy] = useState(home.id);
  const [elected, setElected] = useState<"bat" | "bowl">("bat");
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send("cricket.toss", { wonBy, elected });
      }}
    >
      <label className="block">
        <span className="label">{msg("pad.ck.tossWonBy")}</span>
        <select value={wonBy} onChange={(e) => setWonBy(e.target.value)} className="select w-44">
          <option value={home.id}>{home.name}</option>
          <option value={away.id}>{away.name}</option>
        </select>
      </label>
      <label className="block">
        <span className="label">{msg("pad.ck.electedTo")}</span>
        <select
          value={elected}
          onChange={(e) => setElected(e.target.value as "bat" | "bowl")}
          className="select w-28"
        >
          <option value="bat">bat</option>
          <option value="bowl">bowl</option>
        </select>
      </label>
      <button type="submit" disabled={busy} className="btn btn-primary">
        {msg("pad.ck.recordToss")}
      </button>
    </form>
  );
}

function personName(side: SideInfo, personId: string): string {
  return (
    side.lineup.find((p) => p.person_id === personId)?.full_name ??
    side.members.find((m) => m.person_id === personId)?.full_name ??
    personId
  );
}

function BallForm({
  innings,
  batting,
  fielding,
  bpo,
  send,
  busy,
}: {
  innings: InningsView;
  batting: SideInfo;
  fielding: SideInfo;
  bpo: number;
  send: SendEvent;
  busy: boolean;
}) {
  const msg = useMsg();
  const fine = innings.fine;
  const batters = batting.lineup.length > 0 ? batting.lineup : batting.members.map((m) => ({
    person_id: m.person_id,
    full_name: m.full_name,
  }));
  const bowlers = fielding.lineup.length > 0 ? fielding.lineup : fielding.members.map((m) => ({
    person_id: m.person_id,
    full_name: m.full_name,
  }));

  const [striker, setStriker] = useState(fine?.striker ?? "");
  const [nonStriker, setNonStriker] = useState(fine?.nonStriker ?? "");
  const [bowler, setBowler] = useState(fine?.currentBowler ?? "");
  const [extraKind, setExtraKind] = useState("");
  const [extraRuns, setExtraRuns] = useState("1");
  const [wicketKind, setWicketKind] = useState("");
  const [outWho, setOutWho] = useState("");
  const [fielder, setFielder] = useState("");

  // Track the engine's rotation between balls.
  useEffect(() => {
    if (fine?.striker) setStriker(fine.striker);
    if (fine?.nonStriker) setNonStriker(fine.nonStriker);
    setBowler(fine?.currentBowler ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fine?.striker, fine?.nonStriker, fine?.currentBowler]);

  const over = Math.floor(innings.legalBalls / bpo);
  const ballInOver = (innings.legalBalls % bpo) + 1;
  const dismissed = new Set(fine?.dismissed ?? []);
  const newOver = innings.legalBalls % bpo === 0;

  async function ball(batRuns: number) {
    if (!striker || !nonStriker || !bowler) return;
    const boundary = batRuns === 4 ? 4 : batRuns === 6 ? 6 : undefined;
    const payload: Record<string, unknown> = {
      over,
      ballInOver,
      striker,
      nonStriker,
      bowler,
      runs: {
        bat: batRuns,
        ...(extraKind
          ? { extras: { kind: extraKind, runs: Number(extraRuns) || 1 } }
          : {}),
      },
      ...(boundary ? { boundary } : {}),
      ...(wicketKind
        ? {
            wicket: {
              kind: wicketKind,
              out: outWho || striker,
              ...(fielder ? { fielder } : {}),
              bowlerCredited: BOWLER_CREDITED.has(wicketKind),
            },
          }
        : {}),
    };
    const ok = await send("cricket.ball", payload);
    if (ok) {
      setExtraKind("");
      setExtraRuns("1");
      setWicketKind("");
      setOutWho("");
      setFielder("");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        {msg("pad.ck.over")} <span className="font-mono">{over}.{ballInOver}</span>
        {newOver && <span className="ml-2 text-amber-600">{msg("pad.ck.newOver")}</span>}
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="label">{msg("pad.ck.striker")}</span>
          <select
            value={striker}
            onChange={(e) => setStriker(e.target.value)}
            className="select px-2 py-1 text-xs"
          >
            <option value="">—</option>
            {batters
              .filter((p) => !dismissed.has(p.person_id))
              .map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  {p.full_name}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{msg("pad.ck.nonStriker")}</span>
          <select
            value={nonStriker}
            onChange={(e) => setNonStriker(e.target.value)}
            className="select px-2 py-1 text-xs"
          >
            <option value="">—</option>
            {batters
              .filter((p) => !dismissed.has(p.person_id))
              .map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  {p.full_name}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{msg("pad.ck.bowler")}</span>
          <select
            value={bowler}
            onChange={(e) => setBowler(e.target.value)}
            className="select px-2 py-1 text-xs"
          >
            <option value="">—</option>
            {bowlers.map((p) => (
              <option key={p.person_id} value={p.person_id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {[0, 1, 2, 3, 4, 6].map((r) => (
          <button
            key={r}
            type="button"
            disabled={busy || !striker || !nonStriker || !bowler}
            onClick={() => ball(r)}
            className={`h-11 w-11 rounded-lg border text-sm font-semibold transition disabled:opacity-40 ${
              r === 4 || r === 6
                ? "border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
            title={r === 4 || r === 6 ? msg("pad.ck.boundary", { r }) : msg("pad.ck.runs", { r })}
          >
            {r}
          </button>
        ))}
        <select
          value={extraKind}
          onChange={(e) => setExtraKind(e.target.value)}
          className="select w-28 px-2 py-1 text-xs"
          aria-label={msg("pad.ck.extras")}
        >
          <option value="">{msg("pad.ck.noExtras")}</option>
          {EXTRA_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {extraKind && (
          <input
            type="number"
            min={1}
            value={extraRuns}
            onChange={(e) => setExtraRuns(e.target.value)}
            className="input w-16 px-2 py-1 text-xs"
            aria-label={msg("pad.ck.extraRuns")}
          />
        )}
        <select
          value={wicketKind}
          onChange={(e) => {
            setWicketKind(e.target.value);
            if (e.target.value && !outWho) setOutWho(striker);
          }}
          className="select w-32 px-2 py-1 text-xs"
          aria-label={msg("pad.ck.wicket")}
        >
          <option value="">{msg("pad.ck.noWicket")}</option>
          {WICKET_KINDS.map((k) => (
            <option key={k} value={k}>
              W: {k}
            </option>
          ))}
        </select>
        {wicketKind && (
          <>
            <select
              value={outWho}
              onChange={(e) => setOutWho(e.target.value)}
              className="select w-32 px-2 py-1 text-xs"
              aria-label={msg("pad.ck.batterOut")}
            >
              <option value={striker}>{striker ? personName(batting, striker) : msg("pad.ck.strikerLc")}</option>
              <option value={nonStriker}>
                {nonStriker ? personName(batting, nonStriker) : msg("pad.ck.nonStrikerLc")}
              </option>
            </select>
            {(wicketKind === "caught" || wicketKind === "runout" || wicketKind === "stumped") && (
              <select
                value={fielder}
                onChange={(e) => setFielder(e.target.value)}
                className="select w-32 px-2 py-1 text-xs"
                aria-label={msg("pad.ck.fielder")}
              >
                <option value="">{msg("pad.ck.fielderPlaceholder")}</option>
                {bowlers.map((p) => (
                  <option key={p.person_id} value={p.person_id}>
                    {p.full_name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
      <p className="text-xs text-slate-400">{msg("pad.ck.ballHint")}</p>
    </div>
  );
}

// Over-by-over coarse entry (the default): enter this over's runs + wickets,
// "Add over" folds it into the innings via a progressive cricket.innings.summary
// (the engine enforces monotone growth). A full over = bpo legal balls. Close
// the innings from the controls below when the side is all out / overs done.
function OverByOverForm({
  open,
  batting,
  bpo,
  send,
  busy,
}: {
  open: InningsView | null;
  batting: SideInfo | null;
  bpo: number;
  send: SendEvent;
  busy: boolean;
}) {
  const msg = useMsg();
  const [runs, setRuns] = useState("");
  const [wickets, setWickets] = useState("");
  const runsN = Number(runs || 0);
  const wktsN = Number(wickets || 0);
  const curRuns = open?.runs ?? 0;
  const curWkts = open?.wickets ?? 0;
  const curBalls = open?.legalBalls ?? 0;
  const overNo = Math.floor(curBalls / bpo) + 1;

  async function addOver() {
    const ok = await send("cricket.innings.summary", {
      runs: curRuns + runsN,
      wickets: curWkts + wktsN,
      legalBalls: curBalls + bpo,
      partial: true, // progressive: keep the innings open (Close innings ends it)
    });
    if (ok) {
      setRuns("");
      setWickets("");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        {batting ? msg("pad.ck.sideBatting", { name: batting.name }) : msg("pad.ck.nextInnings")} — {msg("pad.ck.total")}{" "}
        <span className="font-mono font-semibold text-slate-900">
          {curRuns}/{curWkts}
        </span>{" "}
        ({msg("pad.ck.oversAbbr", { overs: oversText(curBalls, bpo) })})
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">{msg("pad.ck.overNoRuns", { n: overNo })}</span>
          <input
            type="number"
            min={0}
            aria-label={msg("pad.ck.runsThisOver")}
            className="input w-24 px-2 py-1 text-sm"
            value={runs}
            onChange={(e) => setRuns(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">{msg("pad.ck.wickets")}</span>
          <input
            type="number"
            min={0}
            max={10}
            aria-label={msg("pad.ck.wicketsThisOver")}
            className="input w-20 px-2 py-1 text-sm"
            value={wickets}
            onChange={(e) => setWickets(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary px-4 py-1.5 text-sm"
          disabled={busy || runs === ""}
          onClick={() => void addOver()}
        >
          {msg("pad.ck.addOver")}
        </button>
      </div>
      <p className="text-xs text-slate-400">{msg("pad.ck.overHint", { bpo })}</p>
    </div>
  );
}

function SummaryForm({ bpo, send, busy }: { bpo: number; send: SendEvent; busy: boolean }) {
  const msg = useMsg();
  const [runs, setRuns] = useState("");
  const [wickets, setWickets] = useState("");
  const [overs, setOvers] = useState("");
  const [balls, setBalls] = useState("");
  const [partial, setPartial] = useState(false);
  const [declared, setDeclared] = useState(false);

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send("cricket.innings.summary", {
          runs: Number(runs),
          wickets: Number(wickets || 0),
          legalBalls: Number(overs || 0) * bpo + Number(balls || 0),
          ...(declared ? { declared: true } : {}),
          ...(partial ? { partial: true } : {}),
        });
        setRuns("");
        setWickets("");
        setOvers("");
        setBalls("");
        setPartial(false);
        setDeclared(false);
      }}
    >
      <label className="block">
        <span className="label">{msg("pad.ck.runsLabel")}</span>
        <input
          required
          type="number"
          min={0}
          value={runs}
          onChange={(e) => setRuns(e.target.value)}
          className="input w-24"
        />
      </label>
      <label className="block">
        <span className="label">{msg("pad.ck.wickets")}</span>
        <input
          type="number"
          min={0}
          max={10}
          value={wickets}
          onChange={(e) => setWickets(e.target.value)}
          className="input w-20"
        />
      </label>
      <label className="block">
        <span className="label">{msg("pad.ck.overs")}</span>
        <input
          type="number"
          min={0}
          value={overs}
          onChange={(e) => setOvers(e.target.value)}
          className="input w-20"
        />
      </label>
      <label className="block">
        <span className="label">{msg("pad.ck.plusBalls")}</span>
        <input
          type="number"
          min={0}
          max={5}
          value={balls}
          onChange={(e) => setBalls(e.target.value)}
          className="input w-20"
        />
      </label>
      <label className="flex items-center gap-1 pb-2 text-xs text-slate-500">
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
        {msg("pad.ck.inProgress")}
      </label>
      <label className="flex items-center gap-1 pb-2 text-xs text-slate-500">
        <input
          type="checkbox"
          checked={declared}
          onChange={(e) => setDeclared(e.target.checked)}
        />
        {msg("pad.ck.declared")}
      </label>
      <button type="submit" disabled={busy || runs === ""} className="btn btn-primary">
        {msg("pad.ck.recordInnings")}
      </button>
    </form>
  );
}

function InterruptionControls({ send, busy }: { send: SendEvent; busy: boolean }) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const [oversPerSide, setOversPerSide] = useState("");
  const [target, setTarget] = useState("");

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => send("cricket.interruption", { kind: "rain" })}
        className="btn btn-ghost px-3 py-1.5 text-xs"
      >
        🌧 {msg("pad.ck.interruption")}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(!open)}
        className="btn btn-ghost px-3 py-1.5 text-xs"
      >
        {msg("pad.ck.reviseOvers")}
      </button>
      {open && (
        <span className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">{msg("pad.ck.oversPerSide")}</span>
            <input
              type="number"
              min={1}
              value={oversPerSide}
              onChange={(e) => setOversPerSide(e.target.value)}
              className="input w-24 px-2 py-1 text-xs"
            />
          </label>
          <label className="block">
            <span className="label">{msg("pad.ck.manualTarget")}</span>
            <input
              type="number"
              min={1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="input w-24 px-2 py-1 text-xs"
            />
          </label>
          <button
            type="button"
            disabled={busy || (!oversPerSide && !target)}
            onClick={async () => {
              const ok = await send("cricket.revise", {
                ...(oversPerSide ? { oversPerSide: Number(oversPerSide) } : {}),
                ...(target ? { target: Number(target) } : {}),
              });
              if (ok) {
                setOpen(false);
                setOversPerSide("");
                setTarget("");
              }
            }}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {msg("pad.ck.applyRevision")}
          </button>
        </span>
      )}
    </>
  );
}
