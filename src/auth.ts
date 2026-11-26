import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Interface } from "node:readline/promises";
import { PROVIDERS } from "./providers/registry.ts";

export interface ProviderAuth {
  apiKey: string;
  baseUrl?: string; // only for "Other" providers that aren't in the registry
}

/** ~/.ohm/auth.json: one key per provider + the model to start with. */
export interface AuthFile {
  defaultModel?: string; // "provider/model"
  providers: Record<string, ProviderAuth>;
}

export const AUTH_FILE = join(homedir(), ".ohm", "auth.json");

export function readAuth(): AuthFile {
  if (!existsSync(AUTH_FILE)) return { providers: {} };
  try {
    const raw = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    // Old Task 1b format { provider, baseUrl, apiKey, model } → convert, so old setups keep working
    if (typeof raw.apiKey === "string") {
      return {
        defaultModel: `${raw.provider}/${raw.model}`,
        providers: { [raw.provider]: { apiKey: raw.apiKey, baseUrl: raw.baseUrl } },
      };
    }
    return { defaultModel: raw.defaultModel, providers: raw.providers ?? {} };
  } catch {
    return { providers: {} }; // broken file: treat as "not set up"
  }
}

function saveAuth(auth: AuthFile): void {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

/** Remember the model /model switched to, so the next run starts there. */
export function setDefaultModel(ref: string): void {
  const auth = readAuth();
  auth.defaultModel = ref;
  saveAuth(auth);
}

/** Add (or replace) ONE provider's key. Keys for other providers are kept. */
export async function runSetup(rl: Interface): Promise<void> {
  const auth = readAuth();

  console.log("\nConnect a model provider:\n");
  PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}${auth.providers[p.id] ? "  ✓ key saved" : ""}`));
  console.log(`  ${PROVIDERS.length + 1}. Other (any OpenAI-compatible API)`);

  const choice = Number((await rl.question("\nChoose [1]: ")).trim() || "1");
  const info = PROVIDERS[choice - 1]; // undefined = "Other"

  let id = info?.id ?? "";
  let baseUrl: string | undefined;
  if (!info) {
    id = (await rl.question("Short name for it (e.g. groq): ")).trim().toLowerCase();
    baseUrl = (await rl.question("Base URL (e.g. https://api.example.com/v1): ")).trim();
  }

  let apiKey = "none";
  if (info?.needsKey !== false) {
    if (info?.keyUrl) console.log(`Create a key here: ${info.keyUrl}`);
    apiKey = (await rl.question("API key: ")).trim();
  }
  const model = (await rl.question(`Model ID for ${id} (copy it from the provider's model list): `)).trim();

  if (!id || id.includes("/") || !apiKey || !model || (!info && !baseUrl)) {
    throw new Error("Setup cancelled: name (without /), API key, model and (for Other) base URL are required.");
  }

  auth.providers[id] = { apiKey, ...(baseUrl ? { baseUrl } : {}) };
  auth.defaultModel = `${id}/${model}`;
  saveAuth(auth);
  console.log(`\nSaved. Using ${auth.defaultModel}. /login adds another provider, /model switches.\n`);
}
