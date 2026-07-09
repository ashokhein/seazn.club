import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONSENT_KEY,
  CONSENT_VERSION_KEY,
  COOKIE_POLICY_VERSION,
  analyticsConsented,
  needsConsentPrompt,
} from "@/lib/consent";

// Minimal localStorage for the node test env.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

describe("consent gating", () => {
  it("first visit: prompt, no capture", () => {
    expect(needsConsentPrompt()).toBe(true);
    expect(analyticsConsented()).toBe(false);
  });

  it("accepted against the current policy: capture, no prompt", () => {
    localStorage.setItem(CONSENT_KEY, "accepted");
    localStorage.setItem(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION);
    expect(analyticsConsented()).toBe(true);
    expect(needsConsentPrompt()).toBe(false);
  });

  it("policy changed since consent: re-prompt and stop capturing", () => {
    localStorage.setItem(CONSENT_KEY, "accepted");
    localStorage.setItem(CONSENT_VERSION_KEY, "2000-01-01"); // stale version
    expect(analyticsConsented()).toBe(false);
    expect(needsConsentPrompt()).toBe(true);
  });

  it("rejected: no capture, no prompt", () => {
    localStorage.setItem(CONSENT_KEY, "rejected");
    localStorage.setItem(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION);
    expect(analyticsConsented()).toBe(false);
    expect(needsConsentPrompt()).toBe(false);
  });
});
