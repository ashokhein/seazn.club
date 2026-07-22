// Task 22, found by driving a real Event Pass purchase in a browser: the
// cookie-consent banner sat at `z-50`, the same layer as every dialog overlay,
// and it is mounted LAST in the root layout (app/layout.tsx) — so on a tie it
// paints on top. At 390×844 it covered the bottom of the checkout sheet and
// `document.elementFromPoint` at the centre of Stripe's "Pay" button resolved to
// the banner, not the checkout iframe. The buyer could not pay.
//
// Only a first-time visitor sees the banner, and a first-time visitor is every
// buyer of a $29 one-time pass, so this was the whole money path on a phone.
//
// The rule is one number: the banner must sit STRICTLY BELOW every overlay that
// can appear over it. Asserted as a source contract — CookieConsent's markup
// only exists after a client effect and this suite runs under `environment:
// "node"` (same reasoning as cookie-consent-fab-offset.test.ts) — and against
// the REAL overlay class strings rather than a copied constant, so raising an
// overlay back into a tie fails here too.
//
// The browser-level proof lives in `e2e/event-pass.spec.ts`
// ("checkout sheet vs the cookie banner"), which hit-tests the actual button.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(WEB, ...parts), "utf8");

/** The numeric z from a Tailwind `z-N` / `z-[N]` class in a class string. */
function zIndexOf(className: string): number {
  const m = className.match(/\bz-(?:\[)?(\d+)(?:\])?\b/);
  expect(m, `no z-index class in: ${className.slice(0, 120)}`).not.toBeNull();
  return Number(m![1]);
}

function firstFixedClassName(source: string): string {
  const m = source.match(/className="([^"]*\bfixed\b[^"]*)"/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("the cookie banner never covers a dialog", () => {
  const bannerZ = zIndexOf(firstFixedClassName(read("components", "cookie-consent.tsx")));

  it("sits below the shared Modal overlay — the Event Pass and Pro checkout sheets", () => {
    // globals.css `.modal-overlay` is what components/modal.tsx renders, and
    // components/pass-upgrade.tsx mounts Stripe's embedded checkout inside it.
    const css = read("app", "globals.css");
    const rule = css.match(/\.modal-overlay\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const overlayZ = zIndexOf(rule![1]!);
    expect(
      bannerZ,
      `cookie banner z-${bannerZ} must be below .modal-overlay z-${overlayZ}; ` +
        "a tie is a loss because the banner is mounted last in app/layout.tsx",
    ).toBeLessThan(overlayZ);
  });

  it("sits below the confirm dialogs a page can open over it", () => {
    for (const file of [
      ["components", "ui", "confirm-provider.tsx"],
      ["components", "v2", "confirm-dialog.tsx"],
    ]) {
      const z = zIndexOf(firstFixedClassName(read(...file)));
      expect(bannerZ, `${file.join("/")} overlay is z-${z}`).toBeLessThan(z);
    }
  });
});
