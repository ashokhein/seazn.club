import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { barlowCondensed } from "@/lib/fonts";
import { AnalyticsBootstrap } from "@/components/analytics-bootstrap";
import { CookieConsent } from "@/components/cookie-consent";
import { ConfirmProvider } from "@/components/ui/confirm-provider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Seazn Club — Tournament Management",
    template: "%s — Seazn Club",
  },
  description:
    "Run fair, fun, multi-sport tournaments for your club. Chess, carrom, cricket and more.",
  metadataBase: new URL("https://seazn.club"),
  icons: {
    icon: [
      { url: "/icons/icon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    other: [
      { rel: "mask-icon", url: "/icons/icon-512.png" },
    ],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Seazn Club",
    images: [{ url: "/logo.png", width: 500, height: 500, alt: "Seazn Club" }],
  },
  twitter: {
    card: "summary",
    images: ["/logo.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${barlowCondensed.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">
        {/* Confirmation dialogs everywhere (v3/03 §3) — console and public
            trees both have destructive actions. */}
        <ConfirmProvider>{children}</ConfirmProvider>
        {/* Identifies the logged-in user for PostHog; a no-op for anon traffic.
            Suspense keeps its DB reads off the page's render-blocking path. */}
        <Suspense fallback={null}>
          <AnalyticsBootstrap />
        </Suspense>
        {/* Global consent banner — analytics stays opted out until Accept. */}
        <CookieConsent />
      </body>
    </html>
  );
}
