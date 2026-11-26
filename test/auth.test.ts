import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point the home folder at a temp folder, so these tests never touch your real ~/.ohm/auth.json.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const { join } = await import("node:path");
  const home = join(os.tmpdir(), `ohm-test-home-auth-${process.pid}`);
  return { ...os, homedir: () => home, default: { ...os, homedir: () => home } };
});

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { AUTH_FILE, readAuth, runSetup, setDefaultModel } from "../src/auth.ts";
import { PROVIDERS } from "../src/providers/registry.ts";
import { fakeReadline } from "./helpers.ts";

const saved = () => JSON.parse(readFileSync(AUTH_FILE, "utf8"));
const writeAuth = (content: unknown) => {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, typeof content === "string" ? content : JSON.stringify(content));
};
const choiceOf = (id: string) => String(PROVIDERS.findIndex((p) => p.id === id) + 1);

beforeEach(() => {
  // Safety net: stop if the mock didn't work and this is the real auth file
  if (!AUTH_FILE.includes("ohm-test-home-auth")) throw new Error(`refusing to touch ${AUTH_FILE}`);
  rmSync(homedir(), { recursive: true, force: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(homedir(), { recursive: true, force: true }));

describe("readAuth", () => {
  it("returns no providers when the file doesn't exist", () => {
    expect(readAuth()).toEqual({ providers: {} });
  });

  it("reads the current format", () => {
    const data = { defaultModel: "anthropic/c1", providers: { anthropic: { apiKey: "a" }, openai: { apiKey: "o" } } };
    writeAuth(data);
    expect(readAuth()).toEqual(data);
  });

  it("converts the old one-provider format from Task 1b", () => {
    writeAuth({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", model: "vendor/m" });
    expect(readAuth()).toEqual({
      defaultModel: "openrouter/vendor/m",
      providers: { openrouter: { apiKey: "sk-or", baseUrl: "https://openrouter.ai/api/v1" } },
    });
  });

  it("treats a broken file as not set up", () => {
    writeAuth("{ this is not json");
    expect(readAuth()).toEqual({ providers: {} });
  });
});

describe("setDefaultModel", () => {
  it("changes the default model and keeps every saved key", () => {
    writeAuth({ defaultModel: "openai/a", providers: { openai: { apiKey: "o" }, anthropic: { apiKey: "k" } } });
    setDefaultModel("anthropic/b");
    expect(saved()).toEqual({ defaultModel: "anthropic/b", providers: { openai: { apiKey: "o" }, anthropic: { apiKey: "k" } } });
  });

  it("creates the file when there is none", () => {
    setDefaultModel("openai/x");
    expect(saved()).toEqual({ defaultModel: "openai/x", providers: {} });
  });
});

describe("runSetup", () => {
  it("saves the chosen provider's key and makes its model the default", async () => {
    await runSetup(fakeReadline([choiceOf("openrouter"), "sk-or-123", "vendor/model-x"]));
    expect(saved()).toEqual({ defaultModel: "openrouter/vendor/model-x", providers: { openrouter: { apiKey: "sk-or-123" } } });
  });

  it("picks the first provider when you just press Enter", async () => {
    await runSetup(fakeReadline(["", "key", "model"]));
    expect(saved().defaultModel).toBe(`${PROVIDERS[0].id}/model`);
  });

  it("keeps keys for other providers (running /login again adds one)", async () => {
    writeAuth({ defaultModel: "openai/a", providers: { openai: { apiKey: "o" } } });
    await runSetup(fakeReadline([choiceOf("anthropic"), "sk-ant", "claude-x"]));
    expect(saved()).toEqual({
      defaultModel: "anthropic/claude-x",
      providers: { openai: { apiKey: "o" }, anthropic: { apiKey: "sk-ant" } },
    });
  });

  it('saves an "Other" provider with its own name and base URL', async () => {
    const other = String(PROVIDERS.length + 1);
    await runSetup(fakeReadline([other, "Groq", "https://api.groq.com/openai/v1", "gsk", "llama-x"]));
    expect(saved()).toEqual({
      defaultModel: "groq/llama-x",
      providers: { groq: { apiKey: "gsk", baseUrl: "https://api.groq.com/openai/v1" } },
    });
  });

  it("doesn't ask for a key when the provider needs none (Ollama)", async () => {
    const rl = fakeReadline([choiceOf("ollama"), "llama3"]);
    await runSetup(rl);
    expect(rl.asked.some((q) => q.includes("API key"))).toBe(false);
    expect(saved()).toEqual({ defaultModel: "ollama/llama3", providers: { ollama: { apiKey: "none" } } });
  });

  it("shows which providers already have a key", async () => {
    writeAuth({ providers: { openai: { apiKey: "o" } } });
    await runSetup(fakeReadline([choiceOf("openai"), "o2", "m"]));
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/OpenAI\s+✓ key saved/);
  });

  it("refuses to save when an answer is missing", async () => {
    await expect(runSetup(fakeReadline([choiceOf("openai"), "key", ""]))).rejects.toThrow(/Setup cancelled/);
    await expect(runSetup(fakeReadline([choiceOf("openai"), "", "model"]))).rejects.toThrow(/Setup cancelled/);
    expect(existsSync(AUTH_FILE)).toBe(false);
  });

  it('refuses an "Other" name with a slash, or without a base URL', async () => {
    const other = String(PROVIDERS.length + 1);
    await expect(runSetup(fakeReadline([other, "a/b", "https://x", "k", "m"]))).rejects.toThrow(/Setup cancelled/);
    await expect(runSetup(fakeReadline([other, "groq", "", "k", "m"]))).rejects.toThrow(/Setup cancelled/);
    expect(existsSync(AUTH_FILE)).toBe(false);
  });
});
