// Tips registry (v3/03 §4): every contextual tip in one reviewable file —
// id → {title, body, helpSlug}. Components render <Tip id="…"/>; copy never
// lives inline. helpSlug deep-links into /help once PROMPT-35 ships it;
// until then lib/help.ts resolves nothing and the link doesn't render.

export interface TipEntry {
  title: string;
  body: string;
  /** /help article slug — rendered as "Learn more →" only when it resolves. */
  helpSlug?: string;
}

export const TIPS = {
  "division.visibility": {
    title: "Who can see a division",
    body: "A division follows its competition: Private is team-only, Link only means anyone with the link, Public is findable on Google and our discover page.",
    helpSlug: "sharing/visibility",
  },
  "division.start-locks": {
    title: "Starting locks the setup",
    body: "Once scoring starts, entrants and format are locked so results stay fair. Finish seeding and structure first.",
    helpSlug: "divisions/lifecycle",
  },
  "scoring.seq-conflict": {
    title: "Someone else scored first",
    body: "Two scorers updated the same match at once. The app refreshed to the latest score — re-enter your point if it's still missing.",
    helpSlug: "scoring/conflicts",
  },
  "entrants.kinds": {
    title: "Teams, individuals and pairs",
    body: "A division registers one kind of entrant: whole teams, individual players, or fixed pairs (doubles). Pick the kind that matches who plays a fixture.",
    helpSlug: "entrants/kinds",
  },
  "persons.merge": {
    title: "Merging duplicate players",
    body: "Same person listed twice? Merge moves their team memberships, lineups and profiles onto the player you keep, then removes the duplicate. Results are untouched — but a merge can't be undone.",
    helpSlug: "entrants/duplicate-players",
  },
  "persons.public-cards": {
    title: "What makes a profile public",
    body: "Two separate locks, and a public player card needs both. The player's own consent — no plan overrides it, and switching it off takes the card down again — and your plan: public cards need Pro, Pro Plus, or an Event Pass on that competition. Name and photo are consented separately.",
    helpSlug: "players/player-stats-and-photo",
  },
  "persons.actions": {
    title: "Player actions",
    body: "Invite to claim emails the player a link to run their own profile — matches, RSVPs, consent. Unlink disconnects a claimed account; rosters and results stay. Merge… folds a duplicate into the player you keep.",
    helpSlug: "players/invite-to-claim",
  },
  "formats.picker": {
    title: "Choosing a format",
    body: "League plays everyone once and ranks by points. Knockout eliminates losers. Groups + knockout qualifies the top of each group. Swiss pairs equals with equals — good for big fields on short time.",
    helpSlug: "formats/overview",
  },
  "billing.downgrade-freeze": {
    title: "What downgrading freezes",
    body: "Nothing is deleted. Anything over the Community limits becomes read-only until you upgrade again or archive something. Your logo and your card entry fees keep working — only the platform fee goes back to 8% — while Pro extras like your brand colour, branded exports and API keys switch off.",
    helpSlug: "billing/downgrade",
  },
  "billing.groups": {
    title: "One subscription, several organisations",
    body: "A subscription can pay for more than one organisation. They share one card and one invoice, but each keeps its own limits, its own Stripe connection and its own payouts.",
    helpSlug: "billing/groups",
  },
  "billing.extra-org": {
    title: "What another organisation costs",
    body: "Each organisation after the first is half your plan's rate. It also moves to your plan's entry-fee cut — 2% on Pro or 1% on Pro Plus, instead of the 8% a free organisation pays.",
    helpSlug: "billing/groups",
  },
  // Held back when the tips landed, because quantity_paid was written by
  // nothing and a chip promising a free slot would have been a lie. It is
  // written now (syncGroupQuantity), and the reconcile sweep keeps it honest.
  "billing.freed-slot": {
    title: "You have a slot you have already paid for",
    body: "When an organisation leaves, we do not lower the bill mid-period — the slot stays yours until the subscription renews. Adding another organisation into it costs nothing until then.",
    helpSlug: "billing/groups",
  },
  "billing.billed-by": {
    title: "Why the plan is managed elsewhere",
    body: "This organisation is covered by someone else's subscription. The card and the invoices sit with whoever pays, because one subscription can cover several organisations.",
    helpSlug: "billing/groups",
  },
  "billing.event-pass": {
    title: "What an Event Pass covers",
    body: "For this competition only: 64 entrants per division, 10 divisions, branded exports, public player cards, sponsor packages, the realtime scoreboard and a 5% platform fee instead of 8%. It is not Pro — your brand colour, player stats, officials, discipline, embeds and API access all stay Pro. A passed competition stops counting against your active-competition limit; the pass doesn't carry to next season's edition.",
    helpSlug: "billing/event-pass",
  },
  "registration.platform-fee": {
    title: "The platform fee",
    body: "Charging entry fees is free on every plan, Community included. What your plan sets is the fee we keep on card payments: 8% on Community, 5% on a competition with an Event Pass, 2% on Pro, 1% on Pro Plus. Stripe's own processing fee is separate.",
    helpSlug: "registration/card-payments",
  },
  "registration.ref-number": {
    title: "Reference numbers",
    body: "Every registration gets a short reference like R-7F3K. Players use it to find, pay for or withdraw their entry — no account needed.",
    helpSlug: "registration/reference-numbers",
  },
  "schedule.locking": {
    title: "Pinned slots",
    body: "Pin a match (📌 → 🔒) and the auto passes — Auto-schedule, Re-flow remaining, Clear slots — leave it exactly where it is. You can still drag or move a pinned match yourself, and it stays pinned at its new slot. To stop ALL edits, freeze the whole schedule from the History panel instead.",
    helpSlug: "scheduling/locks",
  },
  "schedule.undo-watermark": {
    title: "Undo and save points",
    body: "Every schedule change is undoable, and a save point marks a known-good timetable you can restore. Match results are never touched by either.",
    helpSlug: "scheduling/undo",
  },
  "settings.brand-colour": {
    title: "Logo free, colour Pro",
    body: "Your organisation logo is free on every plan and sits on your public pages, exports and share images. The brand colour that themes those pages is a Pro feature — and an Event Pass doesn't include it, so a passed competition still carries your logo, not your palette.",
    helpSlug: "billing/plans",
  },
  "api.key-scopes": {
    title: "Key scopes",
    body: "Read keys only fetch data. Score keys can also push live scores. Manage keys can change anything — treat them like passwords and revoke any key you no longer use.",
    helpSlug: "api/keys",
  },
  "slideshow.url": {
    title: "The slideshow URL",
    body: "Open it on any TV or projector browser — it cycles standings and matchups by itself and keeps itself up to date.",
    helpSlug: "sharing/slideshow",
  },
  "register.youth": {
    title: "Why guardian consent?",
    body: "This division is for under-18 players, so a parent or guardian confirms the entry. Public pages show shortened names for youth divisions.",
    helpSlug: "registration/youth",
  },
  "board.filter": {
    title: "Filter by division",
    body: "These chips are the divisions on this board. Tap any of them to show just those divisions; tap again to bring one back. The filter lives in the page URL, so you can share or bookmark a filtered view.",
    helpSlug: "scheduling/board",
  },
  "schedule.save-points": {
    title: "Save points",
    body: "A save point bookmarks the timetable exactly as it is now — every kick-off time and court. Restore rewinds the schedule to that bookmark by undoing each change since, one by one. Match results are never touched: if rewinding would erase a played result, the restore stops there. One save point is free, Pro includes five, Pro Plus is unlimited.",
    helpSlug: "scheduling/undo",
  },
  "schedule.field-fairness": {
    title: "Field fairness",
    body: "A tie-break, not a rule. When two courts are free at the same moment, this decides which one an entrant gets: Balance courts favours the court they have used least, Rotate every game avoids the one they just played on. Kick-off times always win — no match is ever delayed to even out courts.",
    helpSlug: "scheduling/constraints",
  },
} as const satisfies Record<string, TipEntry>;

export type TipId = keyof typeof TIPS;
