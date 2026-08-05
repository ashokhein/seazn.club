---
title: Reviewing possible duplicates
description: The duplicate check finds records that look like the same person, shows you why it thinks so, and merges the pair into one — without deleting anything, and with an undo that puts both records back.
order: 5
---

The same player often ends up in the directory twice — typed in by hand one season, imported from a spreadsheet the next, registered once by a club and once by themselves. **Directory → Players** carries a **Possible duplicates** panel that finds those pairs for you, shows the evidence it used, and merges the two records into one.

The check runs **live, every time you open the page**. Nothing is stored, nothing is queued, and a pair you fix elsewhere is simply gone from the list next time you look.

## What gets suggested, and what never does

A **shared name** is the entry ticket: two records whose names match once spacing and capitals are ignored. From there, two things raise the **match strength** — the **same date of birth**, and **playing for the same team**. The strongest pairs sit at the top.

Four kinds of pair are left out of the list entirely, rather than shown with a low score:

- **Different dates of birth.** Two records that give different dates are the best evidence in your own data that these are two people who share a name. See [below](#a-differing-date-of-birth) — you can still merge them by hand.
- **Two different accounts.** If each record has been claimed by a different login, that is two humans signing in, and merging is refused outright.
- **A player record and an official record.** Officiating identities are kept separate on purpose; folding them together would destroy officiating history.
- **A record that has already been merged away.** It is not on your roster any more, so it is not offered again.

## What a merge does

Open a pair with **Review**. The dialog puts the two records side by side — **Keep this record** on the left, **Merge this one in** on the right — with name, date of birth, gender, reference and account on both sides so you can see exactly what differs. The older record is proposed as the one to keep; **Swap** turns it round if the newer one is the better record.

Everything attached to the record being merged in moves to the record you keep:

- **Team and entrant memberships** — every squad the duplicate was named in.
- **Fixture lineups** — past team sheets stay intact, now under the kept record.
- **Sport profiles** — position and attribute profiles, per sport.
- **Availability replies** — RSVPs to fixtures.
- **Suspensions and bans** — a ban recorded against either record survives the merge and applies to the kept record. This matters: a merge must never be a way to lose a suspension.
- **The account link** — if only one of the two was claimed by a player, the kept record inherits that link, so the player still signs in to the right profile.

**Season statistics are recalculated, not copied.** Both records' totals are dropped and every affected division is folded again from its match events, so goals and cards recorded under either record end up counted once, on the kept player. Match results and scores are never touched by a merge.

One thing deliberately does **not** move: **the merged-in record's photo**. A photo the player never agreed to show publicly must not become visible through a record whose settings allow photos, so the kept record keeps its own photo, or none.

Merging is a decision with a name on it. The button stays dead until you tick **I have checked both records. They are the same person.**, and the merge is recorded against you in the log.

## Nothing is deleted, and you can undo it

The record you merge in is **not deleted**. It is marked as absorbed and hidden from your rosters, reports and public pages, but the row and everything about it is kept, along with a full snapshot of the state before the merge.

That is what makes **undo** real. Under the panel, **Recent merges** lists what has been merged, most recent first, and **Undo** on any entry puts both records back: the absorbed record returns as its own record, and the kept record goes back to the visibility settings it had before. There is no time limit — an undo works as well next month as it does thirty seconds later.

Four limits worth knowing before you rely on it:

- **Undo restores what the merge moved, and nothing else.** Anything that happened *after* the merge — a new team the kept player was added to, an edit you made to their name — belongs to the kept record by your own later action and stays there.
- **But an edit to something the merge *did* move is replaced.** If the merge carried a squad number across and you then changed it, undoing puts the number back the way it was before the merge. Undo restores the snapshot for those rows rather than merging your later edit into it.
- **A merge can only be undone once.** Undoing a second time is refused; the entry stays in the log as a record of what happened, marked **Undone**, and the pair goes back to being a live duplicate suggestion you can merge again.
- **Merges are undone newest first.** If you merged A into B and later merged B into C, the second merge has to be undone before the first — the first one's Undo is refused until then, and tells you so. Undoing them out of order would put back a record that a later merge has since folded away again.

## What happens to public visibility

Each record carries its own settings for what is shown publicly — the player's name, their photo. When two records are merged those settings are combined, and **the stricter setting wins**:

> If either record hid something, the merged record hides it.

Both records showed the name and the merged record shows it. One of them hid the name and the merged record hides it, even if the record you chose to keep was the one showing it. A merge is a tidy-up of your directory, not a moment where someone's privacy quietly widens because two rows became one — so it can only ever narrow what is shown, never open it up.

The dialog shows you this before you commit, under **Public visibility**: each setting, what each record says, and what it will be **after the merge**. If a player later wants their name shown again, that is a change they or you make on the profile afterwards, deliberately.

## A differing date of birth

A pair whose records give **different dates of birth** is never suggested. Two dates is the clearest signal the data has that these are two different people, and a tool that nudged an organiser toward fusing two juniors who share a name would be doing real harm.

It is still a merge you can make by hand, because a mistyped year is a common enough mistake. In the players list, choose **Merge…** on the record you want to fold in, then **Keep this one** on the record to keep. That opens the same **Merge two records** dialog, which says the dates differ and asks for a second, separate tick: **I know the dates of birth differ and want to merge anyway.** That confirmation is only ever yours to give — nothing here will offer it for you.

That same pair of buttons is how you merge any two records you already know about, whether or not the duplicate check suggested them.

## A merge can reveal a clash on a published schedule

Two records could be in two matches at the same time quite legally, because as far as the scheduler was concerned they were two people. Once they are one person, that same timetable has somebody on two courts at once.

So after a merge, every **published** board the kept player appears in is checked again, and anything the checker now objects to is listed under **Published schedules to check**, with the board and the clash named.

**This does not block the merge, and it is not an error.** Refusing the merge would leave the duplicate in place and the schedule just as wrong, with nothing you could do about either. What the panel is telling you is that a timetable you have already published has a problem in it that was invisible until now.

What to do about it:

- Open the board and move one of the two matches. The [schedule board](/help/scheduling/board) shows the clash the same way it shows any other, and **Fix with AI** can repair just the affected slots — see [AI Schedule](/help/scheduling/ai-scheduling).
- A **completed** competition is flagged as such and needs no action; there is nothing left to reschedule, but it is worth knowing the fixture list read that way.
- If the merge itself was the mistake, undo it — the schedule goes back to being clear because the two records are two people again.

Boards still in setup are not checked, on purpose: nobody has seen them yet, and you will run the usual checks before you publish.

## Common questions

**Why do I have duplicates at all?** Usually one import and one manual add with slightly different spellings, or a club entering a player who then registers themselves. Reviewing the panel before a new season starts catches most of them.

**Does merging change any results?** No. Scores, match events and standings are never rewritten. Statistics are recounted from those same events so the totals land on one player instead of two, but the matches themselves are untouched.

**Can I merge more than two records?** Merge them a pair at a time. If a third record for the same person turns up later, merge it into the same kept record — chains are flattened, so the kept record always stays the one live record for that person.

**The pair I want isn't listed.** The names have to match for a pair to be suggested. If they are spelled differently, correct one of the names first and the pair appears on the next load.

Related: [merging a pair you spotted yourself](/help/entrants/duplicate-players), [claiming a player profile](/help/players/claim-your-profile), [inviting players to claim](/help/players/invite-to-claim), [the schedule board](/help/scheduling/board).
