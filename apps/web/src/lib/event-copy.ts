// Human copy for score-ledger events (doc 09 §2): the fixture console's
// activity feed renders these instead of raw `type {json}` rows. Isomorphic —
// no server imports. Unknown event types fall back to a prettified label so
// new sports degrade gracefully.
//
// #427 second pass. This module used to author its own English, which made it
// the second unlocalized scoring surface (the first, the scorer's error
// banner, became `scoringErrorText`) — and worse, it carried a SECOND name for
// event types `scoring-vocab.ts` already translates in four locales, plus its
// own PERIOD_LABEL table that had drifted two phases ahead of PHASE_KEY.
//
// The split now is: every NOUN comes from `scoring-vocab` — the event type's
// name via `eventLabel`, a card's colour and a period's phase via `enumLabel`,
// an award's name via `awardLabel` — and only the SENTENCE FRAMES belong to
// this module, under `eventCopy.*`. `__tests__/event-copy.test.ts` pins that
// division: it asserts every badge is byte-identical to what `eventLabel`
// would return, for every event type the engine declares, in all four locales.
//
// Payload-derived text (`core.note`'s body, `scalars()`'s dump of a summary
// row) is deliberately NOT translated. That is scorer-authored or numeric data
// echoed back, not copy this app wrote.
import { interpolate } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";
import { awardLabel, enumLabel, eventLabel, type MsgFn } from "@/lib/scoring-vocab";

export interface EventDescription {
  /** Short badge text, e.g. "Goal", "Set summary", "Undo". */
  label: string;
  /** Human sentence, e.g. "Riverside FC — 21' (penalty)". */
  text: string;
  /** Badge tint bucket. */
  tone: "start" | "score" | "card" | "period" | "admin" | "void" | "note";
}

type Payload = Record<string, unknown>;

/** Every `eventCopy.*` key this module can emit — read by the parity test. */
export const EVENT_COPY_KEYS: readonly MessageKey[] = [
  "eventCopy.ownGoal", "eventCopy.unknownPerson", "eventCopy.voided",
  "eventCopy.forfeited", "eventCopy.abandoned", "eventCopy.awarded",
  "eventCopy.fromPenalty", "eventCopy.shootoutScored", "eventCopy.shootoutMissed",
  "eventCopy.wins", "eventCopy.winsBy", "eventCopy.draw", "eventCopy.recorded",
  "eventCopy.inProgress", "eventCopy.pointTo",
];

/** `m()` narrowed to MsgFn carries no vars, so interpolate on the way out. */
const say = (m: MsgFn, key: MessageKey, vars?: Record<string, string | number>) =>
  interpolate(m(key), vars);

function name(names: Record<string, string>, id: unknown, m: MsgFn): string {
  return typeof id === "string" ? (names[id] ?? m("eventCopy.unknownPerson")) : m("eventCopy.unknownPerson");
}

function minute(p: Payload): string {
  return typeof p.minute === "number" ? ` — ${p.minute}'` : "";
}

/** "volleyball.set.summary" → "Set summary" — only for a type no module declares. */
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

/** " — reason", localized where the reason is a known enum member. */
function because(p: Payload, m: MsgFn): string {
  return typeof p.reason === "string" && p.reason ? ` — ${enumLabel("reason", p.reason, m)}` : "";
}

