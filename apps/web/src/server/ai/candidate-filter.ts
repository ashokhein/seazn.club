// Pure eligibility filter for the OpenRouter model shootout. No network: the
// caller fetches /api/v1/models and passes the array in, so the rules stay
// unit-testable and the generated candidate list is reproducible.
//
// The three capability rules come from the 2026-07-20 v4 benchmark
// (design/v4/04-architect-benchmarks.md), not from taste:
//   - reasoning is load-bearing — the no-thinking arm left blocking conflicts
//     on 2/3 dense runs AND cost more, because repairs resend prior output;
//   - structured outputs are required — both runners read a parsed plan;
//   - context must clear the observed output (29,858 tokens mean on the dense
//     pack) plus the context pack and repair-round resends.
//
// Data-policy survival is NOT decided here. It is a live property of the
// endpoints, probed by scripts/openrouter-preflight.ts.

export const MIN_CONTEXT_TOKENS = 128_000;

export type OpenRouterModel = {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
};

export type Candidate = {
  id: string;
  contextLength: number;
};

export function eligibleCandidates(models: OpenRouterModel[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];

  for (const m of models) {
    if (seen.has(m.id)) continue;
    const params = m.supported_parameters ?? [];
    const contextLength = m.context_length ?? 0;

    if (!params.includes("reasoning")) continue;
    if (!params.includes("structured_outputs")) continue;
    if (contextLength < MIN_CONTEXT_TOKENS) continue;

    seen.add(m.id);
    out.push({ id: m.id, contextLength });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}
