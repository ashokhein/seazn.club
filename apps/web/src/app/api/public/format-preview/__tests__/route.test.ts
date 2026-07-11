import { describe, expect, it } from "vitest";
import { POST } from "../route";

function req(body: unknown, ip = "203.0.113.7") {
  return new Request("http://localhost/api/public/format-preview", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/public/format-preview", () => {
  it("returns phases for a valid request, no auth required", async () => {
    const res = await POST(req({ format: "groups-knockout", entrants: 8 }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { phases: Array<{ sections: unknown[] }> };
    };
    expect(json.ok).toBe(true);
    expect(json.data.phases).toHaveLength(2);
    expect(json.data.phases[0]!.sections.length).toBeGreaterThan(0);
  });

  it("rejects unknown formats and out-of-range entrants", async () => {
    expect((await POST(req({ format: "swiss", entrants: 8 }))).status).toBe(400);
    expect((await POST(req({ format: "league", entrants: 3 }))).status).toBe(400);
    expect((await POST(req({ format: "league", entrants: 17 }))).status).toBe(400);
  });
});
