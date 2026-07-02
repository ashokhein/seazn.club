import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";

export async function MarketingNav() {
  const user = await getCurrentUser().catch(() => null);
  return (
    <header className="sticky top-0 z-40 border-b border-purple-100 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide.png" alt="Seazn Club" className="h-9 w-auto" />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-3">
          <Link
            href="/pricing"
            className="hidden rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-purple-50 hover:text-purple-700 sm:inline-flex"
          >
            Pricing
          </Link>
          <Link
            href="/use-cases/clubs"
            className="hidden rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-purple-50 hover:text-purple-700 md:inline-flex"
          >
            Use cases
          </Link>
          {user ? (
            <Link href="/dashboard" className="btn btn-primary text-sm">
              Dashboard →
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost text-sm">
                Log in
              </Link>
              <Link href="/login?tab=signup" className="btn btn-primary text-sm">
                Start free
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
