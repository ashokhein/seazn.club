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
import { useMsg } from "@/components/i18n/dict-provider";

interface Props {
  divisionId: string;
  divisionName: string;
  orgSlug: string;
  compSlug: string;
}

export function DivisionDangerZone({ divisionId, divisionName, orgSlug, compSlug }: Props) {
  const msg = useMsg();
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
        setError(err instanceof Error ? err.message : msg("danger.deleteFailed"));
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
      setError(err instanceof Error ? err.message : msg("danger.archiveFailed"));
      setDialog("none");
    } finally {
      setBusy(false);
    }
  }

  return (
    // No own card/heading: the settings "Danger zone" disclosure Group is the
    // card AND the label — the inner h2 duplicated it ("Danger zone" twice).
    <section>
      <p className="text-xs text-slate-500">{msg("danger.desc")}</p>
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
          {msg("danger.archive")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => setDialog("delete")}
          disabled={busy}
        >
          {msg("danger.delete")}
        </button>
      </div>

      <ConfirmDialog
        open={dialog === "delete"}
        title={msg("danger.deleteTitle", { name: divisionName })}
        confirmLabel={msg("danger.deleteConfirm")}
        typedName={divisionName}
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDialog("none")}
      >
        <p>
          <strong>{msg("danger.destroyedLabel")}</strong> {msg("danger.destroyedText")}
        </p>
        <p>
          <strong>{msg("danger.keptLabel")}</strong> {msg("danger.keptText")}
        </p>
        <p>{msg("danger.cannotUndo")}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "archive"}
        title={msg("danger.archiveTitle", { name: divisionName })}
        confirmLabel={msg("danger.archiveConfirm")}
        busy={busy}
        onConfirm={() => void doArchive()}
        onCancel={() => setDialog("none")}
      >
        {suggestArchive && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-700">{msg("danger.suggestArchive")}</p>
        )}
        <p>{msg("danger.archiveBody")}</p>
      </ConfirmDialog>
    </section>
  );
}
