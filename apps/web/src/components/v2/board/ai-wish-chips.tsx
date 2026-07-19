"use client";

// Wish chips (v4 Task 12, design/v4/03 §3). A row of one-tap pickers above the
// brief textarea that assemble structured "wishes" (finish by, play before/
// after, keep apart, final last, pin slots). Confirmed wishes render as
// removable floodlight-amber pills — amber because, per the console's colour
// contract (02 §1), amber = "your instruction / the AI's plan". The parent owns
// the Wish[] and turns it into instruction text via compileWishes; this
// component is pure UI over that list. Chip LABELS are localized here; the
// COMPILED instruction text stays English (see wish-compile.ts).
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import type { Wish } from "./wish-compile";

type Kind = Wish["kind"];
type Edge = "before" | "after";
type Entrant = { id: string; name: string };

const KINDS: Kind[] = ["finish_by", "start_window", "keep_apart", "final_last", "pin_entrant"];

const KIND_LABEL: Record<Kind, MessageKey> = {
  finish_by: "board.ai.wish.kind.finishBy",
  start_window: "board.ai.wish.kind.startWindow",
  keep_apart: "board.ai.wish.kind.keepApart",
  final_last: "board.ai.wish.kind.finalLast",
  pin_entrant: "board.ai.wish.kind.pinEntrant",
};

/** Localized pill caption for a confirmed wish (distinct from the English
 *  compiled sentence — the pill is UI, the compiled text feeds the LLM). */
function pillLabel(msg: ReturnType<typeof useMsg>, w: Wish): string {
  switch (w.kind) {
    case "finish_by":
      return msg("board.ai.wish.pill.finishBy", { time: w.time });
    case "start_window":
      return msg("board.ai.wish.pill.startWindow", {
        name: w.targetName,
        edge: msg(`board.ai.wish.edge.${w.edge}`),
        time: w.time,
      });
    case "keep_apart":
      return msg("board.ai.wish.pill.keepApart", { a: w.aName, b: w.bName });
    case "final_last":
      return msg("board.ai.wish.pill.finalLast", { court: w.court });
    case "pin_entrant":
      return msg("board.ai.wish.pill.pinEntrant", { name: w.name });
  }
}

