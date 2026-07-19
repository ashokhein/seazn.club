"use client";
// SPEC-2 composer (PROMPT-83). Title + markdown body (the shared ProseEditor —
// same sanitizing render + org-prefix image upload the public page uses),
// optional hero image (the logo/badge upload rail → content-upload, which stores
// under this org's public prefix), a kind picker, and an optional competition
// scope. Manual posts are free on every plan; this never gates. The frozen-slug
// rule is surfaced in copy: the URL locks on first publish.
import { useState } from "react";
import { ProseEditor } from "@/components/prose-editor";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { OrgPost, PostKind } from "@/server/usecases/org-posts";

// round_recap is auto-only; the composer offers the human-authored kinds.
const KINDS: PostKind[] = ["news", "announcement", "result"];

export function Composer({
  orgId,
  competitions,
  post,
  onDone,
}: {
  orgId: string;
  competitions: { id: string; name: string }[];
  /** Present = edit an existing draft/post; absent = compose a new draft. */
  post?: OrgPost;
  onDone: (changed: boolean) => void;
}) {
  const msg = useMsg();
  const [title, setTitle] = useState(post?.title ?? "");
  const [bodyMd, setBodyMd] = useState(post?.bodyMd ?? "");
  const [kind, setKind] = useState<PostKind>(post?.kind ?? "news");
  const [competitionId, setCompetitionId] = useState<string>(post?.competitionId ?? "");
  const [heroImagePath, setHeroImagePath] = useState<string | null>(post?.heroImagePath ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !!post;
  const published = post?.status === "published";

  async function uploadHero(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { upload_url, public_url } = await apiV1<{ upload_url: string; public_url: string }>(
        `/api/orgs/${orgId}/content-upload`,
        { method: "POST", json: { content_type: file.type } },
      );
      const put = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      setHeroImagePath(public_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("news.composer.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const scope = competitionId || null;
      if (editing) {
        await apiV1(`/api/v1/posts/${post!.id}`, {
          method: "PATCH",
          json: {
            title: title.trim(),
            body_md: bodyMd,
            hero_image_path: heroImagePath,
            competition_id: scope,
          },
        });
      } else {
        // post_created is fired server-side in createPost (next to the usecase).
        await apiV1(`/api/v1/orgs/${orgId}/posts`, {
          method: "POST",
          json: {
            title: title.trim(),
            body_md: bodyMd,
            kind,
            ...(scope ? { competition_id: scope } : {}),
            ...(heroImagePath ? { hero_image_path: heroImagePath } : {}),
          },
        });
      }
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("news.composer.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="news-composer">
      <label className="block">
        <span className="label">{msg("news.composer.title")}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input mt-1 w-full"
          placeholder={msg("news.composer.titlePlaceholder")}
          data-testid="composer-title"
        />
      </label>

      {!editing && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">{msg("news.composer.kind")}</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as PostKind)}
              className="input mt-1 w-full"
              data-testid="composer-kind"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {msg(`news.kind.${k === "round_recap" ? "recap" : k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{msg("news.composer.scope")}</span>
            <select
              value={competitionId}
              onChange={(e) => setCompetitionId(e.target.value)}
              className="input mt-1 w-full"
              data-testid="composer-scope"
            >
              <option value="">{msg("news.composer.scopeOrg")}</option>
              {competitions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div>
        <span className="label">{msg("news.composer.body")}</span>
        <div className="mt-1">
          <ProseEditor
            value={bodyMd}
            onChange={setBodyMd}
            orgId={orgId}
            placeholder={msg("news.composer.bodyPlaceholder")}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="label">{msg("news.composer.hero")}</span>
        {heroImagePath ? (
          // eslint-disable-next-line @next/next/no-img-element -- org-prefix upload just made
          <img src={heroImagePath} alt="" className="h-12 w-20 rounded-md object-cover" />
        ) : null}
        <label className="btn btn-ghost min-h-11 cursor-pointer text-xs">
          {heroImagePath ? msg("news.composer.heroReplace") : msg("news.composer.heroUpload")}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            disabled={busy}
            onChange={(e) => uploadHero(e.target.files?.[0])}
          />
        </label>
        {heroImagePath && (
          <button type="button" onClick={() => setHeroImagePath(null)} className="text-xs text-red-500 underline">
            {msg("news.composer.heroRemove")}
          </button>
        )}
      </div>

      <p className="text-[11px] text-slate-400">
        {published ? msg("news.composer.slugFrozen") : msg("news.composer.slugLocks")}
      </p>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || title.trim() === ""}
          onClick={save}
          className="btn btn-primary min-h-11 text-sm"
          data-testid="composer-save"
        >
          {editing ? msg("news.composer.save") : msg("news.composer.create")}
        </button>
        <button type="button" onClick={() => onDone(false)} className="btn btn-ghost min-h-11 text-sm">
          {msg("news.composer.cancel")}
        </button>
      </div>
    </div>
  );
}
