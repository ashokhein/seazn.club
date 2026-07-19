import { describe, expect, it } from "vitest";
import { orgAssetPrefix, safeOrgHeroUrl } from "@/server/news/public-view";

// SECURITY (T82 review): a post's hero_image_path is org-authored and lands on a
// public page. It must be confined to THIS org's public-storage prefix before it
// reaches an <img src> — an external host, a data: URI, or another org's path is
// rejected (null → no hero, fall back to the scorebug/title).
const SB = "https://proj.supabase.co";
const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("safeOrgHeroUrl", () => {
  it("accepts a full URL under this org's assets prefix", () => {
    const url = `${orgAssetPrefix(ORG, SB)}content/abc.png`;
    expect(safeOrgHeroUrl(url, ORG, SB)).toBe(url);
  });

  it("resolves a bare org storage path to a public URL", () => {
    expect(safeOrgHeroUrl(`orgs/${ORG}/content/abc.png`, ORG, SB)).toBe(
      `${SB}/storage/v1/object/public/assets/orgs/${ORG}/content/abc.png`,
    );
  });

  it("rejects another org's path", () => {
    expect(safeOrgHeroUrl(`orgs/${OTHER}/content/abc.png`, ORG, SB)).toBeNull();
    expect(safeOrgHeroUrl(`${orgAssetPrefix(OTHER, SB)}content/abc.png`, ORG, SB)).toBeNull();
  });

  it("rejects external + data: + javascript: values", () => {
    expect(safeOrgHeroUrl("https://evil.example/x.png", ORG, SB)).toBeNull();
    expect(safeOrgHeroUrl("data:image/png;base64,AAAA", ORG, SB)).toBeNull();
    expect(safeOrgHeroUrl("javascript:alert(1)", ORG, SB)).toBeNull();
  });

  it("returns null for empty / missing values", () => {
    expect(safeOrgHeroUrl(null, ORG, SB)).toBeNull();
    expect(safeOrgHeroUrl("   ", ORG, SB)).toBeNull();
    expect(safeOrgHeroUrl("orgs/x", ORG, "")).toBeNull();
  });
});
