// Registry & versioning — spec 03 §3, PROMPT-03 §2. Divisions pin the module
// version at creation; two versions of one sport resolve independently.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generic } from "../sports/generic/generic.ts";
import type { AnySportModule } from "./module.ts";
import { compareSemver, createRegistry, parseSemver, registry } from "./registry.ts";

const genericV11: AnySportModule = { ...generic, version: "1.1.0" };

describe("parseSemver", () => {
  it("parses strict x.y.z", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it.each(["1.0", "v1.0.0", "1.0.0-beta", "1..0", "one.two.three", ""])(
    "rejects %j with CONFIG_INVALID",
    (version) => {
      expect(() => parseSemver(version)).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    },
  );

  it("compares numerically, not lexically", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.0.1", "1.0.1")).toBe(0);
    expect(compareSemver("0.9.9", "1.0.0")).toBeLessThan(0);
  });
});

describe("registry", () => {
  it("resolves two versions of generic independently (version pinning)", () => {
    const reg = createRegistry();
    reg.register(generic);
    reg.register(genericV11);
    expect(reg.get("generic", "1.0.0")).toBe(generic);
    expect(reg.get("generic", "1.1.0")).toBe(genericV11);
    expect(reg.get("generic", "1.0.0").version).toBe("1.0.0");
  });

  it("latest() picks the highest semver, not insertion order", () => {
    const reg = createRegistry();
    reg.register(genericV11);
    reg.register(generic);
    reg.register({ ...generic, version: "1.2.10" });
    reg.register({ ...generic, version: "1.2.9" });
    expect(reg.latest("generic").version).toBe("1.2.10");
  });

  it("throws MODULE_DUPLICATE on duplicate key+version registration", () => {
    const reg = createRegistry();
    reg.register(generic);
    expect(() => reg.register({ ...generic })).toThrowError(
      expect.objectContaining({ code: "MODULE_DUPLICATE" }),
    );
    // a different version of the same key is fine
    expect(() => reg.register(genericV11)).not.toThrow();
  });

  it("throws MODULE_NOT_FOUND on unknown key or version", () => {
    const reg = createRegistry();
    reg.register(generic);
    expect(() => reg.get("generic", "9.9.9")).toThrowError(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
    expect(() => reg.get("quidditch", "1.0.0")).toThrowError(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
    expect(() => reg.latest("quidditch")).toThrowError(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
  });

  it("rejects modules with a bad version or empty key at registration", () => {
    const reg = createRegistry();
    expect(() => reg.register({ ...generic, version: "latest" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => reg.register({ ...generic, key: "" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("exposes a shared default instance", () => {
    expect(EngineError.is(catchErr(() => registry.latest("__nope__")), "MODULE_NOT_FOUND")).toBe(
      true,
    );
  });
});

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
