// Seed a "3 users, 8 orgs" billing-groups demo so you can test by clicking,
// not by hand-creating everything. Prints a magic-link URL per user — open each
// in its own browser window (one normal, two Incognito) and you're logged in.
//
//   DATABASE_URL=postgres://…  [DB_SCHEMA=seazn_club]  [APP_BASE_URL=http://localhost:3000] \
//     node --experimental-strip-types scripts/seed-billing-groups-demo.ts
//
// Layout it creates:
//   Alice  — Pro, 5 orgs on ONE bill        (the "association" payer)
//   Bob    — Community, 2 orgs on one bill   (receives a handover in the test)
//   Carol  — Community, 1 org
//
// It writes the group shape directly (org -> subscription), matching what
// createOrgForUser produces, so the app reads it exactly as if you had clicked
// through. Safe to run repeatedly: every user/org is tagged unique.
import postgres from "postgres";
import { randomBytes } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
  ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});

const tag = Date.now().toString(36);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function makeUser(email: string, name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true) returning id`;
  return id;
}

/** A billing group (subscription) owned by `ownerId`. */
async function makeGroup(ownerId: string, plan: string, quantityPaid: number): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid, current_period_end)
    values (${ownerId}, ${plan}, 'active', ${quantityPaid},
            ${plan === "community" ? null : sql`now() + interval '30 days'`})
    returning id`;
  return id;
}

/** An org in `groupId`, owned by `ownerId`. */
async function makeOrg(groupId: string, ownerId: string, name: string): Promise<void> {
  const slug = `${slugify(name)}-${tag}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, status, created_by, subscription_id)
    values (${name}, ${slug}, 'active', ${ownerId}, ${groupId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
}

/** A 15-minute magic-link the user opens to be logged in — no email needed. */
async function loginLink(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    insert into login_links (user_id, token, expires_at)
    values (${userId}, ${token}, ${new Date(Date.now() + 15 * 60_000).toISOString()})`;
  return `${base}/magic-link?token=${token}`;
}

async function main() {
  // Alice — Pro, 5 orgs on one bill.
  const alice = await makeUser(`alice-${tag}@demo.test`, "Alice Association");
  const aliceGroup = await makeGroup(alice, "pro", 5);
  for (let i = 1; i <= 5; i++) await makeOrg(aliceGroup, alice, `Alice Club ${i}`);

  // Bob — Community, 2 orgs on one bill.
  const bob = await makeUser(`bob-${tag}@demo.test`, "Bob Owner");
  const bobGroup = await makeGroup(bob, "community", 1);
  for (let i = 1; i <= 2; i++) await makeOrg(bobGroup, bob, `Bob Club ${i}`);

  // Carol — Community, 1 org.
  const carol = await makeUser(`carol-${tag}@demo.test`, "Carol Solo");
  const carolGroup = await makeGroup(carol, "community", 1);
  await makeOrg(carolGroup, carol, "Carol Club");

  const [aLink, bLink, cLink] = await Promise.all([
    loginLink(alice),
    loginLink(bob),
    loginLink(carol),
  ]);

  console.log("\n  Billing-groups demo seeded (3 users, 8 orgs). Log in per user:\n");
  console.log("  Alice  — Pro, 5 orgs on one bill (the payer)");
  console.log(`         ${aLink}\n`);
  console.log("  Bob    — Community, 2 orgs (receives a handover)");
  console.log(`         ${bLink}\n`);
  console.log("  Carol  — Community, 1 org");
  console.log(`         ${cLink}\n`);
  console.log("  Open each in its own browser window (one normal, two Incognito).");
  console.log("  Billing panel: Settings -> Plan & Billing. Links expire in 15 min.\n");
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
