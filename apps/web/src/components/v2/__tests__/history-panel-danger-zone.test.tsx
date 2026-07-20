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

// Regression: "Clear schedule…" was styled `btn border-red-200 text-red-700`.
// `.btn` carries padding but no border width and no background, and
// `border-red-200` is a colour with nothing to paint — so the most destructive
// control in the panel rendered as bare red text, indistinguishable from a
// link, with its .btn padding showing only as a stray indent against the
// paragraph above. `.btn-danger` is the existing token for exactly this.
describe("HistoryPanel — danger zone", () => {
  const html = renderToStaticMarkup(
    <HistoryPanel divisionId="d1" scheduleLocked={false} canEdit />,
  );
  const button =
    html.match(/<button[^>]*>(?=\s*Clear schedule)/)?.[0] ??
    html.match(/<button[^>]*class="[^"]*btn-danger[^"]*"[^>]*>/)?.[0] ??
    "";

  it("renders the clear-schedule control", () => {
    expect(button).not.toBe("");
  });

  it("uses the btn-danger token so the control actually looks like a button", () => {
    expect(button).toContain("btn-danger");
  });

  it("never sets a border colour without a border width to paint it", () => {
    const classes = button.match(/class="([^"]*)"/)?.[1] ?? "";
    const hasBorderColour = /\bborder-(red|purple|slate|amber|indigo)-\d{2,3}\b/.test(classes);
    if (hasBorderColour) expect(classes).toMatch(/\bborder\b(?!-)/);
  });
});
