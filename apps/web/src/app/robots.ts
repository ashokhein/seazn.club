import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/pricing", "/use-cases/", "/legal/"],
        disallow: ["/o/", "/dashboard", "/admin", "/api/", "/settings", "/competitions/", "/divisions/", "/fixtures/", "/directory", "/players", "/people", "/clubs", "/orgs/"],
      },
    ],
    sitemap: "https://seazn.club/sitemap.xml",
  };
}
