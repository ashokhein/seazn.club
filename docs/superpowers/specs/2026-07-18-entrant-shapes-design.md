# Entrant shapes — per-sport, per-kind entrant forms

**Problem.** `EntrantKind` (`team | individual | pair`) is sport-blind and the
entrants panel renders one team-shaped form for everything: a board-game
individual gets a captain checkbox, a squad-number field, an open member
picker and a "Riverside CC" name placeholder. Nothing tells the UI or the
server what an entrant of this sport/kind should look like.

**Decision (user-approved).** Sport modules declare entrant defaults; the
organiser can override per division. Individual/pair entrants take their name
from the picked people.

## 1. Engine: `entrantModel` on sport modules

```ts
// packages/engine — optional module declaration, alongside positions/playerStats
entrantModel?: {
  kinds: EntrantKind[];          // allowed kinds for this sport
  defaultKind: EntrantKind;
  team?: {
    squadNumbers: boolean;       // show/accept squad numbers
    captain: boolean;            // show/accept the captain flag
    minMembers?: number;         // advisory bounds for team rosters
    maxMembers?: number;
  };
}
```

Declared where obvious: football/cricket/hockey/icehockey → `team`;
boardgame/chess → `individual`; tennis/badminton → `individual, pair`;
padel → `pair`. **Modules without the block keep today's behaviour**
(all kinds, team affordances on `team` kind only).

## 2. Resolution: module default → division override

Division `config` gains an optional `entrants` block (existing untyped
config channel — **no migration**):

```ts
config.entrants?: {
  kinds?: EntrantKind[];
  defaultKind?: EntrantKind;
  squadNumbers?: boolean;
  captain?: boolean;
}
```

One pure resolver in the engine:

```ts
effectiveEntrantModel(module: SportModule | null, divisionConfig: unknown): {
  kinds: EntrantKind[];
  defaultKind: EntrantKind;
  squadNumbers: boolean;   // meaningful for team kind only
  captain: boolean;        // meaningful for team kind only
  capFor(kind: EntrantKind): number;  // individual=1, pair=2, team=maxMembers??∞
}
```

Precedence per field: division override → module entrantModel → legacy
default (`kinds: all three`, `defaultKind: "individual"`, team affordances
on). Kind caps are structural: individual=1, pair=2 — config cannot change
them. UI and server both call the resolver; they cannot disagree.

## 3. Division Settings — "Entrants" block

In the existing division Settings tab: allowed-kind checkboxes, default
kind select, captain + squad-number toggles (visible only while `team` is
allowed), a "sport default" hint when untouched, and Reset to sport
defaults. Saves into `config.entrants` through the existing division PATCH.
Guard: cannot untick a kind that existing non-withdrawn entrants already
use (422 from the server, disabled-with-title in the UI).

## 4. Entrants panel adapts

- **Kind select** lists only allowed kinds; hidden when exactly one.
- **Individual**: no name field — person search picks ONE person; entrant
  `display_name` = person's name. Renaming the person later does NOT rename
  the entrant (display_name stays the snapshot it already is).
- **Pair**: two person picks; name auto-fills "Ana & Ben" once both are
  chosen, still editable (real pair-team names).
- **Team**: today's form unchanged (name, open picker), captain/№ per the
  effective model.
- **Roster editor** (expanded row): squad-№ input and captain checkbox only
  when the effective model says so for `team` — never for individual/pair;
  find-player row hides at the kind cap.
- CSV import unchanged.

## 5. Server validation (writes only)

`createEntrants` / entrant PATCH validate against the resolver:
kind ∉ allowed → 422 `ENTRANT_KIND_NOT_ALLOWED`; members > cap → 422
`ENTRANT_ROSTER_TOO_BIG`. Existing rows are never revalidated — reads and
scoring are untouched.

## 6. Testing

- Engine: resolver units — module default, division override, no-model
  legacy fallback, structural caps, capFor.
- Web markup tests: individual variant (no captain/№/name field, single
  pick), pair variant (2 picks, auto name), team unchanged; settings block
  renders sport defaults.
- DB test: 422 kind-not-allowed + roster-too-big; override widens kinds.
- Smoke: boardgame division — 2-member individual → 422, 1-member → 201.

## Out of scope

Per-position roster quotas; org-level policy; person→entrant rename sync;
CSV import redesign; retrofitting existing entrant rows.
