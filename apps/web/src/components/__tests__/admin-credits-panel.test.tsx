// SPEC-6 C2 — the admin Credits section's closed state. The Grant/deduct modal
// is interaction-only and the vitest env is `node` with no DOM, so the modal's
// idempotency + submit path is covered by e2e; here we pin the section header,
// the formatted balance, the wallet id, the shared-pool warning (only when the
// wallet backs more than one org), and the trigger button.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminCreditsPanel } from "../admin-credits-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function render(props: Partial<Parameters<typeof AdminCreditsPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <AdminCreditsPanel
      orgId="org-1"
      walletId="sub_123"
      sharedByOrgs={1}
      balance={1234}
      staffRole="support"
      {...props}
    />,
  );
}

describe("AdminCreditsPanel", () => {
  it("shows the formatted balance and wallet id", () => {
    const html = render();
    expect(html).toContain("1,234");
    expect(html).toContain("sub_123");
    expect(html).toContain("Grant / deduct");
  });

  it("warns only when the wallet is shared by more than one org", () => {
    expect(render({ sharedByOrgs: 1 })).not.toContain("Shared by");
    expect(render({ sharedByOrgs: 3 })).toContain("Shared by 3 orgs");
  });
});
