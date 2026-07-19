// SPEC-1 conformance — every card-emitting sport module must expose a
// `discipline` descriptor whose extractCards projects its ledger into
// DisciplineCard[] with declared colours. Mirrors the conformance kit pattern
// (testkit/conformance.ts): drives the module's own arbitraryEvent generator
// (spec 03 §6) across seeds so the assertion runs on real folded streams, not
// a hand-built ledger.
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { buildStream, defaultLineupPair } from "../testkit/helpers.ts";
import type { AnySportModule } from "../sport/module.ts";

// A module emits cards iff any fidelity tier declares a card/suspension/penalty
// event type (football.card, hockey.suspension.start, icehockey.suspension.start).
const CARD_EVENT = /\.(card|suspension|penalty)/;
function emitsCards(module: AnySportModule): boolean {
  return module.fidelityTiers.some((tier) => tier.eventTypes.some((t) => CARD_EVENT.test(t)));
}

// Collect every card the module's generator produces across a spread of seeds
// — card-emitting modules reach at least one in this budget.
function sampleCards(module: AnySportModule): { personId?: string; color: string; eventId: string }[] {
  const cfg = module.configSchema.parse({});
  const lineups = defaultLineupPair(module.positions);
  const out: { personId?: string; color: string; eventId: string }[] = [];
  for (let seed = 0; seed < 60; seed++) {
    const stream = buildStream(module, cfg, lineups, seed, 40) as EventEnvelope[];
    out.push(...module.discipline!.extractCards(stream));
  }
  return out;
}

describe("SPEC-1 discipline descriptor", () => {
  const carding = builtinModules.filter(emitsCards);

  it("covers exactly the card-emitting shipped modules", () => {
    expect(carding.map((m) => m.key).sort()).toEqual(["football", "hockey", "icehockey"]);
  });

  for (const module of carding) {
    describe(`${module.key}@${module.version}`, () => {
      it("declares a discipline model with at least one colour", () => {
        expect(module.discipline).toBeDefined();
        expect(module.discipline!.colors.length).toBeGreaterThan(0);
        for (const c of module.discipline!.colors) {
          expect(c.key.length).toBeGreaterThan(0);
          expect(c.label.length).toBeGreaterThan(0);
        }
      });

      it("extractCards yields cards, all in declared colours", () => {
        const declared = new Set(module.discipline!.colors.map((c) => c.key));
        const cards = sampleCards(module);
        expect(cards.length).toBeGreaterThan(0);
        for (const card of cards) {
          expect(declared.has(card.color), `undeclared colour "${card.color}"`).toBe(true);
          expect(card.eventId.length).toBeGreaterThan(0);
        }
      });
    });
  }
});