export function AiWishChips({
  wishes,
  onChange,
  entrants,
  courts,
}: {
  wishes: Wish[];
  onChange: (next: Wish[]) => void;
  entrants: Entrant[];
  courts: string[];
}) {
  const msg = useMsg();
  const [active, setActive] = useState<Kind | null>(null);

  // Data availability gates the kinds that need it (entrant / court pickers).
  const hasEntrants = entrants.length > 0;
  const hasCourts = courts.length > 0;
  const kindEnabled = (k: Kind): boolean => {
    if (k === "final_last") return hasCourts;
    if (k === "finish_by") return true;
    return hasEntrants; // start_window / keep_apart / pin_entrant
  };

  const add = (w: Wish) => {
    onChange([...wishes, w]);
    setActive(null);
  };
  const remove = (i: number) => onChange(wishes.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label mb-0">{msg("board.ai.wish.legend")}</span>
      </div>

      {/* Confirmed wishes — removable amber pills */}
      {wishes.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {wishes.map((w, i) => {
            const label = pillLabel(msg, w);
            return (
              <li key={`${w.kind}-${i}`}>
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 py-1 pl-2.5 pr-1 text-xs font-medium text-amber-900">
                  {label}
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    aria-label={msg("board.ai.wish.remove", { label })}
                    className="grid h-4 w-4 place-items-center rounded-full text-amber-700 transition hover:bg-amber-200 hover:text-amber-900"
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add-a-wish kind buttons */}
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => {
          const enabled = kindEnabled(k);
          const isActive = active === k;
          // Explain a greyed-out chip: which data the picker is missing.
          const disabledReason = enabled
            ? undefined
            : msg(k === "final_last" ? "board.ai.wish.noCourts" : "board.ai.wish.noEntrants");
          return (
            <button
              key={k}
              type="button"
              disabled={!enabled}
              title={disabledReason}
              aria-expanded={isActive}
              onClick={() => setActive(isActive ? null : k)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                isActive
                  ? "border-violet-300 bg-violet-50 text-violet-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-violet-300 hover:text-violet-700"
              }`}
            >
              <span aria-hidden className="text-violet-400">
                +
              </span>
              {msg(KIND_LABEL[k])}
            </button>
          );
        })}
      </div>

      {/* Inline picker for the active kind */}
      {active && (
        <WishPicker
          kind={active}
          entrants={entrants}
          courts={courts}
          onAdd={add}
          onCancel={() => setActive(null)}
        />
      )}

      <p className="text-[11px] text-slate-500">{msg("board.ai.wish.hint")}</p>
    </div>
  );
}

// -------------------------------------------------------------- the picker
function WishPicker({
  kind,
  entrants,
  courts,
  onAdd,
  onCancel,
}: {
  kind: Kind;
  entrants: Entrant[];
  courts: string[];
  onAdd: (w: Wish) => void;
  onCancel: () => void;
}) {
  const msg = useMsg();
  const [time, setTime] = useState("");
  const [entrantId, setEntrantId] = useState("");
  const [entrantId2, setEntrantId2] = useState("");
  const [edge, setEdge] = useState<Edge>("before");
  const [court, setCourt] = useState(courts[0] ?? "");

  const nameOf = (id: string) => entrants.find((e) => e.id === id)?.name ?? "";

  let ready = false;
  let build: (() => Wish) | null = null;
  switch (kind) {
    case "finish_by":
      ready = time !== "";
      build = () => ({ kind: "finish_by", time });
      break;
    case "start_window":
      ready = entrantId !== "" && time !== "";
      build = () => ({ kind: "start_window", target: entrantId, targetName: nameOf(entrantId), edge, time });
      break;
    case "keep_apart":
      ready = entrantId !== "" && entrantId2 !== "" && entrantId !== entrantId2;
      build = () => ({ kind: "keep_apart", aName: nameOf(entrantId), bName: nameOf(entrantId2) });
      break;
    case "final_last":
      ready = court !== "";
      build = () => ({ kind: "final_last", court });
      break;
    case "pin_entrant":
      ready = entrantId !== "";
      build = () => ({ kind: "pin_entrant", name: nameOf(entrantId) });
      break;
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-violet-100 bg-violet-50/40 p-2.5">
      {kind === "finish_by" && (
        <Field label={msg("board.ai.wish.time")}>
          <TimeInput value={time} onChange={setTime} />
        </Field>
      )}

      {kind === "start_window" && (
        <>
          <Field label={msg("board.ai.wish.entrant")}>
            <EntrantSelect entrants={entrants} value={entrantId} onChange={setEntrantId} msg={msg} />
          </Field>
          <Field label={msg("board.ai.wish.edgeLabel")}>
            <div role="group" className="flex rounded-lg border border-slate-200 bg-white p-0.5">
              {(["before", "after"] as Edge[]).map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-pressed={edge === e}
                  onClick={() => setEdge(e)}
                  className={`flex-1 rounded-md px-2 py-1 text-xs font-medium capitalize transition ${
                    edge === e ? "bg-violet-600 text-white" : "text-slate-500 hover:text-violet-700"
                  }`}
                >
                  {msg(`board.ai.wish.edge.${e}`)}
                </button>
              ))}
            </div>
          </Field>
          <Field label={msg("board.ai.wish.time")}>
            <TimeInput value={time} onChange={setTime} />
          </Field>
        </>
      )}

      {kind === "keep_apart" && (
        <>
          <Field label={msg("board.ai.wish.first")}>
            <EntrantSelect entrants={entrants} value={entrantId} onChange={setEntrantId} msg={msg} />
          </Field>
          <Field label={msg("board.ai.wish.second")}>
            <EntrantSelect entrants={entrants} value={entrantId2} onChange={setEntrantId2} msg={msg} />
          </Field>
        </>
      )}

      {kind === "final_last" && (
        <Field label={msg("board.ai.wish.court")}>
          <select className="input" value={court} onChange={(e) => setCourt(e.target.value)}>
            {courts.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
      )}

      {kind === "pin_entrant" && (
        <Field label={msg("board.ai.wish.entrant")}>
          <EntrantSelect entrants={entrants} value={entrantId} onChange={setEntrantId} msg={msg} />
        </Field>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={!ready}
          onClick={() => build && onAdd(build())}
          className="btn btn-primary px-3 py-1 text-xs disabled:opacity-50"
        >
          {msg("board.ai.wish.add")}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost px-3 py-1 text-xs">
          {msg("board.ai.wish.cancel")}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input type="time" className="input" value={value} onChange={(e) => onChange(e.target.value)} />
  );
}

function EntrantSelect({
  entrants,
  value,
  onChange,
  msg,
}: {
  entrants: Entrant[];
  value: string;
  onChange: (v: string) => void;
  msg: ReturnType<typeof useMsg>;
}) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{msg("board.ai.wish.choose")}</option>
      {entrants.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
        </option>
      ))}
    </select>
  );
}
