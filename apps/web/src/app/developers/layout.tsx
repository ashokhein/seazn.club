import Link from "next/link";
import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

export const metadata: Metadata = {
  title: { default: "Developers — Seazn Club", template: "%s — Seazn Club Developers" },
  description:
    "Build on the seazn.club platform API: scoped keys, live scoring, standings, registrations. REST, OpenAPI 3.1, versioned.",
};

const NAV = [
  { href: "/developers", label: "Overview" },
  { href: "/developers/reference", label: "API reference" },
  { href: "/developers/guides", label: "Guides" },
  { href: "/developers/changelog", label: "Changelog" },
];

export default function DevelopersLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingNav />
      <div className="border-b border-purple-100 bg-purple-50/40">
        <nav
          aria-label="Developer docs"
          className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:border-purple-300 hover:text-purple-800"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
