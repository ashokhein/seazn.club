# 01 — Engine v2 Strategy

## 1. Thesis

Tournament software wins or loses on **rules fidelity**. Organisers forgive an ugly page;
they never forgive a wrong standing, an unfair pairing, or a cricket table without NRR.
Generic bracket tools (Challonge, Bracket HQ) flatten every sport into win/loss; vertical
tools (CricHeroes, ChessManager, Tournament Software for racket sports) nail one sport and
stop there. The gap in the market: **one platform, per-sport fidelity** — a club that runs
cricket in summer, football in winter, and a chess night in between should not need three
products.

That fidelity lives in exactly one place: the engine. Hence:

- Engine is a **standalone, pure package** (`packages/engine`) — publishable, testable in
  isolation, embeddable in the API, in workers, in the browser (optimistic UI), and in a
  future mobile app.
- Sports are **plugins** conforming to one contract. Adding padel or kabaddi later is a
  bounded, reviewable unit of work — a module + a spec section + a conformance suite.
- Everything is **event-sourced**: the scoresheet is the ledger; state is derived. This
  gives undo, audit, replays, live reconstruction, and "what-if" simulation for free.

## 2. Principles

1. **Match grammar ≠ ranking grammar.** How a fixture is scored (innings, sets, halves)
   is the sport module's business. How results roll up into tables, pairings and brackets
   is the competition engine's business. The boundary is the `MatchOutcome` +
   `StandingsDelta` contract — the only thing the two layers exchange.
2. **Configuration over code for variants.** T20 vs ODI is *not* two sport modules; it is
   one cricket module with `{ oversPerInnings: 20 | 50 }`. U16 vs U18 is *not* two
   competitions; it is one competition with two divisions. Variants are data.
3. **Deterministic and replayable.** Same events in → same state out, bit-for-bit. Ids
   and timestamps are injected. This is what makes the property/fuzz harness (doc 12 in
   `development/`) actually able to simulate 10,000 tournaments per sport in CI.
4. **Officially-grounded defaults, organiser-overridable.** Ship FIFA/ICC/FIDE/FIVB rule
   presets (cited in [11-sources.md](11-sources.md)); let organisers override points,
   tiebreaker order, set counts — grassroots play house rules.
5. **Public by default, monetised by depth.** Standings, schedules and results are the
   shareable artifact that markets the product (open dashboard, doc 09). Depth —
   positions, stats, media, API, branding — is the Pro surface (doc 10).

## 3. Sport coverage strategy

Phase-ordered by (a) beachhead demand, (b) how much of the engine each sport exercises:

| Wave | Sports | Why |
|------|--------|-----|
| 1 | **Chess/board games**, **badminton**, **table tennis**, **volleyball** | Current user base; exercise Swiss pairing + set-based scoring kernel |
| 2 | **Football (soccer)**, **basketball** | Exercise timed-period scoring, squads/positions, cards, shootouts |
| 3 | **Cricket** | The hardest: innings grammar, NRR, DLS, multi-hour fixtures, rich roles. Deliberately after the kernel is proven |
| Later | Tennis/padel/pickleball, futsal, netball, hockey, kabaddi, esports | Mostly reuse set-based or timed-period kernels |

Cricket last-of-the-big-three is deliberate: it forces the most general design, but you
want the event kernel and competition engine stable before taking it on.

## 4. What "separate API" means here

Today API routes are a BFF for the Next.js UI. v2 splits three surfaces:

1. **Engine package** — pure library, no HTTP.
2. **Platform API `/api/v1`** — versioned, OpenAPI-documented REST; consumed by our UI,
   third parties (Pro `api.access`), and the public dashboard. Contract-first.
3. **Web app** — Server Components read models + thin mutations that call the same
   service layer as `/api/v1`. No business logic in routes or components.

Full design: [08-api-design.md](08-api-design.md).

## 5. Non-goals (v2)

- Betting/odds, fantasy, video streaming.
- Officiating hardware integrations (scoreboard controllers) — API-first leaves the door open.
- Ratings systems (Elo/Glicko) — schema reserves space (`ratings` metric family), not built.
- Physical-region data residency.

## 6. Success criteria

- A cricket organiser runs a T20 group + knockout with correct NRR standings and a DLS
  target on a rain-shortened fixture, without support intervention.
- A chess arbiter accepts Buchholz Cut-1 / Sonneborn-Berger tables produced by the engine.
- The simulation harness plays ≥10k random tournaments per sport per CI run with zero
  invariant violations.
- Adding a new set-based sport takes < 1 day, engine-side, using the conformance kit.
- Public dashboard pages serve from cache with no auth and update live during play.
