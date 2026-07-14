"use client";

// Timer registry: every delayed game callback goes through later() so
// unmounting (or switching games) can never fire a stale callback into the
// next game's UI — the bug class the original app hit with raw setTimeout.
import { useCallback, useEffect, useRef } from "react";

export function useLater(): {
  later(fn: () => void, ms: number): void;
  clearPending(): void;
} {
  const pending = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearPending = useCallback(() => {
    pending.current.forEach(clearTimeout);
    pending.current = [];
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    pending.current.push(setTimeout(fn, ms));
  }, []);

  useEffect(() => clearPending, [clearPending]);

  return { later, clearPending };
}
