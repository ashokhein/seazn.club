// <PassSeal> — the 20px seal on an org dashboard card (v17 gap #301).
//
// THIS FILE EXISTS BECAUSE THREE MUTATIONS SHIPPED GREEN (W8 task 6 review).
// The seal's decision used to live in an IIFE inside `o/[orgSlug]/page.tsx`,
// which cannot be unit-rendered here, so the only guard was a scan of the source
// TEXT — and a text scan pins syntax, not meaning. All three of these passed it:
//
//   1. `passLock.get(c.id) === "terminal"` instead of `!= null`
//      — keeps the real call, keeps the join, keeps the `data-pass-ended`
//        string, and re-ships #301 for the entire `past_ends_on` arm.
//   2. swapping which label goes on which state
//      — an ended pass reading "Event Pass M active".
//   3. swapping the two colour sets
//      — the floodlit lime seal on a dead pass.
//
// Each is a failing test below. The cases are generated from PASS_LOCK_REASONS
// and PASS_KEYS rather than listed, so a third reason or a third rung arrives
// here as a failure instead of an untested arm.
//
// Rendered through react-dom/server (node env, no DOM), like the sibling
// pass-component suites: this component has no effects.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PassSeal } from "@/components/pass-seal";
import { PASS_LOCK_REASONS, type PassLockReason } from "@/lib/entitlements";
import { PASS_KEYS, type PassKey } from "@/lib/currency";
import { passActiveLabel } from "@/lib/pass-ladder";
import { t } from "@/lib/i18n-runtime";
import enUi from "@/dictionaries/en/ui.json";

const render = (lockReason: PassLockReason | null, rung: PassKey = "event_pass") =>
  renderToStaticMarkup(<PassSeal dict={enUi} rung={rung} lockReason={lockReason} />);

// Read from the dictionary the component reads, so a copy change reaches this
// file rather than a literal here going quietly stale.
const ENDED_LABEL = t(enUi, "pass.entry.ended");

describe("<PassSeal>", () => {
  // MUTATION 1. `=== "terminal"` passes every source-text assertion and is
  // wrong for exactly one of the two reasons — so the arms are asserted
  // separately, and generated from the union rather than listed.
  it.each(PASS_LOCK_REASONS)("treats %s as ended, not just the terminal arm", (reason) => {
    const html = render(reason);
    expect(html).toContain('data-pass-ended="true"');
    expect(html).not.toContain("data-pass-held=");
  });

  it("marks a pass with no lock reason as held", () => {
    const html = render(null);
    expect(html).toContain('data-pass-held="true"');
    expect(html).not.toContain("data-pass-ended=");
  });

  // MUTATION 2. Both directions, so swapping the labels reds rather than
  // trading one green for another.
  it.each(PASS_LOCK_REASONS)("labels an ended pass ended, whatever the reason (%s)", (reason) => {
    const html = render(reason);
    expect(html).toContain(`aria-label="${ENDED_LABEL}"`);
    expect(html).not.toContain(passActiveLabel(enUi, "event_pass"));
  });

  it.each(PASS_KEYS)("labels a held %s with its own rung, not the family name", (rung) => {
    const html = render(null, rung);
    expect(html).toContain(`aria-label="${passActiveLabel(enUi, rung)}"`);
    expect(html).not.toContain(ENDED_LABEL);
    // The brace bug the rung helper exists to prevent: `t()` renders a
    // forgotten var literally, and this seal is the only text on the card.
    expect(html).not.toContain("{rung}");
  });

  // MUTATION 3. Lime is the console's "this is on" floodlight; a dead pass
  // wearing it is the page making the claim the wave exists to stop.
  it.each(PASS_LOCK_REASONS)("gives an ended pass the quiet tone (%s)", (reason) => {
    const html = render(reason);
    expect(html).toContain("bg-slate-100");
    expect(html).not.toContain("bg-lime-100");
  });

  it("keeps the floodlit tone for a pass that still applies", () => {
    const html = render(null);
    expect(html).toContain("bg-lime-100");
    expect(html).not.toContain("bg-slate-100");
  });

  // WCAG 1.4.1. lime-100 against slate-100 measures 1.01:1, so hue alone is not
  // a channel a sighted reader can rely on — in greyscale, on a dim display or
  // with any colour vision deficiency the two seals were identical, because the
  // glyph markup was byte-identical too. Shape has to carry it.
  it("distinguishes the two states by SHAPE, not only by colour", () => {
    const ended = render("terminal");
    const held = render(null);
    const glyph = (html: string) => html.slice(html.indexOf("<svg"));
    expect(glyph(ended)).not.toEqual(glyph(held));
  });

  // The rung stays on the element in BOTH states — it is how the other two
  // surfaces select this seal, and an ended L pass is still an L pass.
  it.each(PASS_KEYS)("names the rung in both states (%s)", (rung) => {
    expect(render(null, rung)).toContain(`data-pass-held-rung="${rung}"`);
    expect(render("terminal", rung)).toContain(`data-pass-held-rung="${rung}"`);
  });

  // The seal has no room for a word, so the label is the whole accessible name.
  it("carries the label to assistive tech and to hover alike", () => {
    const html = render("past_ends_on");
    expect(html).toContain('role="img"');
    expect(html).toContain(`title="${ENDED_LABEL}"`);
  });
});
