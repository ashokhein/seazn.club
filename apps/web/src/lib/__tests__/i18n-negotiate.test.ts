import { describe, it, expect } from "vitest";
import { negotiateLocale } from "@/lib/i18n-negotiate";

describe("negotiateLocale", () => {
  it("matches the best supported locale", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(negotiateLocale("nl-NL,nl;q=0.9")).toBe("nl");
    expect(negotiateLocale("es-ES,es;q=0.8")).toBe("es");
  });
  it("falls back to en for unsupported / empty", () => {
    expect(negotiateLocale("de-DE,de;q=0.9")).toBe("en"); // unsupported
    expect(negotiateLocale("ta-IN,ta;q=0.9")).toBe("en"); // deferred this cycle
    expect(negotiateLocale(null)).toBe("en");
    expect(negotiateLocale("")).toBe("en");
  });
});
