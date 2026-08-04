import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

// #403 finding 4: the organiser's free-text instruction is sent to an AI
// sub-processor, so the field must not *invite* personal data about people.
// The placeholder was already rule-shaped; the hint was not — it rewarded
// specificity without saying which kind, and the product does compile a
// "keep apart" rule, so "keep Alice away from Bob" was the natural reading.
//
// Nothing is lost by steering the free text at rules: the structured wish chip
// (board.ai.wish.kind.keepApart) already covers entrant-vs-entrant by PICKING
// entrants from the division's own list rather than having them typed as prose.
//
// The strings below are the pre-#403 wording, frozen. A hint that still equals
// its frozen twin is one this change never reached — which is the failure mode
// a bare "the key exists in 4 locales" assertion cannot see.
const BEFORE: Record<string, Record<string, string>> = {
  en: {
    "board.ai.instructionHint": "Plain language works best — the more specific, the better the plan.",
    "board.ai.joint.instructionHint":
      "Say what matters most. Every proposal is checked by the engine before you see it.",
    "board.ai.officials.instructionHint": "Plain language works best — or add a wish below.",
  },
  es: {
    "board.ai.instructionHint":
      "El lenguaje sencillo funciona mejor: cuanto más específico, mejor será el plan.",
    "board.ai.joint.instructionHint":
      "Di lo que más importa. El motor revisa cada propuesta antes de que la veas.",
    "board.ai.officials.instructionHint": "El lenguaje natural funciona mejor: o añade un deseo abajo.",
  },
  fr: {
    "board.ai.instructionHint":
      "Le langage courant fonctionne le mieux — plus c'est précis, meilleur est le plan.",
    "board.ai.joint.instructionHint":
      "Dites ce qui compte le plus. Chaque proposition est vérifiée par le moteur avant de vous être présentée.",
    "board.ai.officials.instructionHint":
      "Le langage courant fonctionne le mieux — ou ajoutez un souhait ci-dessous.",
  },
  nl: {
    "board.ai.instructionHint": "Gewone taal werkt het best — hoe specifieker, hoe beter het plan.",
    "board.ai.joint.instructionHint":
      "Zeg wat het belangrijkst is. Elk voorstel wordt door de engine gecontroleerd voordat je het ziet.",
    "board.ai.officials.instructionHint": "Gewone taal werkt het best — of voeg hieronder een wens toe.",
  },
};

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};

const HINTS = [
  "board.ai.instructionHint",
  "board.ai.joint.instructionHint",
  "board.ai.officials.instructionHint",
] as const;

describe("#403 — the instruction field asks for rules, not people", () => {
  it("every locale carries a reworded hint for all three consoles", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const key of HINTS) {
        expect(dict[key], `${locale}/${key} missing`).toBeTruthy();
        expect(dict[key], `${locale}/${key} still the pre-#403 wording`).not.toBe(
          BEFORE[locale]![key],
        );
      }
    }
  });

  it("the division and joint hints name the scheduling dimensions", () => {
    expect(en["board.ai.instructionHint"]).toMatch(/times, courts and rest gaps/);
    expect(en["board.ai.joint.instructionHint"]).toMatch(/times, courts and rest gaps/);
    expect(en["board.ai.officials.instructionHint"]).toMatch(/duties, times and rest gaps/);
  });

  it("the division hint routes naming an entrant to the structured wish picker", () => {
    // The one place a person legitimately enters the instruction is a keep-apart
    // rule, and the wish chip builds that from the entrant list — no prose.
    expect(en["board.ai.instructionHint"]).toMatch(/pick them with a wish/);
  });

  it("no locale still rewards unbounded specificity", () => {
    expect(en["board.ai.instructionHint"]).not.toMatch(/the more specific/i);
    expect(es["board.ai.instructionHint"]).not.toMatch(/cuanto más específico/i);
    expect(fr["board.ai.instructionHint"]).not.toMatch(/plus c'est précis/i);
    expect(nl["board.ai.instructionHint"]).not.toMatch(/hoe specifieker/i);
  });

  it("keeps each locale actually translated rather than copied from English", () => {
    for (const key of HINTS) {
      for (const locale of ["es", "fr", "nl"]) {
        expect(DICTS[locale]![key], `${locale}/${key}`).not.toBe(en[key]);
      }
    }
  });
});
