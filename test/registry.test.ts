import { describe, expect, it } from "vitest";
import { createProvider, findProvider, parseModelRef, PROVIDERS } from "../src/providers/registry.ts";

describe("parseModelRef", () => {
  it("splits a model ref at the first slash", () => {
    expect(parseModelRef("openrouter/anthropic/claude-x")).toEqual({ providerId: "openrouter", modelId: "anthropic/claude-x" });
    expect(parseModelRef("openai/gpt-x")).toEqual({ providerId: "openai", modelId: "gpt-x" });
  });

  it.each(["gpt-x", "/gpt-x", "openai/", ""])('rejects "%s"', (ref) => {
    expect(() => parseModelRef(ref)).toThrow(/provider\/model/);
  });
});

describe("PROVIDERS", () => {
  it("has unique ids without slashes (they are used in model refs)", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toContain("/");
  });

  it("gives every provider a base URL, and a key variable unless it needs no key", () => {
    for (const p of PROVIDERS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      if (p.needsKey !== false) expect(p.envKey).toMatch(/_API_KEY$/);
    }
  });

  it("findProvider finds a known provider and returns undefined otherwise", () => {
    expect(findProvider("anthropic")?.api).toBe("anthropic");
    expect(findProvider("openrouter")?.api).toBe("openai");
    expect(findProvider("nope")).toBeUndefined();
  });
});

describe("createProvider", () => {
  it("builds the Anthropic adapter for the anthropic format", () => {
    const p = createProvider({ providerId: "anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k" });
    expect(p.name).toBe("anthropic");
  });

  it("builds the OpenAI-compatible adapter, named after the provider", () => {
    const p = createProvider({ providerId: "groq", api: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" });
    expect(p.name).toBe("groq");
    expect(typeof p.stream).toBe("function");
  });
});
