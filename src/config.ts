import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReasoningEffort } from "./types.ts";

export interface Config {
  baseUrl: string;
  apiKey: string;
  models: string[];   // [main model, ...fallbacks]
  textTools: boolean;
  reasoningEffort?: ReasoningEffort;
}

// The .env file next to package.json, wherever you run ohm from
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

export function loadConfig(): Config {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE); // built into Node 20.12+

  const apiKey = process.env.OHM_API_KEY ?? process.env.OPENROUTER_API_KEY;
  const model = process.env.OHM_MODEL;
  if (!apiKey) throw new Error(`Missing OHM_API_KEY. Add it to ${ENV_FILE}`);
  if (!model) throw new Error(`Missing OHM_MODEL. Add it to ${ENV_FILE}`);

  const fallbacks = (process.env.OHM_FALLBACK_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    baseUrl: process.env.OHM_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey,
    models: [model, ...fallbacks],
    textTools: process.env.OHM_TEXT_TOOLS === "1",
    reasoningEffort: parseEffort(process.env.OHM_REASONING_EFFORT),
  };
}

function parseEffort(v: string | undefined): ReasoningEffort | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}
