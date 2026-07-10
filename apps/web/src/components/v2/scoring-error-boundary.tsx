"use client";

// Defence in depth for the scoring surface (v3/09 §2): a render crash in a
// sport pad must NEVER leave a blank panel courtside. The boundary renders a
// recovery message with the fixture link so the scorer always has a way back.
import { Component, type ReactNode } from "react";

interface Props {
  /** Console surface: link back to the fixture page. Omit (device pad, where
   *  dl_ tokens cannot open /fixtures) to reload the current page instead. */
  fixtureId?: string;
  children: ReactNode;
}

interface State {
  crashed: boolean;
}

const ACTION_CLASS =
  "mt-3 inline-block rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-800 hover:bg-amber-100";

export class ScoringErrorBoundary extends Component<Props, State> {
  override state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="scoring-error-boundary"
        className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800"
      >
        <p className="font-semibold">Something went wrong — reload scoring</p>
        <p className="mt-1">
          The score is safe: every entry is already saved. Reload to continue scoring.
        </p>
        <button type="button" onClick={() => window.location.reload()} className={ACTION_CLASS}>
          Reload scoring
        </button>
      </div>
    );
  }
}
