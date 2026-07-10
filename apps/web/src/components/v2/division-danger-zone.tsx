"use client";

// Division delete/archive (v3/09 §4). Delete asks for the typed division
// name and states exactly what is destroyed vs kept; a 409
// DIVISION_HAS_RESULTS pivots the dialog to the archive suggestion. Archive
// uses a plain danger confirm — it is reversible from competition settings.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { routes } from "@/lib/routes";

interface Props {
  divisionId: string;
  divisionName: string;
  orgSlug: string;
  compSlug: string;
}

export function DivisionDangerZone({ divisionId, divisionName, orgSlug, compSlug }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"none" | "delete" | "archive">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestArchive, setSuggestArchive] = useState(false);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}`, { method: "DELETE" });
      router.push(routes.competition(orgSlug, compSlug));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "DIVISION_HAS_RESULTS") {
        setSuggestArchive(true);
        setDialog("archive");
      } else {
        setError(err instanceof Error ? err.message : "Delete failed");
        setDialog("none");
      }
    } finally {
      setBusy(false);
    }
  }

  async function doArchive() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/archive`, { method: "POST" });
      router.push(routes.competition(orgSlug, compSlug));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Archive failed");
      setDialog("none");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-8 border-red-100 p-5">
      <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
      <p className="mt-1 text-xs text-slate-500">
        Archiving hides this division from your console and the public site — restore it any
        time from competition settings. Deleting is permanent and only possible before the
        division starts.
      </p>
      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-ghost text-slate-600"
          onClick={() => {
            setSuggestArchive(false);
            setDialog("archive");
          }}
          disabled={busy}
        >
          Archive division
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => setDialog("delete")}
          disabled={busy}
        >
          Delete division…
        </button>
      </div>

      <ConfirmDialog
        open={dialog === "delete"}
        title={`Delete ${divisionName}?`}
        confirmLabel="Delete division"
        typedName={divisionName}
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDialog("none")}
      >
        <p>
          <strong>Destroyed:</strong> this division, its stages, fixtures, schedules and
          entrant entries.
        </p>
        <p>
          <strong>Kept:</strong> people, teams and clubs — they belong to your organisation,
          not this division.
        </p>
        <p>This cannot be undone.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "archive"}
        title={`Archive ${divisionName}?`}
        confirmLabel="Archive division"
        busy={busy}
        onConfirm={() => void doArchive()}
        onCancel={() => setDialog("none")}
      >
        {suggestArchive && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-700">
            This division has started or has recorded results, so it can’t be deleted —
            archiving keeps every result and stays restorable.
          </p>
        )}
        <p>
          The division disappears from your console and the public site and stops counting
          against your plan. Nothing is destroyed — restore it any time from competition
          settings → Archived divisions.
        </p>
      </ConfirmDialog>
    </section>
  );
}
