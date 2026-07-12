# v6/01 — Official rules digest (normative source for module numbers)

Digested 2026-07-12 from the governing bodies' current documents. Every scoring constant
in the v6 modules traces to a row here. Keep this file updated when rulebooks revise.

Sources:
- **ITF Rules of Tennis 2026** (itftennis.com, `2026-rules-of-tennis-english.pdf`) — Rules
  5–7, Appendix VI (alternative scoring), Appendix VII (court officials).
- **IIHF Official Rule Book 2025/26** (blob.iihf.com, `2025-26_iihf_rulebook_30062025-v1.pdf`)
  — Rules 16–28 (penalties), 77 (game timing), 84 (overtime/shootout).
- **IIHF 2026 World Championship Event Code** (`2026_iihf_event_code_-_iihf_world_championship_1.pdf`)
  — §219 allocation of points, §220 tie-breaking.
- **FIH Rules of Hockey, effective 1 March 2026** (fih.hockey, `fih-Rules-of-hockey-2026-final.pdf`)
  — Rule 5 (match & result), personal penalties; **FIH General Tournament Regulations
  (Jan 2025), Appendix 12** — shoot-out competition.

## §1 Tennis (ITF)

**Game (Rule 5a):** points called Love/15/30/40; at 40–40 "Deuce"; then "Advantage";
two consecutive points after deuce win the game.
**No-Ad (App VI):** at deuce a single deciding point; **receiver chooses service side**
(doubles: receiving team may not change positions).
**Tie-break game (Rule 5b):** numeric scoring; first to **7, win by 2**, open-ended.
Serve rotation: 1 point by the due server, then alternating **2 points each**; ends change
every 6 points; the player who served first in the TB **receives** first next set.
**Set (Rule 6):** "Advantage Set" first to 6 games win-by-2 open-ended; "Tie-break Set"
first to 6 win-by-2 with tie-break game at **6–6**. Must be announced in advance,
including the final-set method.
**Match (Rule 7):** best of 3 or best of 5 sets.
**Alternative scoring (App VI):** Short sets — to 4 games, TB at 4–4 (or 3–3 at
sanctioning body's discretion); Short-set tie-break to **5** (deciding point at 4–4);
**Match tie-break 7 or 10** — played at one set all (or 2–2 in bo5) **replacing the
deciding set**, first to 7/10 win by 2; original service order continues, doubles may
reorder within team.
**Officials (App VII):** referee = final authority on tennis law; chair umpire = final
authority on questions of fact; line/net umpires call their line, chair may overrule a
clear mistake; unsighted call → point replayed.
**Standings conventions:** no draws; typical league scoring is per-match points with
`set_ratio`/game ratio tiebreaks (existing comparator registry covers set/point ratios).

## §2 Ice hockey (IIHF)

**Game (Rule 77):** **3 × 20-minute periods** of actual (stop-clock) play, intermissions
between periods.
**Overtime (Rule 84.1/84.3):** round-robin/preliminary — tie after 60' → **sudden-death
OT, max 5 minutes, 3 skaters + goalkeeper per side**, first goal wins; teams may pull the
goalie for an extra attacker (84.2); carried-over penalties adjust to 4-on-3 / 3-on-3
equivalents at next stoppage. (Playoff/medal rounds use longer OT — 10'/20' — per event
regulations; keep OT length + skater count config.)
**Shootout (Rule 84.4, "GWS"):** if OT scoreless — **5 shooters per team, alternating**;
shooters need not be pre-named; players with uncompleted penalties ineligible; if tied
after 5, **sudden-death pairs** (any eligible player, may repeat) until decided.
**Penalties (Rules 16–28):** minor **2'**, bench minor **2'**, double-minor **4'**,
major **5'**, misconduct **10'** (player off, team NOT short-handed), game misconduct
(off for game, 20' recorded), match penalty (off, 25' recorded, team short 5'), penalty
shot (Rule 24), awarded goal (Rule 25). Short-handed goal does not end a major; minor
ends on PP goal (delayed-penalty and coincidental rules 15/19 exist — module records
events, does not adjudicate edge law).
**Standings (Event Code §219):** **3** regulation win · **2** OT/GWS win · **1** OT/GWS
loss · **0** regulation loss (wire format: 1 point each at 60' tie + 1 extra to the
OT/GWS winner).
**Tie-break (§220):** H2H sub-group points → H2H goal difference → H2H goals for →
result vs closest best-ranked outside team → (sportive criteria/seeding). Maps directly
onto existing `h2h_points/h2h_diff/h2h_for` → `diff` → `for` → `seed` comparators.
**Officials:** 4-official system — 2 referees + 2 linesmen (3-official variant: 1+2);
off-ice crew (game timekeeper, penalty bench, scorekeeper).
**Recording conventions:** goals carry scorer + up to 2 assists; PIM per player/team.

## §3 Field hockey (FIH — key `hockey`)

**Match (Rule 5.1):** **4 × 15-minute quarters**; 2' intervals after Q1 and Q3, **10'
half-time** after Q2 (2026 change: half-time fixed at 10'). Other durations may be agreed
— keep configurable.
**Result (Rule 5.2):** most goals wins; **equal goals (incl. 0–0) = draw** — draws are a
first-class league result. Goals arise from field goals, **penalty corners**, **penalty
strokes** (record goal type for stats; corner/stroke procedure is not folded).
**Shoot-out (Tournament Regs App 12, only when regulations require a winner):**
**5 players per team**, one-on-one vs goalkeeper from the **23 m line, 8 seconds** per
attempt, alternating; tied after 5 → **sudden death** (same pool, order may change;
non-starting team starts SD).
**Personal penalties (Rule 14):** caution → **green card = 2' suspension**, **yellow
card = minimum 5' suspension**, **red card = permanent exclusion**; during green/yellow
suspensions **the team plays with one fewer player** (unlike football yellows). Repeat
offence escalation (green → yellow on subsequent offence); throwing equipment above knee
= mandatory yellow, deliberate at person → red. Extra-players-on-field materially
affecting play → **captain receives yellow** (2026 change).
**Officials:** 2 field umpires (diagonal control), plus technical table/reserve umpire at
tournament level.
**Standings conventions:** FIH leagues 3/1/0 (win/draw/loss); shoot-out points variants
exist in some competitions (Pro League: SO bonus point) — keep `shootoutWin/shootoutLoss`
points config like football's.

## §4 Cross-sport pattern summary (what the engine must newly support)

| Need | Tennis | Ice hockey | Field hockey | Exists today? |
|---|---|---|---|---|
| Nested point→game→set fold, deuce/adv, TB games, match TB | ✅ | — | — | ❌ (set-based kernel is flat) |
| N timed periods (3, 4) as phase machine | — | 3 | 4 | ❌ (football literal 2 halves) |
| Sudden-death OT with skater-count semantics | — | ✅ | — | ❌ (football ET = 2 fixed periods) |
| Shootout best-of-5 + sudden death | — | GWS | SO (8 s / 23 m) | ⚠️ football pens only (private) |
| Timed suspensions → team strength + PIM | — | 2/4/5/10/GM/MP | green 2' / yellow ≥5' | ❌ (football cards = off, no timer) |
| OT-aware standings points (3-2-1-0) | — | ✅ | optional SO bonus | ❌ (points map is W/D/L + shootoutWin) |
| Draws as league result | never | only if OT disabled (rec leagues) | ✅ | ✅ (`supportsDraws`) |
| H2H-first tie-break chain | — | ✅ | ✅ | ✅ (comparators exist) |
| Serve/possession indicator in summary | ✅ | — | — | ⚠️ (headline free-form; no serve state) |
