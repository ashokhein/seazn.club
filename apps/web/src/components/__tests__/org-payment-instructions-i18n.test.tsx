import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// next/navigation hooks used by the component — stub for SSR render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const dict: Dict = {
  ...(uiEn as unknown as Dict),
  "pay.cardTitle": "«card-title-loc»",
  "pay.save": "«save-loc»",
  "pay.methodLegend": "«legend-loc»",
};

describe("org payments-instructions i18n", () => {
  it("reads its chrome from the dictionary (owner view)", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <OrgPaymentInstructions orgId="org-1" initialValue={null} isOwner />
      </DictProvider>,
    );
    expect(html).toContain("«card-title-loc»");
    expect(html).toContain("«save-loc»");
    expect(html).toContain("«legend-loc»");
    expect(html).not.toContain("Card payments (Stripe)"); // English gone
    expect(html).not.toContain(">Save<");
  });
});
