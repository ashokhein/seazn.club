import Link from "next/link";

const LEGAL = [
  { label: "Privacy", href: "/legal/privacy" },
  { label: "Terms", href: "/legal/terms" },
  { label: "Cookie policy", href: "/legal/cookie-policy" },
  { label: "DPA", href: "/legal/dpa" },
  { label: "Sub-processors", href: "/legal/sub-processors" },
];
const USE_CASES = [
  { label: "Sports clubs", href: "/use-cases/clubs" },
  { label: "Tournaments & events", href: "/use-cases/events" },
  { label: "Schools & youth", href: "/use-cases/schools" },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-purple-100 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="mb-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-wide.png" alt="Seazn Club" className="h-7 w-auto" />
            </div>
            <p className="text-sm text-slate-500">
              Run multi-sport community tournaments — from setup to trophy in
              minutes.
            </p>
          </div>
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Product
            </p>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/pricing" className="text-slate-600 hover:text-purple-700">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/login?tab=signup" className="text-slate-600 hover:text-purple-700">
                  Start free
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Use cases
            </p>
            <ul className="space-y-2 text-sm">
              {USE_CASES.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-slate-600 hover:text-purple-700">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Legal
            </p>
            <ul className="space-y-2 text-sm">
              {LEGAL.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-slate-600 hover:text-purple-700">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-10 border-t border-purple-50 pt-6 text-center text-xs text-slate-400">
          © {new Date().getFullYear()} Seazn Club. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
