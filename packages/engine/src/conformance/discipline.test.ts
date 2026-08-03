// SPEC-1 conformance — every card-emitting sport module must expose a
// `discipline` descriptor whose extractCards projects its ledger into
// DisciplineCard[] with declared colours. Mirrors the conformance kit pattern
// (testkit/conformance.ts): drives the module's own arbitraryEvent generator
// (spec 03 §6) across seeds so the assertion runs on real folded streams, not
// a hand-built ledger.
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { football } from "../sports/football/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
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

// W4 shared-engine item 1 — a DisciplineCard must be able to say WHY the card
// was shown and WHO serves it. Without that, an accumulation rule keyed on the
// offence ("three cards for dissent") or a bench penalty served by a nominated
// player cannot be expressed downstream, because the offence stops at the
// sport schema and never reaches the discipline projection.
describe("SPEC-1 discipline card detail (W4)", () => {
  const ledger = (type: string, payload: unknown): EventEnvelope[] => [
    makeEnvelope(0, { type, payload }) as EventEnvelope,
  ];

  it("football projects the Law 12 offence onto the card", () => {
    const [card] = football.discipline!.extractCards(
      ledger("football.card", {
        by: "H",
        person: "H-p7",
        color: "yellow",
        reason: "dissent",
      }),
    );
    expect(card).toMatchObject({ personId: "H-p7", color: "yellow", reason: "dissent" });
  });

  it("football omits reason entirely when the scorer did not record one", () => {
    const [card] = football.discipline!.extractCards(
      ledger("football.card", { by: "H", person: "H-p7", color: "red" }),
    );
    expect(card).toBeDefined();
    expect(Object.hasOwn(card as object, "reason")).toBe(false);
  });

  it("hockey projects the infraction reason onto the card", () => {
    const [card] = hockey.discipline!.extractCards(
      ledger("hockey.suspension.start", {
        by: "H",
        person: "H-p3",
        class: "green",
        reason: "dangerous play",
      }),
    );
    expect(card).toMatchObject({ personId: "H-p3", color: "green", reason: "dangerous play" });
  });

  it("ice hockey names the player who serves a bench minor", () => {
    const [card] = icehockey.discipline!.extractCards(
      ledger("icehockey.suspension.start", {
        by: "A",
        class: "bench_minor",
        reason: "too many men",
        servedBy: "A-p9",
      }),
    );
    expect(card).toMatchObject({
      entrantSide: "A",
      color: "bench_minor",
      reason: "too many men",
      servedBy: "A-p9",
    });
    // A bench minor has no offender, only a server.
    expect(Object.hasOwn(card as object, "personId")).toBe(false);
  });

  it("ice hockey omits servedBy when the penalised player serves it himself", () => {
    const [card] = icehockey.discipline!.extractCards(
      ledger("icehockey.suspension.start", { by: "A", person: "A-p4", class: "minor" }),
    );
    expect(card).toBeDefined();
    expect(Object.hasOwn(card as object, "servedBy")).toBe(false);
    expect(Object.hasOwn(card as object, "reason")).toBe(false);
  });

  it("lets an accumulation rule count cards by offence, not just by colour", () => {
    const cards = football.discipline!.extractCards([
      makeEnvelope(0, {
        type: "football.card",
        payload: { by: "H", person: "H-p7", color: "yellow", reason: "dissent" },
      }) as EventEnvelope,
      makeEnvelope(1, {
        type: "football.card",
        payload: { by: "H", person: "H-p7", color: "yellow", reason: "unsporting_behaviour" },
      }) as EventEnvelope,
      makeEnvelope(2, {
        type: "football.card",
        payload: { by: "H", person: "H-p7", color: "yellow", reason: "dissent" },
      }) as EventEnvelope,
    ]);
    const dissent = cards.filter((c) => c.reason === "dissent");
    expect(dissent).toHaveLength(2);
  });
});
