// G5 — card structure: status chip alone in the header row, ALL actions in
// one wrapped row under the content (was a stacked right rail that squeezed
// the name column, worst on mobile).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import {
  OfficialsDirectoryPanel,
  type DirectoryOfficial,
} from "@/components/v2/officials-directory-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const official = (over: Partial<DirectoryOfficial>): DirectoryOfficial => ({
  id: "o1",
  display_name: "Ref One",
  role_keys: ["referee"],
  entrant_id: null,
  email: "ref@example.com",
  max_per_day: null,
  claimed: false,
  invite_pending: false,
  ...over,
});

function render(officials: DirectoryOfficial[], canEdit = true) {
  return renderToStaticMarkup(
    <DictProvider dict={en as never} locale="en">
      <OfficialsDirectoryPanel officials={officials} canEdit={canEdit} rolesMultiAllowed />
    </DictProvider>,
  );
}

describe("OfficialsDirectoryPanel card layout (G5)", () => {
  it("renders one action row per card with delete pushed to the end", () => {
    const html = render([official({})]);
    // Single action row: bordered top, wraps on narrow screens.
    const row = html.match(/<div class="mt-2 flex flex-wrap items-center gap-1\.5 border-t[^"]*"/g);
    expect(row?.length).toBe(1);
    expect(html).toContain("ml-auto"); // delete right-aligned in the row
  });

  it("read-only viewers get no action row and no email", () => {
    const html = render([official({})], false);
    expect(html).not.toContain("border-t border-slate-100 pt-2");
    expect(html).not.toContain("ref@example.com");
  });

  it("claimed officials keep the status chip but lose the invite action", () => {
    const html = render([official({ claimed: true })]);
    expect(html).toContain("Linked");
    expect(html.match(/Invite/g) ?? []).toHaveLength(0);
  });
});
