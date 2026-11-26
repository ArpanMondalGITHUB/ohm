import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatProvider } from "../src/providers/openai-compat.ts";
import { ProviderError, type Message, type ProviderEvent, type ProviderRequest, type ToolDefinition } from "../src/types.ts";
import { collect, data, sseResponse } from "./helpers.ts";

const echoDef: ToolDefinition = {
  name: "echo",
  description: "Echo text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

/** Replace the global fetch with one that returns `response` and records what was sent. */
function mockFetch(response: Response | (() => Response)) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => (typeof response === "function" ? response() : response));
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    url: () => fetchMock.mock.calls[0][0],
    init: () => fetchMock.mock.calls[0][1],
    body: () => JSON.parse(String(fetchMock.mock.calls[0][1].body)),
  };
}

function streamFrom(baseUrl = "https://api.example.com/v1", req: Partial<ProviderRequest> = {}) {
  const provider = createOpenAICompatProvider({ baseUrl, apiKey: "sk-test", name: "test" });
  return collect(provider.stream({ model: "m1", messages: [{ role: "user", content: "hi" }], tools: [], ...req }));
}

afterEach(() => vi.unstubAllGlobals());

describe("openai-compat: the request", () => {
  it("POSTs to /chat/completions with the key and a streaming body", async () => {
    const http = mockFetch(sseResponse([data({ choices: [{ delta: { content: "x" } }] }), "data: [DONE]\n\n"]));
    await streamFrom();
    expect(http.url()).toBe("https://api.example.com/v1/chat/completions");
    expect(http.init().method).toBe("POST");
    expect(http.init().headers).toMatchObject({ Authorization: "Bearer sk-test", "Content-Type": "application/json" });
    expect(http.body()).toEqual({
      model: "m1",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("sends tools in the OpenAI function format", async () => {
    const http = mockFetch(sseResponse(["data: [DONE]\n\n"]));
    await streamFrom(undefined, { tools: [echoDef] });
    expect(http.body().tools).toEqual([
      { type: "function", function: { name: "echo", description: "Echo text", parameters: echoDef.parameters } },
    ]);
  });

  it("converts our messages to the API format (and ignores replay data)", async () => {
    const http = mockFetch(sseResponse(["data: [DONE]\n\n"]));
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: '{"text":"a"}' }],
        replay: { api: "anthropic", data: ["secret"] },
      },
      { role: "tool", toolCallId: "c1", content: "echo: a" },
      { role: "assistant", content: "done" },
    ];
    await streamFrom(undefined, { messages });
    expect(http.body().messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null, // empty text becomes null when there are tool calls
        tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"a"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "echo: a" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("asks for thinking with reasoning_effort, or reasoning.effort on OpenRouter", async () => {
    let http = mockFetch(sseResponse(["data: [DONE]\n\n"]));
    await streamFrom("https://api.openai.com/v1", { reasoningEffort: "high" });
    expect(http.body()).toMatchObject({ reasoning_effort: "high" });
    expect(http.body()).not.toHaveProperty("reasoning");

    http = mockFetch(sseResponse(["data: [DONE]\n\n"]));
    await streamFrom("https://openrouter.ai/api/v1", { reasoningEffort: "low" });
    expect(http.body()).toMatchObject({ reasoning: { effort: "low" } });
    expect(http.body()).not.toHaveProperty("reasoning_effort");
  });

  it("passes the abort signal to fetch", async () => {
    const http = mockFetch(sseResponse(["data: [DONE]\n\n"]));
    const controller = new AbortController();
    await streamFrom(undefined, { signal: controller.signal });
    expect(http.init().signal).toBe(controller.signal);
  });
});

describe("openai-compat: reading the stream", () => {
  it("yields text pieces in order, then done", async () => {
    mockFetch(
      sseResponse([
        data({ choices: [{ delta: { content: "Hel" } }] }),
        data({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await streamFrom()).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "done", stopReason: "stop", usage: undefined },
    ]);
  });

  it("yields thinking from delta.reasoning (OpenRouter) and delta.reasoning_content (others)", async () => {
    mockFetch(
      sseResponse([
        data({ choices: [{ delta: { reasoning: "think A" } }] }),
        data({ choices: [{ delta: { reasoning_content: "think B" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const events = await streamFrom();
    expect(events.filter((e) => e.type === "reasoning_delta")).toEqual([
      { type: "reasoning_delta", text: "think A" },
      { type: "reasoning_delta", text: "think B" },
    ]);
  });

  it("shows a refusal as text", async () => {
    mockFetch(sseResponse([data({ choices: [{ delta: { refusal: "I can't help with that." } }] }), "data: [DONE]\n\n"]));
    expect((await streamFrom())[0]).toEqual({ type: "text_delta", text: "I can't help with that." });
  });

  it("joins tool call pieces and emits them only at the end", async () => {
    mockFetch(
      sseResponse([
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"te' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "read", arguments: "{}" } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"a"}' } }] }, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await streamFrom()).toEqual([
      { type: "tool_call", call: { id: "c1", name: "echo", arguments: '{"text":"a"}' } },
      { type: "tool_call", call: { id: "c2", name: "read", arguments: "{}" } },
      { type: "done", stopReason: "tool_calls", usage: undefined },
    ]);
  });

  it("handles providers that leave out the tool call index (like Gemini)", async () => {
    mockFetch(
      sseResponse([
        data({ choices: [{ delta: { tool_calls: [{ id: "g1", function: { name: "echo", arguments: '{"text":"1"}' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ id: "g2", function: { name: "echo", arguments: '{"text":"2"}' } }] } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const calls = (await streamFrom()).filter((e): e is Extract<ProviderEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(calls.map((c) => [c.call.id, c.call.arguments])).toEqual([
      ["g1", '{"text":"1"}'],
      ["g2", '{"text":"2"}'],
    ]);
  });

  it("reads usage from the last chunk even though its choices array is empty", async () => {
    mockFetch(
      sseResponse([
        data({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
        data({
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 60 },
            completion_tokens_details: { reasoning_tokens: 5 },
            cost: 0.0012,
          },
        }),
        "data: [DONE]\n\n",
      ]),
    );
    expect((await streamFrom()).at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, reasoningTokens: 5, costUsd: 0.0012 },
    });
  });

  it.each([
    ["length", "length"],
    ["max_tokens", "length"],
    ["tool_calls", "tool_calls"],
    ["function_call", "tool_calls"],
    ["content_filter", "content_filter"],
    ["end_turn", "stop"],
    ["something_new", "other"],
  ])("maps finish_reason %s to stopReason %s", async (raw, expected) => {
    mockFetch(sseResponse([data({ choices: [{ delta: {}, finish_reason: raw }] }), "data: [DONE]\n\n"]));
    expect((await streamFrom()).at(-1)).toMatchObject({ type: "done", stopReason: expected });
  });

  it("skips comments and lines that aren't JSON, and stops at [DONE]", async () => {
    mockFetch(
      sseResponse([
        ": OPENROUTER PROCESSING\n\n",
        "data: not-json\n\n",
        data({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
        data({ choices: [{ delta: { content: "after done" } }] }),
      ]),
    );
    const texts = (await streamFrom()).filter((e) => e.type === "text_delta");
    expect(texts).toEqual([{ type: "text_delta", text: "ok" }]);
  });
});

describe("openai-compat: errors", () => {
  it("throws a ProviderError with the HTTP status and body", async () => {
    mockFetch(new Response('{"error":"rate limited"}', { status: 429 }));
    const error = await streamFrom().catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(429);
    expect(error.message).toContain("HTTP 429");
    expect(error.message).toContain("rate limited");
  });

  it("throws a ProviderError for an error sent in the middle of the stream", async () => {
    mockFetch(
      sseResponse([data({ choices: [{ delta: { content: "par" } }] }), data({ error: { code: 502, message: "upstream died" } })]),
    );
    const error = await streamFrom().catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("upstream died");
  });

  it("uses status 500 when a mid-stream error has no numeric code", async () => {
    mockFetch(sseResponse([data({ error: { code: "server_error", message: "oops" } })]));
    const error = await streamFrom().catch((e) => e);
    expect(error.status).toBe(500);
  });
});
