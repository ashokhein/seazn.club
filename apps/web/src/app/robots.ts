import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/pricing", "/use-cases/", "/legal/"],
        disallow: ["/o/", "/dashboard", "/admin", "/api/", "/settings", "/competitions/", "/divisions/", "/fixtures/", "/directory", "/players", "/people", "/clubs", "/orgs/"],
      },
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
