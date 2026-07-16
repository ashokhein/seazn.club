"use client";

// The organiser description editor (v3/06 §2): TipTap over a deliberately
// small block set — h2/h3, bold/italic, lists, links, image, blockquote,
// divider, and the sponsor/CTA button (a paragraph that is only a bold
// link; see lib/prose). Markdown in, Markdown out (tiptap-markdown), so
// storage stays portable. Preview renders through the SAME pipeline +
// component the public page uses — preview is truth.
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "tiptap-markdown";
import {
  Bold, Eye, Heading2, Heading3, ImagePlus, Italic, Link2, List,
  ListOrdered, Megaphone, Minus, Pencil, Quote,
} from "lucide-react";
import { renderProse, DESCRIPTION_MAX } from "@/lib/prose";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { useMsg } from "@/components/i18n/dict-provider";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

interface Props {
  /** Markdown value (controlled-ish: initial + onChange). */
  value: string;
  onChange: (markdown: string) => void;
  orgId: string;
  placeholder?: string;
  /** Inline style vars for the preview (publicThemeStyle output) so the
   *  organiser previews with their real branding. */
  previewStyle?: React.CSSProperties;
}

function ToolbarButton({
  onClick, active, label, children, disabled,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-md transition disabled:opacity-40 ${
        active ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-purple-50 hover:text-purple-700"
      }`}
    >
      {children}
    </button>
  );
}

export function ProseEditor({ value, onChange, orgId, placeholder, previewStyle }: Props) {
  const msg = useMsg();
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [previewHtml, setPreviewHtml] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        strike: false,
        underline: false,
        link: { openOnClick: false, protocols: ["http", "https", "mailto"] },
      }),
      Image.configure({ inline: false }),
      Markdown.configure({ html: false, linkify: true, transformPastedText: true }),
    ],
    // tiptap-markdown parses string content as Markdown when its extension
    // is present — value in, getMarkdown() out.
    content: value,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "competition-prose min-h-40 max-w-none rounded-b-lg px-3 py-2 outline-none",
        // A bare contenteditable <div> is role=generic, where aria-label is
        // prohibited (axe: aria-prohibited-attr). Declare what it really is.
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": placeholder ?? msg("editor.description"),
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = (
        e.storage as unknown as { markdown: { getMarkdown(): string } }
      ).markdown.getMarkdown();
      onChange(md.slice(0, DESCRIPTION_MAX));
    },
  });

  // Preview = the exact public pipeline (lib/prose → CompetitionProse).
  useEffect(() => {
    if (tab !== "preview") return;
    let alive = true;
    void renderProse(value).then((html) => {
      if (alive) setPreviewHtml(html);
    });
    return () => {
      alive = false;
    };
  }, [tab, value]);

  const setLink = useCallback((e: Editor) => {
    const prev = (e.getAttributes("link").href as string) ?? "";
    const url = window.prompt(msg("editor.linkUrl"), prev);
    if (url === null) return;
    if (url === "") e.chain().focus().unsetLink().run();
    else e.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [msg]);

  const insertCta = useCallback((e: Editor) => {
    const label = window.prompt(msg("editor.buttonLabel"), msg("editor.registerNow"));
    if (!label) return;
    const url = window.prompt(msg("editor.buttonLink"), "https://");
    if (!url) return;
    // The CTA grammar: its own paragraph, bold link only (lib/prose).
    e.chain()
      .focus()
      .insertContent({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: label,
            marks: [{ type: "bold" }, { type: "link", attrs: { href: url } }],
          },
        ],
      })
      .run();
  }, [msg]);

  async function uploadImage(file: File) {
    setUploadError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError(msg("editor.imageTooLarge"));
      return;
    }
    try {
      const res = await fetch(`/api/orgs/${orgId}/content-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: file.type }),
      });
      // handler() envelope: { ok, data } — the grant lives under data.
      const json = (await res.json().catch(() => ({}))) as {
        data?: { upload_url?: string; public_url?: string };
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? msg("editor.uploadNotAllowed"));
      const grant = json.data;
      if (!grant?.upload_url || !grant.public_url) throw new Error(msg("editor.uploadNotAllowed"));
      const put = await fetch(grant.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error(msg("editor.uploadFailed"));
      editor?.chain().focus().setImage({ src: grant.public_url, alt: file.name }).run();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : msg("editor.uploadFailed"));
    }
  }

  const remaining = DESCRIPTION_MAX - value.length;

  return (
    <div className="rounded-lg border border-purple-200 bg-white transition focus-within:border-purple-500 focus-within:ring-2 focus-within:ring-purple-200">
      {/* Write / Preview tabs */}
      <div className="flex items-center justify-between border-b border-purple-100 px-2 py-1">
        <div role="tablist" aria-label={msg("editor.mode")} className="flex gap-1">
          {(
            [
              ["write", msg("editor.write"), Pencil],
              ["preview", msg("editor.preview"), Eye],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                tab === key ? "bg-purple-100 text-purple-800" : "text-slate-500 hover:text-purple-700"
              }`}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={2} />
              {label}
            </button>
          ))}
        </div>
        {remaining < 2000 && (
          <span className={`text-xs ${remaining < 0 ? "text-red-600" : "text-slate-400"}`}>
            {msg("editor.charsLeft", { n: remaining.toLocaleString() })}
          </span>
        )}
      </div>

      {tab === "write" ? (
        <>
          {editor && (
            <div className="flex flex-wrap items-center gap-0.5 border-b border-purple-50 px-2 py-1">
              <ToolbarButton label={msg("editor.heading")} active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                <Heading2 className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label={msg("editor.subheading")} active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
                <Heading3 className="h-4 w-4" />
              </ToolbarButton>
              <span aria-hidden className="mx-1 h-4 w-px bg-purple-100" />
              <ToolbarButton label={msg("editor.bold")} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
                <Bold className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label={msg("editor.italic")} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
                <Italic className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label={msg("editor.link")} active={editor.isActive("link")} onClick={() => setLink(editor)}>
                <Link2 className="h-4 w-4" />
              </ToolbarButton>
              <span aria-hidden className="mx-1 h-4 w-px bg-purple-100" />
              <ToolbarButton label={msg("editor.bulletList")} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
                <List className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label={msg("editor.numberedList")} active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
                <ListOrdered className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label={msg("editor.quote")} active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
                <Quote className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label={msg("editor.divider")} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                <Minus className="h-4 w-4" />
              </ToolbarButton>
              <span aria-hidden className="mx-1 h-4 w-px bg-purple-100" />
              <ToolbarButton label={msg("editor.image")} onClick={() => fileRef.current?.click()}>
                <ImagePlus className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label={msg("editor.cta")} onClick={() => insertCta(editor)}>
                <Megaphone className="h-4 w-4" />
              </ToolbarButton>
            </div>
          )}
          <EditorContent editor={editor} />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadImage(f);
              e.target.value = "";
            }}
          />
          {uploadError && (
            <p className="border-t border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-700">
              {uploadError}
            </p>
          )}
        </>
      ) : (
        <div style={previewStyle} className="min-h-40 rounded-b-lg px-3 py-2">
          {previewHtml ? (
            <CompetitionProse html={previewHtml} />
          ) : (
            <p className="text-sm text-slate-400">{msg("editor.nothingPreview")}</p>
          )}
        </div>
      )}
    </div>
  );
}
