import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider, toAnthropicMessages } from "../src/providers/anthropic.ts";
import { ProviderError, type Message, type ProviderRequest, type ToolDefinition } from "../src/types.ts";
import { collect, sseResponse } from "./helpers.ts";

// ---------- converting our history to Anthropic's format ----------

describe("toAnthropicMessages", () => {
  it("moves system messages to the separate system field", () => {
    const { system, apiMessages } = toAnthropicMessages([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("be nice");
    expect(apiMessages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("joins several system messages", () => {
    const { system } = toAnthropicMessages([
      { role: "system", content: "one" },
      { role: "system", content: "two" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("one\n\ntwo");
  });

  it("puts all tool results for one turn in a single user message", () => {
    const { apiMessages } = toAnthropicMessages([
      { role: "user", content: "read two files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "read", arguments: '{"path":"x"}' },
          { id: "b", name: "read", arguments: '{"path":"y"}' },
        ],
      },
      { role: "tool", toolCallId: "a", content: "X" },
      { role: "tool", toolCallId: "b", content: "Y" },
    ]);
    expect(apiMessages).toHaveLength(3);
    expect(apiMessages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "read", input: { path: "x" } },
        { type: "tool_use", id: "b", name: "read", input: { path: "y" } },
      ],
    });
    expect(apiMessages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "X" },
        { type: "tool_result", tool_use_id: "b", content: "Y" },
      ],
    });
  });

  it("keeps a normal user message separate from earlier tool results", () => {
    const { apiMessages } = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", content: "X" },
      { role: "user", content: "thanks" },
    ]);
    expect(apiMessages.at(-1)).toEqual({ role: "user", content: "thanks" });
  });

  it("sends Claude's own reply back unchanged (thinking blocks included)", () => {
    const raw = [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "done" },
    ];
    const { apiMessages } = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "done", replay: { api: "anthropic", data: raw } },
    ]);
    expect(apiMessages[1]).toEqual({ role: "assistant", content: raw });
  });

  it("ignores replay data written by a different adapter", () => {
    const { apiMessages } = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "hi", replay: { api: "something-else", data: ["x"] } },
    ]);
    expect(apiMessages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "hi" }] });
  });

  it("cleans tool IDs that came from another provider", () => {
    const { apiMessages } = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "call:1.2", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "call:1.2", content: "ok" },
    ]);
    expect(apiMessages[1]).toMatchObject({ content: [{ type: "tool_use", id: "call_1_2" }] });
    expect(apiMessages[2]).toMatchObject({ content: [{ tool_use_id: "call_1_2" }] });
  });

  it("uses {} for tool arguments that aren't a valid JSON object", () => {
    const { apiMessages } = toAnthropicMessages([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "x", arguments: "not json" },
          { id: "b", name: "x", arguments: "[1]" },
          { id: "c", name: "x", arguments: "" },
        ],
      },
    ]);
    expect(apiMessages[1]).toMatchObject({
      content: [{ input: {} }, { input: {} }, { input: {} }],
    });
  });

  it("drops an empty assistant message (Anthropic rejects them)", () => {
    const { apiMessages } = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
      { role: "user", content: "again" },
    ]);
    expect(apiMessages.map((m) => m.role)).toEqual(["user", "user"]);
  });
});

// ---------- streaming through the SDK (fetch is faked, nothing goes to the network) ----------

