// Pins the revalidation profiles (smoke 2026-07-10 regression): spectator
// tags (division/competition/discovery) use "max" — stale-while-revalidate is
// right for scoreboards — but org chrome writes come from an admin who
// immediately views their public page, so the org tag must expire NOW.
// Under "max" the very next request serves the stale page and the org color
// never shows up ("pro org landing carries the org color" smoke failure).
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));
vi.mock("@/lib/cache", () => ({ cacheDelPattern: vi.fn() }));
vi.mock("@/server/public-site/data", () => ({
  divisionTag: (id: string) => `division:${id}`,
  competitionTag: (id: string) => `competition:${id}`,
  orgTag: (slug: string) => `org-public:${slug}`,
  DISCOVERY_TAG: "discovery",
}));

import {
  fireDivisionRevalidate,
  fireOrgRevalidate,
  fireDiscoveryRevalidate,
} from "../revalidate";

beforeEach(() => revalidateTag.mockClear());

describe("public-site revalidation profiles", () => {
  it("org chrome expires immediately (read-your-writes)", () => {
    fireOrgRevalidate("my-org");
    expect(revalidateTag).toHaveBeenCalledWith("org-public:my-org", { expire: 0 });
  });

  it("division/competition tags keep stale-while-revalidate", () => {
    fireDivisionRevalidate("d1", "c1");
    expect(revalidateTag).toHaveBeenCalledWith("division:d1", "max");
    expect(revalidateTag).toHaveBeenCalledWith("competition:c1", "max");
  });

  it("discovery tag keeps stale-while-revalidate", () => {
    fireDiscoveryRevalidate();
    expect(revalidateTag).toHaveBeenCalledWith("discovery", "max");
  });

  it("swallows revalidateTag throwing outside a request scope", () => {
    revalidateTag.mockImplementationOnce(() => {
      throw new Error("static generation store missing");
    });
    expect(() => fireOrgRevalidate("my-org")).not.toThrow();
  });
});
