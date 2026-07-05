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

/** Members + invite-link management for an organization (settings panel). */
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
  const [inviteRole, setInviteRole] = useState<"admin" | "viewer" | "scorer">("viewer");
  const [busy, setBusy] = useState(false);

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

  const createInvite = () =>
    run(() =>
      api(`/api/orgs/${orgId}/invites`, {
        method: "POST",
        json: { role: inviteRole, max_uses: 1 },
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

  return (
    <div>
      {error && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {/* Members */}
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-400">
        Members
      </h4>
      {!members ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {members.map((m) => (
            <li
              key={m.user_id}
              className="flex items-center gap-3 rounded-lg border border-purple-50 bg-white px-3 py-2"
            >
              <Avatar name={m.display_name} src={m.avatar_url} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">
                  {m.display_name}
                  {m.user_id === currentUserId && (
                    <span className="ml-1 text-xs text-slate-400">(you)</span>
                  )}
                </p>
                <p className="truncate text-xs text-slate-400">{m.email}</p>
              </div>
              {isOwner && m.user_id !== currentUserId ? (
                <div className="flex shrink-0 items-center gap-2">
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

      {/* Invite links */}
      {isEditor && (
        <>
          <h4 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-purple-400">
            Invite links
          </h4>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">
              Role
              <select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value as "admin" | "viewer" | "scorer")
                }
                className="input mt-1 py-1.5"
              >
                <option value="viewer">Viewer (read-only)</option>
                <option value="admin">Admin (can manage)</option>
                <option value="scorer">Scorer (assigned matches only)</option>
              </select>
            </label>
            <button
              onClick={createInvite}
              disabled={busy}
              className="btn btn-primary"
            >
              + Create link
            </button>
          </div>

          {activeInvites.length > 0 && (
            <ul className="mt-3 space-y-2">
              {activeInvites.map((i) => (
                <li
                  key={i.id}
                  className="flex items-center gap-2 rounded-lg border border-purple-50 bg-white px-3 py-2"
                >
                  <span className={`badge shrink-0 ${ROLE_BADGE[i.role]}`}>
                    {i.role}
                  </span>
                  <InviteLink token={i.token} />
                  {i.expires_at && (
                    <span className="shrink-0 text-xs text-slate-400">
                      expires <ClientTime value={i.expires_at} mode="time" />
                    </span>
                  )}
                  <button
                    onClick={() => revokeInvite(i.token)}
                    disabled={busy}
                    className="shrink-0 text-xs text-red-500 hover:text-red-700"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function InviteLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/join/${token}`
      : `/join/${token}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
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
      {copied ? "Copied!" : url}
    </button>
  );
}
