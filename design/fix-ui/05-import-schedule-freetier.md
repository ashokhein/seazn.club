# UX Audit — Import wizard, Schedule board, Registrations, brackets, free-tier spot-check

Continuation pass covering the areas explicitly deferred in `02-console-org.md` /
`03-console-division.md` / `04-account-public-embed.md`: the Import wizard's actual
upload/mapping flow, the schedule board's drag-and-place interaction, the Registrations panel,
and a free-tier (Northside Community Club) spot-check. Account: Riverside Sports Club (pro,
French locale) unless noted. Screenshots in `screenshots/05-*`.

---

### [high] Import wizard — column auto-mapping silently drops 2 of 4 columns, even when their names exactly match known field labels
**What I saw:** Uploaded a 4-column CSV (`Club, Équipe, Joueur, Division`) with two data rows.
The "Correspondance des colonnes" (column mapping) panel only shows mapping controls for **Club**
and **Division** — "Équipe" and "Joueur" are missing entirely from the mapping UI, even though
both appear as valid, exact-match options inside the Club/Division dropdowns themselves
(`option "Équipe"`, `option "Joueur"` are literally present in the same `<select>` elements).
See `screenshots/05-import-preview.png`. The preview footer confirms the drop: "1 clubs · 0
équipes · 0 joueurs · 0 inscrits · 0 places d'effectif" — the team and player data were read from
the file (1 club was created) but never mapped/imported.
**Fix prompt:** The column auto-mapper isn't matching all recognized header names — investigate
whether it's capped to a fixed number of columns, only scans a subset of the header row, or has
an off-by-one/ordering bug. Given "Équipe" and "Joueur" are valid dropdown options (so the field
list itself is correct), this looks like a bug in the header-detection loop, not a missing
translation. Test with the exact CSV headers listed in the page's own instructions ("Club,
Équipe, Joueur, Date de naissance, Numéro, Poste, Capitaine, Division") to reproduce reliably.

