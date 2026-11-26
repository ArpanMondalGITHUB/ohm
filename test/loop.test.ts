import { describe, expect, it } from "vitest";
import { runAgent, truncate, type AgentOptions } from "../src/agent/loop.ts";
import type { AgentEvent, Message, Provider, ProviderEvent, ProviderRequest, Tool } from "../src/types.ts";
import { collect } from "./helpers.ts";

// ---------- test doubles ----------

const echoTool: Tool = {
  name: "echo",
  description: "Echo text back",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(args) {
    return `echo: ${args.text}`;
  },
};

const failingTool: Tool = {
  name: "boom",
  description: "Always throws",
  parameters: { type: "object", properties: {} },
  async execute() {
    throw new Error("disk on fire");
  },
};

/** A fake model: each call to stream() plays the next scripted reply. It also records every request. */
function scriptedProvider(script: ProviderEvent[][]) {
  const requests: ProviderRequest[] = [];
  let i = 0;
  const provider: Provider = {
    name: "fake",
    async *stream(req) {
      // copy the messages: the loop keeps changing the same array
      requests.push({ ...req, messages: [...req.messages] });
      const reply = script[i++];
      if (!reply) throw new Error(`the fake model has no reply #${i}`);
      for (const ev of reply) yield ev;
    },
  };
  return { provider, requests };
}

const call = (id: string, name: string, args: string): ProviderEvent => ({
  type: "tool_call",
  call: { id, name, arguments: args },
});
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done = (stopReason: "stop" | "tool_calls" | "length" = "stop", extra: Partial<Extract<ProviderEvent, { type: "done" }>> = {}): ProviderEvent => ({
  type: "done",
  stopReason,
  ...extra,
});

async function run(provider: Provider, messages: Message[], opts: Partial<AgentOptions> = {}) {
  return collect(
    runAgent(messages, {
      provider,
      models: ["fake-model"],
      tools: [echoTool, failingTool],
      cwd: process.cwd(),
      confirm: async () => true,
      ...opts,
    }),
  );
}

const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

// ---------- tests ----------

describe("runAgent: the basic loop", () => {
  it("calls a tool, sends the result back, then finishes", async () => {
    const { provider, requests } = scriptedProvider([
      [call("1", "echo", '{"text":"hi"}'), done("tool_calls")],
      [text("Done!"), done()],
    ]);
    const messages: Message[] = [{ role: "user", content: "say hi" }];
    const events = await run(provider, messages);

    expect(ofType(events, "tool_result")[0]).toMatchObject({ callId: "1", name: "echo", output: "echo: hi", isError: false });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[2]).toEqual({ role: "tool", toolCallId: "1", content: "echo: hi" });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "Done!" });
    expect(events.at(-1)).toEqual({ type: "agent_end" });
    // the second request contains the tool result, so the model can see it
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: "echo: hi" });
  });

  it("stops after one turn when the model asks for no tools", async () => {
    const { provider, requests } = scriptedProvider([[text("Hello"), done()]]);
    const events = await run(provider, [{ role: "user", content: "hi" }]);
    expect(requests).toHaveLength(1);
    expect(ofType(events, "turn_start")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "agent_end" });
  });

  it("streams text deltas and saves the full text in history", async () => {
    const { provider } = scriptedProvider([[text("Hel"), text("lo"), done()]]);
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const events = await run(provider, messages);
    expect(ofType(events, "text_delta").map((e) => e.text)).toEqual(["Hel", "lo"]);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "Hello" });
  });

  it("shows thinking (reasoning_delta) but does not save it in history", async () => {
    const { provider } = scriptedProvider([[{ type: "reasoning_delta", text: "hmm" }, text("Answer"), done()]]);
    const messages: Message[] = [{ role: "user", content: "q" }];
    const events = await run(provider, messages);
    expect(ofType(events, "reasoning_delta")).toEqual([{ type: "reasoning_delta", text: "hmm" }]);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "Answer" });
  });

  it("runs several tool calls from one reply, in order", async () => {
    const { provider } = scriptedProvider([
      [call("a", "echo", '{"text":"1"}'), call("b", "echo", '{"text":"2"}'), done("tool_calls")],
      [done()],
    ]);
    const events = await run(provider, [{ role: "user", content: "x" }]);
    expect(ofType(events, "tool_result").map((e) => e.output)).toEqual(["echo: 1", "echo: 2"]);
  });

  it("sends the model id, tool definitions and reasoning effort to the provider", async () => {
    const { provider, requests } = scriptedProvider([[done()]]);
    await run(provider, [{ role: "user", content: "x" }], { reasoningEffort: "high" });
    expect(requests[0].model).toBe("fake-model");
    expect(requests[0].reasoningEffort).toBe("high");
    expect(requests[0].tools.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(requests[0].tools[0]).not.toHaveProperty("execute"); // only the definition is sent
  });

  it("reports stop reason and usage in turn_end, with turn numbers", async () => {
    const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 };
    const { provider } = scriptedProvider([
      [call("1", "echo", '{"text":"a"}'), done("tool_calls", { usage })],
      [text("ok"), done("stop")],
    ]);
    const events = await run(provider, [{ role: "user", content: "x" }]);
    expect(ofType(events, "turn_start").map((e) => e.turn)).toEqual([1, 2]);
    expect(ofType(events, "turn_end")).toEqual([
      { type: "turn_end", turn: 1, stopReason: "tool_calls", usage },
      { type: "turn_end", turn: 2, stopReason: "stop", usage: undefined },
    ]);
  });

  it("saves the provider's replay data on the assistant message", async () => {
    const replay = { api: "anthropic", data: [{ type: "thinking", signature: "sig" }] };
    const { provider } = scriptedProvider([[text("hi"), done("stop", { replay })]]);
    const messages: Message[] = [{ role: "user", content: "x" }];
    await run(provider, messages);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "hi", replay });
  });

  it("emits a message event for every message it adds to history", async () => {
    const { provider } = scriptedProvider([[call("1", "echo", '{"text":"a"}'), done("tool_calls")], [done()]]);
    const messages: Message[] = [{ role: "user", content: "x" }];
    const events = await run(provider, messages);
    expect(ofType(events, "message").map((e) => e.message)).toEqual(messages.slice(1));
  });
});

