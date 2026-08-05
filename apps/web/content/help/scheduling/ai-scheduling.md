---
title: AI Schedule
description: Describe your timetable in plain language and let AI Schedule plan, refine and repair it — one division or several at once. The engine checks every proposal, and nothing is written until you apply.
order: 5
---

**AI Schedule** turns a plain-language instruction — "finish by 6pm, nobody plays twice in a row, finals on Court 1" — into a full timetable. Open it from the schedule board's **AI schedule** button. It is **propose-only**: the model suggests times and courts, the deterministic engine verifier checks the proposal, and **nothing changes until you apply it**.

## The two phases

Scheduling runs in two passes, and you can stop after the first:

1. **Schedule** — the architect places every movable fixture on a court and time. This phase runs on **every plan** (within the credits and rate limit below).
2. **Officials** — once you're happy with the times, the architect can staff the matches, assigning referees and other officials around their roles, blackout dates and other bookings. Like the schedule pass, it runs on **every plan** too — see [AI Officials](/help/scheduling/ai-officials).

You can apply the schedule on its own, or apply both together.

## What the AI sees

The architect only ever sees this division's own scheduling picture, assembled into one deterministic brief:

- the fixtures it may move, plus any pinned ones it must leave alone;
- entrants, and players shared across entrants — as links between records, never their names (so it never double-books a person);
- your courts, play hours, blackout windows and existing constraints;
- other divisions' bookings on shared courts — as blocked time only, never their names or rosters;
- for the officials pass: your officials, their roles, per-day limits, blackout dates and "booked elsewhere" times.

It cannot see another organisation's schedule, roster or results — only that a slot is taken.

Your data stays yours: the brief is sent to one of our AI providers — Anthropic (Claude), Google (Gemini) or xAI (Grok), some reached through the OpenRouter gateway — only to produce the proposal, and it is **not used to train AI models**. Requests routed through OpenRouter additionally carry zero-data-retention terms. Nothing beyond this division's scheduling brief ever leaves seazn.club — never your whole account, member emails or billing details. See our [sub-processors list](/legal/sub-processors) for the full set of AI providers.

## What your instruction can ask for

Before the timetable is built, your instruction is read once and turned into **rules the checker enforces** — not just advice the model may or may not follow. If the proposal breaks one, it comes back named in the warnings, and the AI is asked to fix it.

These are the things it can turn into a rule:

