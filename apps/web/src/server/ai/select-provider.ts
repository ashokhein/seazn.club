// Resolves the provider for a run. Anthropic is the shipped default, so an
// unset or unrecognised AI_PROVIDER behaves exactly as before this seam existed.
import { anthropicProvider } from "./anthropic-provider";
import { openRouterProvider } from "./openrouter-provider";
import type { AiProvider } from "./provider";

export type ProviderName = "anthropic" | "openrouter";

/** Resolve a provider by explicit name. The model ladder (schedule-ai.ts) runs
 *  each rung on its own provider by passing the name here — never by mutating
 *  AI_PROVIDER, which is process-global and unsafe under concurrent requests. */
export function resolveProvider(name: ProviderName): AiProvider {
  return name === "openrouter" ? openRouterProvider() : anthropicProvider();
}

export function selectProvider(): AiProvider {
  return resolveProvider(process.env.AI_PROVIDER === "openrouter" ? "openrouter" : "anthropic");
}
