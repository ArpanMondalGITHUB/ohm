import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Interface } from "node:readline/promises";
import { readAuth, runSetup } from "./auth.ts";
import { findProvider, parseModelRef, type ApiFormat } from "./providers/registry.ts";
import type { ReasoningEffort } from "./types.ts";

export interface Config {
  modelRef: string;   // "provider/model", shown in the UI
  providerId: string;
  api: ApiFormat;     // which adapter to use
  baseUrl: string;
  apiKey: string;
  models: string[];   // model IDs for this provider: [main, ...fallbacks]
  textTools: boolean;
  reasoningEffort?: ReasoningEffort;
}

const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

/**
 * Work out provider, key and model. Model priority: the argument (from /model),
 * then OHM_MODEL in .env, then the default saved by setup.
 * Returns undefined when there's no model yet, or no key for that provider.
 */
export function loadConfig(modelRef?: string): Config | undefined {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const auth = readAuth();

  const ref = modelRef || process.env.OHM_MODEL || auth.defaultModel;
  if (!ref) return undefined;

  const { providerId, modelId } = parseModelRef(ref);
  const info = findProvider(providerId);
  const saved = auth.providers[providerId];
  if (!info && !saved) {
    throw new Error(`Unknown provider "${providerId}" in "${ref}". Use "provider/model", e.g. "openrouter/${ref}".`);
  }

  // The provider's own env var (e.g. ANTHROPIC_API_KEY) wins over the saved key
  const apiKey =
    (info?.envKey && process.env[info.envKey]) || saved?.apiKey || (info?.needsKey === false ? "none" : undefined);
  if (!apiKey) return undefined;

  const fallbacks = (process.env.OHM_FALLBACK_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    modelRef: ref,
    providerId,
    api: info?.api ?? "openai", // "Other" providers are OpenAI-compatible
    baseUrl: saved?.baseUrl || info?.baseUrl || "",
    apiKey,
    models: [modelId, ...fallbacks],
    textTools: process.env.OHM_TEXT_TOOLS === "1",
    reasoningEffort: parseEffort(process.env.OHM_REASONING_EFFORT),
  };
}

function parseEffort(v: string | undefined): ReasoningEffort | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

/** Load the config, running first-time setup if there's no key yet. */
export async function loadOrSetupConfig(rl: Interface): Promise<Config> {
  const existing = loadConfig();
  if (existing) return existing;

  await runSetup(rl);
  const saved = loadConfig();
  if (!saved) throw new Error("Setup finished but no key was found. Is OHM_MODEL in .env pointing to another provider?");
  return saved;
}
