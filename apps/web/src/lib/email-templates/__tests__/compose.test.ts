import { describe, expect, it } from "vitest";
import { renderEmail } from "@/lib/email-templates/compose";

// Growth loop (PLG L2): every outbound platform email carries a persistent,
// English-only micro-CTA back to /start — consistent with the existing
// "Powered by seazn.club" style attribution elsewhere in the product.
describe("email shell footer", () => {
  it("includes a run-your-own CTA linking to /start", () => {
    const html = renderEmail({
      subject: "Subject",
      preheader: "Preheader",
      eyebrow: "Eyebrow",
      title: "Title",
      contentHtml: "<p>Body</p>",
    });
    expect(html).toContain("seazn.club/start");
    expect(html).toMatch(/run your own/i);
  });
});
