"use client";

import { useEffect, useRef, useState } from "react";

/** Once-on-view reveal (design/v3/12 §2 motion rules). Adds `mk-in` the first
 *  time the element enters the viewport, then stops observing. The CSS end
 *  state is shown immediately under prefers-reduced-motion, so the class is
 *  inert there. */
export function Reveal({
  as: Tag = "div",
  className = "",
  children,
  ...rest
}: {
  as?: "div" | "section" | "li";
  className?: string;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Tag ref={ref as any} className={`mk-reveal ${seen ? "mk-in" : ""} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
