import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureConsole } from "@/components/v2/fixture-console";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Hydration regression (2026-07-13 e2e run): the fixture console SSR'd
// wall-clock strings with the runtime's locale/timezone (raw
// toLocaleTimeString/toLocaleString), so server HTML never matched the
// visitor's hydration render — React logged a mismatch and re-rendered the
// tree client-side on every fixture page view. Contract: SSR output contains
// NO wall-clock time; viewer-local times fill in after mount (ClientTime,
// which renders an empty suppressed span on the server).
describe("FixtureConsole SSR determinism", () => {
  it("server markup contains no locale/timezone-dependent time strings", () => {
    const html = renderToStaticMarkup(
      <FixtureConsole
        fixture={{
          id: "f1",
          status: "in_progress",
          scheduled_at: "2026-07-13T18:30:00.000Z",
          venue: "Centre Court",
          court_label: "1",
          round_no: 2,
        }}
        sport={{
          key: "football",
          config: {},
          scorerLabel: "Referee",
          positionGroups: [],
          roles: [],
          lineupSize: 0,
          fidelityTiers: [],
        }}
        home={{ id: "e1", name: "Riverside FC", members: [], lineup: [] }}
        away={{ id: "e2", name: "Summit Athletic", members: [], lineup: [] }}
        initialState={{
          status: "in_progress",
          last_seq: 2,
          summary: null,
          state: {},
          outcome: null,
        }}
        initialEvents={[
          {
            id: "ev1",
            seq: 1,
            type: "football.goal",
            payload: {},
            recorded_at: "2026-07-13T18:45:12.000Z",
            recorded_by: null,
            device_link_id: null,
            voids_event_id: null,
          },
        ]}
        canEdit={false}
      />,
    );
    // Sanity: the sections that used to embed times are actually rendered.
    expect(html).toContain("Round 2");
    expect(html).toContain("#1");
    // The contract: no HH:MM anywhere in server-rendered markup.
    expect(html).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  });
});
