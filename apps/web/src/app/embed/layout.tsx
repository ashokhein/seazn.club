import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false }, // widgets live inside other sites
};

// Minimal chrome for /embed/* (v3/10 #4): no nav, no footer, white canvas.
// The inline script posts the document height to the parent on every resize
// so the snippet's listener can grow the iframe (auto-height postMessage).
const AUTO_HEIGHT = `
(function () {
  function post() {
    parent.postMessage(
      { type: "seazn:embed:height", height: document.documentElement.scrollHeight },
      "*"
    );
  }
  new ResizeObserver(post).observe(document.documentElement);
  window.addEventListener("load", post);
})();
`;

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-4 bg-white p-3">
      {children}
      <p className="mt-3 text-right text-[10px] text-zinc-400">
        <a
          href="https://seazn.club"
          target="_blank"
          rel="noreferrer"
          className="hover:text-zinc-600"
        >
          live on seazn.club
        </a>
      </p>
      <script dangerouslySetInnerHTML={{ __html: AUTO_HEIGHT }} />
    </div>
  );
}
