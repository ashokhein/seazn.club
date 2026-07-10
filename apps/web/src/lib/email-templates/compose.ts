// Composes emails from the HTML files in ./html (see html/README.md for the
// token contract — email-html-templates.test.ts pins it). Templates are read
// from disk so the .html files stay the single source of truth; the standalone
// build ships them via outputFileTracingIncludes in next.config.js.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { escapeHtml } from "./shared";

// cwd differs by entrypoint: `next dev/start`/vitest run from apps/web, the
// standalone server and root scripts run from a directory that contains
// apps/web. Resolve once, lazily, so importing this module never throws.
const CANDIDATE_DIRS = [
  path.join(process.cwd(), "src/lib/email-templates/html"),
  path.join(process.cwd(), "apps/web/src/lib/email-templates/html"),
];

let resolvedDir: string | undefined;
const cache = new Map<string, string>();

function tpl(rel: string): string {
  const hit = cache.get(rel);
  if (hit) return hit;
  resolvedDir ??= CANDIDATE_DIRS.find((d) => existsSync(d));
  if (!resolvedDir) {
    throw new Error(
      `email templates dir not found; tried: ${CANDIDATE_DIRS.join(", ")}`,
    );
  }
  const s = readFileSync(path.join(resolvedDir, rel), "utf8");
  cache.set(rel, s);
  return s;
}

function fill(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{{${k}}}`, v),
    template,
  );
}

// ---------------------------------------------------------------------------
// Blocks — inputs are plain text and get escaped here unless the parameter is
// documented as HTML (suffix `Html`).
// ---------------------------------------------------------------------------

/** Body paragraph. Takes HTML so callers can bold names etc. — callers must
 *  escape interpolated user content with escapeHtml. */
export function paragraph(textHtml: string): string {
  return fill(tpl("blocks/paragraph.html"), { TEXT: textHtml });
}

/** Bulletproof CTA button. */
export function button(label: string, url: string): string {
  return fill(tpl("blocks/button.html"), {
    CTA_LABEL: escapeHtml(label),
    CTA_URL: escapeHtml(url),
  });
}

/** Soft violet info panel; body newlines are preserved (pre-line). */
export function panel(title: string, body: string): string {
  return fill(tpl("blocks/panel.html"), {
    PANEL_TITLE: escapeHtml(title),
    PANEL_BODY: escapeHtml(body),
  });
}

/** "Button not working?" plain-URL fallback. */
export function linkFallback(url: string): string {
  return fill(tpl("blocks/link-fallback.html"), { FALLBACK_URL: escapeHtml(url) });
}

export interface StandingsRow {
  rank: number;
  name: string;
  played: number;
  won: number;
  lost: number;
  points: number;
  /** Accent-bar treatment — rank 1 or the recipient's own row. */
  leader?: boolean;
}

export interface StandingsArgs {
  title: string; // e.g. "Division 1"
  meta: string; // e.g. "After week 6"
  nameHeader: string; // "Team" | "Player" | "Pair"
  rows: StandingsRow[];
}

/** Scorebug standings table. */
export function standingsTable(args: StandingsArgs): string {
  const rowHtml = args.rows
    .map((r, i) =>
      r.leader
        ? fill(tpl("blocks/standings-row-leader.html"), {
            RANK: String(r.rank),
            NAME: escapeHtml(r.name),
            PLAYED: String(r.played),
            WON: String(r.won),
            LOST: String(r.lost),
            POINTS: String(r.points),
          })
        : fill(tpl("blocks/standings-row.html"), {
            ROW_BG: i % 2 === 0 ? "#ffffff" : "#faf9fc",
            RANK: String(r.rank),
            NAME: escapeHtml(r.name),
            PLAYED: String(r.played),
            WON: String(r.won),
            LOST: String(r.lost),
            POINTS: String(r.points),
          }),
    )
    .join("");
  return fill(tpl("blocks/standings.html"), {
    STANDINGS_TITLE: escapeHtml(args.title),
    STANDINGS_META: escapeHtml(args.meta),
    NAME_HEADER: escapeHtml(args.nameHeader),
    STANDINGS_ROWS: rowHtml,
  });
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface EmailShell {
  subject: string;
  /** Inbox preview snippet, ~40–90 chars. */
  preheader: string;
  /** Right side of the masthead slab — org name, or omit for platform mail. */
  mastheadTag?: string;
  /** Small label above the title, e.g. "Account" or "Riverside · Division 1". */
  eyebrow: string;
  title: string;
  /** Concatenated blocks (already HTML). */
  contentHtml: string;
  /** Why-you-got-this footer line (plain text, escaped here). */
  footerNote?: string;
}

export function renderEmail(shell: EmailShell): string {
  return fill(tpl("base.html"), {
    SUBJECT: escapeHtml(shell.subject),
    PREHEADER: escapeHtml(shell.preheader),
    MASTHEAD_TAG: escapeHtml(shell.mastheadTag ?? ""),
    EYEBROW: escapeHtml(shell.eyebrow),
    TITLE: escapeHtml(shell.title),
    CONTENT: shell.contentHtml,
    FOOTER_NOTE: escapeHtml(shell.footerNote ?? ""),
    YEAR: String(new Date().getFullYear()),
  });
}
