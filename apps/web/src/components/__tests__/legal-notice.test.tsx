import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LegalNotice } from "../legal-notice";
import { DictProvider } from "@/components/i18n/dict-provider";

// A stub `ui` dict whose template deliberately puts {privacy} BEFORE {terms} so
// the test proves the notice honours the translation's own word order (not a
// hardcoded "Terms … and … Privacy" sentence).
const stub = {
  "legal.notice.body": "PRE {privacy} MID {terms} END",
  "legal.notice.terms": "TERMS-LABEL",
  "legal.notice.privacy": "PRIVACY-LABEL",
};

describe("LegalNotice", () => {
  it("renders the template's linked labels in the dict's word order", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={stub} locale="fr">
        <LegalNotice />
      </DictProvider>,
    );
    expect(html).toContain("PRE ");
    expect(html).toContain("TERMS-LABEL");
    expect(html).toContain("PRIVACY-LABEL");
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('href="/legal/privacy"');
    // {privacy} precedes {terms} in the template → so must the rendered output.
    expect(html.indexOf("PRIVACY-LABEL")).toBeLessThan(html.indexOf("TERMS-LABEL"));
  });
});
