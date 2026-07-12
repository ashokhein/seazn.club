import { Reveal } from "./reveal";

/** The page's only two decorative motions (design/v3/12 §4.6): a shuttlecock
 *  crossing and a chess-knight L-hop. Each plays once on scroll and RESTS
 *  visible; a static lime baseline keeps the strip from ever reading empty. */
export function MotifDivider({ kind }: { kind: "shuttle" | "knight" }) {
  return (
    <Reveal repeat aria-hidden="true" className="pointer-events-none mx-auto h-14 max-w-5xl overflow-hidden px-4">
      <svg viewBox="0 0 800 56" className="h-full w-full">
        <line x1="24" y1="46" x2="776" y2="46" stroke="var(--mk-lime)" strokeWidth="2" opacity="0.35" strokeLinecap="round" />
        {kind === "shuttle" ? (
          <g className="mk-shuttle">
            {/* shuttlecock: cork nose + feather cone */}
            <path d="M6 0 L26 -9 L26 9 Z" fill="var(--mk-lime)" stroke="#1e1b2e" strokeWidth="2" strokeLinejoin="round" />
            <circle cx="4" cy="0" r="4.5" fill="var(--mk-cream)" stroke="#1e1b2e" strokeWidth="2" />
          </g>
        ) : (
          <>
            {/* landing square appears where the hop ends */}
            <rect className="mk-knight-square" x="422" y="34" width="30" height="12" rx="3" fill="var(--mk-lime)" opacity="0" />
            <g className="mk-knight">
              {/* chess knight: base plinth, chest, arched neck, muzzle + ear */}
              <path
                d="M4 34 L4 30 Q4 28 6.5 27.5 L8 27 Q10 22 9 17 Q8 11 12 6.5 Q14 4.5 16.5 3.5 L17 0.5 L19.5 3 Q26 4 28.5 10 Q30 14 29 16.5 L25.5 15 Q26 19 23 22 Q20.5 24.5 20 27 L21.5 27.5 Q24 28 24 30 L24 34 Z"
                fill="var(--mk-purple)"
                stroke="#1e1b2e"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <circle cx="20.5" cy="9.5" r="1.6" fill="var(--mk-cream)" />
            </g>
          </>
        )}
      </svg>
    </Reveal>
  );
}
