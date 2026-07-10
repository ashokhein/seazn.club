// TV noticeboard shell — mounts the courtside display face (Barlow Condensed,
// same config as the public org layout) so the slideshow shares the public
// site's scoreboard typography via the --ps-font-display var.
import { Barlow_Condensed } from "next/font/google";

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--ps-font-display",
});

export default function SlideshowLayout({ children }: { children: React.ReactNode }) {
  return <div className={displayFont.variable}>{children}</div>;
}
