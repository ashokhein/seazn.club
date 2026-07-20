import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryPanel } from "@/components/v2/history-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/client-v1", () => ({
  apiV1: vi.fn(async () => ({})),
  ApiV1Error: class extends Error {},
}));

// Regression: the "Save point" submit button carried the app-wide `.btn
// .btn-primary` defaults inside a `flex` row whose sibling input is `w-full`.
// With nothing stopping it, flex squeezed the button until the label wrapped
// onto two lines — a 60px solid-purple slab beside a 40px input, and the
// loudest thing in a panel whose list runs at 12.5px. The fix is three
// properties, each load-bearing:
//   - whitespace-nowrap → the label never wraps (this is what made it "fat")
//   - shrink-0          → flex takes the space from the input, not the button
//   - btn-ghost + text-xs/py-1.5 → matches the density of the list below it
describe("HistoryPanel — save-point button sizing", () => {
  const html = renderToStaticMarkup(
    <HistoryPanel divisionId="d1" scheduleLocked={false} canEdit />,
  );
  const button = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";

  it("renders a submit button for creating a save point", () => {
    expect(button).not.toBe("");
  });

  it("never lets the label wrap, and never gives up width to the input", () => {
    expect(button).toContain("whitespace-nowrap");
    expect(button).toContain("shrink-0");
  });

  it("stays quieter than Restore — creating is setup, restoring is the job", () => {
    expect(button).toContain("btn-ghost");
    expect(button).not.toContain("btn-primary");
  });

  it("matches the panel's 12px scale rather than the app-wide 14px default", () => {
    expect(button).toContain("text-xs");
    expect(html).toMatch(/<input[^>]*class="input[^"]*text-xs/);
  });
});
