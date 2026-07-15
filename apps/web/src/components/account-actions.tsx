"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";

// ---------------------------------------------------------------------------
// Display name form
// ---------------------------------------------------------------------------

export function DisplayNameForm({ currentName }: { currentName: string }) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [status, setStatus] = useState<"idle" | "loading" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to update display name");
      }
      setStatus("saved");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  }

  const trimmed = name.trim();
  const unchanged = trimmed === currentName;

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setStatus("idle");
          }}
          placeholder="Your name"
          required
          maxLength={80}
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={status === "loading" || !trimmed || unchanged}
          className="btn btn-primary shrink-0"
        >
          {status === "loading" ? "Saving…" : "Save"}
        </button>
      </div>
      {status === "saved" && unchanged && (
        <p className="text-sm text-emerald-600">Display name updated.</p>
      )}
      {status === "error" && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Change email form
// ---------------------------------------------------------------------------

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [newEmail, setNewEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    try {
      const res = await fetch("/api/auth/change-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_email: newEmail }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to request email change");
      }
      setStatus("sent");
      setNewEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        Confirmation link sent to your new address. Check your inbox and click the link
        to complete the change.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-sm text-slate-500">
        Current email: <span className="font-medium text-slate-700">{currentEmail}</span>
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="new@example.com"
          required
          maxLength={120}
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={status === "loading" || !newEmail}
          className="btn btn-primary shrink-0"
        >
          {status === "loading" ? "Sending…" : "Change email"}
        </button>
      </div>
      {(status === "error") && (
        <p className="text-sm text-red-600">{error}</p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Leave org button
// ---------------------------------------------------------------------------

export function LeaveOrgButton({ orgId, orgName }: { orgId: string; orgName: string }) {
  const msg = useMsg();
  const router = useRouter();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLeave() {
    const ok = await confirm({
      title: msg("confirm.leaveOrg.title"),
      body: msg("confirm.leaveOrg.body", { name: orgName }),
      confirmLabel: msg("confirm.leaveOrg.label"),
      tone: "danger",
    });
    if (!ok) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/members/me`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to leave organization");
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        onClick={handleLeave}
        disabled={loading}
        className="btn btn-ghost text-sm text-red-600 hover:bg-red-50"
      >
        {loading ? "Leaving…" : "Leave org"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transfer ownership inline form
// ---------------------------------------------------------------------------

export function TransferOwnerForm({
  orgId,
  members,
}: {
  orgId: string;
  members: { user_id: string; display_name: string; email: string; role: string }[];
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirm = useConfirm();
  const [newOwnerId, setNewOwnerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const candidates = members.filter((m) => m.role !== "owner");

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: msg("confirm.transferOwner.title"),
      body: msg("confirm.transferOwner.body"),
      confirmLabel: msg("confirm.transferOwner.label"),
      tone: "danger",
    });
    if (!ok) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/transfer-owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_owner_id: newOwnerId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to transfer ownership");
      }
      setDone(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        Ownership transferred successfully.
      </p>
    );
  }

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        Add at least one other member before transferring ownership.
      </p>
    );
  }

  return (
    <form onSubmit={handleTransfer} className="space-y-3">
      <div className="flex gap-2">
        <select
          value={newOwnerId}
          onChange={(e) => setNewOwnerId(e.target.value)}
          required
          className="input flex-1"
        >
          <option value="">Select new owner…</option>
          {candidates.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.display_name} ({m.email})
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading || !newOwnerId}
          className="btn btn-ghost text-sm text-amber-700 hover:bg-amber-50 shrink-0"
        >
          {loading ? "Transferring…" : "Transfer"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Delete account button (danger zone)
// ---------------------------------------------------------------------------

export function DeleteAccountButton() {
  const [phase, setPhase] = useState<"idle" | "confirm" | "loading" | "done">("idle");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");

  async function handleDelete() {
    setPhase("loading");
    setError("");
    try {
      const res = await fetch("/api/users/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to delete account");
      }
      setPhase("done");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("confirm");
    }
  }

  if (phase === "idle") {
    return (
      <button
        onClick={() => setPhase("confirm")}
        className="btn btn-ghost text-sm text-red-600 hover:bg-red-50"
      >
        Delete account
      </button>
    );
  }

  if (phase === "done") {
    return <p className="text-sm text-slate-500">Account deleted. Redirecting…</p>;
  }

  return (
    <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-medium text-red-800">
        This will permanently delete your account. Type{" "}
        <span className="font-mono font-bold">DELETE</span> to confirm.
      </p>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder="DELETE"
        className="input border-red-300 focus:ring-red-400"
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleDelete}
          disabled={typed !== "DELETE" || phase === "loading"}
          className="btn btn-ghost bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
        >
          {phase === "loading" ? "Deleting…" : "Delete my account"}
        </button>
        <button
          onClick={() => { setPhase("idle"); setTyped(""); setError(""); }}
          className="btn btn-ghost"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
