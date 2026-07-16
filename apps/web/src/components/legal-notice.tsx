"use client";

import Link from "next/link";
import { useMsg } from "@/components/i18n/dict-provider";

/** Clickwrap notice under any action that signs in / creates an account
 *  (GDPR spec 2026-07-14). Server-side stamping lives in lib/legal.ts.
 *  Copy is a single template with {terms}/{privacy} tokens so translations keep
 *  their own word order; the tokens are replaced by the linked labels. Reads the
 *  `ui` catalog via useMsg (en fallback off a DictProvider). */
export function LegalNotice({ className }: { className?: string }) {
  const msg = useMsg();
  const terms = (
    <Link href="/legal/terms" className="underline hover:text-slate-600">
      {msg("legal.notice.terms")}
    </Link>
  );
  const privacy = (
    <Link href="/legal/privacy" className="underline hover:text-slate-600">
      {msg("legal.notice.privacy")}
    </Link>
  );
  const parts = msg("legal.notice.body").split(/(\{terms\}|\{privacy\})/);
  return (
    <p className={`text-xs text-slate-400 ${className ?? "text-center"}`}>
      {parts.map((p, i) =>
        p === "{terms}" ? (
          <span key={i}>{terms}</span>
        ) : p === "{privacy}" ? (
          <span key={i}>{privacy}</span>
        ) : (
          p
        ),
      )}
    </p>
  );
}
