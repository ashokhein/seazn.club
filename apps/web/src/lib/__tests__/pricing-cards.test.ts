import { describe, expect, it } from "vitest";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  ticketTiers,
} from "../pricing-cards";

describe("pricing cards", () => {
  it("stub bullets are drawn from the shared /pricing arrays (drift guard)", () => {
    const [community, pass, pro] = ticketTiers("usd");
    expect(community!.bullets.every((b) => FREE_FEATURES.includes(b))).toBe(true);
    expect(pass!.bullets.every((b) => PASS_FEATURES.includes(b))).toBe(true);
    expect(pro!.bullets.every((b) => PRO_FEATURES.includes(b))).toBe(true);
    expect(community!.bullets.length).toBeGreaterThanOrEqual(3);
  });
  it("prices come from lib/currency (multi-currency stays correct)", () => {
    const [, passUsd, proUsd] = ticketTiers("usd");
    expect(passUsd!.price).toBe("$39");
    expect(proUsd!.price).toBe("$20");
    expect(proUsd!.period).toBe("/mo");
    const [, passInr] = ticketTiers("inr");
    expect(passInr!.price).not.toBe("$39");
  });
  it("only the Event Pass glows", () => {
    expect(ticketTiers("usd").map((t) => Boolean(t.glow))).toEqual([false, true, false]);
  });
});
