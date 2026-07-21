// Resolves the provider for a run. Anthropic is the shipped default, so an
// unset or unrecognised AI_PROVIDER behaves exactly as before this seam existed.
import { anthropicProvider } from "./anthropic-provider";
import { openRouterProvider } from "./openrouter-provider";
import type { AiProvider } from "./provider";

export function selectProvider(): AiProvider {
  return process.env.AI_PROVIDER === "openrouter"
    ? openRouterProvider()
    : anthropicProvider();
}
