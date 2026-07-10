# 16 — Future Feature Roadmap (post-cutover)

Features beyond the v2 core, tiered by value. Tier 1 has enough design here to prompt
from (PROMPT-20); Tiers 2–4 are captured so they aren't lost — expand each into its own
doc+prompt when scheduled. Excluded permanently (doc 01 non-goals): betting/odds,
fantasy, video streaming.

## Tier 1 — revenue & retention movers

### 1.1 Online registration & entry fees
- Public competition page gains **Register** flow: entrant self-registration (team or
  individual) into a division → capacity + waitlist → optional **entry fee**.
- Payments via **Stripe Connect** (org onboards a connected account; platform takes an
  application fee % — second revenue line beyond subscriptions). Refund policy per
  competition (auto-refund on withdrawal before lock date; organiser-discretion after).
- Data: `registrations {division_id, status: pending|paid|confirmed|waitlisted|withdrawn,
  payment_intent_id, answers jsonb}` + per-division `registration_settings` (open/close
  dates, fee, capacity, custom form fields). Registration → entrant on confirm.
- Entitlement: registration free tier = free events only; paid registration (fees) = Pro
  + platform fee. Eligibility rules (doc 06) validate at registration (DOB collected in
  the form with guardian-consent checkbox for minors).
- **As built (PROMPT-20a), normative deltas:** entitlement keys are
  `registration.enabled` (all plans) + `registration.paid` (Pro+, gated at settings
  save so a fee can never be configured below Pro). Status machine adds `pending`
  (holds a spot; free = awaiting organiser approve, paid = awaiting payment). Paid
  registrations confirm + materialise on `checkout.session.completed` (destination
  charge on the org's Connect Express account, platform keeps
  `PLATFORM_FEE_PERCENT`, default 5%); free ones confirm on organiser approve.
  Waitlist auto-promotion moves the oldest to `pending` — a promoted paid registrant
  pays from their token-gated status page (no auto-charge). Refunds: full auto-refund
  (reverse transfer + app-fee return) on withdrawal before `refund_lock_at`; manual
  partial/full via the organiser console after. Everything audited on
  `competition_events` (`registration.*`). Capacity is capped by the plan's
  `entrants.per_division.max` at settings save AND at submit. No emails yet — the
  status-page link returned at submit is the registrant's receipt (comms hub, Tier 3).

### 1.2 Offline-first scoring PWA
- Venue Wi-Fi is the #1 field failure. The event ledger is built for this: scoring pad
  queues events in IndexedDB with client-assigned ids + `expected_seq`; background sync
  replays on reconnect; server idempotency keys (doc 08 §4) make retries safe;
  `SEQ_CONFLICT` triggers fetch-and-rebase (refetch events since local seq, refold,
  re-apply queued events that still validate — surface conflicts to the scorer).
- Service worker: precache scorer console + assigned fixtures' state; installable PWA;
  works fully offline for a whole match, syncs after.
- Design constraint honored throughout v2: **the fold is pure and runs in the browser**
  (`@seazn/engine` is isomorphic) — offline UI shows exactly what the server will compute.

### 1.3 Player accounts
- `persons.user_id` link (already in schema) becomes a flow: org sends claim invite (or
  player scans QR on their public card) → email verify → person linked.
- Claimed players get a **player home**: my schedule (all orgs), my results/stats, my
  teams; availability RSVP per fixture (organiser sees availability grid before picking
  lineups); self check-in via QR at venue.
- Privacy: claiming grants the *player* control of their consent flags (doc 06 §4.7) —
  overrides org-set defaults; guardian-link for minors.

## Tier 2 — engagement (expand when scheduled)

- **Follow + push** — follow team/player/division; PWA push on result/fixture/schedule
  change. Needs notification service + preferences; ties into 1.3.
- **Ratings** — per-sport Elo/Glicko across competitions (chess/TT/badminton first).
  Reserved metric family; ratings feed seeding. Design doc needed (K-factors, decay,
  provisional periods, per-variant pools).
- **Media galleries** — photos per fixture/competition (Supabase Storage + consent
  machinery already designed); moderation queue.
- **Live commentary** — render `core.note` events as a live feed on the public match
  page. Pro. Cheapest Tier-2 item.
- **Embeddable widgets** — script/iframe embeds of standings/live scores for club sites,
  reading public API. Pro; cache-hardened like discovery (doc 15 §4).

## Tier 3 — organiser ops

- **Comms hub** — announcements + fixture reminders + schedule-change alerts to entrants
  (blocked on Inngest, `development/DEFERRED.md`).
- **Certificates & awards** — PDF winner/participation certs from templates; MVP /
  man-of-the-match voting (feeds player cards).
- **Sponsor management** — sponsor slots with links/impressions beyond the doc 09 row.
- **Disciplinary engine** — card accumulation → suspension rules ("2 yellows → miss next
  fixture"), enforced at lineup validation. Natural engine extension; football leagues
  expect it. Needs a small spec in `sports/football.md` when scheduled.
- **Imports** — Challonge / chess-results / spreadsheet importers → v2 domain, lowering
  switching cost.

## Tier 4 — later / wow

- **OBS streaming overlay** — browser-source scoreboard from public fixture state; huge
  for ambitious clubs, cheap off the public API.
- **AI match reports** — prose recap generated from the event ledger per fixture/round
  (the ledger is the perfect structured prompt input); publish to dashboard.
- **Season analytics** — most improved, best economy, streaks; derived read models only.
