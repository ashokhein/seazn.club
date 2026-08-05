import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderIsland, propsOf, walk, type Props } from "@/components/__tests__/_hook-harness";
import { PersonsPanel } from "@/components/v2/persons-panel";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import {
  DuplicatesPanel,
  MergeConfirmDialog,
  MergeHistoryList,
  MergeOutcomeCard,
  type DupCandidate,
  type DupPerson,
} from "@/components/v2/duplicates-panel";

// The panel refreshes the roster after a merge; there is no router in a node
// test. `useRouter` is the only next/navigation surface it touches.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const posted = vi.hoisted(() => ({ calls: [] as { url: string; json: unknown }[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    apiV1: vi.fn(async (url: string, options?: { json?: unknown }) => {
      posted.calls.push({ url, json: options?.json });
      return { merge_id: "m-new", survivor: { id: "p1" }, revealed: [] };
    }),
  };
});

const person = (over: Partial<DupPerson> & { id: string; full_name: string }): DupPerson => ({
  dob: null,
  gender: null,
  consent: {},
  external_ref: null,
  photo_path: null,
  user_id: null,
  ...over,
});

// The #403 case that must not be got wrong silently: the survivor is the more
// permissive record, so "the survivor's flags win" and "the stricter wins"
// disagree on public_name and agree on public_photo.
const SURVIVOR = person({
  id: "p1",
  full_name: "Ada Lovelace",
  dob: "1990-01-02",
  consent: { public_name: true, public_photo: true },
});
const ABSORBED = person({
  id: "p2",
  full_name: "Ada Lovelace",
  dob: "1990-01-02",
  consent: { public_name: false, public_photo: true },
});

const find = (tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>, attr: string) =>
  tree.find((el) => propsOf(el)[attr] !== undefined);
const propsFor = (island: { tree: () => ReturnType<ReturnType<typeof renderIsland>["tree"]> }, attr: string): Props => {
  const el = find(island.tree(), attr);
  if (!el) throw new Error(`no element carrying ${attr}`);
  return propsOf(el);
};
const check = (island: { tree: () => ReturnType<ReturnType<typeof renderIsland>["tree"]> }, attr: string) => {
  (propsFor(island, attr).onChange as (e: unknown) => void)({ target: { checked: true } });
};

const dialogProps = (a: DupPerson, b: DupPerson) => ({
  a,
  b,
  onCancel: () => {},
  onMerged: () => {},
});

describe("DuplicatesPanel — the merge confirmation", () => {
  it("keeps the confirm control disabled until the organiser affirms", () => {
    const island = renderIsland(MergeConfirmDialog, dialogProps(SURVIVOR, ABSORBED));
    expect(propsFor(island, "data-merge-confirm").disabled).toBe(true);
    check(island, "data-affirm");
    expect(propsFor(island, "data-merge-confirm").disabled).toBe(false);
  });

  it("shows the RESOLVED consent, not the survivor's — the stricter value wins", () => {
    const html = renderToStaticMarkup(<MergeConfirmDialog {...dialogProps(SURVIVOR, ABSORBED)} />);
    // survivor true AND absorbed false -> off. "Survivor wins" would read "on".
    expect(html).toMatch(/data-consent-key="public_name"[^>]*data-resolved="off"/);
    // Both true -> on, so the assertion above cannot pass by turning everything off.
    expect(html).toMatch(/data-consent-key="public_photo"[^>]*data-resolved="on"/);
  });

  it("sends the explicit confirmation, and the dob override only when the dates differ", async () => {
    posted.calls.length = 0;
    const same = renderIsland(MergeConfirmDialog, dialogProps(SURVIVOR, ABSORBED));
    check(same, "data-affirm");
    await (propsFor(same, "data-merge-confirm").onClick as () => Promise<void>)();
    expect(posted.calls[0]?.url).toBe("/api/v1/persons/p1/merge");
    expect(posted.calls[0]?.json).toEqual({ duplicate_id: "p2", confirmed: true });

    // A hand-picked pair whose dates disagree needs its OWN affirmation.
    const other = person({ ...ABSORBED, dob: "1991-07-07" });
    const differing = renderIsland(MergeConfirmDialog, dialogProps(SURVIVOR, other));
    check(differing, "data-affirm");
    expect(propsFor(differing, "data-merge-confirm").disabled).toBe(true);
    check(differing, "data-affirm-dob");
    expect(propsFor(differing, "data-merge-confirm").disabled).toBe(false);
    await (propsFor(differing, "data-merge-confirm").onClick as () => Promise<void>)();
    expect(posted.calls[1]?.json).toEqual({
      duplicate_id: "p2",
      confirmed: true,
      allow_dob_mismatch: true,
    });
    // Both dates are on screen so the organiser can see what they are overriding.
    expect(renderToStaticMarkup(<MergeConfirmDialog {...dialogProps(SURVIVOR, other)} />)).toContain(
      "1991-07-07",
    );
  });
});

