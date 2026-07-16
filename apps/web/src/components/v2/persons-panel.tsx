"use client";

// Players directory: add/edit players, consent toggles, merge duplicates.
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { InviteClaim } from "@/components/v2/invite-claim";
import { Tip } from "@/components/ui/tip";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

interface Person {
  id: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
  consent: { public_name?: boolean; public_photo?: boolean };
  external_ref: string | null;
  photo_path: string | null;
  user_id: string | null;
  claim_pending?: boolean;
}

export function PersonsPanel({
  persons,
  storageBase,
  canEdit,
}: {
  persons: Person[];
  storageBase: string;
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mergeSource, setMergeSource] = useState<Person | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return persons;
    return persons.filter((p) => p.full_name.toLowerCase().includes(q));
  }, [persons, filter]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <AddPersonForm
          busy={busy}
          onSubmit={(payload, photo) =>
            run(async () => {
              const person = await apiV1<Person>("/api/v1/persons", {
                method: "POST",
                json: payload,
              });
              if (photo) {
                const form = new FormData();
                form.append("file", photo);
                const res = await fetch(`/api/v1/persons/${person.id}/photo`, {
                  method: "POST",
                  body: form,
                });
                if (!res.ok) {
                  const p = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
                  throw new Error(p.error?.message ?? "Photo upload failed");
                }
              }
            })
          }
        />
      )}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      {mergeSource && (
        <p className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-700">
          {msg("persons.mergingPre")} <strong>{mergeSource.full_name}</strong>{" "}
          {msg("persons.mergingPost")}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setMergeSource(null)}
          >
            {msg("persons.cancel")}
          </button>
        </p>
      )}

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={msg("persons.search")}
        className="input max-w-xs"
      />

      {(() => {
        const identity = (p: Person) => (
          <span className="flex min-w-0 items-center gap-2.5">
            {p.photo_path ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`${storageBase}/${p.photo_path}`}
                alt={`${p.full_name} photo`}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs text-slate-400"
              >
                {p.full_name.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-800">
                {p.full_name}
              </span>
              <span className="block text-xs text-slate-400">
                {[p.dob, p.gender, p.external_ref].filter(Boolean).join(" · ") || "—"}
              </span>
            </span>
          </span>
        );

        const consentPills = (p: Person) => (
          <span className="inline-flex flex-wrap gap-1.5">
            {(
              [
                { key: "public_name" as const, label: msg("persons.consent.name") },
                { key: "public_photo" as const, label: msg("persons.consent.photo") },
              ]
            ).map(({ key, label }) => {
              const on = !!p.consent[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  disabled={!canEdit || busy}
                  title={
                    on
                      ? msg("persons.consent.shownTip", { label })
                      : msg("persons.consent.hiddenTip", { label })
                  }
                  onClick={() =>
                    run(() =>
                      apiV1(`/api/v1/persons/${p.id}`, {
                        method: "PATCH",
                        json: { consent: { ...p.consent, [key]: !on } },
                      }),
                    )
                  }
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition ${
                    on
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-400"
                  } ${canEdit ? "hover:border-slate-400" : ""}`}
                >
                  <span aria-hidden>{on ? "✓" : "–"}</span>
                  {label}
                </button>
              );
            })}
          </span>
        );

        const accountChip = (p: Person) =>
          p.user_id ? (
            <span className="badge bg-emerald-100 text-emerald-700">{msg("claim.claimed")}</span>
          ) : p.claim_pending ? (
            <span className="badge bg-amber-100 text-amber-700">{msg("claim.invited")}</span>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          );

        const actions = (p: Person) => (
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
            <InviteClaim
              personId={p.id}
              personName={p.full_name}
              claimed={!!p.user_id}
              claimPending={!!p.claim_pending}
            />
            {mergeSource && mergeSource.id !== p.id ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await apiV1(`/api/v1/persons/${p.id}/merge`, {
                      method: "POST",
                      json: { duplicate_id: mergeSource.id },
                    });
                    setMergeSource(null);
                  })
                }
                className="btn btn-primary px-2 py-1 text-xs"
              >
                {msg("persons.keepThis")}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || mergeSource?.id === p.id}
                onClick={() => setMergeSource(p)}
                title={msg("persons.merge.tip")}
                className="btn btn-ghost px-2 py-1 text-xs"
              >
                {msg("persons.merge")}
              </button>
            )}
          </span>
        );

        const columns: ResponsiveColumn<Person>[] = [
          { key: "player", header: msg("persons.col.player"), render: identity },
          { key: "public", header: msg("persons.col.public"), render: consentPills },
          { key: "account", header: msg("persons.col.account"), render: accountChip },
          ...(canEdit
            ? [
                {
                  key: "actions",
                  header: (
                    <>
                      {msg("persons.col.actions")}
                      <Tip id="persons.actions" small className="ml-1 align-middle" />
                    </>
                  ),
                  headerClassName: "text-right",
                  className: "text-right",
                  render: actions,
                },
              ]
            : []),
        ];

        return (
          <section className="card p-0 sm:p-0">
            <ResponsiveTable
              aria-label={msg("persons.tableLabel")}
              columns={columns}
              rows={filtered}
              keyOf={(p) => p.id}
              empty={
                <p className="px-4 py-6 text-center text-sm text-slate-400">
                  {msg("persons.empty")}
                </p>
              }
              renderCard={(p) => (
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    {identity(p)}
                    {accountChip(p)}
                  </div>
                  {consentPills(p)}
                  {canEdit && (
                    <div className="flex flex-wrap justify-end gap-1.5 border-t border-slate-100 pt-2">
                      {actions(p)}
                    </div>
                  )}
                </div>
              )}
            />
          </section>
        );
      })()}

    </div>
  );
}

function AddPersonForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>, photo: File | null) => void;
}) {
  const msg = useMsg();
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [publicName, setPublicName] = useState(false);
  const [publicPhoto, setPublicPhoto] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  return (
    <form
      className="card grid w-full grid-cols-1 gap-3 p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          {
            full_name: name,
            dob: dob || null,
            gender: gender || null,
            consent: { public_name: publicName, public_photo: publicPhoto },
          },
          photo,
        );
        setName("");
        setDob("");
        setGender("");
        setPublicName(false);
        setPublicPhoto(false);
        setPhoto(null);
        if (photoInput.current) photoInput.current.value = "";
      }}
    >
      <label className="block">
        <span className="label">{msg("persons.form.fullName")}</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input"
          placeholder={msg("persons.form.namePlaceholder")}
        />
      </label>
      <label className="block">
        <span className="label">{msg("persons.form.dob")}</span>
        <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className="input" />
      </label>
      <label className="block">
        <span className="label">{msg("persons.form.gender")}</span>
        <select value={gender} onChange={(e) => setGender(e.target.value)} className="select">
          <option value="">—</option>
          <option value="m">m</option>
          <option value="f">f</option>
          <option value="x">x</option>
        </select>
      </label>
      <label className="block">
        <span className="label">{msg("persons.form.photo")}</span>
        <input
          ref={photoInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={msg("persons.form.photoAria")}
          className="block w-full text-sm text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={publicName}
          onChange={(e) => setPublicName(e.target.checked)}
          className="h-4 w-4 rounded border-purple-200 accent-purple-600"
        />
        {msg("persons.form.consentName")}
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={publicPhoto}
          onChange={(e) => setPublicPhoto(e.target.checked)}
          className="h-4 w-4 rounded border-purple-200 accent-purple-600"
        />
        {msg("persons.form.consentPhoto")}
      </label>
      <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary w-full sm:col-span-2 sm:w-auto sm:justify-self-start">
        {busy ? msg("persons.form.adding") : msg("persons.form.add")}
      </button>
    </form>
  );
}
