// Pure helpers for the public dashboard (doc 09, PROMPT-12) — no server
// imports so they unit-test without a DB and can ride into client components.

// ---------------------------------------------------------------------------
// Reserved slugs (doc 09 §1): org slugs must never collide with app routes.
// Build-time list = every top-level route of apps/web/src/app plus platform
// names we want to keep. Runtime guard: the (public)/[orgSlug] layout 404s on
// any of these before touching the DB.
// ---------------------------------------------------------------------------
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // existing top-level app routes
  "admin", "api", "dashboard", "engine", "forgot-password", "join", "legal",
  "login", "onboarding", "orgs", "pricing", "reset-password", "settings",
  "t", "tournaments", "use-cases", "verify-email", "score", "my-matches",
  "competitions", "divisions", "fixtures", "people",
  // metadata / static
  "favicon.ico", "robots.txt", "sitemap.xml", "icons", "images", "_next",
  // future-proofing platform names
  "app", "auth", "blog", "docs", "discover", "help", "signup", "register",
  "status", "support", "terms", "privacy", "www",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

// ---------------------------------------------------------------------------
// ICS calendar feed (doc 09 §2: `.ics` per division/entrant). Hand-rolled —
// the format is 20 lines of RFC 5545, not worth a dependency.
// ---------------------------------------------------------------------------
export interface IcsEvent {
  uid: string;
  start: Date;
  /** minutes; feeds default to 90 when the sport gives no better figure */
  durationMinutes: number;
  summary: string;
  location?: string;
  description?: string;
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// RFC 5545 §3.3.11 TEXT escaping + §3.1 line folding at 75 octets.
function icsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

export function buildIcs(calendarName: string, events: IcsEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//seazn.club//public-dashboard//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(calendarName)}`,
  ];
  for (const ev of events) {
    const end = new Date(ev.start.getTime() + ev.durationMinutes * 60_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}@seazn.club`,
      `DTSTAMP:${icsDate(ev.start)}`,
      `DTSTART:${icsDate(ev.start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsText(ev.summary)}`,
      ...(ev.location ? [`LOCATION:${icsText(ev.location)}`] : []),
      ...(ev.description ? [`DESCRIPTION:${icsText(ev.description)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// JSON-LD (SportsEvent on fixture pages — doc 09 §3). Serialised with `<`
// escaped so the payload can never close its own <script> tag.
// ---------------------------------------------------------------------------
export interface SportsEventJsonLd {
  name: string;
  startDate?: string;
  location?: string;
  url: string;
  homeTeam?: string;
  awayTeam?: string;
  eventStatus: "EventScheduled" | "EventCompleted" | "EventCancelled";
}

export function sportsEventJsonLd(input: SportsEventJsonLd): string {
  const payload = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: input.name,
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.location ? { location: { "@type": "Place", name: input.location } } : {}),
    url: input.url,
    ...(input.homeTeam ? { homeTeam: { "@type": "SportsTeam", name: input.homeTeam } } : {}),
    ...(input.awayTeam ? { awayTeam: { "@type": "SportsTeam", name: input.awayTeam } } : {}),
    eventStatus: `https://schema.org/${input.eventStatus}`,
  };
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Standings columns — MetricSpec-driven (doc 09 §2, zero per-sport UI code).
// Structural columns + the module's display metrics + cascade-derived columns.
// A metric column is hidden when no row carries the key (e.g. a Buchholz
// column before the first Swiss ranking ran).
// ---------------------------------------------------------------------------
export interface MetricSpecLike {
  key: string;
  label: string;
  decimals?: number;
  display?: boolean;
}

export interface StandingsRowLike {
  entrantId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  metrics: Record<string, number>;
  rank?: number;
  tieBreak?: { key: string; with: string[] };
}

export interface StandingsColumn {
  key: string; // 'played' | 'won' | … | metric key | derived cascade key
  label: string;
  kind: "structural" | "metric" | "derived";
  decimals?: number;
}

export function standingsColumns(
  metricSpecs: readonly MetricSpecLike[],
  cascade: readonly string[],
  rows: readonly StandingsRowLike[],
  derivedSpecs: readonly { key: string; label: string; decimals: number }[],
): StandingsColumn[] {
  const hasDraws = rows.some((r) => r.drawn > 0);
  const columns: StandingsColumn[] = [
    { key: "played", label: "P", kind: "structural" },
    { key: "won", label: "W", kind: "structural" },
    ...(hasDraws ? [{ key: "drawn", label: "D", kind: "structural" as const }] : []),
    { key: "lost", label: "L", kind: "structural" },
  ];
  for (const spec of metricSpecs) {
    if (spec.display === false) continue;
    if (!rows.some((r) => spec.key in r.metrics)) continue;
    columns.push({
      key: spec.key,
      label: spec.label,
      kind: "metric",
      ...(spec.decimals !== undefined ? { decimals: spec.decimals } : {}),
    });
  }
  columns.push({ key: "points", label: "Pts", kind: "structural" });
  for (const derived of derivedSpecs) {
    if (!cascade.includes(derived.key)) continue;
    columns.push({ key: derived.key, label: derived.label, kind: "derived", decimals: derived.decimals });
  }
  return columns;
}

export function formatMetric(value: number | undefined, decimals?: number): string {
  if (value === undefined) return "—";
  if (decimals !== undefined) return value.toFixed(decimals);
  return `${value}`;
}

// ---------------------------------------------------------------------------
// Set-based per-set breakdown for the public match page. The set-based kernel
// (engine sports/setbased) puts every set's points in ScoreSummary.detail.sets;
// this extracts them render-ready or returns null for non-set-based sports
// (whose detail carries a different shape, or none).
// ---------------------------------------------------------------------------
export interface SetScore {
  home: number;
  away: number;
  closed: boolean;
}

export interface SetBreakdown {
  /** Column label: badminton & table tennis score "Games", volleyball "Sets". */
  unit: string;
  sets: SetScore[];
}

const GAME_UNIT_SPORTS = new Set(["badminton", "tabletennis"]);

/** The kernel headline carries the open set's points — "1 — 0 (14–11)". The
 *  public match page renders those in the per-set scoreboard card instead, so
 *  it strips the suffix to keep the big scoreline sets-only. */
export function stripLiveSetPoints(headline: string): string {
  return headline.replace(/\s*\([^)]*\)\s*$/, "");
}

export function setBreakdown(summary: unknown, sportKey: string): SetBreakdown | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { sets?: unknown }).sets;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const sets: SetScore[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { home, away, closed } = entry as Record<string, unknown>;
    if (typeof home !== "number" || typeof away !== "number") return null;
    sets.push({ home, away, closed: closed === true });
  }
  return { unit: GAME_UNIT_SPORTS.has(sportKey) ? "Game" : "Set", sets };
}

