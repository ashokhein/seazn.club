# Jul3/00 — Idea Backlog (organiser feature requests, 3 Jul 2026 intake)

Capture of the full organiser feature-request list so nothing is lost, mapped to where each
cluster is designed. Style mirrors [16-future-features.md](../16-future-features.md): the
**Grabbed** clusters have a Jul3 design doc + PROMPT; **Deferred-to-corpus** clusters already
have a home elsewhere; **Not-yet-designed** are noted for later. Vote counts (×N) and dates
are from the intake.

## Grabbed — designed in this folder (Jul3)

| # | Cluster | Design | Prompt | Headline asks (date, votes) |
|---|---------|--------|--------|------------------------------|
| 1 | Clubs & bulk import | [01](01-clubs-and-bulk-import.md) | PROMPT-21 | single full import teams+players+parent-club+logos (3 Jul); import all players (10 Jan); bulk/reuse logos (25 Nov, 29 May); club→category hierarchy (4 Jun) |
| 2 | Referee/officials assignment | [02](02-referee-officials-assignment.md) | PROMPT-22 | block-stay before break (29 Jun); assign to pool (20 Jun); phased auto-assign (17 Jun ×2); by rank/result (3 Jun ×3); judges+refs (25 Dec ×2); caps (29 May); hide names (25 Jun) |
| 3 | Schedule undo & locking | [03](03-schedule-undo-and-locking.md) | PROMPT-23 | UNDO (16 Jun); lock fixtures 2-site (22 Jun ×2); confirm-clear (18 May); filtered clear (4 Jul ×2); remove teams in pool (2 Jul) |
| 4 | Scheduling constraints v2 + AI | [04](04-scheduling-constraints-v2.md) | PROMPT-24 | cross-category player clash (22 May, 8 Jun, 29 Jun); min break/no back-to-back (4 Jun); start windows (14 Apr, 10 May); bulk shift (10 Jun, 5 Sep ×3, 26 Jun); no-fixed-time (26 Sep ×3, 8 Dec); wait report (16 Sep ×3); AI plan (29 Jun) |
| 5 | Custom points & standings | [05](05-custom-points-and-standings.md) | PROMPT-25 | netball/rugby/one-goal points (26 Jan, 7 Jan, 22 Oct); carry-over (14 Apr, 25 Nov, 16 Sep); manual override (24 Oct, 3 Jun); tie alert (10 Jun); forfeit/no-result (20 Jan, 8 Dec); penalty entry (28 Jun, 12 Jun); circular H2H (3 Sep); fair-play (3 Sep) |
| 6 | Exports & print | [06](06-exports-and-print.md) | PROMPT-26 | pretty timetable (2 Jul ×2); volleyball scoresheet (12 Jun ×3); club colours (10 Jun); roster (13 May); landscape standings (29 May); match report by-pitch (18 Mar ×3, 30 Sep ×5, 20 Oct ×2); results export (7 Jul ×3) |
| 7 | Player stats | [07](07-player-stats.md) | PROMPT-27 | goals+assists auto (16 Apr, 29 Dec ×2, 10 Feb ×2); top scorers (9 Jun); MVP/MOTM (7 Jul ×2, 7 Jan); per-division (7 Jan); scorer-picker numbers (9 Sep ×4, 11 Jun, 10 Jul, 19 May); sortable (27 Nov ×2) |
| 8 | Format extensions | [08](08-format-extensions.md) | PROMPT-28 | Americano/Mexicano (21 May); custom/non-2^n brackets (7 Jan); CL→EL drop (4 Jul, 8 Apr); independent pools (16 Jun ×3, 10 May); auto-advance + early fill (16 Sep ×2/×4, 12 Aug); >2 encounters (7 Aug ×2); Hammes (20 Jan); ladder (7 Nov, 8 Dec) |
| 9 | New sports & generic scoring | [09](09-new-sports-and-generic-scoring.md) | PROMPT-29 | Tchoukball/golf/race/Raketlon/Ludosport/darts/baseball/netball; floats+minus (1 Oct, 15 Mar); rename PLD/W/D/L (11 Oct ×3, 29 Jul); multi-event ranking (17 Mar, 16 Mar); corner count (4 Apr) |

## Deferred-to-corpus — already have a home

