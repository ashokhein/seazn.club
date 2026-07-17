import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentCard, type ConsentPerson } from "../consent-card";

// Regression: officials have no photo upload anywhere in the product, so
// "Show my photo publicly" was a meaningless (misleading) toggle for a
// person who is only ever linked as an official, not rostered as an entrant.
const officialOnly: ConsentPerson = {
  id: "p1",
  full_name: "Alex Referee",
  org_name: "Riverside",
  consent: {},
  consent_locked: false,
  hasPhotoFeature: false,
};

const rosteredPlayer: ConsentPerson = {
  id: "p2",
  full_name: "Sam Player",
  org_name: "Riverside",
  consent: {},
  consent_locked: false,
  hasPhotoFeature: true,
};

describe("ConsentCard — photo toggle only for rostered persons", () => {
  it("hides the public-photo toggle for an official-only person", () => {
    const html = renderToStaticMarkup(<ConsentCard persons={[officialOnly]} />);
    expect(html).not.toContain("Show my photo publicly");
    expect(html).toContain("Show my name publicly");
    const checkboxCount = (html.match(/type="checkbox"/g) ?? []).length;
    expect(checkboxCount).toBe(1);
  });

  it("still shows the public-photo toggle for a rostered player", () => {
    const html = renderToStaticMarkup(<ConsentCard persons={[rosteredPlayer]} />);
    const checkboxCount = (html.match(/type="checkbox"/g) ?? []).length;
    expect(checkboxCount).toBe(2);
  });
});
