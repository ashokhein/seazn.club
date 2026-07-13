// PROMPT-52 organiser-console derivations. Pure + client-safe: the panel
// already loads every registration row for the division, so the pulse, the
// queue, and duplicate hints are lens functions over that array — the v1
// list API shape stays untouched for external consumers.

export interface DerivableReg {
  id: string;
  status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" | "expired";
  contact_email: string;
  amount_cents: number;
  refunded_cents: number;
  refunded_at: string | Date | null;
  payment_method: "offline" | "stripe" | null;
  expires_at: string | Date | null;
  disputed_at: string | Date | null;
  created_at: string | Date;
}

export interface Pulse {
  confirmed: number;
  holding: number;
  waitlisted: number;
  capacity: number | null;
  paidCents: number;
  dueCents: number;
  refundIncomplete: number;
  disputed: number;
  nextExpiry: string | null;
}

const ACTIVE = new Set(["pending", "paid", "confirmed", "waitlisted"]);

const iso = (v: string | Date): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export function registrationPulse(rows: DerivableReg[], capacity: number | null): Pulse {
  const p: Pulse = {
    confirmed: 0, holding: 0, waitlisted: 0, capacity,
    paidCents: 0, dueCents: 0, refundIncomplete: 0, disputed: 0, nextExpiry: null,
  };
  for (const r of rows) {
    if (r.status === "confirmed") p.confirmed += 1;
    else if (r.status === "pending" || r.status === "paid") p.holding += 1;
    else if (r.status === "waitlisted") p.waitlisted += 1;

    // Money reads follow the SNAPSHOT amount, mirroring spec §2/§8: what a
    // row owes/paid never moves with live settings.
    if (r.status === "pending" && r.amount_cents > 0) p.dueCents += r.amount_cents;
    if ((r.status === "confirmed" || r.status === "paid") && r.amount_cents > 0) {
      p.paidCents += r.amount_cents;
    }
    if (r.refunded_at !== null && r.refunded_cents < r.amount_cents) p.refundIncomplete += 1;
    if (r.disputed_at !== null && ACTIVE.has(r.status)) p.disputed += 1;
    if (r.status === "pending" && r.expires_at !== null) {
      const e = iso(r.expires_at);
      if (p.nextExpiry === null || e < p.nextExpiry) p.nextExpiry = e;
    }
  }
  return p;
}

/** 1-based queue positions, created_at asc then id asc — the same oldest-
 *  first order auto-promotion consumes, so "#N" never lies about the queue. */
export function waitlistPositions(rows: DerivableReg[]): Map<string, number> {
  const queue = rows
    .filter((r) => r.status === "waitlisted")
    .sort((a, b) => iso(a.created_at).localeCompare(iso(b.created_at)) || a.id.localeCompare(b.id));
  return new Map(queue.map((r, i) => [r.id, i + 1]));
}

/** Ids of ACTIVE rows sharing a contact email with another active row in the
 *  set — a non-blocking organiser hint (parents entering two kids are legal). */
export function duplicateContactIds(rows: DerivableReg[]): Set<string> {
  const byEmail = new Map<string, string[]>();
  for (const r of rows) {
    if (!ACTIVE.has(r.status)) continue;
    const key = r.contact_email.trim().toLowerCase();
    if (key === "") continue;
    byEmail.set(key, [...(byEmail.get(key) ?? []), r.id]);
  }
  const dup = new Set<string>();
  for (const ids of byEmail.values()) {
    if (ids.length >= 2) for (const id of ids) dup.add(id);
  }
  return dup;
}
