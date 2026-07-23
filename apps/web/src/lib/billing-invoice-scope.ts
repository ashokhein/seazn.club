/**
 * Tenure-window invoice scoping.
 *
 * A billing group is ONE Stripe customer that can change hands (transfer), so
 * its whole invoice history lives on one customer. Each invoice belongs to
 * whoever was the group's PAYER when it was cut — and Stripe snapshots the
 * payer's name and address onto the invoice PDF, so showing a new payer their
 * predecessor's invoices leaks that predecessor's personal billing details.
 *
 * These pure helpers derive the payer timeline from the transfer ledger and
 * decide which invoices a given viewer may see: only the invoices from tenures
 * where THEY were the payer — their own, across round-trips, never anyone
 * else's. The DB wrapper that feeds real data lives in the billing-manage
 * usecase; keeping the arithmetic here makes it testable without Postgres.
 */

export interface PayerSegment {
  payerUserId: string;
  /** Inclusive epoch-ms lower bound. */
  startMs: number;
  /** Exclusive epoch-ms upper bound; null = the open, current tenure. */
  endMs: number | null;
}

export interface TransferHop {
  fromUserId: string;
  toUserId: string;
  resolvedAtMs: number;
}

/**
 * The ordered payer timeline for one group. The first segment starts at the
 * group's creation and is owned by the original payer (the `fromUserId` of the
 * earliest accepted transfer, or the current payer when there were none). Each
 * accepted transfer closes a segment and opens the next; the final segment is
 * open-ended and belongs to the current payer.
 *
 * Segments are half-open [startMs, endMs): an invoice cut at the exact handover
 * instant belongs to the INCOMING payer, matching the default-card swap that
 * happens at that instant.
 */
export function payerSegments(args: {
  originStartMs: number;
  currentPayerId: string;
  transfers: TransferHop[];
}): PayerSegment[] {
  const hops = [...args.transfers].sort((a, b) => a.resolvedAtMs - b.resolvedAtMs);
  if (hops.length === 0) {
    return [{ payerUserId: args.currentPayerId, startMs: args.originStartMs, endMs: null }];
  }
  const segments: PayerSegment[] = [
    { payerUserId: hops[0].fromUserId, startMs: args.originStartMs, endMs: hops[0].resolvedAtMs },
  ];
  for (let i = 0; i < hops.length; i++) {
    segments.push({
      payerUserId: hops[i].toUserId,
      startMs: hops[i].resolvedAtMs,
      endMs: i + 1 < hops.length ? hops[i + 1].resolvedAtMs : null,
    });
  }
  return segments;
}

/** Whether an invoice cut at `createdMs` falls inside a tenure where `viewerId`
 *  was the payer. */
export function invoiceVisibleTo(
  createdMs: number,
  segments: PayerSegment[],
  viewerId: string,
): boolean {
  return segments.some(
    (s) =>
      s.payerUserId === viewerId &&
      createdMs >= s.startMs &&
      (s.endMs === null || createdMs < s.endMs),
  );
}

/** Keep only the invoices the viewer was the payer for. Stripe's `created` is
 *  epoch SECONDS; segment bounds are epoch MS. */
export function filterInvoicesForViewer<T extends { created: number }>(
  invoices: T[],
  segments: PayerSegment[],
  viewerId: string,
): T[] {
  return invoices.filter((inv) => invoiceVisibleTo(inv.created * 1000, segments, viewerId));
}
