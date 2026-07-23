// Tenure-window invoice scoping: a billing group is one Stripe customer that can
// change hands, so its whole invoice history sits on one customer. Each invoice
// belongs to whoever was the PAYER when it was cut; a viewer may see only the
// invoices from tenures where THEY paid — their own, across round-trips, never a
// predecessor's (privacy: invoice PDFs snapshot the payer's name + address).
import { describe, expect, it } from "vitest";
import {
  payerSegments,
  invoiceVisibleTo,
  filterInvoicesForViewer,
  type PayerSegment,
} from "../billing-invoice-scope";

const DAY = 86_400_000; // ms
const ms = (days: number) => days * DAY;
const sec = (days: number) => days * 86_400; // Stripe `created` is epoch seconds

describe("payerSegments", () => {
  it("a group that never changed hands is one open segment owned by the current payer", () => {
    expect(payerSegments({ originStartMs: ms(0), currentPayerId: "u1", transfers: [] })).toEqual([
      { payerUserId: "u1", startMs: ms(0), endMs: null },
    ]);
  });

  it("one transfer splits the timeline at the handover instant", () => {
    const segs = payerSegments({
      originStartMs: ms(0),
      currentPayerId: "u2",
      transfers: [{ fromUserId: "u1", toUserId: "u2", resolvedAtMs: ms(100) }],
    });
    expect(segs).toEqual([
      { payerUserId: "u1", startMs: ms(0), endMs: ms(100) },
      { payerUserId: "u2", startMs: ms(100), endMs: null },
    ]);
  });

  it("a round-trip yields three segments, the last owned by the current payer", () => {
    const segs = payerSegments({
      originStartMs: ms(0),
      currentPayerId: "u1",
      transfers: [
        { fromUserId: "u1", toUserId: "u2", resolvedAtMs: ms(100) },
        { fromUserId: "u2", toUserId: "u1", resolvedAtMs: ms(200) },
      ],
    });
    expect(segs).toEqual([
      { payerUserId: "u1", startMs: ms(0), endMs: ms(100) },
      { payerUserId: "u2", startMs: ms(100), endMs: ms(200) },
      { payerUserId: "u1", startMs: ms(200), endMs: null },
    ]);
    expect(segs[segs.length - 1].payerUserId).toBe("u1"); // current payer
  });

  it("sorts transfers by resolution time regardless of input order", () => {
    const segs = payerSegments({
      originStartMs: ms(0),
      currentPayerId: "u1",
      transfers: [
        { fromUserId: "u2", toUserId: "u1", resolvedAtMs: ms(200) },
        { fromUserId: "u1", toUserId: "u2", resolvedAtMs: ms(100) },
      ],
    });
    expect(segs.map((s) => s.payerUserId)).toEqual(["u1", "u2", "u1"]);
    expect(segs.map((s) => s.startMs)).toEqual([ms(0), ms(100), ms(200)]);
  });
});

describe("invoiceVisibleTo (half-open [start, end))", () => {
  const roundTrip: PayerSegment[] = payerSegments({
    originStartMs: ms(0),
    currentPayerId: "u1",
    transfers: [
      { fromUserId: "u1", toUserId: "u2", resolvedAtMs: ms(100) },
      { fromUserId: "u2", toUserId: "u1", resolvedAtMs: ms(200) },
    ],
  });

  it("an invoice inside a viewer's tenure is visible to them", () => {
    expect(invoiceVisibleTo(ms(50), roundTrip, "u1")).toBe(true); // tenure 1
    expect(invoiceVisibleTo(ms(150), roundTrip, "u2")).toBe(true); // tenure 2
    expect(invoiceVisibleTo(ms(250), roundTrip, "u1")).toBe(true); // tenure 3
  });

  it("a predecessor's invoice is hidden from the current payer", () => {
    expect(invoiceVisibleTo(ms(150), roundTrip, "u1")).toBe(false); // u2's tenure, not u1's
  });

  it("assigns a handover-instant invoice to the incoming payer", () => {
    // created exactly at the boundary belongs to the NEW segment.
    expect(invoiceVisibleTo(ms(100), roundTrip, "u2")).toBe(true);
    expect(invoiceVisibleTo(ms(100), roundTrip, "u1")).toBe(false);
    expect(invoiceVisibleTo(ms(200), roundTrip, "u1")).toBe(true);
    expect(invoiceVisibleTo(ms(200), roundTrip, "u2")).toBe(false);
  });

  it("shows nothing to someone who was never a payer", () => {
    expect(invoiceVisibleTo(ms(50), roundTrip, "stranger")).toBe(false);
  });
});

describe("filterInvoicesForViewer (Stripe created is epoch seconds)", () => {
  const roundTrip = payerSegments({
    originStartMs: ms(0),
    currentPayerId: "u1",
    transfers: [
      { fromUserId: "u1", toUserId: "u2", resolvedAtMs: ms(100) },
      { fromUserId: "u2", toUserId: "u1", resolvedAtMs: ms(200) },
    ],
  });
  const invoices = [
    { id: "in_t1", created: sec(50) }, // tenure 1 (u1)
    { id: "in_t2", created: sec(150) }, // tenure 2 (u2)
    { id: "in_t3", created: sec(250) }, // tenure 3 (u1)
  ];

  it("a returning payer sees the UNION of their tenures, never the middle one", () => {
    // The headline case: u1 owned, handed to u2, took it back. u1 sees their own
    // first and third tenures; u2's middle stretch stays hidden.
    expect(filterInvoicesForViewer(invoices, roundTrip, "u1").map((i) => i.id)).toEqual([
      "in_t1",
      "in_t3",
    ]);
  });

  it("the middle payer sees only their own tenure", () => {
    expect(filterInvoicesForViewer(invoices, roundTrip, "u2").map((i) => i.id)).toEqual(["in_t2"]);
  });

  it("a never-transferred group shows the sole payer everything", () => {
    const segs = payerSegments({ originStartMs: ms(0), currentPayerId: "solo", transfers: [] });
    expect(filterInvoicesForViewer(invoices, segs, "solo").map((i) => i.id)).toEqual([
      "in_t1",
      "in_t2",
      "in_t3",
    ]);
  });
});
