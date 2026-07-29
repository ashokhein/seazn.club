import { Ticket, TicketSlash } from "lucide-react";
import { passActiveLabel } from "@/lib/pass-ladder";
import { t, type Dict } from "@/lib/i18n";
import type { PassKey } from "@/lib/currency";
import type { PassLockReason } from "@/lib/entitlements";

interface Props {
  dict: Dict;
  /** Which rung the competition holds — the seal names it (v17 #294). */
  rung: PassKey;
  /** Why the pass has stopped applying, or null while it still does. */
  lockReason: PassLockReason | null;
}

/**
 * The pass seal on an org dashboard card — 20px, no room for a word, and the
 * ONLY thing that card says about the pass.
 *
 * EXTRACTED FROM THE PAGE, and that is the entire point of the file (W8 task 6
 * review, I-1). The decision used to be an IIFE inside `o/[orgSlug]/page.tsx`,
 * and an `app/**\/page.tsx` cannot be unit-rendered here (cookies, session,
 * tenant DB), so the only guard available was a scan of the source TEXT. A text
 * scan pins syntax, never meaning: `passLock.get(c.id) === "terminal"` keeps the
 * real `passLockReason` call, keeps the join, keeps the `data-pass-ended`
 * string — and re-ships #301 for the whole `past_ends_on` arm while every
 * assertion stays green. So did swapping the two labels, and so did swapping the
 * two colour sets. Three green mutations on the one surface where the seal is
 * the only thing the reader gets.
 *
 * Here they are three failing tests instead, because this renders.
 *
 * ANY reason means ended. Not `=== "terminal"`: a competition still marked
 * `live` whose `ends_on` passed the grace boundary is exactly as unlifted as an
 * archived one, and it is the arm a reader is most likely to be surprised by.
 * The arms themselves stay in `passLockReason` — this asks whether there IS a
 * reason, never which.
 *
 * `PassLockReason` is imported as a TYPE only: `@/lib/entitlements` reaches
 * postgres and ioredis, and this component sits one prop away from client
 * islands.
 */
export function PassSeal({ dict, rung, lockReason }: Props) {
  const ended = lockReason != null;
  const label = ended ? t(dict, "pass.entry.ended") : passActiveLabel(dict, rung);
  // SHAPE, not just hue (W8 task 6 review, I-2). Lime-100 against slate-100 is
  // 1.01:1 — a tint a sighted reader can miss entirely in greyscale, on a dim
  // display, or with any colour vision deficiency, and the two states carried
  // the identical glyph. The truth was reaching `aria-label` and `title` only,
  // which serves assistive tech and hover and nobody scanning a grid of cards.
  // A struck-through ticket says "void" without a word. WCAG 1.4.1.
  const Glyph = ended ? TicketSlash : Ticket;
  return (
    <span
      data-pass-held={!ended || undefined}
      data-pass-ended={ended || undefined}
      data-pass-held-rung={rung}
      role="img"
      aria-label={label}
      title={label}
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ring-1 ring-inset ${
        ended
          ? "bg-slate-100 text-slate-500 ring-slate-300"
          : "bg-lime-100 text-lime-800 ring-lime-300"
      }`}
    >
      <Glyph className="h-3 w-3" strokeWidth={2.25} aria-hidden />
    </span>
  );
}
