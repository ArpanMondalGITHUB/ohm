import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point the home folder at a temp folder, so these tests never touch your real ~/.ohm/auth.json.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const { join } = await import("node:path");
  const home = join(os.tmpdir(), `ohm-test-home-config-${process.pid}`);
  return { ...os, homedir: () => home, default: { ...os, homedir: () => home } };
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { AUTH_FILE } from "../src/auth.ts";
import { loadConfig, loadOrSetupConfig } from "../src/config.ts";
import { fakeReadline } from "./helpers.ts";

// config.ts loads ohm's real .env. process.loadEnvFile never overwrites a variable that is
// already set, so setting these to "" first keeps your real .env out of the tests.
const VARS = [
  "OHM_MODEL",
  "OHM_FALLBACK_MODELS",
  "OHM_TEXT_TOOLS",
  "OHM_REASONING_EFFORT",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
];
let envBefore: NodeJS.ProcessEnv;

const writeAuth = (content: unknown) => {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(content));
};

beforeEach(() => {
  if (!AUTH_FILE.includes("ohm-test-home-config")) throw new Error(`refusing to touch ${AUTH_FILE}`);
  rmSync(homedir(), { recursive: true, force: true });
  envBefore = { ...process.env };
  for (const name of VARS) process.env[name] = "";
});
afterEach(() => {
  // put process.env back exactly as it was (also removes anything .env added)
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
  vi.restoreAllMocks();
});
afterAll(() => rmSync(homedir(), { recursive: true, force: true }));

describe("loadConfig", () => {
  it("returns undefined when nothing is set up", () => {
    expect(loadConfig()).toBeUndefined();
  });

  it("uses the saved default model and key", () => {
    writeAuth({ defaultModel: "anthropic/claude-x", providers: { anthropic: { apiKey: "sk-ant" } } });
    expect(loadConfig()).toEqual({
      modelRef: "anthropic/claude-x",
      providerId: "anthropic",
      api: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant",
      models: ["claude-x"],
      textTools: false,
      reasoningEffort: undefined,
    });
  });

  it("keeps slashes in the model id (OpenRouter style)", () => {
    writeAuth({ defaultModel: "openrouter/vendor/model", providers: { openrouter: { apiKey: "k" } } });
    expect(loadConfig()).toMatchObject({ providerId: "openrouter", api: "openai", models: ["vendor/model"] });
  });

  it("model priority: the argument, then OHM_MODEL, then the saved default", () => {
    writeAuth({ defaultModel: "openai/saved", providers: { openai: { apiKey: "o" } } });
    expect(loadConfig()?.modelRef).toBe("openai/saved");
    process.env.OHM_MODEL = "openai/from-env";
    expect(loadConfig()?.modelRef).toBe("openai/from-env");
    expect(loadConfig("openai/from-arg")?.modelRef).toBe("openai/from-arg");
  });

  it("the provider's own key variable wins over the saved key", () => {
    writeAuth({ defaultModel: "openai/m", providers: { openai: { apiKey: "saved-key" } } });
    process.env.OPENAI_API_KEY = "env-key";
    expect(loadConfig()?.apiKey).toBe("env-key");
  });

  it("works with only an environment key (nothing saved)", () => {
    process.env.OHM_MODEL = "anthropic/claude-x";
    process.env.ANTHROPIC_API_KEY = "env-key";
    expect(loadConfig()).toMatchObject({ providerId: "anthropic", apiKey: "env-key" });
  });

  it("returns undefined when the provider has no key", () => {
    writeAuth({ providers: { openai: { apiKey: "o" } } });
    expect(loadConfig("anthropic/claude-x")).toBeUndefined();
  });

  it("needs no key for Ollama", () => {
    expect(loadConfig("ollama/llama3")).toMatchObject({ apiKey: "none", baseUrl: "http://localhost:11434/v1", api: "openai" });
  });

  it('uses the saved base URL for an "Other" provider and treats it as OpenAI-compatible', () => {
    writeAuth({ providers: { groq: { apiKey: "g", baseUrl: "https://api.groq.com/openai/v1" } } });
    expect(loadConfig("groq/llama")).toMatchObject({ api: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "g" });
  });

  it("throws a clear error for an unknown provider", () => {
    expect(() => loadConfig("qwen/qwen3-coder")).toThrow(/Unknown provider "qwen"/);
  });

  it("throws when the model has no provider part", () => {
    expect(() => loadConfig("just-a-model")).toThrow(/provider\/model/);
  });

  it("reads fallback models, thinking effort and text-tools mode", () => {
    writeAuth({ defaultModel: "openai/main", providers: { openai: { apiKey: "o" } } });
    process.env.OHM_FALLBACK_MODELS = " backup-1, ,backup-2 ";
    process.env.OHM_REASONING_EFFORT = "high";
    process.env.OHM_TEXT_TOOLS = "1";
    expect(loadConfig()).toMatchObject({ models: ["main", "backup-1", "backup-2"], reasoningEffort: "high", textTools: true });
  });

  it("ignores an invalid thinking effort", () => {
    writeAuth({ defaultModel: "openai/m", providers: { openai: { apiKey: "o" } } });
    process.env.OHM_REASONING_EFFORT = "extreme";
    expect(loadConfig()?.reasoningEffort).toBeUndefined();
  });
});

describe("loadOrSetupConfig", () => {
  it("doesn't ask anything when a key and model are already saved", async () => {
    writeAuth({ defaultModel: "openai/m", providers: { openai: { apiKey: "o" } } });
    const rl = fakeReadline([]);
    expect((await loadOrSetupConfig(rl)).modelRef).toBe("openai/m");
    expect(rl.asked).toEqual([]);
  });

  it("runs the setup questions when nothing is saved, then returns the new config", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rl = fakeReadline(["", "sk-new", "model-1"]); // Enter = first provider
    const config = await loadOrSetupConfig(rl);
    expect(rl.asked.length).toBeGreaterThan(0);
    expect(config.apiKey).toBe("sk-new");
    expect(config.models).toEqual(["model-1"]);
  });
});
