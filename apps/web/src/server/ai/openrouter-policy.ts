// The data policy attached to every OpenRouter request.
//
// help/scheduling/ai-scheduling.md tells organisers their brief "is not used to
// train AI models", and ai-officials.md repeats the guarantee. Routing through
// third parties only keeps that true if the policy travels with the request, so
// it lives here as a constant rather than an env var: there is no deployment in
// which loosening it is correct.
//
// Reviewed: 2026-07-21. Re-review whenever a provider is added.

/** Upstream providers permitted to serve our traffic — FIRST-PARTY VENDORS ONLY.
 *
 *  A model id says who BUILT the model, never who SERVES it. Verified
 *  2026-07-21 against /api/v1/models/{id}/endpoints: `anthropic/claude-sonnet-5`
 *  has 7 endpoints across Azure, Anthropic, Amazon Bedrock and Google Vertex;
 *  `z-ai/glm-5.2` has 31 across ~30 companies; `moonshotai/kimi-k2.6` has 20.
 *  `data_collection: "deny"` filters on training policy — it does NOT pin who
 *  processes the data. Without this list a single request could be served by
 *  any of them, which is not what the help pages promise organisers.
 *
 *  These are provider ROUTING SLUGS, not model-id prefixes — they differ
 *  (`x-ai/grok-4.5` is served by slug `xai`, display name "xAI"). Take slugs
 *  from the `tag` field, up to the first `/`.
 *
 *  Each slug below was verified with a live request carrying the full policy;
 *  all six returned 200 and were served by the named vendor.
 *
 *  Widened 2026-07-21 to six vendors: added `google-vertex` and `openai`.
 *  `google-vertex` (not `google-ai-studio`) was a deliberate choice — it's
 *  the enterprise GCP path with regional endpoints, which suits a UK/EU
 *  product. help/scheduling/ai-scheduling.md and ai-officials.md must name
 *  all six vendors (Task 12, not yet written as of this widening). */
export const ALLOWED_PROVIDERS = [
  "anthropic",
  "xai",
  "z-ai",
  "moonshotai",
  "google-vertex",
  "openai",
] as const;

const POLICY = {
  provider: {
    data_collection: "deny",
    only: ALLOWED_PROVIDERS,
    // Upstream default is true. Left on, routing can fall through to a
    // provider outside `only` and the promise quietly stops holding.
    allow_fallbacks: false,
  },
  zdr: true,
} as const;

/** Stamp the policy onto a request body, last, so nothing can override it. */
export function applyPolicy<T extends object>(body: T): T & typeof POLICY {
  return { ...body, ...POLICY };
}
