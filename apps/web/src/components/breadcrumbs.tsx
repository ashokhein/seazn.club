"use client";
// Breadcrumb trail + universal back button for the /o console (v3/01 §3–4).
// Derived entirely from the pathname — zero per-page wiring. The org segment
// doubles as the org switcher (plain links to /o/[slug]; ActiveOrgSync
// repairs the cookie on arrival). Mobile collapses to "‹ parent", which IS
// the back affordance; desktop gets a 44px chevron whose parent name shows
// on hover. Back always targets the structural parent, never history.back().
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { routes } from "@/lib/routes";
import { buildCrumbs, type BreadcrumbNameMap } from "@/lib/breadcrumb-chain";

export type { BreadcrumbNameMap };

interface BreadcrumbsProps {
  orgName: string;
  orgs: { name: string; slug: string }[];
  names: BreadcrumbNameMap;
}

function OrgCrumb({ orgName, orgs }: Pick<BreadcrumbsProps, "orgName" | "orgs">) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (orgs.length < 2) {
    return <span className="truncate font-medium text-cream/90">{orgName}</span>;
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex max-w-48 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-cream/90 transition hover:bg-cream/10"
      >
        <span className="truncate">{orgName}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-cream/50" strokeWidth={2} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-cream/10 bg-night-2 py-1 shadow-xl"
        >
          {orgs.map((o) => (
            <Link
              key={o.slug}
              role="menuitem"
              href={routes.orgHome(o.slug)}
              onClick={() => setOpen(false)}
              className={`block truncate px-3 py-2 text-sm transition hover:bg-cream/10 hover:text-cream ${
                o.name === orgName ? "font-medium text-lime-400" : "text-cream/80"
              }`}
            >
              {o.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Breadcrumbs({ orgName, orgs, names }: BreadcrumbsProps) {
  const pathname = usePathname();
  const crumbs = buildCrumbs({ pathname, orgName, names });
  if (crumbs.length === 0) return null;
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2]! : null;

  return (
    // Night apron under the gantry (floodlit-console spec §4).
    <div className="app-crumbs">
      <div className="mx-auto flex max-w-6xl items-center px-4 text-xs text-cream/60">
        {/* Universal back button (§4): structural parent, 44px target,
            hidden on org home. Parent name slides in on desktop hover. */}
        {parent && (
          <Link
            href={parent.href}
            aria-label={`Back to ${parent.label}`}
            className="group -ml-3 flex h-11 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-cream/70 transition hover:text-cream"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            <span className="hidden max-w-0 truncate opacity-0 transition-all duration-150 group-hover:max-w-40 group-hover:opacity-100 sm:inline-block">
              {parent.label}
            </span>
          </Link>
        )}

        {/* Mobile (§3 wireframe): the trail collapses to "‹ parent" — the
            back link above IS the affordance, so just show where it goes.
            Org home keeps the switcher. */}
        {parent ? (
          <Link href={parent.href} className="min-w-0 truncate py-3 sm:hidden">
            {parent.label}
          </Link>
        ) : (
          <div className="flex min-w-0 items-center py-2 sm:hidden">
            <OrgCrumb orgName={orgName} orgs={orgs} />
          </div>
        )}

        {/* Desktop trail: every level links; the current page is plain text. */}
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 py-2 sm:flex">
          <OrgCrumb orgName={orgName} orgs={orgs} />
          {crumbs.slice(1).map((crumb, i) => {
            const isLast = i === crumbs.length - 2;
            return (
              <span key={crumb.href} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="h-3 w-3 shrink-0 text-cream/30" strokeWidth={2} />
                {isLast ? (
                  <span aria-current="page" className="truncate font-medium text-cream/90">
                    {crumb.label}
                  </span>
                ) : (
                  <Link href={crumb.href} className="truncate transition hover:text-cream">
                    {crumb.label}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
