import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyLink } from "@/components/copy-link";

// Regression (fix-ui audit 03-console-division.md, "Registrations panel —
// mobile — public registration link input shows almost no usable text"):
// the input shared one flex row with the Copy/Open/QR buttons, so on a
// narrow viewport `flex-1` only got the leftover space after 3 buttons.
// The input must take the full row width on mobile.
describe("CopyLink — mobile width", () => {
  it("gives the readonly URL input the full row width, with buttons on their own row", () => {
    const html = renderToStaticMarkup(<CopyLink path="/shared/org/comp/register" qrFileName="q.png" />);
    const inputMatch = html.match(/<input[^>]*class="([^"]+)"/);
    expect(inputMatch).not.toBeNull();
    expect(inputMatch![1]).toContain("w-full");
  });
});
