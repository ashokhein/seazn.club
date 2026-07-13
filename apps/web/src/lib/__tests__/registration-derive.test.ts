// PROMPT-52: organiser console derivations are pure functions over the row
// set the panel already loads — spec 2026-07-13 "Data" section. Semantics
// (who holds a spot, what counts as due) mirror spec 2026-07-12 §2.
import { describe, expect, it } from "vitest";
import {
  duplicateContactIds,
  registrationPulse,
  waitlistPositions,
  type DerivableReg,
} from "../registration-derive";

let n = 0;
const reg = (patch: Partial<DerivableReg>): DerivableReg => ({
  id: `r${++n}`,
  status: "confirmed",
  contact_email: `p${n}@x.test`,
  amount_cents: 0,
  refunded_cents: 0,
  refunded_at: null,
  payment_method: null,
  expires_at: null,
  disputed_at: null,
  created_at: new Date(2026, 0, n).toISOString(),
  ...patch,
});

describe("registrationPulse", () => {
  it("counts spot-holders and waitlist against capacity", () => {
    const rows = [
      reg({ status: "confirmed" }),
      reg({ status: "pending" }),
      reg({ status: "paid" }),
      reg({ status: "waitlisted" }),
      reg({ status: "withdrawn" }),
      reg({ status: "expired" }),
    ];
    const p = registrationPulse(rows, 4);
    expect(p).toMatchObject({ confirmed: 1, holding: 2, waitlisted: 1, capacity: 4 });
  });

  it("rolls up money: paid, due, refund-incomplete, disputed, next expiry", () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 7_200_000).toISOString();
    const rows = [
      reg({ status: "confirmed", amount_cents: 1900, payment_method: "stripe" }),
      reg({ status: "pending", amount_cents: 1900, payment_method: "stripe", expires_at: later }),
      reg({ status: "pending", amount_cents: 500, payment_method: "offline" }),
      reg({ status: "pending", amount_cents: 1000, payment_method: "stripe", expires_at: soon }),
      // refund started but not complete: refunded_at set, refunded < amount
      reg({ status: "confirmed", amount_cents: 2000, refunded_cents: 500, refunded_at: soon }),
      reg({ status: "confirmed", amount_cents: 1500, disputed_at: soon }),
    ];
    const p = registrationPulse(rows, null);
    expect(p.paidCents).toBe(1900 + 2000 + 1500); // confirmed rows with a fee snapshot
    expect(p.dueCents).toBe(1900 + 500 + 1000); // pending rows still owing
    expect(p.refundIncomplete).toBe(1);
    expect(p.disputed).toBe(1);
    expect(p.nextExpiry).toBe(soon);
  });

  it("zeroes cleanly on an empty division", () => {
    expect(registrationPulse([], 8)).toEqual({
      confirmed: 0, holding: 0, waitlisted: 0, capacity: 8,
      paidCents: 0, dueCents: 0, refundIncomplete: 0, disputed: 0, nextExpiry: null,
    });
  });
});

describe("waitlistPositions", () => {
  it("orders 1-based by created_at among waitlisted rows only", () => {
    const a = reg({ status: "waitlisted", created_at: "2026-01-02T00:00:00Z" });
    const b = reg({ status: "waitlisted", created_at: "2026-01-01T00:00:00Z" });
    const c = reg({ status: "pending", created_at: "2026-01-01T00:00:00Z" });
    const pos = waitlistPositions([a, b, c]);
    expect(pos.get(b.id)).toBe(1);
    expect(pos.get(a.id)).toBe(2);
    expect(pos.has(c.id)).toBe(false);
  });

  it("breaks created_at ties by id", () => {
    const t = "2026-01-01T00:00:00Z";
    const a = reg({ id: "aaa", status: "waitlisted", created_at: t });
    const b = reg({ id: "bbb", status: "waitlisted", created_at: t });
    const pos = waitlistPositions([b, a]);
    expect(pos.get("aaa")).toBe(1);
    expect(pos.get("bbb")).toBe(2);
  });
});

describe("duplicateContactIds", () => {
  it("flags active rows sharing an email, case/space-insensitively", () => {
    const a = reg({ status: "confirmed", contact_email: "Mum@Family.test " });
    const b = reg({ status: "waitlisted", contact_email: "mum@family.test" });
    const c = reg({ status: "pending", contact_email: "solo@x.test" });
    const dup = duplicateContactIds([a, b, c]);
    expect(dup).toEqual(new Set([a.id, b.id]));
  });

  it("ignores terminal rows — re-registering after withdrawal is legal", () => {
    const gone = reg({ status: "withdrawn", contact_email: "again@x.test" });
    const back = reg({ status: "confirmed", contact_email: "again@x.test" });
    expect(duplicateContactIds([gone, back]).size).toBe(0);
  });
});
