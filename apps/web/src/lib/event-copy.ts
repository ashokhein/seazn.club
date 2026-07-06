// Human copy for score-ledger events (doc 09 §2): the fixture console's
// activity feed renders these instead of raw `type {json}` rows. Isomorphic —
// no server imports. Unknown event types fall back to a prettified label so
// new sports degrade gracefully.

export interface EventDescription {
  /** Short badge text, e.g. "Goal", "Set", "Undo". */
  label: string;
  /** Human sentence, e.g. "Riverside FC — 21' (penalty)". */
  text: string;
  /** Badge tint bucket. */
  tone: "start" | "score" | "card" | "period" | "admin" | "void" | "note";
}

type Payload = Record<string, unknown>;

const PERIOD_LABEL: Record<string, string> = {
  HT: "Half-time",
  FT: "Full-time",
  ET_H1: "Extra time — first half",
  ET_HT: "Extra time — half-time",
  ET_H2: "Extra time — second half",
  ET_FT: "End of extra time",
};

function name(names: Record<string, string>, id: unknown): string {
  return typeof id === "string" ? (names[id] ?? "Unknown") : "Unknown";
}

function minute(p: Payload): string {
  return typeof p.minute === "number" ? ` — ${p.minute}'` : "";
}

/** "volleyball.set.summary" → "Set summary" */
function prettify(type: string): string {
  const tail = type.split(".").slice(1).join(" ").replace(/_/g, " ").trim() || type;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/** Compact human rendering of an unknown payload: skip ids/uuids, keep scalars. */
function scalars(p: Payload): string {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}/i;
  return Object.entries(p)
    .filter(([, v]) => ["number", "string", "boolean"].includes(typeof v))
    .filter(([, v]) => !(typeof v === "string" && UUID.test(v)))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join(", ");
}

export function describeEvent(
  type: string,
  rawPayload: unknown,
  names: Record<string, string>,
): EventDescription {
  const p = (rawPayload ?? {}) as Payload;

  switch (type) {
    // ── core ──
    case "core.start":
      return { label: "Started", text: "Match started", tone: "start" };
    case "core.note":
      return { label: "Note", text: String(p.text ?? ""), tone: "note" };
    case "core.void":
      return { label: "Undo", text: "Previous entry voided", tone: "void" };
    case "core.forfeit":
      return {
        label: "Forfeit",
        text: `${name(names, p.by)} forfeited${p.reason ? ` — ${p.reason}` : ""}`,
        tone: "admin",
      };
    case "core.abandon":
      return {
        label: "Abandoned",
        text: `Match abandoned${p.reason ? ` — ${p.reason}` : ""}`,
        tone: "admin",
      };
    case "core.award":
      return { label: "Awarded", text: `Awarded to ${name(names, p.to)}`, tone: "admin" };

    // ── football ──
    case "football.goal": {
      const extras = [p.ownGoal && "own goal", p.penalty && "penalty"].filter(Boolean).join(", ");
      return {
        label: p.ownGoal ? "Own goal" : "Goal",
        text: `${name(names, p.by)}${minute(p)}${extras && !p.ownGoal ? ` (${extras})` : ""}`,
        tone: "score",
      };
    }
    case "football.card":
      return {
        label: `${String(p.color ?? "card").replace("_", " ")}`,
        text: `${name(names, p.by)}${minute(p)}`,
        tone: "card",
      };
    case "football.period":
      return {
        label: "Period",
        text: PERIOD_LABEL[String(p.phase)] ?? String(p.phase ?? "period"),
        tone: "period",
      };
    case "football.shootout.kick":
      return {
        label: "Shootout",
        text: `${name(names, p.by)} ${p.scored ? "scored" : "missed"}`,
        tone: "score",
      };
    case "football.substitution":
      return { label: "Substitution", text: name(names, p.by), tone: "note" };

    // ── cricket ──
    case "cricket.innings.summary":
      return { label: "Innings", text: scalars(p), tone: "score" };
    case "cricket.interruption":
      return {
        label: "Interruption",
        text: scalars(p) || String(p.kind ?? "interruption"),
        tone: "admin",
      };
    case "cricket.superover":
      return { label: "Super over", text: scalars(p), tone: "score" };

    // ── boardgame / generic ──
    case "boardgame.result":
      return {
        label: "Result",
        text:
          p.winner != null
            ? `${name(names, p.winner)} wins${p.method ? ` by ${p.method}` : ""}`
            : "Draw",
        tone: "score",
      };
    case "generic.result": {
      const hasScores = p.p1Score != null || p.p2Score != null;
      return {
        label: "Result",
        text: hasScores ? `${p.p1Score ?? 0} – ${p.p2Score ?? 0}` : p.isDraw ? "Draw" : "Recorded",
        tone: "score",
      };
    }
  }

  // Set-based coarse summaries: volleyball.set.summary, badminton.game.summary,
  // tabletennis.game.summary — all carry {home, away, partial?}.
  if (/\.(set|game)\.summary$/.test(type)) {
    const unit = type.includes(".set.") ? "Set" : "Game";
    return {
      label: p.partial ? `${unit} (live)` : unit,
      text: `${p.home ?? 0} – ${p.away ?? 0}${p.partial ? " in progress" : ""}`,
      tone: "score",
    };
  }
  if (/\.rally$/.test(type)) {
    return { label: "Rally", text: `Point ${name(names, p.wonBy)}`, tone: "score" };
  }
  if (/\.ball$/.test(type)) {
    return { label: "Ball", text: scalars(p), tone: "score" };
  }

  return { label: prettify(type), text: scalars(p), tone: "note" };
}

export const EVENT_TONE_STYLE: Record<EventDescription["tone"], string> = {
  start: "bg-sky-100 text-sky-700",
  score: "bg-emerald-100 text-emerald-700",
  card: "bg-amber-100 text-amber-700",
  period: "bg-purple-100 text-purple-700",
  admin: "bg-red-50 text-red-600",
  void: "bg-amber-100 text-amber-700",
  note: "bg-slate-100 text-slate-600",
};