describe("runAgent: tool errors become results (the loop never crashes)", () => {
  it("turns an unknown tool into an error result", async () => {
    const { provider } = scriptedProvider([[call("1", "nope", "{}"), done("tool_calls")], [text("Sorry"), done()]]);
    const events = await run(provider, [{ role: "user", content: "x" }]);
    const [result] = ofType(events, "tool_result");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unknown tool "nope".*echo, boom/);
  });

  it("turns an exception thrown by a tool into an error result", async () => {
    const { provider } = scriptedProvider([[call("1", "boom", "{}"), done("tool_calls")], [done()]]);
    const events = await run(provider, [{ role: "user", content: "x" }]);
    expect(ofType(events, "tool_result")[0]).toMatchObject({ isError: true, output: "Error: disk on fire" });
  });

  it("reports missing required arguments without running the tool", async () => {
    let ran = false;
    const strict: Tool = { ...echoTool, name: "strict", execute: async () => ((ran = true), "x") };
    const { provider } = scriptedProvider([[call("1", "strict", "{}"), done("tool_calls")], [done()]]);
    const events = await run(provider, [{ role: "user", content: "x" }], { tools: [strict] });
    expect(ofType(events, "tool_result")[0]).toMatchObject({ isError: true, output: expect.stringMatching(/missing required argument\(s\): text/) });
    expect(ran).toBe(false);
  });

  it("reports arguments that can't be parsed at all", async () => {
    const { provider } = scriptedProvider([[call("1", "echo", "not json"), done("tool_calls")], [done()]]);
    const events = await run(provider, [{ role: "user", content: "x" }]);
    expect(ofType(events, "tool_result")[0]).toMatchObject({ isError: true, output: expect.stringMatching(/could not parse arguments/) });
  });

  it("repairs sloppy JSON (code fences, trailing comma) and runs the tool", async () => {
    const { provider } = scriptedProvider([[call("1", "echo", '```json\n{"text":"fixed",}\n```'), done("tool_calls")], [done()]]);
    const events = await run(provider, [{ role: "user", content: "x" }]);
    expect(ofType(events, "tool_result")[0]).toMatchObject({ isError: false, output: "echo: fixed" });
  });

  it("does NOT run tool calls from a reply that was cut off by the token limit", async () => {
    let ran = false;
    const spy: Tool = { ...echoTool, execute: async () => ((ran = true), "x") };
    const { provider, requests } = scriptedProvider([
      [call("1", "echo", '{"text":"half'), done("length")],
      [text("resent"), done()],
    ]);
    const events = await run(provider, [{ role: "user", content: "x" }], { tools: [spy] });
    expect(ran).toBe(false);
    expect(ofType(events, "tool_result")[0]).toMatchObject({ isError: true, output: expect.stringMatching(/output token limit/) });
    // the error still goes back to the model, which gets another turn
    expect(requests).toHaveLength(2);
  });

  it("cuts very long tool output", async () => {
    const big: Tool = { ...echoTool, name: "big", execute: async () => "x".repeat(50_000) };
    const { provider } = scriptedProvider([[call("1", "big", '{"text":"a"}'), done("tool_calls")], [done()]]);
    const events = await run(provider, [{ role: "user", content: "x" }], { tools: [big] });
    const [result] = ofType(events, "tool_result");
    expect(result.output.length).toBeLessThan(31_000);
    expect(result.output).toMatch(/characters cut/);
  });
});

