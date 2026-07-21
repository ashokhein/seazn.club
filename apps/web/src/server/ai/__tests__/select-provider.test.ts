import { describe, it, expect, beforeEach } from "vitest";
import { selectProvider } from "../select-provider";

beforeEach(() => {
  delete process.env.AI_PROVIDER;
});

describe("provider selection", () => {
  it("defaults to anthropic when AI_PROVIDER is unset", () => {
    expect(selectProvider().id).toBe("anthropic");
  });

  it("selects openrouter when asked", () => {
    process.env.AI_PROVIDER = "openrouter";
    expect(selectProvider().id).toBe("openrouter");
  });

  it("falls back to anthropic on an unrecognised value rather than failing a run", () => {
    process.env.AI_PROVIDER = "tuesday";
    expect(selectProvider().id).toBe("anthropic");
  });
});
