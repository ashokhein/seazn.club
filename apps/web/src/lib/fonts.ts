// Stadium-night display face for the console (floodlit-console spec §3).
// Mounted once at the root layout on --font-barlow; marketing and the public
// tree keep their own next/font instances (--mk-font-display / --ps-font-
// display) — same underlying woff2 files, so no extra download path.
import { Barlow_Condensed } from "next/font/google";

export const barlowCondensed = Barlow_Condensed({
  weight: ["600", "700"],
  subsets: ["latin"],
  variable: "--font-barlow",
});
