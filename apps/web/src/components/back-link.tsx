import Link from "@/components/ui/console-link";
import { ArrowLeft } from "lucide-react";

/** Structural back affordance for console pages outside the /o breadcrumb
 *  shell — same contract as the breadcrumb back button: a real parent link,
 *  never history.back(). */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="-ml-1 mb-2 inline-flex items-center gap-1.5 rounded-md px-1 py-1.5 text-sm text-slate-500 transition hover:text-slate-700"
    >
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      {label}
    </Link>
  );
}
