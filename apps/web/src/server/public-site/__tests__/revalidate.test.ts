// Pins the revalidation profiles (smoke 2026-07-10 regression): spectator
// tags (division/competition/discovery) use "max" — stale-while-revalidate is
// right for scoreboards — but org chrome writes come from an admin who
// immediately views their public page, so the org tag must expire NOW.
// Under "max" the very next request serves the stale page and the org color
// never shows up ("pro org landing carries the org color" smoke failure).
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateTag = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag, revalidatePath }));
vi.mock("@/lib/cache", () => ({ cacheDelPattern: vi.fn() }));
vi.mock("@/server/public-site/data", () => ({
  divisionTag: (id: string) => `division:${id}`,
  competitionTag: (id: string) => `competition:${id}`,
  orgTag: (slug: string) => `org-public:${slug}`,
  DISCOVERY_TAG: "discovery",
}));
const broadcastRevalidate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/peer-revalidate", () => ({ broadcastRevalidate }));
// Task 7: CDN purge fires alongside the peer broadcast at the same seam —
// mocked here purely to assert the wiring, not purgeCdn's own behavior
// (that's cdn-purge.test.ts's job).
const purgeCdn = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/cdn-purge", () => ({ purgeCdn }));

import {
  fireDivisionRevalidate,
  fireOrgRevalidate,
  fireDiscoveryRevalidate,
  firePostRevalidate,
} from "../revalidate";

beforeEach(() => {
  revalidateTag.mockClear();
  revalidatePath.mockClear();
  broadcastRevalidate.mockClear();
  purgeCdn.mockClear();
});

describe("public-site revalidation profiles", () => {
  it("org chrome expires immediately (read-your-writes)", () => {
    fireOrgRevalidate("my-org");
    expect(revalidateTag).toHaveBeenCalledWith("org-public:my-org", { expire: 0 });
  });

  it("org chrome broadcast fans out with expire mode", () => {
    fireOrgRevalidate("riverside");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["org-public:riverside"], "expire");
  });

  it("division/competition tags keep stale-while-revalidate", () => {
    fireDivisionRevalidate("d1", "c1");
    expect(revalidateTag).toHaveBeenCalledWith("division:d1", "max");
    expect(revalidateTag).toHaveBeenCalledWith("competition:c1", "max");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["division:d1", "competition:c1"], "swr");
  });

  it("division-only broadcast omits the competition tag when none is passed", () => {
    fireDivisionRevalidate("d1");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["division:d1"], "swr");
  });

  it("discovery tag keeps stale-while-revalidate", () => {
    fireDiscoveryRevalidate();
    expect(revalidateTag).toHaveBeenCalledWith("discovery", "max");
    expect(broadcastRevalidate).toHaveBeenCalledWith(["discovery"], "swr");
  });

  it("swallows revalidateTag throwing outside a request scope", () => {
    revalidateTag.mockImplementationOnce(() => {
      throw new Error("static generation store missing");
    });
    expect(() => fireOrgRevalidate("my-org")).not.toThrow();
    // Broadcast is unconditional — it must still fire even though the local
    // revalidateTag call above threw (outside-request-scope path).
    expect(broadcastRevalidate).toHaveBeenCalledWith(["org-public:my-org"], "expire");
  });
});

// Task 7 (spec 2026-07-12 §3 A-step 1): a CDN purge must fire alongside the
// peer broadcast at every revalidation seam — otherwise a stray rendering
// change can go un-cached (or a purge can silently stop happening) with no
// test ever catching it. This is a pure wiring check: purgeCdn's own
// behavior (debounce, fail-open, env-gating) is covered by cdn-purge.test.ts.
describe("CDN purge fires alongside peer broadcast (Task 7)", () => {
  it("fireDivisionRevalidate calls purgeCdn", () => {
    fireDivisionRevalidate("d1", "c1");
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });

  it("fireOrgRevalidate calls purgeCdn", () => {
    fireOrgRevalidate("riverside");
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });

  it("fireDiscoveryRevalidate calls purgeCdn", () => {
    fireDiscoveryRevalidate();
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });
});

// News post pages are route-level ISR with no fetch tags — status flips purge
// by PATH (post page + feed) so archive/republish takes effect immediately on
// the serving instance (the CI smoke "archived post page 404s publicly" check
// fails without this).
describe("firePostRevalidate (news post status flips)", () => {
  it("purges the post page and the feed by path", () => {
    firePostRevalidate("riverside", "summer-schedule");
    expect(revalidatePath).toHaveBeenCalledWith("/shared/riverside/news/summer-schedule");
    expect(revalidatePath).toHaveBeenCalledWith("/shared/riverside/news");
  });

  it("swallows revalidatePath throwing outside a request scope, still purges CDN", () => {
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("static generation store missing");
    });
    expect(() => firePostRevalidate("riverside", "old-notice")).not.toThrow();
    expect(purgeCdn).toHaveBeenCalledTimes(1);
  });
});
