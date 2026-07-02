"use client";

import { useEffect, useState } from "react";

/**
 * Renders a locale/timezone-formatted time on the client only. The first
 * render (server + client hydration) is an empty span, so the markup matches
 * and React doesn't report a hydration mismatch; the formatted value fills in
 * after mount using the viewer's local timezone.
 */
export function ClientTime({
  value,
  mode = "time",
}: {
  value: string | Date | null;
  mode?: "time" | "datetime" | "date";
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!value) return;
    const d = value instanceof Date ? value : new Date(value);
    setText(
      mode === "datetime"
        ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
        : mode === "date"
          ? d.toLocaleDateString([], { dateStyle: "medium" })
          : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  }, [value, mode]);

  return <span suppressHydrationWarning>{text}</span>;
}
