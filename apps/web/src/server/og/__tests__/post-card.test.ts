import { describe, expect, it } from "vitest";
import { postCardModel } from "@/server/og/post-card";

// The PURE model half of the news share card (mirrors og/model.test): the
// free-vs-Pro badge split and the scoreline decision are unit-tested without
// rendering a pixel (satori/ImageResponse can't be tree-inspected from a route).
const base = {
  branding: [null, null],
  orgName: "Riverside FC",
  logo: null,
};

describe("postCardModel", () => {
  it("free tier carries the seazn acquisition badge", () => {
    const m = postCardModel({ ...base, branded: false, kind: "news", title: "Hello" });
    expect(m.showBadge).toBe(true);
  });

  it("Pro (branded) drops the badge", () => {
    const m = postCardModel({ ...base, branded: true, kind: "news", title: "Hello" });
    expect(m.showBadge).toBe(false);
  });

  it("result posts render a scoreline; other kinds do not", () => {
    const result = postCardModel({
      ...base,
      branded: false,
      kind: "result",
      title: "Riverside 3–1 Northside",
    });
    expect(result.scoreline).toEqual({
      home: "Riverside",
      homeScore: "3",
      awayScore: "1",
      away: "Northside",
    });
    const recap = postCardModel({
      ...base,
      branded: false,
      kind: "round_recap",
      title: "Round 3 recap: Prem",
    });
    expect(recap.scoreline).toBeNull();
  });

  it("colors the accent bar by kind", () => {
    expect(postCardModel({ ...base, branded: false, kind: "result", title: "A 1–0 B" }).accent).toBe(
      "#a3e635",
    );
    expect(
      postCardModel({ ...base, branded: false, kind: "announcement", title: "News" }).accent,
    ).toBe("#ef4444");
  });
});
