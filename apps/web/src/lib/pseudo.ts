// en-XA pseudolocale (v5 i18n §8) — DEV/CI ONLY. Every translated string is
// accented, ~30% wider, and wrapped in ⟦…⟧. Two payoffs:
//   1. Any visible text WITHOUT ⟦…⟧ markers is a hardcoded (un-extracted) string
//      — the Playwright audit fails on it, turning "did we miss one?" into a gate.
//   2. The width bump surfaces truncation/overflow before real locales ship.
// {var} placeholders are preserved verbatim so interpolation still works.

const ACCENT: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ğ", h: "ĥ", i: "í",
  j: "ĵ", k: "ķ", l: "ł", m: "ɱ", n: "ñ", o: "ó", p: "þ", q: " q", r: "ř",
  s: "š", t: "ţ", u: "ú", v: "ṽ", w: "ŵ", x: "x", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ğ", H: "Ĥ", I: "Í",
  J: "Ĵ", K: "Ķ", L: "Ł", M: "Ɱ", N: "Ñ", O: "Ó", P: "Þ", Q: "Q", R: "Ř",
  S: "Š", T: "Ţ", U: "Ú", V: "Ṽ", W: "Ŵ", X: "X", Y: "Ý", Z: "Ž",
};

export function toPseudo(s: string): string {
  const parts = s.split(/(\{\w+\})/); // keep {var} spans intact
  const body = parts
    .map((p) => (/^\{\w+\}$/.test(p) ? p : p.replace(/[a-zA-Z]/g, (ch) => ACCENT[ch] ?? ch)))
    .join("");
  const letters = s.replace(/\{\w+\}/g, "").replace(/[^a-zA-Z]/g, "").length;
  const pad = "·".repeat(Math.max(1, Math.ceil(letters * 0.3))); // middot filler
  return `⟦${body}${pad}⟧`;
}

export function buildPseudoDictionary(
  dict: Record<string, unknown>,
): Record<string, unknown> {
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? toPseudo(v)
      : v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
        : v;
  return walk(dict) as Record<string, unknown>;
}
