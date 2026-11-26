import { createAnthropicProvider } from "./anthropic.ts";
import { createOpenAICompatProvider } from "./openai-compat.ts";
import type { Provider } from "../types.ts";

/** The wire format a provider speaks. Add one ONLY when you write a new adapter file. */
export type ApiFormat = "openai" | "anthropic";

export interface ProviderInfo {
  id: string;         // used in model refs: "<id>/<model>"
  label: string;      // shown in the /login menu
  api: ApiFormat;
  baseUrl: string;
  envKey?: string;    // env var that can hold the key, e.g. ANTHROPIC_API_KEY
  keyUrl?: string;    // where to create a key
  needsKey?: boolean; // false for local servers like Ollama
}

/** Every provider ohm knows. Adding an OpenAI-compatible one = adding one line. */
export const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic (Claude)", api: "anthropic", baseUrl: "https://api.anthropic.com", envKey: "ANTHROPIC_API_KEY", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openrouter", label: "OpenRouter (one key, many models)", api: "openai", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys" },
  { id: "openai", label: "OpenAI", api: "openai", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", label: "Google Gemini", api: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "ollama", label: "Ollama (local, no key)", api: "openai", baseUrl: "http://localhost:11434/v1", needsKey: false },
];

export function findProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** "openrouter/anthropic/claude-x" → provider "openrouter", model "anthropic/claude-x" (split at the FIRST slash). */
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Model must look like "provider/model", e.g. "anthropic/<model-id>". Got "${ref}".`);
  }
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** Build the right adapter for a provider. */
export function createProvider(c: { providerId: string; api: ApiFormat; baseUrl: string; apiKey: string }): Provider {
  switch (c.api) {
    case "anthropic":
      return createAnthropicProvider({ apiKey: c.apiKey, baseUrl: c.baseUrl });
    case "openai":
      return createOpenAICompatProvider({ baseUrl: c.baseUrl, apiKey: c.apiKey, name: c.providerId });
  }
}
