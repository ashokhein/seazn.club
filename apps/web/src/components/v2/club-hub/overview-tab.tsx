"use client";
// Club hub → Overview (W1 §5.2): profile edit, kit colours (flat colour record
// home_primary/home_secondary/away_primary/away_secondary), contacts CRUD, and a
// danger zone. patchClub + the contacts routes finally get a UI. The kit stripe
// in the page header reads the same colours this tab edits.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { kitChipStyle } from "./kit-style";

interface Contact {
  id: string;
  role_key: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
}
interface ClubFull {
  id: string;
  name: string;
  short_name: string | null;
  slug: string | null;
  logo_path: string | null;
  colors: Record<string, string> | null;
  external_ref: string | null;
  home_ground: string | null;
  website: string | null;
  notes: string | null;
  contacts: Contact[];
}

const ROLES = ["secretary", "chairman", "treasurer", "welfare", "manager", "other"] as const;
const KIT_GROUPS = [
  {
    key: "home",
    slots: [
      { role: "primary", colorKey: "home_primary" },
      { role: "secondary", colorKey: "home_secondary" },
    ],
  },
  {
    key: "away",
    slots: [
      { role: "primary", colorKey: "away_primary" },
      { role: "secondary", colorKey: "away_secondary" },
    ],
  },
] as const;

/** Role labels come from a fixed key set; an unknown role_key (an older import)
 *  degrades to "Other" rather than rendering a raw key. */
function roleLabelKey(role: string): MessageKey {
  return ((ROLES as readonly string[]).includes(role)
    ? `clubs.contact.role.${role}`
    : "clubs.contact.role.other") as MessageKey;
}

