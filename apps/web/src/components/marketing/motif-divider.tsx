import { Reveal } from "./reveal";

/** The page's only two decorative motions (design/v3/12 §4.6): a shuttle arc
 *  and a chess-knight L-hop, each < 1.2s, once, on scroll. */
export function MotifDivider({ kind }: { kind: "shuttle" | "knight" }) {
  return (
    <Reveal aria-hidden="true" className="pointer-events-none mx-auto h-12 max-w-5xl overflow-hidden px-4">
      {kind === "shuttle" ? (
        <svg viewBox="0 0 800 48" className="h-full w-full">
          <g className="mk-shuttle">
            <path d="M0 6 l14 10 -14 10 5 -10z" fill="var(--mk-purple)" stroke="#1e1b2e" strokeWidth="2" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 800 48" className="h-full w-full">
          <g className="mk-knight">
            <path
              d="M8 34 q2 -14 12 -18 q-2 -6 4 -8 q8 -2 10 6 q8 4 6 14 l-4 6z"
              fill="var(--mk-purple)"
              stroke="#1e1b2e"
              strokeWidth="2"
            />
          </g>
        </svg>
      )}
    </Reveal>
  );
}
