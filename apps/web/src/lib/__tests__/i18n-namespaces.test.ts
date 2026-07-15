// Namespace drift guard (v5 i18n cycle 47). As batches add per-domain namespaces
// it is easy to widen the Namespace type but forget a loader or a locale's JSON
// file — which only surfaces as a runtime import crash on the affected page.
// This asserts every registered namespace resolves for every locale (loader +
// on-disk file present), mirroring the help slug↔registry disk check.
import { describe, expect, it } from "vitest";
import { NAMESPACES, LOCALES, getDictionary } from "@/lib/i18n";

describe("i18n namespace registry", () => {
  it("registers the cycle-47 console copy-catalog namespace", () => {
    expect(NAMESPACES).toContain("ui");
  });

  it("every namespace resolves for every locale (loader + file present)", async () => {
    for (const ns of NAMESPACES) {
      for (const locale of LOCALES) {
        const dict = await getDictionary(locale, ns);
        expect(dict, `${locale}/${ns}`).toBeTypeOf("object");
      }
    }
  });
});