/** One Anthropic SSE event. */
const ev = (name: string, payload: object) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`;

/** A realistic Claude reply: thinking, text, then a tool call whose input arrives in pieces. */
const toolUseReply = [
  ev("message_start", {
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    },
  }),
  ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Let me look." } }),
  ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig123" } }),
  ev("content_block_stop", { index: 0 }),
  ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Reading " } }),
  ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "the file." } }),
  ev("content_block_stop", { index: 1 }),
  ev("content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } }),
  ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
  ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } }),
  ev("content_block_stop", { index: 2 }),
  ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42 } }),
  ev("message_stop", {}),
];

const readDef: ToolDefinition = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/** Fake fetch BEFORE creating the provider: the SDK picks up the global fetch when the client is made. */
function mockFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    url: () => String(fetchMock.mock.calls[0][0]),
    headers: () => new Headers(fetchMock.mock.calls[0][1]?.headers),
    body: () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body)),
  };
}

function streamFrom(req: Partial<ProviderRequest> = {}) {
  const provider = createAnthropicProvider({ apiKey: "sk-ant-test", baseUrl: "https://api.anthropic.com" });
  const messages: Message[] = [
    { role: "system", content: "You are ohm." },
    { role: "user", content: "read a.ts" },
  ];
  return collect(provider.stream({ model: "claude-test", messages, tools: [readDef], ...req }));
}

afterEach(() => vi.unstubAllGlobals());

describe("anthropic provider: the request", () => {
  it("calls /v1/messages with the key, caching and tools", async () => {
    const http = mockFetch(() => sseResponse(toolUseReply));
    await streamFrom();

    expect(http.url()).toBe("https://api.anthropic.com/v1/messages");
    // The SDK decides how the key is sent: newer versions use "authorization: Bearer", older ones "x-api-key"
    const headers = http.headers();
    const sentKey = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "");
    expect(sentKey).toBe("sk-ant-test");
    const body = http.body();
    expect(body).toMatchObject({
      model: "claude-test",
      stream: true,
      max_tokens: 64000,
      cache_control: { type: "ephemeral" }, // automatic caching of the conversation
      system: [{ type: "text", text: "You are ohm.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "read a.ts" }],
      tools: [{ name: "read", description: "Read a file", input_schema: readDef.parameters }],
    });
    // without OHM_REASONING_EFFORT, ohm leaves thinking to the model's default
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    // Claude doesn't accept temperature, so it is never sent
    expect(body).not.toHaveProperty("temperature");
  });

  it("asks for adaptive thinking and an effort level when reasoningEffort is set", async () => {
    const http = mockFetch(() => sseResponse(toolUseReply));
    await streamFrom({ reasoningEffort: "medium" });
    expect(http.body()).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    });
  });

  it("leaves out system and tools when there are none", async () => {
    const http = mockFetch(() => sseResponse(toolUseReply));
    const provider = createAnthropicProvider({ apiKey: "k" });
    await collect(provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] }));
    expect(http.body()).not.toHaveProperty("system");
    expect(http.body()).not.toHaveProperty("tools");
  });
});

describe("anthropic provider: reading the stream", () => {
  it("streams thinking and text, then the tool call, then done", async () => {
    mockFetch(() => sseResponse(toolUseReply));
    const events = await streamFrom();
    expect(events.slice(0, 4)).toEqual([
      { type: "reasoning_delta", text: "Let me look." },
      { type: "text_delta", text: "Reading " },
      { type: "text_delta", text: "the file." },
      { type: "tool_call", call: { id: "toolu_1", name: "read", arguments: '{"path":"a.ts"}' } },
    ]);
  });

  it("reports stop reason, usage (total input incl. cache) and the raw reply to replay", async () => {
    mockFetch(() => sseResponse(toolUseReply));
    const last = (await streamFrom()).at(-1);
    expect(last).toMatchObject({
      type: "done",
      stopReason: "tool_calls",
      usage: { inputTokens: 115, outputTokens: 42, cachedInputTokens: 100 },
      replay: { api: "anthropic" },
    });
    // the replay data keeps the thinking block WITH its signature, exactly as Claude sent it
    const replay = last?.type === "done" ? (last.replay?.data as Array<{ type: string; signature?: string }>) : [];
    expect(replay.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(replay[0].signature).toBe("sig123");
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["refusal", "content_filter"],
    ["pause_turn", "other"],
  ])("maps stop_reason %s to %s", async (raw, expected) => {
    const reply = [
      toolUseReply[0],
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: raw, stop_sequence: null }, usage: { output_tokens: 1 } }),
      ev("message_stop", {}),
    ];
    mockFetch(() => sseResponse(reply));
    expect((await streamFrom()).at(-1)).toMatchObject({ type: "done", stopReason: expected });
  });
});

describe("anthropic provider: errors", () => {
  it("turns an HTTP error into a ProviderError with the status (so retry.ts can decide)", async () => {
    const http = mockFetch(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const error = await streamFrom().catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(429);
    // maxRetries: 0, so the SDK doesn't retry on its own
    expect(http.fetchMock).toHaveBeenCalledTimes(1);
  });
});
