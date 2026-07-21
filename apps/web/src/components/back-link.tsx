import Link from "@/components/ui/console-link";
import { ArrowLeft } from "lucide-react";

/** Structural back affordance for console pages outside the /o breadcrumb
 *  shell — same contract as the breadcrumb back button: a real parent link,
 *  never history.back().
 *
 *  `emphasis="button"` gives it the ghost-button chrome. The settings
 *  sub-pages use it because the breadcrumb apron's chevron was not found:
 *  16px at 70% opacity on the dark bar, its label hidden until hover, sitting
 *  beside a text trail. Reported twice as "there is no back button" (user
 *  picked this treatment over making the apron chevron louder, 2026-07-21). */
export function BackLink({
  href,
  label,
  emphasis = "quiet",
}: {
  href: string;
  label: string;
  emphasis?: "quiet" | "button";
}) {
  return (
    <Link
      href={href}
      className={
        emphasis === "button"
          ? "btn btn-ghost mb-3 inline-flex items-center gap-1.5 text-sm"
          : "-ml-1 mb-2 inline-flex items-center gap-1.5 rounded-md px-1 py-1.5 text-sm text-slate-500 transition hover:text-slate-700"
      }
    >
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      {label}
    </Link>
  );
}
