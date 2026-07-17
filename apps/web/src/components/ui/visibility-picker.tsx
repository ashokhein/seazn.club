"use client";

// Visibility radio cards (v3/03 §7): plain language over engineer vocabulary
// — every option shows its consequence permanently, because the decision IS
// the consequence. Maps 1:1 onto the existing private/unlisted/public keys
// (no schema change; noindex behaviour unchanged). After a shareable choice
// the share URL surfaces right here with a copy button.
//
// Youth guard (v3/11 gap 8): when the surface contains youth divisions,
// leaving Private first raises a consent-responsibility interstitial — the
// organiser confirms they hold guardian consent before names go public.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

export type VisibilityKey = "private" | "unlisted" | "public";

const OPTIONS: { value: VisibilityKey; label: MessageKey; consequence: MessageKey }[] = [
  { value: "private", label: "visibility.private.label", consequence: "visibility.private.consequence" },
  { value: "unlisted", label: "visibility.unlisted.label", consequence: "visibility.unlisted.consequence" },
  { value: "public", label: "visibility.public.label", consequence: "visibility.public.consequence" },
];

export function VisibilityPicker({
  value,
  onChange,
  disabled = false,
  sharePath,
  hasYouthDivisions = false,
}: {
  value: VisibilityKey | string;
  onChange: (next: VisibilityKey) => void;
  disabled?: boolean;
  /** Site-relative public path (e.g. /shared/org/comp) — shown as a full URL
   *  with a copy button once the choice is shareable. */
  sharePath?: string | null;
  /** v3/11 gap 8: raises the guardian-consent interstitial when leaving Private. */
  hasYouthDivisions?: boolean;
}) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const shareUrl = sharePath ? `${origin}${sharePath}` : null;

  async function pick(next: VisibilityKey) {
    if (next === value) return;
    if (hasYouthDivisions && value === "private" && next !== "private") {
      const ok = await confirm({
        title: msg("visibility.youth.title"),
        body: msg("visibility.youth.body"),
        confirmLabel: msg("visibility.youth.confirm"),
      });
      if (!ok) return;
    }
    onChange(next);
  }

  async function copy() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    // min-w-0 matters: a fieldset's UA default is min-inline-size:min-content,
    // which makes it burst out of narrow cards instead of shrinking.
    <fieldset className="min-w-0 space-y-2 [min-inline-size:0]">
      <legend className="label">{msg("visibility.legend")}</legend>
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
              active
                ? "border-purple-400 bg-purple-50/60 ring-1 ring-purple-200"
                : "border-slate-200 bg-white hover:border-purple-200"
            } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <input
              type="radio"
              name="visibility"
              value={opt.value}
              checked={active}
              disabled={disabled}
              onChange={() => void pick(opt.value)}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-800">
                {msg(opt.label)}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                {msg(opt.consequence)}
              </span>
            </span>
          </label>
        );
      })}
      {value !== "private" && shareUrl && (
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-purple-50/70 px-3 py-2">
          <span className="label !mb-0 shrink-0">{msg("visibility.share.label")}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">
            {shareUrl}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="btn btn-ghost shrink-0 px-2 py-1 text-xs"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-green-600" />
                {msg("visibility.share.copied")}
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                {msg("visibility.share.copy")}
              </>
            )}
          </button>
        </div>
      )}
    </fieldset>
  );
}