// ---------------------------------------------------------------------------
// Period-kernel breakdowns (v6/00 §5): goals by period, the strength chip
// while suspensions run, the discipline list, and the serving side (tennis).
// All read ScoreSummary.detail and return null when the sport doesn't carry
// that shape — the surfaces stay sport-agnostic.
// ---------------------------------------------------------------------------

export interface PeriodScoreRow {
  phase: string;
  home: number;
  away: number;
}

export function periodBreakdown(summary: unknown): PeriodScoreRow[] | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { periods?: unknown }).periods;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: PeriodScoreRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { phase, home, away } = entry as Record<string, unknown>;
    if (typeof phase !== "string" || typeof home !== "number" || typeof away !== "number") {
      return null;
    }
    rows.push({ phase, home, away });
  }
  return rows;
}

/** "5v4" / "10v11" while a team-short suspension runs, else null. */
export function matchStrength(summary: unknown): string | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const strength = (detail as { strength?: unknown }).strength;
  return typeof strength === "string" && strength !== "" ? strength : null;
}

export interface DisciplineEntry {
  side: "home" | "away";
  person?: string;
  classKey: string;
}

export function disciplineList(summary: unknown): DisciplineEntry[] | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { discipline?: unknown }).discipline;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: DisciplineEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { side, person, classKey } = entry as Record<string, unknown>;
    if ((side !== "home" && side !== "away") || typeof classKey !== "string") return null;
    rows.push({
      side,
      classKey,
      ...(typeof person === "string" ? { person } : {}),
    });
  }
  return rows;
}

/** Which side is serving (nested kernel, rally fidelity) — null otherwise. */
export function servingSide(summary: unknown): "home" | "away" | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const serving = (detail as { serving?: unknown }).serving;
  return serving === "home" || serving === "away" ? serving : null;
}

/** Human label for a discipline class key: "double_minor" → "Double minor". */
export function disciplineLabel(classKey: string): string {
  const label = classKey.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ---------------------------------------------------------------------------
// Row normalization + spectator vocabulary
// ---------------------------------------------------------------------------

/** postgres.js returns timestamptz columns as Date objects, and RSC hands
    them to client components untouched — where string code (localeCompare
    sorts, slicing) crashes. Normalize to ISO string at the query edge. */
export function isoDateTime(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

/** Spectator-language chip over the competition status vocab
    (draft|published|live|completed|archived). */
export type CompetitionChip = "on-now" | "finished" | "upcoming";
export function competitionChip(status: string): CompetitionChip {
  if (status === "live") return "on-now";
  if (status === "completed" || status === "archived") return "finished";
  return "upcoming";
}

/** i18n dictionary key for a competition's status chip label (v5 i18n §4). Pure
 *  (no i18n import) so this module stays client-safe; the server page resolves
 *  it via t(dict, chipLabelKey(status)). */
export function chipLabelKey(
  status: string,
): "chip.onNow" | "chip.finished" | "chip.upcoming" {
  const chip = competitionChip(status);
  return chip === "on-now"
    ? "chip.onNow"
    : chip === "finished"
      ? "chip.finished"
      : "chip.upcoming";
}