describe("runAgent: free-text tool calls and text mode", () => {
  it("rescues tool calls the model wrote as <tool_call> text", async () => {
    const { provider } = scriptedProvider([
      [text('<tool_call>{"name":"echo","arguments":{"text":"t"}}</tool_call>'), done()],
      [text("ok"), done()],
    ]);
    const messages: Message[] = [{ role: "user", content: "x" }];
    const events = await run(provider, messages);
    expect(ofType(events, "tool_result")[0]).toMatchObject({ output: "echo: t", isError: false });
    expect(messages[1]).toMatchObject({ role: "assistant", toolCalls: [{ name: "echo" }] });
  });

  it("in text mode: sends no tool definitions and returns results as user messages", async () => {
    const { provider, requests } = scriptedProvider([
      [text('<tool_call>{"name":"echo","arguments":{"text":"t"}}</tool_call>'), done()],
      [text("ok"), done()],
    ]);
    const messages: Message[] = [{ role: "user", content: "x" }];
    await run(provider, messages, { textTools: true });
    expect(requests[0].tools).toEqual([]);
    expect(messages[1]).not.toHaveProperty("toolCalls");
    expect(messages[2]).toEqual({ role: "user", content: '<tool_result name="echo">\necho: t\n</tool_result>' });
  });
});

describe("runAgent: steering and follow-up messages (pi's two loops)", () => {
  it("adds a steering message before the next model call", async () => {
    const steering: Message = { role: "user", content: "also do Y" };
    let given = false;
    const { provider, requests } = scriptedProvider([
      [call("1", "echo", '{"text":"a"}'), done("tool_calls")],
      [text("did both"), done()],
    ]);
    const messages: Message[] = [{ role: "user", content: "do X" }];
    await run(provider, messages, {
      getSteeringMessages: () => {
        // empty at the start, the message after turn 1, then empty again
        if (requests.length === 1 && !given) {
          given = true;
          return [steering];
        }
        return [];
      },
    });
    expect(requests[1].messages.at(-1)).toEqual(steering);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
  });

  it("starts another round when follow-up messages are waiting", async () => {
    const followUp: Message = { role: "user", content: "next question" };
    let given = false;
    const { provider, requests } = scriptedProvider([[text("first"), done()], [text("second"), done()]]);
    const events = await run(provider, [{ role: "user", content: "q" }], {
      getFollowUpMessages: () => (given ? [] : ((given = true), [followUp])),
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual(followUp);
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
  });
});

describe("runAgent: retries are reported", () => {
  it("forwards retry events when the first model fails", async () => {
    const { ProviderError } = await import("../src/types.ts");
    let calls = 0;
    const provider: Provider = {
      name: "flaky",
      async *stream(req) {
        calls++;
        if (req.model === "bad") throw new ProviderError(404, "no such model");
        yield text("from good");
        yield done();
      },
    };
    const events = await run(provider, [{ role: "user", content: "x" }], { models: ["bad", "good"] });
    expect(ofType(events, "retry")[0]).toMatchObject({ model: "good", delayMs: 0 });
    expect(ofType(events, "text_delta")[0].text).toBe("from good");
    expect(calls).toBe(2);
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => expect(truncate("short")).toBe("short"));
  it("keeps the start and the end of long text", () => {
    const out = truncate("a".repeat(60) + "b".repeat(60), 40);
    expect(out.startsWith("a".repeat(20))).toBe(true);
    expect(out.endsWith("b".repeat(20))).toBe(true);
    expect(out).toContain("[80 characters cut]");
  });
});
