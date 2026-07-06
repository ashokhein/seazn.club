import "server-only";
// Day-of device links (doc 13 §7, PROMPT-21): account-less, fixture-scoped
// scoring tokens. Mint/revoke are session-editor actions; the token's own
// auth path lives in api-v1/auth.ts (requireFixtureActor). Capabilities are
// strictly ⊂ scorer: append + void-own-link-events pre-finalize, read
// fixture state/events, realtime token — nothing else.
import { createHash, randomBytes } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";

export const DEVICE_LINK_PREFIX = "dl_";

export function hashDeviceLinkToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a new device-link secret. Shown once; only the sha256 is stored. */
export function mintDeviceLinkSecret(): string {
  return DEVICE_LINK_PREFIX + randomBytes(32).toString("base64url");
}

export interface DeviceLinkRow {
  id: string;
  fixture_id: string;
  label: string | null;
  issued_by: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

const COLS = ["id", "fixture_id", "label", "issued_by", "expires_at", "revoked_at", "created_at"] as const;

/**
 * End of the CURRENT day in the fixture's venue timezone (doc 13 §7:
 * schedule_settings.tz of the fixture's division, else UTC). Day-of links —
 * whoever holds the phone scores today, the link dies at local midnight.
 */
export function endOfLocalDay(now: Date, tz: string): Date {
  let parts: { year: number; month: number; day: number };
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [year, month, day] = fmt.format(now).split("-").map(Number);
    parts = { year, month, day };
  } catch {
    // Unknown tz string → UTC fallback.
    parts = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
  // Next local midnight: take local date, add one day, find the UTC instant
  // of that local 00:00 by probing the tz offset at an approximate instant.
  const approxNextMidnightUtc = Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0);
  const offsetMinutes = tzOffsetMinutes(new Date(approxNextMidnightUtc), tz);
  return new Date(approxNextMidnightUtc - offsetMinutes * 60_000);
}

/** Offset (minutes east of UTC) of `tz` at `instant`. */
function tzOffsetMinutes(instant: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second),
    );
    return Math.round((asUtc - instant.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

function requireSessionEditor(auth: AuthCtx): void {
  // Editors only, session only — a device link must not mint device links,
  // and neither may an API key (api_keys pattern).
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Device links can only be managed with a session login");
  }
}

/**
 * Mint a device link for a fixture (doc 13 §7). Revokes prior active links —
 * one live device per fixture. Secret returned exactly once.
 */
export async function createDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
  label: string | null,
): Promise<DeviceLinkRow & { secret: string }> {
  requireSessionEditor(auth);
  await requireFeature(auth.orgId, "scoring.device_links"); // 402 for Community
  const secret = mintDeviceLinkSecret();
  const row = await withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<{ id: string; division_id: string; status: string }[]>`
      select id, division_id, status from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    if (fixture.status === "finalized" || fixture.status === "cancelled") {
      throw new HttpError(422, `fixture is ${fixture.status} — nothing left to score`);
    }
    const [settings] = await tx<{ tz: string }[]>`
      select tz from schedule_settings where division_id = ${fixture.division_id}`;
    const expiresAt = endOfLocalDay(new Date(), settings?.tz ?? "UTC");

    // One live device per fixture: minting revokes prior active links.
    await tx`
      update device_links set revoked_at = now()
      where fixture_id = ${fixtureId} and revoked_at is null`;

    const [created] = await tx<DeviceLinkRow[]>`
      insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at)
      values (${auth.orgId}, ${fixtureId}, ${hashDeviceLinkToken(secret)},
              ${label}, ${auth.userId}, ${expiresAt})
      returning ${tx(COLS)}`;
    return created;
  });
  return { ...row, secret };
}

/** Revoke one link (immediate 401 for the holder). */
export async function revokeDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
  linkId: string,
): Promise<DeviceLinkRow> {
  requireSessionEditor(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DeviceLinkRow[]>`
      update device_links set revoked_at = coalesce(revoked_at, now())
      where id = ${linkId} and fixture_id = ${fixtureId}
      returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "device link not found");
    return row;
  });
}

/** The fixture's active link, if any (organiser console; no secret). */
export async function getActiveDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
): Promise<DeviceLinkRow | null> {
  requireSessionEditor(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DeviceLinkRow[]>`
      select ${tx(COLS)} from device_links
      where fixture_id = ${fixtureId} and revoked_at is null and expires_at > now()
      order by created_at desc limit 1`;
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// Token resolution (the auth path; superuser read like api_keys — RLS-bounded
// reads happen in the use-cases proper once the org is pinned).
// ---------------------------------------------------------------------------

export interface ResolvedDeviceLink {
  id: string;
  org_id: string;
  fixture_id: string;
  issued_by: string;
}

/**
 * Resolve a dl_ bearer token. Expired/revoked → 401 with a DISTINCT code the
 * pad renders as "link expired, ask the organiser" (doc 13 §7).
 */
export async function resolveDeviceLinkToken(token: string): Promise<ResolvedDeviceLink> {
  const [link] = await sql<
    (ResolvedDeviceLink & { expires_at: string; revoked_at: string | null })[]
  >`
    select id, org_id, fixture_id, issued_by, expires_at, revoked_at
    from device_links where token_hash = ${hashDeviceLinkToken(token)} limit 1`;
  if (!link) throw new HttpError(401, "Invalid device link", "LINK_INVALID");
  if (link.revoked_at) {
    throw new HttpError(401, "This device link was revoked — ask the organiser", "LINK_REVOKED");
  }
  if (new Date(link.expires_at).getTime() <= Date.now()) {
    throw new HttpError(401, "This device link has expired — ask the organiser", "LINK_EXPIRED");
  }
  return { id: link.id, org_id: link.org_id, fixture_id: link.fixture_id, issued_by: link.issued_by };
}
