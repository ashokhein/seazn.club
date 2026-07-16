import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProseEditor } from "@/components/prose-editor";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// The editor chrome reads editor.* from the active dictionary. Sentinel values
// prove the labels come from the provider, not hardcoded English. The TipTap
// toolbar only mounts client-side (immediatelyRender:false), so under node/SSR
// we assert the always-rendered Write/Preview tabs — they share the same msg
// binding as the toolbar buttons.
const dict: Dict = {
  ...(uiEn as unknown as Dict),
  "editor.write": "«write-loc»",
  "editor.preview": "«preview-loc»",
  "editor.mode": "«mode-loc»",
};

describe("prose-editor chrome i18n", () => {
  it("localizes the Write/Preview tabs from the dictionary", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <ProseEditor value="" onChange={() => {}} orgId="org-1" />
      </DictProvider>,
    );
    expect(html).toContain("«write-loc»");
    expect(html).toContain("«preview-loc»");
    expect(html).toContain('aria-label="«mode-loc»"');
    expect(html).not.toContain(">Write<"); // English tab label gone
  });
});
