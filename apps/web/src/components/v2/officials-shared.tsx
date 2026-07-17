"use client";

// Shared officials bits (v11.1 follow-up): the avatar/initials helpers and
// the invite-claim inline editor used by BOTH the directory's officials tab
// (full roster management) and the schedule's officials tab (assignment —
// read-only roster strip). Kept here so the two surfaces don't drift.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const AVATAR_COLORS = ["#7c3aed", "#0891b2", "#db2777", "#ea580c", "#16a34a", "#2563eb", "#9333ea", "#c2410c"];
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function OfficialAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "h-6 w-6 text-[10px]" : "h-9 w-9 text-xs";
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white ${dims}`}
      style={{ backgroundColor: avatarColor(name) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/**
 * Invite-to-claim form for one official (v11, reshaped v11.1 UX pass): the
 * trigger button now lives with the CALLER (roster row right rail) and this
 * form renders full-width below the row — the old self-contained toggle
 * expanded inside the row's flex and overlapped the name/role chips. Posts
 * through the shared claim rail; only on email-send failure shows the
 * one-time claim link with a copy button.
 */
export function OfficialInviteForm({
  officialId,
  initialEmail,
  onClose,
}: {
  officialId: string;
  initialEmail: string | null;
  onClose: () => void;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ claim_url: string; email_sent: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiV1<{ claim_url: string; email_sent: boolean }>(
        `/api/v1/officials/${officialId}/invite`,
        { method: "POST", json: { email: email.trim() } },
      );
      setResult(res);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("officials.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {!result ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void send();
          }}
        >
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor={`off-invite-${officialId}`}>
              {msg("officials.inviteEmail")}
            </label>
            <input
              id={`off-invite-${officialId}`}
              type="email"
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {msg("officials.inviteSend")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {msg("officials.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-1.5 text-xs">
          <p className={result.email_sent ? "text-lime-700" : "text-amber-700"}>
            {result.email_sent ? msg("officials.inviteSent") : msg("officials.inviteEmailFailed")}
          </p>
          {!result.email_sent && (
            <>
              <p className="text-slate-500">{msg("officials.inviteLink")}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
                  {result.claim_url}
                </code>
                <button
                  type="button"
                  className="btn btn-ghost py-1 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(result.claim_url);
                    setCopied(true);
                  }}
                >
                  {copied ? msg("officials.copied") : msg("officials.copy")}
                </button>
              </div>
            </>
          )}
          <button type="button" className="btn btn-ghost py-1 text-xs" onClick={onClose}>
            {msg("officials.done")}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * Pure state-transition for the role chip picker (v11.1) — exported so the
 * free-plan swap-not-stack rule is unit-testable without a DOM. Free plan
 * (multiAllowed=false) never holds two roles: picking a second chip SWAPS
 * the selection and reports blocked=true (the caller shows the UpgradeGate
 * pill), matching the server's assertRolesAllowed 1-role limit — the UI must
 * never let a free org submit a set that would 422.
 */
export function nextOfficialRoles(
  current: string[],
  role: string,
  multiAllowed: boolean,
): { roles: string[]; blocked: boolean } {
  if (current.includes(role)) {
    if (current.length === 1) return { roles: current, blocked: false }; // keep >= 1 role
    return { roles: current.filter((r) => r !== role), blocked: false };
  }
  if (multiAllowed) return { roles: [...current, role], blocked: false };
  if (current.length === 0) return { roles: [role], blocked: false };
  return { roles: [role], blocked: true }; // swap, never stack
}

/**
 * Role chip toggle group (v11.1): replaces the old free-text "space
 * separated roles" input. Free plan is single-role — picking a second chip
 * SWAPS the selection (never submits two) and surfaces the same UpgradeGate
 * pill every other Pro gate uses, so the UI never lets a free org 422 the
 * server's assertRolesAllowed check. Pro toggles freely. A small text input
 * appends a role not in the suggestion list.
 */
export function RoleChipPicker({
  value,
  onChange,
  suggestions,
  multiAllowed,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  multiAllowed: boolean;
}) {
  const msg = useMsg();
  const [custom, setCustom] = useState("");
  const [blocked, setBlocked] = useState(false);
  const chips = [...new Set([...suggestions, ...value])];

  function toggle(role: string) {
    const next = nextOfficialRoles(value, role, multiAllowed);
    onChange(next.roles);
    setBlocked(next.blocked);
  }

  function addCustom() {
    const role = custom.trim().toLowerCase().replace(/\s+/g, "_");
    if (!role) return;
    toggle(role);
    setCustom("");
  }

  return (
    <div className="space-y-1.5">
      <span className="label">{msg("officials.roles")}</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={msg("officials.roles")}>
        {chips.map((role) => {
          const active = value.includes(role);
          return (
            <button
              key={role}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(role)}
              className={`rounded-full border px-2.5 py-1 text-xs capitalize transition ${
                active
                  ? "border-purple-600 bg-purple-600 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-purple-300"
              }`}
            >
              {role.replace(/_/g, " ")}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          className="input w-full sm:w-56"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={msg("officials.roleCustomPlaceholder")}
          aria-label={msg("officials.roleCustomPlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-ghost shrink-0 whitespace-nowrap"
          disabled={!custom.trim()}
          onClick={addCustom}
        >
          {msg("officials.roleCustomAdd")}
        </button>
      </div>
      {blocked && <UpgradeGate feature="officials.roles_multi" compact />}
    </div>
  );
}
