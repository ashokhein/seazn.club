// #382 — the eviction notice, read off the rendered panel.
//
// `usecases/__tests__/history.test.ts` pins that `createCheckpoint` RETURNS an
// `evicted` field. Nothing there says the organiser is ever told. A save that
// silently drops a bookmark is the whole failure mode this change is supposed
// to avoid, so the join between the API's answer and the sentence on screen
// needs its own witness.
//
// A static `renderToStaticMarkup` cannot reach it: the notice only exists AFTER
// a submit, so this drives the real island — state, effects, the English
// catalog, the output tree — through the shared hook harness.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

// `useConfirm` throws outside its provider by design; the harness's useContext
// hands back the context default, which is that null. Everything else in the
// panel runs for real — `useMsg` falls back to the English catalog outside a
// DictProvider, which IS the production path, so the sentences below are the
// shipped ones rather than dictionary keys.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const apiV1 = vi.fn();
vi.mock("@/lib/client-v1", () => ({
  apiV1: (...args: unknown[]) => apiV1(...args),
  ApiV1Error: class extends Error {},
}));

const { HistoryPanel } = await import("../history-panel");

const cp = (id: string, label: string) => ({
  id,
  seq: 1,
  label,
  kind: "manual" as const,
  created_at: "2026-08-05T10:00:00.000Z",
});

/** The panel's two mount reads, plus the POST the submit makes.
 *  `createReturns` is what `POST /checkpoints` answers with. */
function stubApi(createReturns: unknown, after: ReturnType<typeof cp>[]) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return createReturns;
    if (path.endsWith("/history")) return { watermark: 1, seq: 1, events: [] };
    return after;
  });
}

/** Type a label and submit the create form, then let the panel's reload settle. */
async function saveNamed(
  island: ReturnType<typeof renderIsland<Record<string, unknown>>>,
  label: string,
) {
  const input = island
    .tree()
    .find((el: ReactElement) => propsOf(el)["aria-label"] === "Save point label");
  (propsOf(input!).onChange as (e: unknown) => void)({ target: { value: label } });
  const form = island.tree().find((el: ReactElement) => el.type === "form");
  (propsOf(form!).onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
  // The submit handler is fire-and-forget (`void run(...)`); let its awaits and
  // the reload that follows drain before reading the tree.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const render = () =>
  renderIsland(
    (props: Record<string, unknown>) =>
      HistoryPanel(props as { divisionId: string; scheduleLocked: boolean; canEdit: boolean }),
    { divisionId: "d1", scheduleLocked: false, canEdit: true },
  );

describe("HistoryPanel — the save-point eviction notice (#382)", () => {
  it("names the save point that was replaced, and how many the plan keeps", async () => {
    stubApi(
      { ...cp("c3", "three"), evicted: { id: "c1", label: "before rain reshuffle" } },
      [cp("c3", "three"), cp("c2", "two")],
    );
    const island = render();
    await saveNamed(island, "three");

    const text = textOf(island.tree());
    // The interpolated NAME, not just the key: a sentence that renders
    // "“{name}” was replaced" satisfies a key-level assertion and tells the
    // organiser nothing.
    expect(text).toContain("“before rain reshuffle” was replaced");
    // The count is the manual group's own length — two survivors on community.
    expect(text).toContain("your plan keeps 2 save points");
    // And the reassurance, or the notice reads as data loss.
    expect(text).toContain("Undo still rewinds past it");
  });

  it("says nothing when the save evicted nothing", async () => {
    stubApi(cp("c1", "one"), [cp("c1", "one")]);
    const island = render();
    await saveNamed(island, "one");

    const text = textOf(island.tree());
    expect(text).not.toContain("was replaced");
    expect(text).not.toContain("Undo still rewinds past it");
  });

  it("is a notice, not a paywall — no UpgradeGate is rendered", async () => {
    stubApi(
      { ...cp("c3", "three"), evicted: { id: "c1", label: "one" } },
      [cp("c3", "three"), cp("c2", "two")],
    );
    const island = render();
    await saveNamed(island, "three");

    // The 402 path renders <UpgradeGate>. Nothing was refused here, so the
    // organiser must not be shown one.
    const gates = island
      .tree()
      .filter((el: ReactElement) => typeof el.type === "function" && el.type.name === "UpgradeGate");
    expect(gates).toHaveLength(0);
    expect(textOf(island.tree())).toContain("was replaced");
  });

  it("clears the notice when the next action is not a save", async () => {
    stubApi(
      { ...cp("c3", "three"), evicted: { id: "c1", label: "one" } },
      [cp("c3", "three"), cp("c2", "two")],
    );
    const island = render();
    await saveNamed(island, "three");
    expect(textOf(island.tree())).toContain("was replaced");

    // Undo. A notice left standing beside an unrelated action would claim that
    // action dropped a save point.
    const undo = island
      .tree()
      .find(
        (el: ReactElement) => el.type === "button" && textOf(propsOf(el).children).includes("Undo"),
      );
    (propsOf(undo!).onClick as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(textOf(island.tree())).not.toContain("was replaced");
  });
});
