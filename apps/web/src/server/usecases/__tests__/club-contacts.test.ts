// Club contacts CRUD (W1 §4.2/§5.2 FA officer model) + team move/detach.
// is_primary is unique per club — a new/patched primary clears the previous one
// in the same transaction. Each test seeds a FRESH org (unique orgId → unique
// entitlement cache key, and its own cap budget), so no cross-test leak. The
// contacts test creates 1 club; the move test creates 1 club + 1 team — both
// inside the community 2-club/2-team caps. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  createClub,
  createClubContact,
  listClubContacts,
  patchClubContact,
  deleteClubContact,
} from "../clubs";
import { createTeam, setTeamClub } from "../teams";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ct " + suffix}, ${"ct-" + suffix})
    returning id`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("club contacts", () => {
  it("CRUDs a contact and enforces single primary per club", async () => {
    const auth = await seedOrg();
    const club = await createClub(auth, { name: "Contact FC" });
    const a = await createClubContact(auth, club.id, {
      role_key: "secretary", full_name: "Sam Sec", email: "sam@x.test", is_primary: true });
    const b = await createClubContact(auth, club.id, {
      role_key: "treasurer", full_name: "Tia Tre", is_primary: true });
    const list = await listClubContacts(auth, club.id);
    expect(list.filter((c) => c.is_primary)).toHaveLength(1); // b won
    expect(list.find((c) => c.id === a.id)!.is_primary).toBe(false);
    await patchClubContact(auth, club.id, a.id, { phone: "0123" });
    await deleteClubContact(auth, club.id, b.id);
    expect(await listClubContacts(auth, club.id)).toHaveLength(1);
  });

  it("moves a team into and out of a club", async () => {
    const auth = await seedOrg();
    const club = await createClub(auth, { name: "Move FC" });
    const team = await createTeam(auth, { name: "Movers" });
    expect((await setTeamClub(auth, team.id, club.id)).club_id).toBe(club.id);
    expect((await setTeamClub(auth, team.id, null)).club_id).toBeNull();
  });
});
