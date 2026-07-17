// PROMPT-32 golden/unit acceptance: chip-state vocabulary, logo fallback
// chain, typed-confirm arming, messages interpolation, division hue
// stability. All pure — the e2e suite covers the rendered behaviour.
import { describe, expect, it } from "vitest";
import {
  competitionChipState,
  divisionChipState,
  CHIP_SORT,
} from "@/components/ui/status-chip";
import { initials } from "@/components/ui/entity-logo";
import { isConfirmArmed } from "@/lib/typed-confirm";
import { msg, messages } from "@/lib/messages";
import { divisionHue, divisionAccent } from "@/lib/division-hue";
import { formatLabel, nextLine } from "@/server/usecases/card-stats";

describe("status chip vocabulary (v3/03 §1)", () => {
  it("maps competition statuses to the five chip states", () => {
    expect(competitionChipState("draft")).toBe("draft");
    expect(competitionChipState("published")).toBe("registration");
    expect(competitionChipState("live")).toBe("live");
    expect(competitionChipState("completed")).toBe("completed");
    expect(competitionChipState("archived")).toBe("archived");
    expect(competitionChipState("live", { archived: true })).toBe("archived");
  });

  it("maps division statuses; a registration window promotes setup", () => {
    expect(divisionChipState("setup")).toBe("draft");
    expect(divisionChipState("setup", { registrationOpen: true })).toBe("registration");
    expect(divisionChipState("scheduled")).toBe("scheduled");
    expect(divisionChipState("active")).toBe("live");
    expect(divisionChipState("completed")).toBe("completed");
    expect(divisionChipState("active", { archived: true })).toBe("archived");
  });

  it("sorts Live first, then Registration open, Draft, Completed, Archived", () => {
    const order = ["archived", "draft", "live", "completed", "registration"] as const;
    const sorted = [...order].sort((a, b) => CHIP_SORT[a] - CHIP_SORT[b]);
    expect(sorted).toEqual(["live", "registration", "draft", "completed", "archived"]);
  });
});

describe("EntityLogo fallback chain (v3/03 §5)", () => {
  it("initials: single word takes two letters, multi-word takes first+last", () => {
    expect(initials("Riverside")).toBe("RI");
    expect(initials("Northside Netters")).toBe("NN");
    expect(initials("A B C United")).toBe("AU");
    expect(initials("  ")).toBe("?");
  });
});

describe("typed-confirm arming (v3/03 §3)", () => {
  it("no challenge → armed", () => {
    expect(isConfirmArmed(undefined, "")).toBe(true);
  });
  it("mismatch blocks confirm; exact match arms", () => {
    expect(isConfirmArmed("U16 Boys", "")).toBe(false);
    expect(isConfirmArmed("U16 Boys", "u16 boys")).toBe(false);
    expect(isConfirmArmed("U16 Boys", "U16 Boys ")).toBe(false);
    expect(isConfirmArmed("U16 Boys", "U16 Boys")).toBe(true);
  });
});

describe("messages layer (v3/11 gap 4)", () => {
  it("interpolates placeholders and leaves unknown ones intact", () => {
    expect(msg("confirm.leaveOrg.body", { name: "Acme" })).toContain("Acme");
    expect(msg("confirm.typed.instruction")).toContain("{name}");
  });
  it("every message is non-empty English", () => {
    for (const [key, value] of Object.entries(messages)) {
      expect(value.length, key).toBeGreaterThan(0);
    }
  });
});

describe("division hue (v3/03 §1)", () => {
  it("is stable for an id and stays off the brand violet band (260–290°)", () => {
    const id = "3c9f1c2e-1111-4eee-9c60-000000000042";
    expect(divisionHue(id)).toBe(divisionHue(id));
    for (let i = 0; i < 50; i++) {
      const hue = divisionHue(`division-${i}`);
      expect(hue < 260 || hue > 290).toBe(true);
    }
    expect(divisionAccent(id)).toMatch(/^hsl\(\d+ 62% 48%\)$/);
  });
});

describe("card meta lines (v3/03 §1)", () => {
  it("formatLabel names real structures", () => {
    expect(formatLabel([])).toBeNull();
    expect(formatLabel(["knockout"])).toBe("Knockout");
    expect(formatLabel(["group", "knockout"])).toBe("Groups + Knockout");
  });
  it("nextLine is null-safe on TBD entrants and unscheduled fixtures", () => {
    expect(nextLine(null, "en")).toBeNull();
    expect(
      nextLine(
        { home: "Arun", away: null, court_label: null, scheduled_at: null, in_play: false },
        "en",
      ),
    ).toEqual({ text: "Arun vs TBD", live: false });
  });

  it("nextLine reports `live` separately instead of baking a 'Now:' prefix into the text — the caller (EntityCard) picks exactly one label, so a live fixture never renders both 'Next:' and 'Now:' stacked together (design/fix-ui/02-console-org.md)", () => {
    const line = nextLine(
      { home: "A", away: "B", court_label: "Court 2", scheduled_at: null, in_play: true },
      "en",
    );
    expect(line).toEqual({ text: "A vs B · Court 2", live: true });
    // No baked-in label of either kind — the raw fixture text alone.
    expect(line?.text).not.toMatch(/^(Next|Now):/);
  });

  it("nextLine formats the scheduled time using the given locale, not a hardcoded en-GB string", () => {
    const at = new Date();
    at.setDate(at.getDate() + 3); // outside "same day" so weekday/month render
    const line = nextLine(
      { home: "A", away: "B", court_label: null, scheduled_at: at.toISOString(), in_play: false },
      "fr",
    );
    // French weekday/month abbreviations use lowercase + a trailing period
    // ("mar.", "juil."), unlike the English "Tue"/"Jul" the old hardcoded
    // en-GB formatter always produced regardless of locale.
    expect(line?.text).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
  });
});

describe("pin tip copy (PROMPT-33 follow-up)", () => {
  it("schedule.locking explains BOTH halves: auto passes skip pins, manual moves still work", async () => {
    const { TIPS } = await import("@/config/tips");
    const tip = TIPS["schedule.locking"];
    // The old copy implied a pinned slot was immovable — it isn't. Any future
    // edit must keep saying that manual moves stay allowed and point at the
    // division freeze for full read-only.
    expect(tip.body).toMatch(/Auto-schedule|auto pass/i);
    expect(tip.body).toMatch(/still drag|move .* yourself/i);
    expect(tip.body).toMatch(/freeze/i);
  });
});
