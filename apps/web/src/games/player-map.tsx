"use client";

// slug → lazily loaded game component. Lives apart from registry.ts so the
// registry stays pure data that server code (sitemap, metadata) can import;
// next/dynamic keeps each game's bundle out of every other page.
import dynamic from "next/dynamic";
import type { ComponentType } from "react";

const loading = () => (
  <div className="flex h-full items-center justify-center text-sm text-slate-400">
    Loading game…
  </div>
);

export const PLAYER_MAP: Record<string, ComponentType> = {
  "chess-quest": dynamic(() => import("./chess-quest"), { ssr: false, loading }),
};
