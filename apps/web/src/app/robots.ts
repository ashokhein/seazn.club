import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/pricing", "/use-cases/", "/legal/"],
        disallow: ["/dashboard", "/admin", "/api/", "/settings", "/competitions/", "/divisions/", "/fixtures/", "/directory", "/people", "/clubs", "/orgs/"],
      },
    ],
    sitemap: "https://seazn.club/sitemap.xml",
  };
}
