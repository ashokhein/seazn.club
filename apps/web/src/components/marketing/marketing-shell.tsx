// Marketing display face: same Barlow Condensed config as the public tree
// (see src/app/slideshow/layout.tsx) but on its own --mk-font-display var so
// the --ps-* public theme layer stays untouched.
import { Barlow_Condensed } from "next/font/google";
import { MarketingNav } from "@/components/marketing-nav";
import { BackButton } from "@/components/marketing/back-button";
import { MarketingFooter } from "@/components/marketing-footer";

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--mk-font-display",
});

export function MarketingShell({
  variant = "light",
  lang = "en",
  children,
}: {
  variant?: "night-scroll" | "light";
  /** Active locale for the shared nav + footer copy. Marketing [lang] pages
   *  pass their segment; English-canonical trees (help/developers/games/legal)
   *  keep the default. */
  lang?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${displayFont.variable} flex min-h-screen flex-col`}>
      <MarketingNav variant={variant} lang={lang} />
      {variant === "light" ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-4">
          <BackButton />
        </div>
      ) : null}
      <div className="flex-1">{children}</div>
      <MarketingFooter lang={lang} />
    </div>
  );
}
