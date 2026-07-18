import type { MetadataRoute } from "next";
import { listPublicSitemapEntries } from "@/server/public-site/data";
import { listDiscoverySports } from "@/server/public-site/discovery";
import { liveGames } from "@/games/registry";
import { siteOrigin } from "@/lib/site-origin";

const BASE = siteOrigin();

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = [
    { url: BASE, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/discover`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${BASE}/live`, lastModified: now, changeFrequency: "hourly", priority: 0.8 },
    { url: `${BASE}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/games`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    ...liveGames().map((g) => ({
      url: `${BASE}/games/${g.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    { url: `${BASE}/use-cases/clubs`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/use-cases/events`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/use-cases/schools`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/cookie-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/dpa`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/sub-processors`, lastModified: now, changeFrequency: "monthly", priority: 0.2 },
  ];

  // Public competitions + their divisions (doc 09 §3 — `public` only;
  // unlisted stays out of the sitemap AND carries noindex). DB may be
  // unreachable at build time: fall back to the static set.
  let publicEntries: MetadataRoute.Sitemap = [];
  try {
    const competitions = await listPublicSitemapEntries();
    publicEntries = competitions.flatMap((c) => [
      {
        url: `${BASE}/shared/${c.orgSlug}/${c.compSlug}`,
        lastModified: now,
        changeFrequency: "hourly" as const,
        priority: 0.7,
      },
      ...c.divisionSlugs.map((div) => ({
        url: `${BASE}/shared/${c.orgSlug}/${c.compSlug}/${div}`,
        lastModified: now,
        changeFrequency: "hourly" as const,
        priority: 0.6,
      })),
    ]);
  } catch {
    // no DB (build sandbox) — static entries only
  }

  // Per-sport discovery landings (doc 15 §2): only sports that currently have
  // discoverable competitions — no empty SEO shells.
  let sportEntries: MetadataRoute.Sitemap = [];
  try {
    const sports = await listDiscoverySports();
    sportEntries = sports.map((s) => ({
      url: `${BASE}/discover/${s.key}`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: 0.8,
    }));
  } catch {
    // no DB (build sandbox)
  }

  return [...staticEntries, ...sportEntries, ...publicEntries];
}
