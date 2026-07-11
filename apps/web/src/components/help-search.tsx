"use client";

// Client-side help search (v3/06 §3): FlexSearch over the /api/help-index
// document list — no external service, index fetched once on first focus.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Document } from "flexsearch";

interface Doc {
  slug: string;
  title: string;
  description: string;
  text: string;
  [key: string]: string;
}

export function HelpSearch() {
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [hits, setHits] = useState<Doc[]>([]);
  const indexRef = useRef<Document<Doc> | null>(null);

  async function ensureIndex() {
    if (indexRef.current) return;
    const res = await fetch("/api/help-index");
    const list = (await res.json()) as Doc[];
    const index = new Document<Doc>({
      document: {
        id: "slug",
        index: ["title", "description", "text"],
        store: true,
      },
      tokenize: "forward",
    });
    for (const doc of list) index.add(doc);
    indexRef.current = index;
    setDocs(list);
  }

  useEffect(() => {
    if (!query.trim() || !indexRef.current || !docs) {
      setHits([]);
      return;
    }
    const results = indexRef.current.search(query, { limit: 8, enrich: true });
    const seen = new Set<string>();
    const merged: Doc[] = [];
    for (const field of results) {
      for (const r of field.result) {
        const doc = (r as { doc: Doc }).doc;
        if (!seen.has(doc.slug)) {
          seen.add(doc.slug);
          merged.push(doc);
        }
      }
    }
    setHits(merged.slice(0, 8));
  }, [query, docs]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-purple-200 bg-white px-4 py-3 shadow-sm transition focus-within:border-purple-500 focus-within:ring-2 focus-within:ring-purple-200">
        <Search aria-hidden className="h-4 w-4 shrink-0 text-purple-400" strokeWidth={2} />
        <input
          type="search"
          value={query}
          onFocus={() => void ensureIndex()}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the help centre — try “waitlist”"
          aria-label="Search help articles"
          className="w-full bg-transparent text-slate-800 outline-none placeholder:text-slate-400"
        />
      </div>
      {query.trim() && (
        <ul className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-purple-100 bg-white shadow-lg">
          {hits.length === 0 ? (
            <li className="px-4 py-3 text-sm text-slate-500">
              {docs ? "No articles match — try another word." : "Loading index…"}
            </li>
          ) : (
            hits.map((h) => (
              <li key={h.slug} className="border-b border-purple-50 last:border-0">
                <Link
                  href={`/help/${h.slug}`}
                  className="block px-4 py-2.5 transition hover:bg-purple-50/60"
                >
                  <span className="block text-sm font-medium text-slate-800">{h.title}</span>
                  <span className="block truncate text-xs text-slate-500">{h.description}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
