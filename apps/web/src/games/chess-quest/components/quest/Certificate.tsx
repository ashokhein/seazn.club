"use client";

// Printable certificate — hidden on screen, shown alone when printing (see
// chess-quest.css @media print). Port of js/app.js printCertificate.
import { LANDS } from "../../content/lands";
import { certTitle } from "../../lib/cert";
import { useProgress } from "../../lib/progress";

export function Certificate() {
  const progress = useProgress();
  const name = progress.getName() || "This player";
  const t1 = progress.trackDone(1);
  const t2 = progress.trackDone(2);
  const t3 = progress.trackDone(3);
  const { title, line } = certTitle(t1, t2, t3);
  const landsDone = LANDS.filter((l) => progress.landDone(l)).length;
  const date = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="cq-cert-sheet" aria-hidden>
      <div className="cq-cert-frame">
        <div className="cq-cert-crest">♞</div>
        <div className="cq-cert-brand">Chess Quest</div>
        <h1 className="cq-cert-title">{title}</h1>
        <p className="cq-cert-lede">This certificate proudly declares that</p>
        <div className="cq-cert-name">{name}</div>
        <p className="cq-cert-line">{line}.</p>
        <div className="cq-cert-stats">
          ⭐ {progress.totalStars()} stars &nbsp;·&nbsp; 🗓 {progress.activityDates().length} days of
          play &nbsp;·&nbsp; 🏰 {landsDone} of {LANDS.length} lands
        </div>
        <div className="cq-cert-foot">
          <span className="cq-cert-sig">
            <span className="cq-cert-sigline">{date}</span>Date
          </span>
          <span className="cq-cert-sig">
            <span className="cq-cert-sigline">Coach Pony ♞</span>Quest Coach
          </span>
        </div>
      </div>
    </div>
  );
}
