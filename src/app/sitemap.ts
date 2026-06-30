import type { MetadataRoute } from "next";

const BASE = "https://seazn.club";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: BASE, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/use-cases/clubs`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/use-cases/events`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/use-cases/schools`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/cookie-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/dpa`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/sub-processors`, lastModified: now, changeFrequency: "monthly", priority: 0.2 },
  ];
}
