"use client";
// SPEC-2 console News tab (PROMPT-83): a drafts queue (auto-drafts badged ⚡, a
// "result changed" stale chip when auto_source.stale), the published list, and
// the composer. .app-* panel/table idiom; ⚡ auto + stale are chips, not banners.
// Renders straight off the server-passed posts (router.refresh() after every
// mutation re-runs the page and re-passes them) — no client-side list cache to
// drift. Manual posts are free on every plan; nothing here gates.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Zap, Pencil, Trash2, Send, Archive, ExternalLink } from "lucide-react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { kindEyebrow } from "@/lib/news-presentation";
import { Composer } from "@/components/news/composer";
import type { OrgPost, PostKind } from "@/server/usecases/org-posts";

const KIND_CHIP: Record<
  ReturnType<typeof kindEyebrow>["tone"],
  string
> = {
  lime: "bg-lime-100 text-lime-800",
  white: "bg-slate-100 text-slate-700",
  red: "bg-red-100 text-red-700",
  muted: "bg-slate-100 text-slate-500",
};

function KindChip({ kind, label }: { kind: PostKind; label: string }) {
  const tone = kindEyebrow(kind).tone;
  return (
    <span className={`badge text-[10px] uppercase tracking-wide ${KIND_CHIP[tone]}`}>{label}</span>
  );
}

export function NewsTab({
  orgId,
  orgSlug,
  posts,
  competitions,
  canEdit,
}: {
  orgId: string;
  orgSlug: string;
  posts: OrgPost[];
  competitions: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [mode, setMode] = useState<{ kind: "closed" } | { kind: "new" } | { kind: "edit"; post: OrgPost }>({
    kind: "closed",
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const drafts = posts.filter((p) => p.status === "draft");
  const published = posts.filter((p) => p.status === "published");

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("news.actionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  const publish = (p: OrgPost) =>
    act(p.id, () => apiV1(`/api/v1/posts/${p.id}`, { method: "PATCH", json: { action: "publish" } }));
  const archive = (p: OrgPost) =>
    act(p.id, () => apiV1(`/api/v1/posts/${p.id}`, { method: "PATCH", json: { action: "archive" } }));
  const remove = (p: OrgPost) =>
    act(p.id, () => apiV1(`/api/v1/posts/${p.id}`, { method: "DELETE" }));

  function kindLabel(kind: PostKind): string {
    return msg(`news.kind.${kind === "round_recap" ? "recap" : kind}`);
  }

  return (
    <div className="space-y-6" data-testid="news-tab">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">{msg("news.intro")}</p>
        {canEdit && mode.kind === "closed" && (
          <button
            type="button"
            onClick={() => setMode({ kind: "new" })}
            className="btn btn-primary text-sm"
            data-testid="news-new"
          >
            <Plus className="h-4 w-4" /> {msg("news.new")}
          </button>
        )}
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {mode.kind !== "closed" && (
        <section className="card p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-800">
            {mode.kind === "new" ? msg("news.composeNew") : msg("news.editPost")}
          </h3>
          <Composer
            orgId={orgId}
            competitions={competitions}
            post={mode.kind === "edit" ? mode.post : undefined}
            onDone={(changed) => {
              setMode({ kind: "closed" });
              if (changed) router.refresh();
            }}
          />
        </section>
      )}

      {/* Drafts queue */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {msg("news.drafts")} ({drafts.length})
        </h3>
        {drafts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
            {msg("news.draftsEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
            {drafts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-3" data-testid="draft-row">
                <KindChip kind={p.kind} label={kindLabel(p.kind)} />
                {p.autoSource ? (
                  <span
                    className="badge bg-purple-100 text-[10px] uppercase tracking-wide text-purple-700"
                    data-testid="auto-chip"
                    title={msg("news.autoDraft")}
                  >
                    <Zap className="h-3 w-3" /> {msg("news.auto")}
                  </span>
                ) : null}
                {p.autoSource?.stale ? (
                  <span
                    className="badge bg-amber-100 text-[10px] uppercase tracking-wide text-amber-700"
                    data-testid="stale-chip"
                  >
                    {msg("news.stale")}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{p.title}</span>
                {canEdit && (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setMode({ kind: "edit", post: p })}
                      className="btn btn-ghost px-2 py-1 text-xs"
                      aria-label={msg("news.edit")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => publish(p)}
                      className="btn btn-primary px-2.5 py-1 text-xs"
                      data-testid="draft-publish"
                    >
                      <Send className="h-3.5 w-3.5" /> {msg("news.publish")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => remove(p)}
                      className="btn btn-ghost px-2 py-1 text-xs text-red-500"
                      aria-label={msg("news.delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Published */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {msg("news.published")} ({published.length})
        </h3>
        {published.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
            {msg("news.publishedEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
            {published.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-3" data-testid="published-row">
                <KindChip kind={p.kind} label={kindLabel(p.kind)} />
                <a
                  href={`/shared/${orgSlug}/news/${p.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 hover:text-purple-700"
                >
                  {p.title}
                </a>
                <a
                  href={`/shared/${orgSlug}/news/${p.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost px-2 py-1 text-xs"
                  aria-label={msg("news.viewPublic")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                {canEdit && (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setMode({ kind: "edit", post: p })}
                      className="btn btn-ghost px-2 py-1 text-xs"
                      aria-label={msg("news.edit")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => archive(p)}
                      className="btn btn-ghost px-2 py-1 text-xs"
                      aria-label={msg("news.archive")}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => remove(p)}
                      className="btn btn-ghost px-2 py-1 text-xs text-red-500"
                      aria-label={msg("news.delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
