"use client";

import { createClient } from "@supabase/supabase-js";

let _browser: ReturnType<typeof createClient> | null = null;

/** Supabase client for realtime subscriptions only. Never use for DB reads/writes. */
export function supabaseBrowser() {
  if (_browser) return _browser;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase env vars not configured");
  _browser = createClient(url, key);
  return _browser;
}
