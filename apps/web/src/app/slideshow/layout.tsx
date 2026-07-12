// TV noticeboard shell — mounts the courtside display face (Barlow Condensed,
// same config as the public org layout) so the slideshow shares the public
// site's scoreboard typography via the --ps-font-display var.
import type { Metadata } from "next";
import { Barlow_Condensed } from "next/font/google";

// Shared slideshow links get a proper title; the share image inherits the
// root stadium-night card (app/opengraph-image.tsx).
export const metadata: Metadata = { title: "Live noticeboard" };

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--ps-font-display",
});

export default function SlideshowLayout({ children }: { children: React.ReactNode }) {
  return <div className={displayFont.variable}>{children}</div>;
}
