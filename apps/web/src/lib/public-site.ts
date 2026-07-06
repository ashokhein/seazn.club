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
