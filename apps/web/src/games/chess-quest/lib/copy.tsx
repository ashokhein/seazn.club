"use client";

// Copy register: Story (kid voice) vs Classic (adult coaching voice).
// Defaults to Classic on the public site; Phase D's profiles add the toggle.
import { createContext, useContext, useMemo } from "react";

export type Register = "story" | "classic";

const CopyCtx = createContext<Register>("classic");

export function CopyProvider({
  register = "classic",
  children,
}: {
  register?: Register;
  children: React.ReactNode;
}) {
  return <CopyCtx.Provider value={register}>{children}</CopyCtx.Provider>;
}

export function useCopy(): { t(story: string, classic: string): string; isStory(): boolean } {
  const register = useContext(CopyCtx);
  return useMemo(
    () => ({
      t: (story: string, classic: string) => (register === "story" ? story : classic),
      isStory: () => register === "story",
    }),
    [register],
  );
}
