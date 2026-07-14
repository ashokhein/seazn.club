// Auth-tunnel shell (floodlit-console spec §6): the full-night moment between
// the marketing site and the console. Night gradient + corner floodlight
// beams + cream condensed wordmark; the page's white cards ("ticket windows")
// come in as children and stay untouched.
import Link from "next/link";

export function NightStage({
  maxW = "max-w-sm",
  children,
}: {
  /** Column width — auth cards are max-w-sm, invite pages max-w-md. */
  maxW?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="app-night-stage grid min-h-screen place-items-center px-4 py-10">
      <div className={`w-full ${maxW}`}>
        <div className="mb-6 text-center">
          <Link href="/" aria-label="Seazn Club — home" className="inline-block">
            {/* The brand mark, not a text lockup: cream wordmark with the lime
                pitch line + red ball, legible on the night stage. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-wide-night.png" alt="Seazn Club" className="mx-auto h-9 w-auto" />
          </Link>
        </div>
        {children}
      </div>
    </main>
  );
}