describe("DuplicatesPanel — after the merge", () => {
  const board = (over: Record<string, unknown>) => ({
    division_id: "d1",
    conflicts: [{ fixtureId: "f1", reason: "person_overlap" }],
    ...over,
  });

  it("renders a revealed conflict on a COMPLETED division instead of filtering it away", () => {
    const html = renderToStaticMarkup(
      <MergeOutcomeCard
        survivorName="Ada Lovelace"
        boards={[
          board({ division_id: "d-done", name: "Autumn League", status: "completed" }),
          board({ division_id: "d-live", name: "Spring League", status: "active" }),
        ]}
        onUndo={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toMatch(/data-board="d-done"[^>]*data-board-completed="true"/);
    expect(html).toMatch(/data-board="d-live"[^>]*data-board-completed="false"/);
    expect(html).toContain("Autumn League");
    expect(html).toContain("person overlap");
  });

  it("offers Undo for a live merge and not for one already reversed", () => {
    const html = renderToStaticMarkup(
      <MergeHistoryList
        entries={[
          { merge_id: "m-live", survivor_name: "Ada", absorbed_name: "A. Lovelace", reversed: false },
          { merge_id: "m-gone", survivor_name: "Bea", absorbed_name: "B. Bee", reversed: true },
        ]}
        onUndo={() => {}}
      />,
    );
    // The reversed merge stays in the log — it is the audit trail.
    expect(html).toMatch(/data-merge-entry="m-gone"/);
    expect(html).toMatch(/data-undo="m-live"/);
    expect(html).not.toMatch(/data-undo="m-gone"/);
  });
});

describe("DuplicatesPanel — the queue", () => {
  const candidate = (over: Partial<DupCandidate>): DupCandidate => ({
    a: SURVIVOR,
    b: ABSORBED,
    score: 4,
    evidence: [],
    ...over,
  });

  it("renders the evidence behind every candidate", () => {
    const html = renderToStaticMarkup(
      <DuplicatesPanel
        canEdit
        candidates={[
          candidate({
            evidence: [
              { kind: "name", detail: "ada lovelace" },
              { kind: "dob", detail: "1990-01-02" },
              { kind: "shared_entrant", detail: "Riverside Reds" },
            ],
          }),
          candidate({
            a: person({ id: "p3", full_name: "Grace Hopper" }),
            b: person({ id: "p4", full_name: "Grace Hopper" }),
            score: 1,
            evidence: [{ kind: "name", detail: "grace hopper" }],
          }),
        ]}
      />,
    );
    for (const detail of ["ada lovelace", "1990-01-02", "Riverside Reds", "grace hopper"]) {
      expect(html).toContain(detail);
    }
    expect(html).toContain("Same date of birth");
    expect(html).toContain("Plays for the same team");
    // The second pair has name evidence only, so its other meters are empty.
    expect(html).toMatch(/data-evidence-kind="shared_entrant"[^>]*data-evidence-on="false"/);
  });

  // Regression: the roster's own "Merge… → Keep this one" POSTed
  // `{ duplicate_id }` with no `confirmed`, which the route answers 422
  // MERGE_NOT_CONFIRMED. It routes through the same dialog now, so the
  // affirmation and the consent resolution are not optional on that path either.
  it("hand-picking a merge from the roster opens the confirmation instead of posting", () => {
    posted.calls.length = 0;
    // The roster's row actions are handed to ResponsiveTable as `render` props,
    // so `walk` alone never reaches them. ResponsiveTable is hookless and
    // server-safe, so expanding just that one child is safe.
    const expand = (node: ReactNode): ReactElement[] => {
      const out: ReactElement[] = [];
      for (const el of walk(node)) {
        out.push(el);
        if (el.type === ResponsiveTable) {
          out.push(
            ...walk((el.type as (p: unknown) => ReactNode)(el.props)),
          );
        }
      }
      return out;
    };
    const island = renderIsland(
      PersonsPanel,
      {
        persons: [
          { ...SURVIVOR, consent: SURVIVOR.consent as Record<string, boolean> },
          { ...ABSORBED, consent: ABSORBED.consent as Record<string, boolean> },
        ],
        storageBase: "",
        canEdit: true,
      },
      expand,
    );
    (propsFor(island, "data-merge-pick").onClick as () => void)();
    (propsFor(island, "data-keep-this").onClick as () => void)();
    expect(island.tree().some((el) => el.type === MergeConfirmDialog)).toBe(true);
    expect(posted.calls).toEqual([]);
  });

  it("reads as reassurance, not absence, when there is nothing to review", () => {
    const html = renderToStaticMarkup(<DuplicatesPanel canEdit candidates={[]} />);
    expect(html).toContain("No duplicates to review");
    expect(html).toMatch(/data-dupes-empty="true"/);
  });
});