| Cluster | Where | Asks |
|---------|-------|------|
| Registration, fees, waitlist, capacity, moderation, self-roster | doc 16 §1.1 / PROMPT-20a | pay online (18 Aug), waitlist (11 Mar ×2, 2 Jun), moderate registrations (14 Jan ×3), self-fill roster (27 May ×6, 6 Jan), max players/squad (28 Jan, 11 Oct, 15 Feb), registration open date (28 May) |
| Offline scoring PWA + match timer + live/per-field results | doc 16 §1.2 / PROMPT-20b, doc 13 | offline venue wifi; match timer (13 May, 16 Feb); per-field live results admin (15 Mar ×2, 4 Jun, 13 May); manual mark-live (29 May) |
| Player accounts, QR check-in, favourites, availability | doc 16 §1.3 / PROMPT-20c | claim/QR (10 Mar); favourites across divisions (8 Jun); check-in/attendance (2 Jun); availability |
| Comms hub, announcements, push, email-all | doc 16 Tier 2–3 (Inngest-blocked) | broadcast banner/alert (29 Jun ×3); push emergency (8 Jun ×3); pop-up news (29 May); email participants (1 Jul ×3); notification templates + reply-to (29 May) |
| Public dashboard, presentation, active-game slide, live-ticker | doc 09, doc 12 | active-game slide w/ timer+logos (9 Jun ×1/×2); hide completed (29 May); match duration (29 May); field-count layout (29 May); QR to app (10 Mar); live-ticker (17 Jul); field filter (2 Jun ×4) |
| Branding, sponsors, custom pages, contact button, white-label | doc 09 branding / doc 16 Tier 3 | bg colour/gradient/overlay (22 May); sponsor logos all pages (23 May); sponsor area (2 Jul); extra pages/regulations (1 Jul); contact button (22 May ×2); white-label fonts (5 Feb); confirmation-email branding (2 Aug) |
| Discovery / embeds / widgets | doc 15, doc 16 Tier 2 | embed standings/brackets (16 Sep ×3); embeddable widgets |
| API / third-party / ChatGPT-Claude integration | doc 08 §2 (API keys) | own-webapp via API (9 Jun, 20 May); connect ChatGPT/Claude (7 Apr); Google Sheets |
| Score granularity (set 3–1 only, tennis 6–4 6–4, tiebreak) | doc 14 | enter overall set score (23 Apr); tennis real scores (2 Jun, 25 Jun); 0.5/minus scores (15 Mar) — engine side in Jul3/09 |
| Disciplinary (cards→suspension) | doc 16 Tier 3 | card accumulation rules |

## Not-yet-designed — noted, low urgency or app-layer

- **i18n & custom labels** — Portuguese/Brazilian (many, high freq), Czech/Slovak/Italian/
  Catalan/Swedish/Arabic/Croatian/Slovenian; fully-editable/custom language (16 Dec ×2);
  gender-neutral German (8 Jul ×2); rename buttons/own text (5 May). App-layer i18n +
  per-org label overrides; high volume, low complexity. **Candidate: its own app-side prompt.**
- **Org ops** — copy/duplicate tournament (21 May, 16 Jun ×4, 13 Apr), archive (20 May),
  group yearly editions (4 Jun), org-level defaults for sign-up/sponsors (23 May), duplicate
  presentation/dia (17 May, 30 Sep, 8 Jan), copy format across age groups (3 Jun, 7 Jan).
  Mostly CRUD/duplication utilities over the greenfield model. **Candidate: an "org ops" prompt.**
- **Scoped permissions** — separate manage-referees vs manage-participants (18 June); admin
  invite of non-account users (29 May, 10 Mar). Extends doc 13 roles. **Candidate: doc 13 delta.**
- **Flags/countries** — Basque Country (15 Apr), Jersey (27 Mar), Switzerland (17 Sep),
  Europe (27 Jan). Trivial data additions.
- **Kinball 3-team fixture** (2 Feb) & **golf per-hole/handicap** (7 Aug) — break core
  assumptions (2-sided fixture / per-hole ledger); flagged in Jul3/09 §3, §5 as their own
  future design+prompt.
- **Barcodes/QR on match tickets** (27 May), **corner/fairplay deciders** (4 Apr, 3 Sep —
  partly Jul3/05), **meal/volunteer/shift management** (13 May, 29 May Idea 1), **certificates
  & awards sheet** (7 Apr ×1, doc 16 Tier 3), **live video draw** (13 Aug ×2), **AI match
  reports** (doc 16 Tier 4).

## Notes
- Vote/date data is indicative (from the 3 Jul intake dump), useful for prioritisation not
  as a contract.
- Ordering of the Grabbed set for build: 2 (referees), 3 (undo), 5 (points) are the highest
  pure-engine leverage; 1 (clubs/import) is the headline intake ask; 4/6/7 follow.
