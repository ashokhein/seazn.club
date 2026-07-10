# Seazn Club email HTML system

Modern, email-client-safe HTML templates for every mail the platform sends.
One shell (`base.html`) + composable blocks (`blocks/*.html`), all wired with
`{{TOKEN}}` placeholders so the TypeScript builders in `../` can swap content
in with plain string replacement — no JSX/MJML build step, works as-is with
the Resend send path in `lib/email.ts`.

The design carries the public "courtside" identity into the inbox: the
`#231738` court slab masthead with the 3px `#7c3aed` court line, Barlow
Condensed display type (falls back to Arial Narrow where web fonts don't
load), and the scorebug standings table as the signature block.

## Files

| File | Role |
| --- | --- |
| `base.html` | Full document shell: masthead, court line, title, `{{CONTENT}}` slot, footer |
| `blocks/paragraph.html` | Body copy paragraph |
| `blocks/button.html` | Bulletproof CTA (td-bgcolor pattern, renders in Outlook) |
| `blocks/panel.html` | Soft violet info panel (payment instructions, notices) |
| `blocks/link-fallback.html` | "Button not working?" plain-URL fallback |
| `blocks/standings.html` | Scorebug standings table shell (slab header + column labels) |
| `blocks/standings-row.html` | Standard row — alternate `{{ROW_BG}}` `#ffffff` / `#faf9fc` |
| `blocks/standings-row-leader.html` | Rank-1 (or recipient) row: accent bar + soft fill |
| `previews/registration-standings.html` | Fully substituted sample — open in a browser |

## Composition

```ts
const html = base
  .replaceAll("{{SUBJECT}}", subject)
  .replaceAll("{{PREHEADER}}", preheader)
  .replaceAll("{{MASTHEAD_TAG}}", orgName ?? "")
  .replaceAll("{{EYEBROW}}", eyebrow)
  .replaceAll("{{TITLE}}", title)
  .replaceAll("{{CONTENT}}", [paragraph, panel, standings, button, linkFallback].join("\n"))
  .replaceAll("{{FOOTER_NOTE}}", footerNote)
  .replaceAll("{{YEAR}}", String(new Date().getFullYear()));
```

All values substituted into tokens MUST be HTML-escaped first
(`escapeHtml` in `../shared.ts`) unless the token is documented as HTML.

## Token reference

### `base.html`

| Token | Content |
| --- | --- |
| `{{SUBJECT}}` | Text. Mirrors the message subject (used in `<title>`) |
| `{{PREHEADER}}` | Text. Inbox preview snippet, ~40–90 chars; invisible in body |
| `{{MASTHEAD_TAG}}` | Text. Right side of slab — org/competition name, or `""` for platform auth mail |
| `{{EYEBROW}}` | Text. Small label above title, e.g. `Riverside Racquets · Division 1` or `Account` |
| `{{TITLE}}` | Text. Display title, rendered uppercase condensed |
| `{{CONTENT}}` | HTML. Concatenated blocks |
| `{{FOOTER_NOTE}}` | Text/HTML. Why-you-got-this line, e.g. "You received this because you entered Spring Open 2026." |
| `{{YEAR}}` | Text. Copyright year |

### Blocks

| Block | Tokens |
| --- | --- |
| `paragraph.html` | `{{TEXT}}` — HTML allowed (e.g. `<strong>`) |
| `button.html` | `{{CTA_LABEL}}` text, `{{CTA_URL}}` URL |
| `panel.html` | `{{PANEL_TITLE}}` text, `{{PANEL_BODY}}` text (newlines preserved via `white-space:pre-line`) |
| `link-fallback.html` | `{{FALLBACK_URL}}` URL (appears twice) |
| `standings.html` | `{{STANDINGS_TITLE}}` e.g. `Division 1`, `{{STANDINGS_META}}` e.g. `After week 6`, `{{NAME_HEADER}}` `Team`/`Player`/`Pair`, `{{STANDINGS_ROWS}}` HTML rows |
| `standings-row.html` | `{{ROW_BG}}` `#ffffff`/`#faf9fc` alternating, `{{RANK}}`, `{{NAME}}`, `{{PLAYED}}`, `{{WON}}`, `{{LOST}}`, `{{POINTS}}` |
| `standings-row-leader.html` | `{{RANK}}`, `{{NAME}}`, `{{PLAYED}}`, `{{WON}}`, `{{LOST}}`, `{{POINTS}}` |

## Email inventory → block recipe

Every send lives in `lib/email.ts`; builders in `lib/email-templates/*.ts`.

| Email (builder) | Kind | Recipe |
| --- | --- | --- |
| `verification.ts` | transactional | paragraph + button + link-fallback |
| `password-reset.ts` | transactional | paragraph + button + link-fallback |
| `magic-link.ts` | transactional | paragraph + button + link-fallback |
| `email-change-confirm.ts` | transactional | paragraph + button + link-fallback |
| `email-change-notice.ts` | transactional | paragraph only (no CTA) |
| `account-deletion.ts` | transactional | paragraph only (no CTA) |
| `invite.ts` | lifecycle | paragraph + button + link-fallback, `{{MASTHEAD_TAG}}` = org |
| `registration.ts` | lifecycle | paragraph + panel (fee/instructions) + button + link-fallback |
| `payment-reminder.ts` | lifecycle | paragraph + panel + button |
| standings digest (new) | lifecycle | paragraph + standings + button |

## Client-compat notes

- Layout is nested tables + inline styles; no flexbox/grid/margin-on-div.
- Barlow Condensed loads via Google Fonts `<link>` (Apple Mail, some others);
  everyone else gets Arial Narrow → the layout is metric-tolerant to both.
- CTA uses the td-bgcolor button pattern — clickable/painted in Outlook.
- `color-scheme: light` is declared so dark-mode clients keep the courtside
  contrast instead of auto-inverting the slab.
- Preheader div is zero-size + `mso-hide:all`.
- Mobile: `@media` in `<head>` tightens paddings and shrinks the title;
  card goes full-width under 620px. All standings columns stay visible.
