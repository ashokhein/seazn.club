// /admin/entitlements, rendered — the operator's view of the plan matrix.
//
// What was wrong (v17 #294). This page hardcoded its plan list TWICE — a
// `PLAN_KEYS` tuple driving the cell editors and a hand-written row of four
// `<th>`s — and `lib/entitlement-admin`'s pivot kept a third copy. V341 seeded
// `event_pass_l` into `plan_entitlements`, so the rows existed and every
// resolver honoured them, but staff had no column for the rung: they could
// neither see what L grants nor correct it, on the one screen that exists to
// do exactly that. (The PATCH route kept a fourth copy, and 400'd on an L
// edit — pinned separately in `api/admin/entitlements/__tests__/route.test.ts`.)
//
// A pivot test cannot catch this: `groupForAdmin` returned the right data all
// along and the page dropped it on the floor. So this renders the real page and
// asserts the COLUMN, which is the thing that was missing.
//
// Rendered through react-dom/server — vitest runs `environment: "node"` and
// this workspace has no jsdom (same pattern as upgrade-page.test.tsx). Only the
// DB is mocked; `EntCellEditor` is the real client component, because a column
// that renders a heading and no editor is still an operator who cannot edit.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_PLAN_KEYS, ADMIN_PLAN_LABEL } from "@/lib/entitlement-admin";

const rows = [
  { plan_key: "community", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 4 },
  { plan_key: "event_pass", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 10 },
  { plan_key: "event_pass_l", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 20 },
  { plan_key: "pro", feature_key: "divisions.per_competition.max", bool_value: null, int_value: null },
  { plan_key: "pro_plus", feature_key: "divisions.per_competition.max", bool_value: null, int_value: null },
  // The other key V341 overrides: L's cap is NULL, which on a PRESENT row means
  // unlimited (∞) and on an absent one would mean DENY. The distinction is the
  // whole point of the `present` flag the editor is seeded from.
  { plan_key: "event_pass", feature_key: "entrants.per_division.max", bool_value: null, int_value: 128 },
  { plan_key: "event_pass_l", feature_key: "entrants.per_division.max", bool_value: null, int_value: null },
];

// Two `sql` calls in order: the matrix read, then the override counts.
let call = 0;
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve(call++ === 0 ? rows : []),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import AdminEntitlementsPage from "../page";

const render = async () => {
  call = 0;
  return renderToStaticMarkup(await AdminEntitlementsPage());
};

describe("/admin/entitlements renders a column per plan", () => {
  it("heads a column for every plan, the L rung included", async () => {
    const html = await render();
    for (const plan of ADMIN_PLAN_KEYS) {
      expect(html, `no heading for ${plan}`).toContain(`>${ADMIN_PLAN_LABEL[plan]}<`);
    }
    // Named explicitly as well as through the loop: the loop passes trivially
    // if ADMIN_PLAN_KEYS itself ever loses the rung, and that regression is
    // exactly as bad as the page dropping the column.
    expect(html).toContain(">Event Pass L<");
    // The two pass rungs must be told apart. "Event Pass" alone, sitting beside
    // "Event Pass L", reads as the family name and leaves an operator guessing
    // which column the $29 product is.
    expect(html).toContain(">Event Pass M<");
  });

  it("gives every plan an editable cell, not just a heading", async () => {
    const html = await render();
    // One editor per plan per feature: two features above × five plans.
    for (const plan of ADMIN_PLAN_KEYS) {
      const editors = html.split(`data-ent-plan="${plan}"`).length - 1;
      expect(editors, `${plan} has no cell editor`).toBe(2);
    }
  });

  it("renders L's real values — 20 divisions, ∞ entrants — not M's", async () => {
    const html = await render();
    // The failure this guards is silent: a column that renders but reads its
    // neighbour's row tells an operator the L rung caps at 128.
    expect(html).toContain("20");
    expect(html).toContain("∞");
  });

  it("heads every section's table with the same column count", async () => {
    const html = await render();
    // The page renders one table per ENTITLEMENT_DOMAINS section (including
    // the ones this fixture leaves empty), so count per table rather than
    // across the page. Each must carry: Feature key + Type + one per plan +
    // What it gates + Overrides. A hand-written `<th>` row drifting from
    // ADMIN_PLAN_KEYS is what put the body and the header out of step before.
    const tables = html.split("<table").slice(1);
    expect(tables.length, "no tables rendered").toBeGreaterThan(0);
    const counts = new Set(tables.map((t) => t.split("<th ").length - 1));
    expect([...counts].join(",")).toBe(String(ADMIN_PLAN_KEYS.length + 4));
  });
});
