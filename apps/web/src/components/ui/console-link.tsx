import NextLink from "next/link";
import type { ComponentProps } from "react";

/**
 * Link for console surfaces (/o, /admin): prefetch is OFF by default.
 *
 * Console routes are auth-gated and fully dynamic (`private, no-store`), and
 * none of them have a loading.tsx boundary — so the router's viewport
 * prefetch renders the ENTIRE target page server-side (DB queries included)
 * for every link on screen, and re-runs the whole set after each
 * router.refresh(). Pass `prefetch` explicitly to opt a link back in (e.g. a
 * static /help target).
 */
export default function ConsoleLink(props: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={false} {...props} />;
}