- **A limit on matches in a day** — "two matches per day". Counted by calendar day in your organisation's timezone, over all the divisions you selected together — and it counts matches **already** on that day, not only the ones this run is placing.
- **A minimum gap** — "at least 45 minutes between matches". This only ever **raises** the rest you have set in schedule settings; it never lowers it. Ask for 40 minutes when your settings say 90 and you keep 90.
- **A gap before the next round** — "40 minutes before the round it feeds". Measured from the end of a match to the start of the one its winner goes into.
- **A day for a particular match** — "the final on Friday", or a specific date. "The final" means the match nothing advances out of. In a competition with several divisions it means **every** division's final, unless you name one.
- **Earliest and latest starts** — "nothing before 9am", "nothing after 8pm", read as clock times where your organisation sits.
- **A range of dates** — "from tomorrow till Friday". See [the dates a plan covers](#the-dates-a-plan-covers) below.

**Dates are worked out here, never by the AI.** It is told the words you used — "tomorrow", "Friday" — and we resolve them against the real calendar, so a plan cannot be a day out because a model counted wrong.

Two things it deliberately will **not** turn into a rule, because it could not enforce them honestly:

- **A limit aimed at one player or one team** — "nobody plays more than twice a day". The day limit above counts the matches in a day, not the matches one person has, so reading it that way would give you a very different rule from the one you asked for. It comes back to you unread instead.
- **A range of dates for one division only.** A run has a single calendar, so a range meant for one division would quietly shorten every other division's. State the dates for the whole run, or plan that division on its own.

**Anything that cannot become a rule is shown back to you, in your own words.** A preference like "keep the mornings relaxed" is passed to the AI to take into account, and wording nobody can turn into a checkable rule is listed as-is. We never invent a rule you did not ask for, and never present something as enforced when nothing is enforcing it.

## Check what this means

You never have to pay to find out how your sentence was read. The console's first button is **Check what this means**: it reads your instruction and shows you the result, and **no credit is spent**. Only the card it opens can start a run.

The card is a receipt with up to five parts:

- **Read as** — the rules the checker will enforce. A proposal that breaks one comes back named in the warnings and the AI is asked to fix it. This is the part that binds.
- **Passed on, never checked** — the wishes. We hand these to the AI word for word, and then nothing afterwards checks whether it listened. A timetable that ignores one still passes. It is deliberately not called a rule.
- **Couldn't use** — your own words, quoted exactly as you typed them. This became no rule at all. We quote rather than paraphrase, because rewriting something we failed to understand would suggest we understood it.
- **Assumed** — the readings we had to choose. "Friday" means any Friday in the run, and we name which one is next; a date range too tight for a per-day limit is read as running a week longer, and says so.
- **Window** — the dates your instruction claimed, in your organisation's timezone. It is blank when your instruction claimed none, and is never quietly back-filled with the run's default dates.

Then you choose:

- **Run with these rules** starts the run and charges the credits named on the button — the same number the Run cost card above it shows.
- **Back to the brief** spends nothing at all. Nothing is sent, nothing is charged, and your sentence is still in the box to edit.

**What you confirm is what runs.** The run uses the reading you were shown rather than reading your sentence a second time, so the rules cannot change between the card and the timetable. Edit the brief after checking it and the card steps aside: you are asked to check the new sentence rather than having a different set of rules run behind a confirmation you gave for the old one.

Two cases the card says out loud rather than hiding:

- **Nothing in your instruction can be enforced.** The AI still reads your words, but no rule will be checked. Better to know before the run than to wonder afterwards why nothing held.
- **We couldn't read it at all.** You are offered **Send it as written** — the instruction goes to the AI as a plain-language request, the way it worked before, with nothing pretending to be enforced — or you can edit and try again. We never take that fallback for you.

Checking uses no credit, but it is not weightless: each check uses one of your **five scheduling runs an hour** for that division, because it does put your sentence in front of a model.

## The dates a plan covers

Every run is bounded by a **calendar window** — the days the competition is allowed to run. It is taken from the division's **start and end dates** in schedule settings. Set a start but no end and the window runs seven days from your start date; set neither and it falls back to **the next seven days**, beginning today in the organisation's timezone.

The window also stretches to cover anything already on the board, so a repair run never reports the very matches it was asked to keep. Plan several divisions together and they share **one** window, wide enough for all of them — the earliest start and the latest end across everything you selected. No division is ever asked to squeeze inside another's dates.

Where the dates are worked out for you, the window only ever **widens**, never narrows. Before the run it is stretched to cover:

- **play hours you set explicitly**, if any of them fall outside those dates; and
- **fixtures already on the board**, so a match you placed by hand is never treated as out of bounds.

Those dates are a floor, not a cage — you cannot accidentally shrink the window below work you have already done.

**Unless you say otherwise in your instruction.** If you write dates into the instruction — "run everything from tomorrow till Friday" — that range is used exactly as written, instead of the worked-out one. Widening it onto dates you did not ask for would quietly undo the one thing you actually said. If matches then land outside it, you will see them as warnings, which is the point.

A match the proposal puts **outside** the window comes back as a **warning**, listed with the other soft warnings for you to read. It blocks nothing: you can look at it and apply the schedule anyway. Usually it means the end date is earlier than the competition really runs, and the fix is to set the dates rather than to argue with the proposal.

### Divisions with no start date

A division with no start date used to reach the planner as though it sat at the very beginning of the calendar — drafts came back stamped **1 January 1970**, and the model then reasoned outwards from that date.

An undated division now **anchors on the first planning hour of the window's first day**, 08:00 in the organisation's timezone. That anchor only gives the planner somewhere sensible to start counting from; your play hours still decide where matches may actually go.

Any fixture still carrying one of those impossibly old dates now reaches the planner as **not yet placed** rather than as a real date, so it gets scheduled properly instead of being read as already settled.

All of this is resolved in **one zone — your organisation's scheduling timezone**. See [timezones](/help/scheduling/timezones) for what that means when a division sits in a different zone from its organisation.

## Generate, refine, repair

- **Generate** builds a fresh timetable from your instruction.
- **Refine** adjusts the current proposal — "pull the semifinals earlier" — without starting over.
- **Repair** is the scoped fix. When something later breaks the board (a new blackout, a venue clash), the board shows a **"needs repair"** nudge; **Fix with AI** opens the console focused on just the affected slots, so the rest of the timetable stays put.

Every proposal is checked by the same engine that powers the drag-and-drop board. Blocking clashes (a double-booked court, a final before its feeder finishes) are repaired automatically for up to two rounds; anything left over is shown to you rather than hidden. Rest gaps, session windows and soft warnings are surfaced, never silently ignored.

### Matches whose players aren't decided yet

In a knockout, a later match carries no names until the rounds before it are played. A semi-final slot says "winner of match 3", and the final says nothing at all. A rule like "nobody plays two matches at once" had nothing to hold on to in those slots — so an undecided match could be put on at the same moment as a match one of its possible players was already in, which is exactly where a clash hurts most.

Undecided slots are now checked against **everyone who could still reach them**. The engine follows the bracket backwards through the matches that feed the slot and treats every player who could still arrive there as if they were already in it. Two things are left out of that walk: **byes**, which are not matches anyone plays, and **rounds that are already finished**, where the result is known and the players who went out cannot turn up again.

Because the list is everyone who *could* reach the slot rather than who will, the check is deliberately cautious. It can hold two undecided matches apart that, once the results are in, would have had nobody in common — costing you one more gap in the day. That is the trade we chose: an extra gap is an inconvenience, one player sent to two courts at the same time is a match that cannot be played.

### Two people with the same name

If the same name appears on two player records — the same person entered twice, or registered once by a club and once by themselves — the scheduler treats them as **one player** and keeps their matches apart. Nothing is merged: the two records stay separate on your rosters, results and reports, and nothing is written to them. The assumption lives only inside the run, for as long as it takes to lay out the timetable.

So a clash warning may name a player who does not look like they are in that match. That is usually one of these two rules talking — an undecided slot they could still reach, or a second record under the same name — and it is not a bug. The warning is telling you the timetable is unsafe as it stands; if you know the two names really are different people, you can apply the schedule anyway.

## What to review after a run

Under the proposal is a **To review** panel, headed with the number of things in it. That count is the length of the list beneath it and nothing else, so it can never disagree with what you can see. None of these rows block the apply — they are the things worth a look before you write the timetable to the board.

Three kinds of row appear there:

- **Warnings** — the checker flagged a placement but is letting it through: a match outside the window, a rest gap shorter than you asked for, a soft clash. Each names the fixture, and one tap highlights them all on the board.
- **Left out — stays in the tray** — a fixture the run could not place anywhere legal, with the reason and the rule it ran out of. Applying does **not** invent a slot for it: it stays unscheduled in the tray exactly as it was, and you can place it by hand, widen the window or play hours, and run again. A schedule that came back with three fixtures left out puts three matches back in the tray, not on the board.
- **Assumed** — what the AI assumed while it was placing, in its own words.

The **Assumed** rows here are not the ones on the preview card. The card's are ours, worked out before anything ran — how we read "Friday", which week your dates landed in. These are the AI's, about the timetable it just built. They live in different places because they were decided at different times, by different things.

On the competition board the same panel carries a **division chip** on every row, so a warning about one division is never read as a warning about the one next to it.

## What a run costs

AI Schedule needs no upgrade — it runs on **every plan, Community included**. There is no per-division run cap any more: every run is metered by your organisation's shared **AI credit wallet** instead. Generate, refine and repair are all metered the same way, and so is the officials pass.

Before anything is spent, the console shows a **Run cost** card: how big the job is (fixtures, courts, an estimated token count) and how many credits it will charge. Nothing is taken until you press the button.

### Credits buy a thinking budget, not usage

A credit does not buy "a run". It buys the model a **budget of thinking tokens** for that run:

| Credits | Thinking budget for the whole run |
| --- | --- |
| 1 | up to 32K tokens |
| 2 | up to 64K tokens |
| 3 | up to 128K tokens |

The price is fixed the moment you confirm. A run that needs less than its budget is not partly refunded, and a run that reaches the ceiling stops there rather than quietly costing more. A run that fails outright — no usable timetable at all — is **not charged**: the hold on your wallet is released and the run history shows the credits coming straight back.

### Choosing how many credits to spend

The card pre-selects the number the size of the job suggests — a short league lands on 1, a multi-day tournament across many courts on 3 — and you can move it up or down before confirming.

Moving it **down** is allowed and costs less, but the run then has the smaller budget to work in. That is what the warning "**may stop before a full schedule**" means: the model can reach the ceiling part-way through and hand back a partial or rougher timetable instead of a complete one. You still see whatever it produced, checked by the engine exactly as usual, and you can apply it, discard it, or run again at the higher setting.

Moving it **up** buys more room for an unusually awkward brief. If the card calls the run **very large** even at 3 credits, more budget is not the answer — split the division and schedule it in parts.

The officials pass has its own sizing (its briefs are lighter, so it almost always lands on 1), and its no-instruction default spread makes no model call at all and is charged a flat 1 credit. See [AI Officials](/help/scheduling/ai-officials).

See [AI credits](/help/billing/credits) for the monthly grant, buying packs, and how a billing group shares one wallet.

Separately, every plan has a burst brake of **5 AI runs an hour per division** for scheduling, and its own **5 an hour** for officials — independent counters, so a busy hour staffing matches doesn't use up your scheduling budget or the other way round.

## Scheduling several divisions together

The competition's own schedule board (**Competition → Schedule**) can plan **several divisions at once**, so divisions sharing a venue are fitted around each other in a single pass instead of being scheduled one at a time and patched up afterwards. The multi-division board is a **Pro** feature.

Pick the divisions in the console, write one instruction covering all of them, and review the proposal division by division. Applying writes every division together — **all of them or none**.

Undo works the other way round. Each division gets its own **before-AI** save point, and undo restores them one at a time rather than in a single step, so a restore that fails doesn't stop the rest going back. If any division is left on the AI schedule, the console names it and offers to try just those again — and the save points stay valid, so you can also restore any of them from its own schedule page later. Only the newest three before-AI points are kept, so you can still step back past the most recent one.

**Shared courts are matched by name, and by nothing else.** There is no venue-wide court list behind the scenes: a court is the label you typed into each division's schedule settings. So "Court 1" in one division and "Court A" in another are **two different courts** as far as the run is concerned, and it will happily put a match on each at the same time. If the divisions you picked don't use the same names, the console warns you before the run — the fix is to make the names match in each division's schedule settings.

**Somebody playing in two divisions gets the longer rest of the two.** If one division allows 20 minutes between matches and the other insists on 120, a player entered in both is given 120 either way round. A person's recovery does not depend on which draw the match happens to belong to.

Two more limits worth knowing:

- A joint run needs **at least two divisions**. To schedule one on its own, open its own schedule page.
- The whole run is capped at **500 fixtures to place**, the same ceiling a single division has. Over that, run the divisions in smaller groups.

A division with nothing left to place is skipped rather than charged for, and a frozen division can't be picked at all.

### What a joint run costs

Each selected division is sized on its own, exactly as it would be alone, and then the run gets a **batch discount of one credit**:

> **credits charged = (the divisions' credits added up) − 1**, never less than 1.

Three divisions sized 1, 2 and 3 add up to 6 and are charged **5 credits**. The receipt lists each line, the discount and the total before anything is spent, and every line has its own credits picker with the same meaning as above.

One thing that surprises people: the **thinking budget is sized from the undiscounted total**, not from what you pay. Those three divisions get the budget 6 credits buys while being charged 5 — the batch discount lowers the price, never the capability, so scheduling divisions together is never a worse deal than scheduling them one at a time.

## Clashes are repaired before you see them

When a plan comes back with a clash — two matches on one court, a player with no
rest between games, a semi-final before the quarter-final that feeds it — the
schedule is repaired automatically before it reaches you, and it is repaired by
**moving as few fixtures as possible**.

That last part is the point. A schedule you have already read is a schedule you
have started to rely on: the two courts you told the caretaker about, the slot
the visiting side booked travel around. A repair that shuffles forty fixtures to
fix one clash is technically correct and practically useless. So the repair looks
for the smallest set of moves that resolves every conflict, and when it can prove
no smaller set exists, it says so.

Everything you pinned stays pinned. A pinned fixture is never moved to make room
for another one.

**This costs no credits.** It runs before the model is asked to try again, and
when it succeeds the model is not asked at all — which is usually faster as well
as cheaper.

### When some conflicts are left over

Sometimes the repair cannot resolve everything. A day with more matches than the
courts and hours can hold has no valid arrangement, and no amount of moving
fixtures will invent one. Sometimes a single knot of interlocking fixtures is
simply too large to solve quickly, and waiting longer would be worse than asking
the model.

In those cases the panel tells you how many fixtures were sorted out and how many
were handed back to the AI, and the run continues as it always did. You are never
left with a schedule that quietly still has clashes in it: whatever the repair
produces is checked against every rule before it is shown to you, and anything
still unresolved is named.

## Applying and undo

Applying writes the times (and, if you included them, the officials) to the board and marks those fixtures as AI-scheduled. It first creates a **before-AI** save point, so **undo** puts everything back exactly as it was. The instruction you typed is kept with the applied schedule, so you can always see what you asked for.

Related: [the schedule board](/help/scheduling/board), [scheduling constraints](/help/scheduling/constraints), [undo and save points](/help/scheduling/undo), [AI Officials](/help/scheduling/ai-officials).
