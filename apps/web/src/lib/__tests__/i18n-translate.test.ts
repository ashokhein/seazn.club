import { describe, it, expect, vi } from "vitest";
// Cross-tree import: the pipeline lives in scripts/, tested by the apps/web
// vitest via a relative path (same pattern as the other i18n CLI utils).
import { translateBatch } from "../../../../../scripts/i18n/translate.ts";

describe("translateBatch", () => {
  it("returns {} and never calls the model for empty entries", async () => {
    const create = vi.fn();
    const out = await translateBatch({ messages: { create } } as never, {
      locale: "fr",
      entries: {},
      glossary: {},
    });
    expect(out).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  it("calls the model once and parses the structured JSON reply", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ "a.b": "Nouveau" }) }],
    });
    const out = await translateBatch({ messages: { create } } as never, {
      locale: "fr",
      entries: { "a.b": "New" },
      glossary: { doNotTranslate: ["Seazn Club"] },
    });
    expect(out["a.b"]).toBe("Nouveau");
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0][0] as {
      model: string;
      output_config: { format: { type: string } };
    };
    expect(arg.model).toBe("claude-opus-4-8");
    expect(arg.output_config.format.type).toBe("json_schema");
  });
});
