// Help-centre screenshot generator (v3/06 §3): drives a running dev server
// with Playwright and regenerates the screenshots the /help articles embed,
// so they follow UI changes instead of rotting. Output:
//   apps/web/public/help-shots/<name>.png
//
// Usage (dev server with seeded demo data must be running):
//   SHOTS_BASE=http://localhost:3000 SHOTS_EMAIL=ashokhein+demo1@gmail.com \
//     node --experimental-strip-types scripts/help-shots.ts
//
// CI runs this weekly (.github/workflows/help-shots.yml) and uploads the set
// as an artifact for review — the founder owns which shots ship (gap 14).
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Playwright is a devDependency of apps/web — resolve it from there.
const require = createRequire(join(root, "apps", "web", "package.json"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { chromium } = require("playwright") as typeof import("playwright");

const BASE = process.env.SHOTS_BASE ?? "http://localhost:3000";
const EMAIL = process.env.SHOTS_EMAIL ?? "ashokhein+demo1@gmail.com";
const OUT = join(root, "apps", "web", "public", "help-shots");

/** name → path. Console paths resolve after login; /shared works logged out. */
const SHOTS: { name: string; path: string; loggedIn: boolean }[] = [
  { name: "dashboard", path: "/dashboard", loggedIn: true },
  { name: "org-settings", path: "/settings", loggedIn: true },
  { name: "help-home", path: "/help", loggedIn: false },
  { name: "developers", path: "/developers", loggedIn: false },
  { name: "pricing", path: "/pricing", loggedIn: false },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Magic-link login (dev servers return login_url in the response).
  const res = await page.request.post(`${BASE}/api/auth/magic-link`, {
    data: { email: EMAIL },
  });
  const loginUrl = ((await res.json()) as { data?: { login_url?: string } }).data?.login_url;
  if (!loginUrl) {
    console.error("No login_url — is the dev server running with a seeded demo account?");
    process.exit(1);
  }
  await page.goto(loginUrl);
  await page.waitForURL((u) => !u.pathname.startsWith("/magic-link"), { timeout: 15_000 });

  for (const shot of SHOTS) {
    await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(OUT, `${shot.name}.png`), fullPage: false });
    console.log(`✓ ${shot.name}.png ← ${shot.path}`);
  }

  await browser.close();
  console.log(`wrote ${SHOTS.length} screenshots to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