export function OverviewTab({
  club,
  canEdit,
  storageBase,
}: {
  club: ClubFull;
  canEdit: boolean;
  storageBase: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: club.name,
    short_name: club.short_name ?? "",
    slug: club.slug ?? "",
    home_ground: club.home_ground ?? "",
    website: club.website ?? "",
    notes: club.notes ?? "",
  });
  const [colors, setColors] = useState<Record<string, string>>(club.colors ?? {});
  const [contact, setContact] = useState({ role_key: "secretary", full_name: "", email: "", phone: "" });

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setPaywall(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED")
        setPaywall(String(err.extra.feature_key ?? ""));
      else setError(err instanceof Error ? err.message : msg("clubs.overview.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const savePatch = () =>
    run(() =>
      apiV1(`/api/v1/clubs/${club.id}`, {
        method: "PATCH",
        json: {
          name: form.name.trim(),
          short_name: form.short_name.trim() || null,
          slug: form.slug.trim() || null,
          home_ground: form.home_ground.trim() || null,
          website: form.website.trim() || null,
          notes: form.notes.trim() || null,
          colors: Object.keys(colors).length ? colors : null,
        },
      }),
    );

  return (
    <div className="space-y-5">
      {paywall && <UpgradeGate feature={paywall} />}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {/* Profile + kit colours */}
      <section className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <label className="label flex flex-col gap-1">
          {msg("clubs.form.name")}
          <input
            className="input"
            disabled={!canEdit}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="label flex flex-col gap-1">
          {msg("clubs.form.short")}
          <input
            className="input"
            disabled={!canEdit}
            value={form.short_name}
            onChange={(e) => setForm({ ...form, short_name: e.target.value })}
          />
        </label>
        <label className="label flex flex-col gap-1">
          {msg("clubs.overview.slug")}
          <input
            className="input"
            disabled={!canEdit}
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
          />
        </label>
        <label className="label flex flex-col gap-1">
          {msg("clubs.overview.homeGround")}
          <input
            className="input"
            disabled={!canEdit}
            value={form.home_ground}
            onChange={(e) => setForm({ ...form, home_ground: e.target.value })}
          />
        </label>
        <label className="label flex flex-col gap-1">
          {msg("clubs.overview.website")}
          <input
            className="input"
            type="url"
            disabled={!canEdit}
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
          />
        </label>
        <label className="label flex flex-col gap-1 sm:col-span-2">
          {msg("clubs.overview.notes")}
          <textarea
            className="input"
            rows={3}
            disabled={!canEdit}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </label>

        <div className="sm:col-span-2">
          <p className="label mb-2">{msg("clubs.overview.kitColours")}</p>
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            {KIT_GROUPS.map((group) => (
              <fieldset key={group.key}>
                <legend className="text-xs font-medium text-slate-500">
                  {msg(`clubs.overview.kit.${group.key}`)}
                </legend>
                <div className="mt-1 flex items-end gap-3">
                  {group.slots.map((slot) => (
                    <label key={slot.colorKey} className="flex flex-col gap-1 text-xs text-slate-500">
                      {msg(`clubs.overview.${slot.role}`)}
                      <input
                        type="color"
                        disabled={!canEdit}
                        value={colors[slot.colorKey] ?? "#0f172a"}
                        aria-label={msg(`clubs.overview.color.${slot.colorKey}`)}
                        onChange={(e) => setColors({ ...colors, [slot.colorKey]: e.target.value })}
                        className="h-9 w-14 cursor-pointer rounded border border-slate-200"
                      />
                    </label>
                  ))}
                  <span
                    aria-hidden
                    title={msg("clubs.overview.kitPreview")}
                    className="mb-0.5 h-3.5 w-3.5 rounded-sm ring-1 ring-slate-200"
                    style={kitChipStyle(colors[group.slots[0].colorKey], colors[group.slots[1].colorKey])}
                  />
                </div>
              </fieldset>
            ))}
          </div>
        </div>

        {canEdit && (
          <div className="flex justify-end sm:col-span-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void savePatch()}
            >
              {msg("clubs.overview.save")}
            </button>
          </div>
        )}
      </section>

      {/* Club crest — the identity every team without its own badge inherits. */}
      <CrestCard
        clubId={club.id}
        logoPath={club.logo_path}
        storageBase={storageBase}
        canEdit={canEdit}
        onError={setError}
        onPaywall={setPaywall}
        onChanged={() => router.refresh()}
      />

      {/* Contacts */}
      <section className="card space-y-3 p-4" aria-label={msg("clubs.overview.contactsTitle")}>
        <h2 className="text-sm font-semibold text-slate-900">{msg("clubs.overview.contactsTitle")}</h2>
        {club.contacts.length === 0 && (
          <p className="text-sm text-slate-500">{msg("clubs.overview.noContacts")}</p>
        )}
        {club.contacts.length > 0 && (
          <ul className="space-y-2 text-sm">
            {club.contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {msg(roleLabelKey(c.role_key))}
                </span>
                <span className="font-medium text-slate-800">{c.full_name}</span>
                {c.is_primary && (
                  <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                    {msg("clubs.contact.primary")}
                  </span>
                )}
                {c.email && <span className="text-slate-500">{c.email}</span>}
                {c.phone && <span className="text-slate-500">{c.phone}</span>}
                {canEdit && (
                  <span className="ml-auto flex items-center gap-3">
                    {!c.is_primary && (
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded px-1 py-2 text-xs font-medium text-purple-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300"
                        onClick={() =>
                          void run(() =>
                            apiV1(`/api/v1/clubs/${club.id}/contacts/${c.id}`, {
                              method: "PATCH",
                              json: { is_primary: true },
                            }),
                          )
                        }
                      >
                        {msg("clubs.contact.makePrimary")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded px-1 py-2 text-xs font-medium text-red-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                      onClick={() =>
                        void run(() =>
                          apiV1(`/api/v1/clubs/${club.id}/contacts/${c.id}`, { method: "DELETE" }),
                        )
                      }
                    >
                      {msg("clubs.contact.remove")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form
            className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!contact.full_name.trim()) return;
              void run(async () => {
                await apiV1(`/api/v1/clubs/${club.id}/contacts`, {
                  method: "POST",
                  json: {
                    role_key: contact.role_key,
                    full_name: contact.full_name.trim(),
                    email: contact.email.trim() || null,
                    phone: contact.phone.trim() || null,
                    is_primary: club.contacts.length === 0,
                  },
                });
                setContact({ role_key: "secretary", full_name: "", email: "", phone: "" });
              });
            }}
          >
            <label className="label flex flex-col gap-1 text-xs">
              {msg("clubs.contact.role")}
              <select
                className="input"
                value={contact.role_key}
                onChange={(e) => setContact({ ...contact, role_key: e.target.value })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {msg(`clubs.contact.role.${r}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="label flex flex-col gap-1 text-xs">
              {msg("clubs.contact.name")}
              <input
                className="input"
                value={contact.full_name}
                required
                onChange={(e) => setContact({ ...contact, full_name: e.target.value })}
              />
            </label>
            <label className="label flex flex-col gap-1 text-xs">
              {msg("clubs.contact.email")}
              <input
                className="input"
                type="email"
                value={contact.email}
                onChange={(e) => setContact({ ...contact, email: e.target.value })}
              />
            </label>
            <label className="label flex flex-col gap-1 text-xs">
              {msg("clubs.contact.phone")}
              <input
                className="input"
                value={contact.phone}
                onChange={(e) => setContact({ ...contact, phone: e.target.value })}
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {msg("clubs.contact.add")}
            </button>
          </form>
        )}
      </section>

      {/* Danger zone */}
      {canEdit && (
        <section className="card border-red-200 p-4">
          <h2 className="text-sm font-semibold text-red-700">{msg("clubs.overview.danger")}</h2>
          <p className="mb-3 text-xs text-slate-500">{msg("clubs.overview.deleteHint")}</p>
          <button
            type="button"
            className="btn btn-ghost w-full text-red-600 sm:w-auto"
            disabled={busy}
            onClick={async () => {
              const ok = await confirmDialog({
                title: msg("confirm.deleteClub.title"),
                body: msg("confirm.deleteClub.body", { name: club.name }),
                confirmLabel: msg("confirm.deleteClub.label"),
                tone: "danger",
              });
              if (!ok) return;
              await run(() => apiV1(`/api/v1/clubs/${club.id}`, { method: "DELETE" }));
              window.location.href = "/directory?tab=clubs";
            }}
          >
            {msg("clubs.delete")}
          </button>
        </section>
      )}
    </div>
  );
}

// Single-file club crest control. Reuses the bulk-logo endpoint with an
// explicit one-file mapping pinned to this club — the `mapping` entry is the
// input the server honours over its own filename stem-matching, so the upload
// can never land on a sibling org club. Removal clears the pointer only
// (crest objects are content-hash shared).
function CrestCard({
  clubId,
  logoPath,
  storageBase,
  canEdit,
  onError,
  onPaywall,
  onChanged,
}: {
  clubId: string;
  logoPath: string | null;
  storageBase: string;
  canEdit: boolean;
  onError: (msg: string | null) => void;
  onPaywall: (feature: string | null) => void;
  onChanged: () => void;
}) {
  const msg = useMsg();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      const form = new FormData();
      form.append("files", file);
      form.append("mapping", JSON.stringify({ [file.name]: clubId }));
      form.append("assign_remaining", "false");
      const res = await fetch("/api/v1/clubs/logos", { method: "POST", body: form });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: { message?: string; feature_key?: string };
      };
      if (!res.ok || payload.ok === false) {
        if (res.status === 402) {
          onPaywall(String(payload.error?.feature_key ?? ""));
          return;
        }
        throw new Error(payload.error?.message ?? `Upload failed (${res.status})`);
      }
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    onError(null);
    try {
      await apiV1(`/api/v1/clubs/${clubId}`, { method: "PATCH", json: { logo_path: null } });
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3 p-4" aria-label={msg("clubs.crest.title")}>
      <h2 className="text-sm font-semibold text-slate-900">{msg("clubs.crest.title")}</h2>
      <div className="flex flex-wrap items-center gap-4">
        {/* The tile itself is the primary upload target — click to pick a file. */}
        <button
          type="button"
          disabled={!canEdit || busy}
          onClick={() => inputRef.current?.click()}
          aria-label={logoPath ? msg("clubs.crest.replace") : msg("clubs.crest.upload")}
          className="group relative rounded-lg focus-visible:ring-2 focus-visible:ring-purple-400 disabled:cursor-default"
        >
          {logoPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${storageBase}/${logoPath}`}
              alt={msg("clubs.crest.title")}
              className="h-16 w-16 rounded-lg border border-slate-200 object-contain"
            />
          ) : (
            <span className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-slate-300 text-slate-400 group-hover:border-purple-400 group-hover:text-purple-500">
              <span aria-hidden className="text-lg leading-none">+</span>
              <span className="text-[9px] uppercase tracking-wide">{msg("clubs.crest.emptyTile")}</span>
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-slate-500">{msg("clubs.crest.hint")}</p>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary min-h-[44px] text-sm sm:min-h-0"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {busy
                  ? msg("clubs.team.uploading")
                  : logoPath
                    ? msg("clubs.crest.replace")
                    : msg("clubs.crest.upload")}
              </button>
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  void upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {logoPath && (
                <button
                  type="button"
                  className="btn min-h-[44px] text-sm sm:min-h-0"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {msg("clubs.crest.remove")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
