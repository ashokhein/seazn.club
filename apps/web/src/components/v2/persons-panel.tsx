"use client";

// Players directory: add/edit players, consent toggles, merge duplicates.
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";

interface Person {
  id: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
  consent: { public_name?: boolean; public_photo?: boolean };
  external_ref: string | null;
  photo_path: string | null;
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
          Merging <strong>{mergeSource.full_name}</strong> into… pick the player to
          keep below.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setMergeSource(null)}
          >
            cancel
          </button>
        </p>
      )}

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search players…"
        className="input max-w-xs"
      />

      <section className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">DOB</th>
              <th className="px-4 py-2 text-left">Gender</th>
              <th className="px-4 py-2 text-left">Public name</th>
              <th className="px-4 py-2 text-left">Public photo</th>
              {canEdit && <th className="px-4 py-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 6 : 5} className="px-4 py-6 text-center text-sm text-slate-400">
                  No players found.
                </td>
              </tr>
            )}
            {filtered.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-2 text-sm font-medium text-slate-800">
                  <span className="flex items-center gap-2">
                    {p.photo_path ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${storageBase}/${p.photo_path}`}
                        alt={`${p.full_name} photo`}
                        className="h-7 w-7 rounded-full object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-xs text-slate-400"
                      >
                        {p.full_name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span>
                      {p.full_name}
                      {p.external_ref && (
                        <span className="ml-2 font-mono text-xs text-slate-400">
                          {p.external_ref}
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="px-4 py-2 text-sm text-slate-500">{p.dob ?? "—"}</td>
                <td className="px-4 py-2 text-sm text-slate-500">{p.gender ?? "—"}</td>
                {(["public_name", "public_photo"] as const).map((key) => (
                  <td key={key} className="px-4 py-2">
                    <button
                      type="button"
                      disabled={!canEdit || busy}
                      onClick={() =>
                        run(() =>
                          apiV1(`/api/v1/persons/${p.id}`, {
                            method: "PATCH",
                            json: { consent: { ...p.consent, [key]: !p.consent[key] } },
                          }),
                        )
                      }
                      className={`badge ${
                        p.consent[key]
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-slate-100 text-slate-500"
                      } ${canEdit ? "cursor-pointer" : ""}`}
                    >
                      {p.consent[key] ? "yes" : "no"}
                    </button>
                  </td>
                ))}
                {canEdit && (
                  <td className="px-4 py-2 text-right text-xs">
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
                        Keep this one
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || mergeSource?.id === p.id}
                        onClick={() => setMergeSource(p)}
                        className="text-slate-400 hover:text-purple-600 hover:underline"
                      >
                        merge…
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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
        <span className="label">Full name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input"
          placeholder="Priya Sharma"
        />
      </label>
      <label className="block">
        <span className="label">DOB (eligibility only)</span>
        <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className="input" />
      </label>
      <label className="block">
        <span className="label">Gender</span>
        <select value={gender} onChange={(e) => setGender(e.target.value)} className="select">
          <option value="">—</option>
          <option value="m">m</option>
          <option value="f">f</option>
          <option value="x">x</option>
        </select>
      </label>
      <label className="block">
        <span className="label">Photo</span>
        <input
          ref={photoInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Player photo"
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
        consents to public name
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={publicPhoto}
          onChange={(e) => setPublicPhoto(e.target.checked)}
          className="h-4 w-4 rounded border-purple-200 accent-purple-600"
        />
        consents to public photo
      </label>
      <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary w-full sm:col-span-2 sm:w-auto sm:justify-self-start">
        {busy ? "Adding…" : "Add player"}
      </button>
    </form>
  );
}
