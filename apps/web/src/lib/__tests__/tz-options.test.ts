import { describe, expect, it } from "vitest";
import { TZ_ALIAS, TZ_META } from "@/lib/tz-data";
import {
  canonicalZone,
  groupByRegion,
  listZoneOptions,
  searchZones,
  zoneCity,
  TZ_REGIONS,
} from "@/lib/tz-options";

const options = listZoneOptions("en");

describe("tz-data completeness", () => {
  // The generated table is committed, not built. This is the guard that a
  // tzdata bump in the runtime cannot silently outrun it: every zone Intl is
  // willing to hand out must be either canonical or a known alias, or the
  // picker would quietly drop it.
  it("covers every zone the runtime reports", () => {
    const zones =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? [];
    expect(zones.length).toBeGreaterThan(100);
    const unknown = zones.filter((z) => !TZ_META[z] && !TZ_ALIAS[z]);
    expect(unknown).toEqual([]);
  });

  it("every alias resolves to a canonical zone", () => {
    for (const [from, to] of Object.entries(TZ_ALIAS)) {
      expect(TZ_META[from], `${from} is an alias, so must not be canonical`).toBeUndefined();
      expect(TZ_META[to], `${from} -> ${to} must be canonical`).toBeDefined();
    }
  });

  it("every zone carries a country and a known region", () => {
    for (const [zone, [cc, region]] of Object.entries(TZ_META)) {
      expect(cc, zone).toMatch(/^[A-Z]{2}$/);
      expect(TZ_REGIONS, zone).toContain(region);
    }
  });
});

describe("regions are geography, not IANA prefix", () => {
  // The complaint this work started from: every Gulf state lives under the
  // `Asia/` prefix, so grouping by prefix filed Dubai between Tokyo and
  // Kolkata. Region comes from the COUNTRY now.
  it("files Dubai under Middle East, not Asia", () => {
    expect(TZ_META["Asia/Dubai"]).toEqual(["AE", "middle-east"]);
    const dubai = options.find((o) => o.zone === "Asia/Dubai")!;
    expect(dubai.region).toBe("middle-east");
    expect(dubai.country).toBe("United Arab Emirates");
  });

  it("files the rest of the Gulf and the Levant under Middle East too", () => {
    for (const zone of [
      "Asia/Qatar",
      "Asia/Riyadh",
      "Asia/Kuwait",
      "Asia/Bahrain",
      "Asia/Muscat",
      "Asia/Baghdad",
      "Asia/Beirut",
      "Asia/Jerusalem",
      "Europe/Istanbul", // Turkey, despite the Europe/ spelling
    ]) {
      expect(TZ_META[zone]?.[1], zone).toBe("middle-east");
    }
  });

  it("keeps South Asia and East Asia apart", () => {
    expect(TZ_META["Asia/Kolkata"][1]).toBe("south-asia");
    expect(TZ_META["Asia/Karachi"][1]).toBe("south-asia");
    expect(TZ_META["Asia/Tokyo"][1]).toBe("east-asia");
    expect(TZ_META["Asia/Shanghai"][1]).toBe("east-asia");
    expect(TZ_META["Asia/Singapore"][1]).toBe("southeast-asia");
  });

  it("does not file Siberia under Europe just because Russia is European", () => {
    expect(TZ_META["Europe/Moscow"][1]).toBe("europe");
    expect(TZ_META["Asia/Kamchatka"][1]).toBe("central-asia");
    expect(TZ_META["Asia/Novosibirsk"][1]).toBe("central-asia");
  });
});

describe("listZoneOptions", () => {
  it("returns the full set, one row per canonical zone", () => {
    expect(options.length).toBe(Object.keys(TZ_META).length);
    expect(options.length).toBeGreaterThan(400);
  });

  it("never lists the same city twice — the bug the old 6-entry rename left", () => {
    // listTimezones() used to canonicalize only six legacy spellings, so
    // America/Cordoba and America/Argentina/Cordoba both survived the Set and
    // the dropdown showed Córdoba, Mendoza and Jujuy twice each.
    const zones = options.map((o) => o.zone);
    expect(new Set(zones).size).toBe(zones.length);
    for (const legacy of ["America/Cordoba", "America/Mendoza", "America/Jujuy", "Asia/Calcutta"]) {
      expect(zones).not.toContain(legacy);
      expect(canonicalZone(legacy)).not.toBe(legacy);
      expect(zones).toContain(canonicalZone(legacy));
    }
  });

  it("humanises the city and localises the country", () => {
    const hcm = options.find((o) => o.zone === "Asia/Ho_Chi_Minh")!;
    expect(hcm.city).toBe("Ho Chi Minh");
    expect(zoneCity("America/Indiana/Knox")).toBe("Knox");
    expect(options.find((o) => o.zone === "Europe/Paris")!.country).toBe("France");
    expect(listZoneOptions("fr").find((o) => o.zone === "Europe/Berlin")!.country).toBe(
      "Allemagne",
    );
  });
});

describe("searchZones", () => {
  it("ranks an exact city first", () => {
    expect(searchZones(options, "dubai")[0].zone).toBe("Asia/Dubai");
    expect(searchZones(options, "tokyo")[0].zone).toBe("Asia/Tokyo");
  });

  it("puts city prefixes above everything else", () => {
    const hits = searchZones(options, "dub").map((o) => o.zone);
    expect(hits.slice(0, 2).sort()).toEqual(["Asia/Dubai", "Europe/Dublin"]);
  });

  it("matches on country as well as city", () => {
    const hits = searchZones(options, "emirates").map((o) => o.zone);
    expect(hits).toContain("Asia/Dubai");
    const india = searchZones(options, "india").map((o) => o.zone);
    expect(india).toContain("Asia/Kolkata");
  });

  it("matches on a path segment that is neither city nor country", () => {
    // "Indiana" appears only in the zone path.
    const hits = searchZones(options, "indiana").map((o) => o.zone);
    expect(hits).toContain("America/Indiana/Knox");
  });

  it("matches on the ISO country code", () => {
    expect(searchZones(options, "ae").map((o) => o.zone)).toContain("Asia/Dubai");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchZones(options, "zzzznotaplace")).toEqual([]);
  });

  it("returns the WHOLE list for an empty query, not a truncated head", () => {
    // Regression: the result cap used to apply to the empty query too, so the
    // browsable list stopped after 60 cities alphabetically — everything from
    // Bogota onwards, and every region after Africa, was simply absent.
    expect(searchZones(options, "  ")).toHaveLength(options.length);
    expect(searchZones(options, "")).toHaveLength(options.length);
    const regions = new Set(searchZones(options, "").map((o) => o.region));
    expect(regions.size).toBe(new Set(options.map((o) => o.region)).size);
  });

  it("caps an actual search so a broad query stays responsive", () => {
    expect(searchZones(options, "a", 10)).toHaveLength(10);
  });
});

describe("groupByRegion", () => {
  it("orders regions as TZ_REGIONS declares and drops empty ones", () => {
    const groups = groupByRegion(options);
    const regions = groups.map(([region]) => region);
    expect(regions).toEqual(TZ_REGIONS.filter((r) => regions.includes(r)));
    for (const [, list] of groups) expect(list.length).toBeGreaterThan(0);
  });

  it("keeps every row — grouping loses nothing", () => {
    const total = groupByRegion(options).reduce((n, [, list]) => n + list.length, 0);
    expect(total).toBe(options.length);
  });

  it("groups a filtered list without inventing empty headings", () => {
    const groups = groupByRegion(searchZones(options, "dub"));
    expect(groups.map(([r]) => r).sort()).toEqual(["europe", "middle-east"]);
  });
});