export function describeEvent(
  type: string,
  rawPayload: unknown,
  names: Record<string, string>,
  m: MsgFn,
): EventDescription {
  const p = (rawPayload ?? {}) as Payload;
  // Single source for the badge. Every branch below either uses this verbatim
  // or replaces it with something the PAYLOAD says (an own goal, a card's
  // colour) — never with a second name for the type itself.
  const badge = eventLabel(type, m);

  switch (type) {
    // ── core ──
    case "core.start":
      // The badge already reads "Match started"; a sentence would repeat it.
      return { label: badge, text: "", tone: "start" };
    case "core.note":
      // Scorer-authored free text — echoed, never translated.
      return { label: badge, text: String(p.text ?? ""), tone: "note" };
    case "core.void":
      return { label: badge, text: m("eventCopy.voided"), tone: "void" };
    case "core.forfeit":
      return {
        label: badge,
        text: say(m, "eventCopy.forfeited", { name: name(names, p.by, m) }) + because(p, m),
        tone: "admin",
      };
    case "core.abandon":
      return { label: badge, text: m("eventCopy.abandoned") + because(p, m), tone: "admin" };
    case "core.award": {
      // Canonical CoreAward is { person, key } (Jul3/07 §4 — MOTM/MVP and
      // friends); `to` is a legacy fallback so old ledger rows keep a name.
      // The award's name comes from the vocabulary the player-stat `*_awards`
      // rows use, so "Man of the Match" is translated once, not twice.
      const who = name(names, p.person ?? p.to, m);
      const key = typeof p.key === "string" ? p.key : null;
      const award = (key && awardLabel(key, m)) ?? (key ? prettify(`award.${key}`) : m("eventCopy.awarded"));
      return { label: badge, text: `${award} — ${who}`, tone: "admin" };
    }

    // ── football ──
    case "football.goal": {
      const penalty = p.penalty && !p.ownGoal ? ` (${m("eventCopy.fromPenalty")})` : "";
      return {
        label: p.ownGoal ? m("eventCopy.ownGoal") : badge,
        text: `${name(names, p.by, m)}${minute(p)}${penalty}`,
        tone: "score",
      };
    }
    case "football.card":
      return {
        // The colour IS the badge when the payload names one — "Second yellow"
        // says more than "Card", and it is enum vocabulary, not a second name.
        label: typeof p.color === "string" ? enumLabel("color", p.color, m) : badge,
        text: `${name(names, p.by, m)}${minute(p)}`,
        tone: "card",
      };
    case "football.period":
      return {
        label: badge,
        text: typeof p.phase === "string" ? enumLabel("phase", p.phase, m) : "",
        tone: "period",
      };
    case "football.shootout.kick":
      return {
        label: badge,
        text: say(m, p.scored ? "eventCopy.shootoutScored" : "eventCopy.shootoutMissed", {
          name: name(names, p.by, m),
        }),
        tone: "score",
      };
    case "football.sub":
    case "football.substitution": // legacy ledger rows
      return { label: badge, text: name(names, p.by, m), tone: "note" };

    // ── cricket ──
    case "cricket.innings.summary":
      return { label: badge, text: scalars(p), tone: "score" };
    case "cricket.interruption":
      return {
        label: badge,
        text: scalars(p) || (typeof p.kind === "string" ? enumLabel("kind", p.kind, m) : ""),
        tone: "admin",
      };

    // ── boardgame / generic ──
    case "boardgame.result": {
      if (p.winner == null) return { label: badge, text: m("eventCopy.draw"), tone: "score" };
      const who = name(names, p.winner, m);
      return {
        label: badge,
        text:
          typeof p.method === "string"
            ? say(m, "eventCopy.winsBy", { name: who, method: enumLabel("method", p.method, m) })
            : say(m, "eventCopy.wins", { name: who }),
        tone: "score",
      };
    }
    case "generic.result": {
      const hasScores = p.p1Score != null || p.p2Score != null;
      return {
        label: badge,
        text: hasScores
          ? `${p.p1Score ?? 0} – ${p.p2Score ?? 0}`
          : p.isDraw
            ? m("eventCopy.draw")
            : m("eventCopy.recorded"),
        tone: "score",
      };
    }
  }

  // Set-based coarse summaries: volleyball.set.summary, badminton.game.summary,
  // tabletennis.game.summary — all carry {home, away, partial?}. The "in
  // progress" note moved from the badge into the sentence so the badge stays
  // exactly the event type's declared name.
  if (/\.(set|game)\.summary$/.test(type)) {
    return {
      label: badge,
      text: `${p.home ?? 0} – ${p.away ?? 0}${p.partial ? ` ${m("eventCopy.inProgress")}` : ""}`,
      tone: "score",
    };
  }
  if (/\.rally$/.test(type)) {
    return { label: badge, text: say(m, "eventCopy.pointTo", { name: name(names, p.wonBy, m) }), tone: "score" };
  }
  if (/\.ball$/.test(type)) {
    return { label: badge, text: scalars(p), tone: "score" };
  }

  // A type no shipped module declares: `eventLabel` already prettified it.
  return { label: badge, text: scalars(p), tone: "note" };
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
