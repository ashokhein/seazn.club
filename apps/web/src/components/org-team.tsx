"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Avatar } from "@/components/avatar";
import { ClientTime } from "@/components/client-time";
import {
  ORG_ROLES,
  type OrgInvite,
  type OrgMember,
  type OrgRole,
} from "@/lib/types";

const ROLE_BADGE: Record<OrgRole, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
  scorer: "bg-emerald-100 text-emerald-700",
};

type InviteRole = "admin" | "viewer" | "scorer";

/** How long a shareable team-settings link lives, in days. 24 hours: long
 *  enough to survive the tab that created it and be shared in the group
 *  chat, short enough that a leaked link ages out on its own. Courtside QR
 *  invites keep their own 1-hour TTL server-side. */
const LINK_INVITE_DAYS = 1;

function RoleOptions() {
  return (
    <>
      <option value="viewer">Viewer (read-only)</option>
      <option value="admin">Admin (can manage)</option>
      <option value="scorer">Scorer (assigned matches only)</option>
    </>
  );
}

/** Members + invite management (email + shareable link) for an organization
 *  (settings panel). */
export function OrgTeam({
  orgId,
  role,
  currentUserId,
}: {
  orgId: string;
  role: OrgRole;
  currentUserId: string;
}) {
  const isOwner = role === "owner";
  const isEditor = role === "owner" || role === "admin";

  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [emailAddr, setEmailAddr] = useState("");
  const [emailRole, setEmailRole] = useState<InviteRole>("viewer");
  const [emailNotice, setEmailNotice] = useState<
    { kind: "ok" | "warn"; text: string } | null
  >(null);
  const [linkRole, setLinkRole] = useState<InviteRole>("viewer");

  const load = useCallback(async () => {
    try {
      const [m, inv] = await Promise.all([
        api<OrgMember[]>(`/api/orgs/${orgId}/members`),
        isEditor
          ? api<OrgInvite[]>(`/api/orgs/${orgId}/invites`)
          : Promise.resolve([] as OrgInvite[]),
      ]);
      setMembers(m);
      setInvites(inv);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [orgId, isEditor]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const sendEmailInvite = () =>
    run(async () => {
      setEmailNotice(null);
      const out = await api<OrgInvite & { email_sent?: boolean }>(
        `/api/orgs/${orgId}/invites`,
        { method: "POST", json: { role: emailRole, email: emailAddr.trim() } },
      );
      setEmailNotice(
        out.email_sent
          ? { kind: "ok", text: `Invite sent to ${out.email}` }
          : {
              kind: "warn",
              text: "The email could not be sent — copy their personal link below and share it directly.",
            },
      );
      setEmailAddr("");
    });

  const createLink = () =>
    run(() =>
      api(`/api/orgs/${orgId}/invites`, {
        method: "POST",
        json: { role: linkRole, max_uses: 0, expires_in_days: LINK_INVITE_DAYS },
      }),
    );

  const revokeInvite = (token: string) =>
    run(() =>
      api(`/api/orgs/${orgId}/invites/${token}/revoke`, { method: "POST" }),
    );

  const changeRole = (userId: string, newRole: OrgRole) =>
    run(() =>
      api(`/api/orgs/${orgId}/members/${userId}/role`, {
        method: "POST",
        json: { role: newRole },
      }),
    );

  const removeMember = (userId: string) =>
    run(() =>
      api(`/api/orgs/${orgId}/members/${userId}`, { method: "DELETE" }),
    );

  const activeInvites = invites.filter(
    (i) =>
      !i.revoked &&
      (i.max_uses === 0 || i.used_count < i.max_uses) &&
      (!i.expires_at || new Date(i.expires_at).getTime() > Date.now()),
  );
  const emailInvites = activeInvites.filter((i) => i.email);
  const linkInvites = activeInvites.filter((i) => !i.email);

  return (
    <div>
      {error && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {/* Members */}
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-600">
        Members
      </h4>
      {!members ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {members.map((m) => (
            <li
              key={m.user_id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-purple-50 bg-white px-3 py-2"
            >
              <Avatar name={m.display_name} src={m.avatar_url} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">
                  {m.display_name}
                  {m.user_id === currentUserId && (
                    <span className="ml-1 text-xs text-slate-500">(you)</span>
                  )}
                </p>
                <p className="truncate text-xs text-slate-500">{m.email}</p>
              </div>
              {isOwner && m.user_id !== currentUserId ? (
                /* Actions wrap to their own full-width line on phones —
                   thumb-sized targets instead of a cramped row (v3/02 §3.1). */
                <div className="flex w-full items-center justify-end gap-2 sm:w-auto sm:shrink-0">
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) =>
                      changeRole(m.user_id, e.target.value as OrgRole)
                    }
                    className="input py-1 text-xs"
                  >
                    {ORG_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeMember(m.user_id)}
                    disabled={busy}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className={`badge shrink-0 ${ROLE_BADGE[m.role]}`}>
                  {m.role}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Invite by email */}
      {isEditor && (
        <>
          <h4 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-purple-600">
            Invite by email
          </h4>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (emailAddr.trim()) sendEmailInvite();
            }}
          >
            <label className="min-w-[12rem] flex-1 text-xs text-slate-500">
              Email
              <input
                type="email"
                required
                value={emailAddr}
                onChange={(e) => setEmailAddr(e.target.value)}
                placeholder="name@club.org"
                className="input mt-1"
              />
            </label>
            <label className="text-xs text-slate-500">
              Role
              <select
                value={emailRole}
                onChange={(e) => setEmailRole(e.target.value as InviteRole)}
                className="input mt-1 py-1.5"
              >
                <RoleOptions />
              </select>
            </label>
            <button
              type="submit"
              disabled={busy || !emailAddr.trim()}
              className="btn btn-primary w-full sm:w-auto"
            >
              Send invite
            </button>
          </form>
          {emailNotice && (
            <p
              className={`mt-2 rounded-md px-3 py-2 text-sm ${
                emailNotice.kind === "ok"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-amber-50 text-amber-700"
              }`}
            >
              {emailNotice.text}
            </p>
          )}
          {emailInvites.length > 0 && (
            <ul className="mt-3 space-y-2">
              {emailInvites.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-purple-50 bg-white px-3 py-2"
                >
                  <span className={`badge shrink-0 ${ROLE_BADGE[i.role]}`}>
                    {i.role}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                    {i.email}
                  </span>
                  {/* Meta wraps to its own full-width line on phones — the
                      address keeps the room (v3/02 §3.1, same as members). */}
                  <span className="flex w-full items-center justify-end gap-3 sm:w-auto sm:shrink-0">
                    {i.expires_at && (
                      <span className="shrink-0 text-xs text-slate-500">
                        expires <ClientTime value={i.expires_at} mode="date" />
                      </span>
                    )}
                    <CopyLinkButton token={i.token} />
                    <button
                      onClick={() => revokeInvite(i.token)}
                      disabled={busy}
                      className="shrink-0 text-xs text-red-500 hover:text-red-700"
                    >
                      Revoke
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Invite by link */}
          <h4 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-purple-600">
            Invite by link
          </h4>
          <p className="mb-2 text-xs text-slate-500">
            Anyone with the link joins as the selected role. Links last 24
            hours and stay listed here until they expire or are revoked.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">
              Role
              <select
                value={linkRole}
                onChange={(e) => setLinkRole(e.target.value as InviteRole)}
                className="input mt-1 py-1.5"
              >
                <RoleOptions />
              </select>
            </label>
            <button
              onClick={createLink}
              disabled={busy}
              className="btn btn-primary w-full sm:w-auto"
            >
              + Create link
            </button>
          </div>

          {linkInvites.length > 0 && (
            <ul className="mt-3 space-y-2">
              {linkInvites.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-purple-50 bg-white px-3 py-2"
                >
                  <span className={`badge shrink-0 ${ROLE_BADGE[i.role]}`}>
                    {i.role}
                  </span>
                  <InviteLink token={i.token} />
                  <span className="flex w-full items-center justify-end gap-3 sm:w-auto sm:shrink-0">
                    <span className="shrink-0 text-xs text-slate-500">
                      {i.max_uses === 0 && i.used_count > 0 && (
                        <>{i.used_count} joined · </>
                      )}
                      {i.expires_at && (
                        <>
                          expires <ClientTime value={i.expires_at} mode="datetime" />
                        </>
                      )}
                    </span>
                    <button
                      onClick={() => revokeInvite(i.token)}
                      disabled={busy}
                      className="shrink-0 text-xs text-red-500 hover:text-red-700"
                    >
                      Revoke
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function joinUrl(token: string): string {
  return typeof window !== "undefined"
    ? `${window.location.origin}/join/${token}`
    : `/join/${token}`;
}

function InviteLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  // The token is masked on screen (shoulder-surfing, screen shares); Copy
  // puts the full URL on the clipboard.
  const masked = `/join/${token.slice(0, 4)}…${token.slice(-4)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(joinUrl(token));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <button
      onClick={copy}
      className="min-w-0 flex-1 truncate text-left font-mono text-xs text-purple-700 hover:underline"
      title="Copy invite link"
    >
      {copied ? "Copied!" : `${masked} — copy link`}
    </button>
  );
}

/** Compact copy affordance for email-invite rows (the address is the
 *  identity there; the URL itself would just be noise). */
function CopyLinkButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(joinUrl(token));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <button
      onClick={copy}
      className="shrink-0 text-xs text-purple-700 hover:underline"
      title="Copy invite link"
    >
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}
