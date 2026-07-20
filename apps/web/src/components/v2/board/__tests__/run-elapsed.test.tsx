import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunElapsed, formatElapsed } from "../run-elapsed";

// The elapsed line is a translated template, not a bare number — the separator
// and the "usually under N min" calibration belong to the locale.
const stub = { "board.ai.elapsed": "T={elapsed} HINT" };

describe("formatElapsed", () => {
  it("pads seconds so the line never jitters between :9 and :10", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9)).toBe("0:09");
    expect(formatElapsed(10)).toBe("0:10");
  });

  it("rolls into minutes at the measured run lengths (84s, 213s)", () => {
    expect(formatElapsed(60)).toBe("1:00");
    expect(formatElapsed(84)).toBe("1:24");
    expect(formatElapsed(213)).toBe("3:33");
  });
});

const render = () =>
  renderToStaticMarkup(
    <DictProvider dict={stub} locale="en">
      <RunElapsed />
    </DictProvider>,
  );

describe("RunElapsed", () => {
  it("starts at zero on mount — the caller mounts it per run, so the clock resets itself", () => {
    expect(render()).toContain("T=0:00 HINT");
  });

  it("interpolates the clock into the locale template rather than printing the placeholder", () => {
    const html = render();
    expect(html).toContain("T=0:00 HINT");
    expect(html).not.toContain("{elapsed}");
  });

  it("is a timer that does not narrate every tick to screen readers", () => {
    const html = render();
    // The run button already announces "Working on your schedule…"; a live
    // region here would talk over the rest of the page once a second.
    expect(html).toContain('role="timer"');
    expect(html).toContain('aria-live="off"');
  });
});