### [high] Import wizard — "division does not exist" error for a division that visibly exists, likely a name-vs-slug mismatch
**What I saw:** The CSV's `Division` column contained the exact display name "Football Division
1" — a division that demonstrably exists under Summer League 2026 (see
`03-console-division.md`). The import preview nonetheless reports for every row: `division
'Football Division 1' does not exist — create divisions before importing` tagged
`DIVISION_NOT_FOUND`. The error is keyed `Ligne N (divisionSlug): ...` — the field name
"divisionSlug" strongly suggests the importer is matching against the division's **URL slug**
(`football-division-1`) rather than its human-readable display name, but nothing in the page's
instructions ("Une ligne par joueur... avec des colonnes comme Club, Équipe, Joueur, ..., Division")
tells the user to use a slug instead of the name shown everywhere else in the product.
**Fix prompt:** Either (a) make the Division column matcher accept the division's display name
(case-insensitively, matching what's shown throughout the rest of the console) in addition to
its slug, or (b) if slug-matching is intentional for disambiguation, say so explicitly in the
help text/column instructions ("Division — use the exact division slug, shown in its Settings
tab") so users don't paste in what they see on screen and get a confusing false-negative.

### [medium] Import wizard — validation error message and error-code badge are raw English, unlocalized
**What I saw:** The error line `division 'Football Division 1' does not exist — create
divisions before importing` plus the trailing `DIVISION_NOT_FOUND` badge are both in English,
inside an otherwise fully-French page (heading, column-mapping labels, preview summary line are
all correctly French). The `DIVISION_NOT_FOUND` constant-style badge in particular reads like an
internal error code leaking into end-user UI rather than user-facing copy.
**Fix prompt:** Route the row-validation error messages through the same `ui` message catalog as
the rest of the Import page (consistent with the many other i18n gaps logged across this audit —
see `README.md`'s cross-cutting section). Consider whether the raw `DIVISION_NOT_FOUND`-style
badges should be shown to end users at all, or only the human-readable sentence beside them.

### [OK] Import wizard — safe-to-reimport behavior communicated clearly; club creation preview is clear
The page's own copy ("Réimporter le même fichier est toujours sans risque — les lignes
correspondantes n'ont aucun effet") and the "Riverside — nouveau club Riverside" preview grouping
under "lignes 2, 3" are both clear, well-designed feedback for the parts of the import that did
work. The "Corrigez les erreurs pour valider" button correctly disables until errors clear.

### [medium] Schedule board — page title/breadcrumb and weekday labels are unlocalized
**What I saw:** `/o/[org]/c/[comp]/schedule` (Autumn Cup 2026) breadcrumb reads "... › Autumn Cup
2026 › **Schedule**" in English, while the page's own H1 correctly reads "Calendrier de la
compétition — Autumn Cup 2026" in French. The day-selector tabs also show English weekday
abbreviations: "Fri 10 Jul", "Mon 20 Jul", "Tue 21 Jul", "Wed 22 Jul" instead of French forms
("ven. 10 juil.", etc). See `screenshots/05-schedule-board-desktop.png`. Same systemic i18n gap
pattern as everywhere else in this audit.
**Fix prompt:** Route the breadcrumb segment and the day-tab date formatting through the same
locale-aware formatter used for the H1 and the rest of the page (see the established pattern
referenced in `02-console-org.md`'s i18n findings).

### [OK] Schedule board — select-then-place scheduling interaction works correctly
Selected a fixture ("North Nets vs West Blockers"), then clicked an empty 10:00/Court 3 slot's
"Placer le match sélectionné" button — the fixture moved correctly and the board re-rendered with
it in the new slot, confirmed via `screenshots/05-schedule-move-result.png`. This is a
click-to-select-then-click-to-place model, not raw HTML5 drag-and-drop, but functions correctly
and is arguably more mobile-friendly than a real drag interaction would be.

### [medium] Free-tier (Northside Community Club) — same FAB overlap and i18n patterns reproduce; no free-tier-specific new bugs found
**What I saw:** Spot-checked Northside's org home and a division page. Northside's console
renders in English (not French, unlike Riverside), so the i18n leaks documented elsewhere in this
audit aren't visible on this account (there's no locale mismatch to expose them) — this account
happens to mask that entire bug class, which is itself worth noting as a gap in cross-account
test coverage, not a product bug. The FAB overlap reproduces identically. Free-tier gating (Pro
feature upsell banners, 2-division/16-entrant caps) rendered correctly and consistently with the
patterns already documented as "OK" in `02-console-org.md`'s billing section.
**Fix prompt:** None — flagging only that the free-tier account happens to be English-locale in
this dataset, so it's not a substitute for locale-leak testing; keep using a French-locale
account (Riverside) specifically to catch i18n regressions going forward.

## Not reached this pass
Import wizard's actual "Valider l'import" commit step (didn't want to commit malformed/incorrect
test data given the DIVISION_NOT_FOUND blocker), Registrations "En attente"/waitlist tab
behavior with an actual waitlisted entrant, a populated groups+knockout bracket visualization
(no demo division had enough entrants to generate one — see `03-console-division.md`), and a
systematic full free-tier walkthrough (only spot-checked 2 pages).

## Summary
- Checked: Import wizard (upload + column-mapping + error preview), schedule board (view +
  select-and-place interaction), free-tier spot-check (org home + 1 division)
- Severity counts: 2 high (import column-mapping drop; import division-match name/slug
  mismatch), 3 medium (import error i18n/raw-code leak; schedule board i18n leak; free-tier
  locale-coverage gap note), 2 verified-OK notes
- Top priority: **(1)** the import division-matching bug — likely blocks real organisers from
  bulk-importing entrants into existing divisions via the documented workflow, a core feature
  entirely broken by this, **(2)** the column auto-mapping drop — same severity, same feature,
  compounds the first bug
