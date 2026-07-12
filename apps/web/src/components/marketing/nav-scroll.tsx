"use client";

import { useEffect } from "react";

/** Flips the nav from night (over the hero) to solid once #mk-hero-sentinel
 *  leaves the viewport. The nav itself stays a server component. */
export function NavScrollFlip() {
  useEffect(() => {
    const nav = document.querySelector("[data-mk-nav]");
    const sentinel = document.getElementById("mk-hero-sentinel");
    if (!nav || !sentinel) return;
    const io = new IntersectionObserver(([entry]) => {
      const overHero = Boolean(entry?.isIntersecting);
      nav.classList.toggle("mk-nav-night", overHero);
      nav.classList.toggle("mk-nav-solid", !overHero);
    });
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);
  return null;
}
