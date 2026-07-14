import Link from "next/link";

/** Clickwrap notice under any action that signs in / creates an account
 *  (GDPR spec 2026-07-14). Server-side stamping lives in lib/legal.ts. */
export function LegalNotice({ className }: { className?: string }) {
  return (
    <p className={`text-xs text-slate-400 ${className ?? "text-center"}`}>
      By continuing, you agree to our{" "}
      <Link href="/legal/terms" className="underline hover:text-slate-600">
        Terms of Service
      </Link>{" "}
      and{" "}
      <Link href="/legal/privacy" className="underline hover:text-slate-600">
        Privacy Policy
      </Link>
      .
    </p>
  );
}
