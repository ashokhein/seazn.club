// Marketing display face: same Barlow Condensed config as the public tree
// (see src/app/slideshow/layout.tsx) but on its own --mk-font-display var so
// the --ps-* public theme layer stays untouched.
import { Barlow_Condensed } from "next/font/google";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--mk-font-display",
});

export function MarketingShell({
  variant = "light",
  children,
}: {
  variant?: "night-scroll" | "light";
  children: React.ReactNode;
}) {
  return (
    <div className={`${displayFont.variable} flex min-h-screen flex-col`}>
      <MarketingNav variant={variant} />
      <div className="flex-1">{children}</div>
      <MarketingFooter />
    </div>
  );
}
