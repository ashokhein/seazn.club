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
  "formats.picker": {
    title: "Choosing a format",
    body: "League plays everyone once and ranks by points. Knockout eliminates losers. Groups + knockout qualifies the top of each group. Swiss pairs equals with equals — good for big fields on short time.",
    helpSlug: "formats/overview",
  },
  "billing.downgrade-freeze": {
    title: "What downgrading freezes",
    body: "Nothing is deleted. Anything over the Community limits becomes read-only until you upgrade again or archive something.",
    helpSlug: "billing/downgrade",
  },
  "billing.event-pass": {
    title: "What an Event Pass covers",
    body: "A pass upgrades one competition for its lifetime — every division inside it gets Pro features. It doesn't carry to next season's edition.",
    helpSlug: "billing/event-pass",
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
  "api.key-scopes": {
    title: "Key scopes",
    body: "Read keys can only fetch data. Write keys can change it — treat them like passwords and revoke any key you no longer use.",
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
} as const satisfies Record<string, TipEntry>;

export type TipId = keyof typeof TIPS;
