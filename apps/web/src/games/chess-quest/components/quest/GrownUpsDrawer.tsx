"use client";

// Grown-ups / training-partner drawer — a disclosure with the register's
// coaching guide. Port of js/app.js renderGrownUps (190–206).
import { GROWN_UPS, GROWN_UPS_CLASSIC } from "../../content/grown-ups";
import { useCopy } from "../../lib/copy";

export function GrownUpsDrawer() {
  const { t, isStory } = useCopy();
  const g = isStory() ? GROWN_UPS : GROWN_UPS_CLASSIC;

  return (
    <details className="rounded-2xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-purple-800">
        {t("For grown-ups — how to run the quest", "Training guide — how to run the quest")}
      </summary>
      <div className="mt-3 flex flex-col gap-4 text-sm text-slate-600">
        <section>
          <h3 className="mk-display font-bold text-purple-950">Every session, same recipe</h3>
          <div className="mt-2 flex flex-col gap-1">
            {g.recipe.map(([time, what]) => (
              <div key={time} className="flex gap-2">
                <b className="w-14 shrink-0 text-purple-700">{time}</b>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3 className="mk-display font-bold text-purple-950">
            {t("Rules for the grown-up", "Rules of the road")}
          </h3>
          <ul className="mt-1 list-disc pl-5">
            {g.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mk-display font-bold text-purple-950">Toolbox</h3>
          <ul className="mt-1 list-disc pl-5">
            {g.toolbox.map(([name, desc]) => (
              <li key={name}>
                <b>{name}</b> — {desc}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mk-display font-bold text-purple-950">
            {t("If she gets stuck or bored", "If you get stuck or bored")}
          </h3>
          <ul className="mt-1 list-disc pl-5">
            {g.stuck.map(([q, a]) => (
              <li key={q}>
                <b>{q}</b> {a}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </details>
  );
}
