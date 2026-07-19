// SPEC-2 / PROMPT-82 — auto-draft body templates. PURE functions (no DB, no
// I/O): the decided-seam hook in org-posts.ts extracts the fixture/standings
// data and calls these to build the {title, bodyMd} of a draft post. Post
// CONTENT is org-authored and never machine-translated (SPEC-2 gotcha), so
// these render once in the org's locale AT DRAFT TIME and the strings freeze
// into body_md — hence a small inline locale table here rather than a live UI
// dictionary namespace (that belongs to PROMPT-83's console strings).
import type { Locale } from "@/lib/i18n-constants";

// En dash between the two scores (SPEC-2 title: "Riverside 3–1 Northside").
const DASH = "–";

// BCP-47 tag per app locale for Intl date formatting (venue-tz date line).
const BCP47: Record<Locale, string> = {
  en: "en-GB",
  fr: "fr-FR",
  es: "es-ES",
  nl: "nl-NL",
};

interface LocaleStrings {
  scorers: string;
  results: string;
  standings: string;
  points: string; // short "pts" suffix in the standings block
  roundRecapTitle: (round: number, division: string) => string;
  movesTo: (team: string, position: number) => string;
  tbc: string;
}

const STRINGS: Record<Locale, LocaleStrings> = {
  en: {
    scorers: "Scorers",
    results: "Results",
    standings: "Standings",
    points: "pts",
    roundRecapTitle: (r, d) => `Round ${r} recap: ${d}`,
    movesTo: (team, p) => `${team} moves up to ${ordinalEn(p)}.`,
    tbc: "TBC",
  },
  fr: {
    scorers: "Buteurs",
    results: "Résultats",
    standings: "Classement",
    points: "pts",
    roundRecapTitle: (r, d) => `Résumé de la journée ${r} : ${d}`,
    movesTo: (team, p) => `${team} monte à la ${p}e place.`,
    tbc: "À confirmer",
  },
  es: {
    scorers: "Goleadores",
    results: "Resultados",
    standings: "Clasificación",
    points: "pts",
    roundRecapTitle: (r, d) => `Resumen de la jornada ${r}: ${d}`,
    movesTo: (team, p) => `${team} sube al puesto ${p}.`,
    tbc: "Por confirmar",
  },
  nl: {
    scorers: "Doelpuntenmakers",
    results: "Uitslagen",
    standings: "Stand",
    points: "ptn",
    roundRecapTitle: (r, d) => `Samenvatting ronde ${r}: ${d}`,
    movesTo: (team, p) => `${team} klimt naar plek ${p}.`,
    tbc: "Nog te bevestigen",
  },
};

function ordinalEn(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Venue-zone datetime with the zone labelled (v12 fixtureWhen shape, localized
 *  tag). Returns the locale's "TBC" when unscheduled. Pure/deterministic given
 *  (at, tz) — Node ICU renders the same string on CI. */
export function draftWhen(at: string | null, tz: string | null, locale: Locale): string {
  const s = STRINGS[locale];
  if (!at) return s.tbc;
  const zone = tz ?? "UTC";
  try {
    const formatted = new Date(at).toLocaleString(BCP47[locale], {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${formatted} (${zone})`;
  } catch {
    return `${new Date(at).toISOString()} (UTC)`;
  }
}

export interface ResultDraftInput {
  locale: Locale;
  homeName: string;
  awayName: string;
  /** Per-side summary line (SideSummary.line) — "3", "252/8 (50)", etc. */
  homeScore: string;
  awayScore: string;
  competitionName: string;
  divisionName: string;
  venue?: string | null;
  scheduledAt?: string | null;
  venueTz?: string | null;
  /** Only when the sport has playerStats AND events are attributed (SPEC-2). */
  scorers?: { name: string; count?: number }[];
  /** Only for league-stage fixtures: the winner's post-result position. */
  movement?: { team: string; position: number } | null;
}

/** Result post: title "Home s–s Away", body = competition line, venue+date,
 *  optional scorers list, optional standings-movement line. */
export function resultDraft(input: ResultDraftInput): { title: string; bodyMd: string } {
  const s = STRINGS[input.locale];
  const title = `${input.homeName} ${input.homeScore}${DASH}${input.awayScore} ${input.awayName}`;

  const lines: string[] = [];
  lines.push(`**${input.competitionName}** · ${input.divisionName}`);
  const whenLine = draftWhen(input.scheduledAt ?? null, input.venueTz ?? null, input.locale);
  lines.push(input.venue ? `${input.venue} · ${whenLine}` : whenLine);

  if (input.scorers && input.scorers.length > 0) {
    lines.push("");
    lines.push(`**${s.scorers}**`);
    for (const sc of input.scorers) {
      lines.push(`- ${sc.name}${sc.count && sc.count > 1 ? ` (${sc.count})` : ""}`);
    }
  }
  if (input.movement) {
    lines.push("");
    lines.push(s.movesTo(input.movement.team, input.movement.position));
  }
  return { title, bodyMd: lines.join("\n") };
}

export interface RoundRecapDraftInput {
  locale: Locale;
  competitionName: string;
  divisionName: string;
  /** 1-based (v13 lesson). */
  roundNo: number;
  results: { homeName: string; homeScore: string; awayName: string; awayScore: string }[];
  /** Top of the table (caller slices top-N). */
  standings: { position: number; name: string; played: number; points: number }[];
}

/** Round recap post: title "Round N recap: Division", body = results grid +
 *  top-of-standings block. */
export function roundRecapDraft(input: RoundRecapDraftInput): { title: string; bodyMd: string } {
  const s = STRINGS[input.locale];
  const title = s.roundRecapTitle(input.roundNo, input.divisionName);

  const lines: string[] = [];
  lines.push(`**${input.competitionName}** · ${input.divisionName}`);
  lines.push("");
  lines.push(`**${s.results}**`);
  for (const r of input.results) {
    lines.push(`- ${r.homeName} ${r.homeScore}${DASH}${r.awayScore} ${r.awayName}`);
  }
  if (input.standings.length > 0) {
    lines.push("");
    lines.push(`**${s.standings}**`);
    for (const row of input.standings) {
      lines.push(`${row.position}. ${row.name} — ${row.points} ${s.points} (${row.played})`);
    }
  }
  return { title, bodyMd: lines.join("\n") };
}
