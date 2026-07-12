"use client";

import { useEffect, useRef, useState } from "react";

/** On-view reveal (design/v3/12 §2 motion rules). Adds `mk-in` when the
 *  element enters the viewport — once by default; with `repeat` the class is
 *  removed on exit so the animation replays on every entry. The CSS end
 *  state is shown immediately under prefers-reduced-motion, so the class is
 *  inert there. */
export function Reveal({
  as: Tag = "div",
  className = "",
  repeat = false,
  children,
  ...rest
}: {
  as?: "div" | "section" | "li";
  className?: string;
  repeat?: boolean;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (seen && !repeat) return;
    const io = new IntersectionObserver(
      (entries) => {
        const inView = entries.some((e) => e.isIntersecting);
        if (inView) {
          setSeen(true);
          if (!repeat) io.disconnect();
        } else if (repeat) {
          setSeen(false);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, repeat]);

  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Tag ref={ref as any} className={`mk-reveal ${seen ? "mk-in" : ""} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
